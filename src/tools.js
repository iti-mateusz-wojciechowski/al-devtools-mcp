// Tool definitions and handlers.
//
// Deliberately a small surface. Symbol lookup, object IDs, build/compile and
// diagnostics are already covered by other AL MCP servers (al-mcp-server, the
// official altool MCP, al-object-id-ninja); duplicating them would cost context
// on every request and add no capability. Raw syntax trees are omitted too --
// getfullsyntaxtree returns ~1.7MB of JSON for a 1100-line file.
//
// Every command is exposed through an enum on a handful of tools rather than one
// tool per command: tool schemas are paid for on every request, enum values are
// not.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { findProjectPath } from './devtools.js';
import { unifiedDiff, diffStats } from './diff.js';
import { kindName } from './symbolKinds.js';

// Purely syntactic rewrites. Fast, and safe to run without reading symbols.
export const CLEANUP_COMMANDS = {
  sortProcedures: 'Sort procedures alphabetically (respects #region scopes; attributes and doc comments travel with each procedure)',
  sortTriggers: 'Sort triggers alphabetically',
  sortProperties: 'Sort object properties into canonical order',
  sortTableFields: 'Sort table fields by field ID',
  sortVariables: 'Sort var declarations into AL canonical order (complex types first, then simple types by type then name)',
  sortUsings: 'Sort namespace using statements',
  sortReportColumns: 'Sort report columns',
  sortPermissions: 'Sort permission set permissions',
  sortPermissionSetList: 'Sort included permission sets',
  sortCustomizations: 'Sort the Customizations property',
  removeBeginEnd: 'Remove begin..end around single statements',
  removeEmptyLines: 'Remove redundant empty lines',
  removeEmptySections: 'Remove empty sections',
  removeEmptyTriggers: 'Remove empty triggers',
  removeProceduresSemicolon: 'Remove redundant semicolons after procedure declarations',
  collapseEmptyBrackets: 'Collapse empty { } brackets',
  trimTrailingWhitespace: 'Trim trailing whitespace',
  oneStatementPerLine: 'Split multiple statements onto separate lines',
  addParentheses: 'Add missing parentheses to parameterless calls (CodeCop AA0008)',
  fixKeywordsCase: 'Normalise keyword casing',
  fixIdentifiersCase: 'Normalise identifier and keyword casing',
  formatDocument: 'Apply standard AL document formatting',
  addUsingRegion: 'Wrap using statements in a #region',
  updateUsingsList: 'Remove unused using statements',
};

// Need the symbol table (Base App / dependencies) loaded, so slower and richer.
export const METADATA_COMMANDS = {
  addToolTips: 'Add missing ToolTips to page fields, reusing tooltips from dependencies where available',
  addTooTipsEndingDots: 'Add the required trailing period to ToolTips',
  refreshToolTips: 'Refresh ToolTips from dependency definitions',
  setPageFieldToolTip: 'Reuse a field ToolTip defined on other pages',
  addFieldCaptions: 'Add missing Caption properties to table fields',
  addObjectCaptions: 'Add missing object Captions',
  addEnumCaptions: 'Add missing Captions to enum values',
  addPageControlCaptions: 'Add missing Captions to page controls',
  addDataClassification: 'Add missing DataClassification to fields',
  removeRedundantDataClassification: 'Remove DataClassification that matches the object default',
  addAppAreas: 'Add missing ApplicationArea to page controls and actions',
  removeRedundantAppAreas: 'Remove ApplicationArea that duplicates the object default',
  addTableDataCaptionFields: 'Add the DataCaptionFields property to tables',
  addDropDownFieldGroups: 'Add DropDown field groups',
  convertObjectIdsToNames: 'Replace numeric object IDs with object names',
  removeUnusedVariables: 'Remove variables that are never referenced (CodeCop AA0137)',
  removeWith: 'Remove "with" statements, qualifying members explicitly',
  makeFlowFieldsReadOnly: 'Mark FlowFields as Editable = false',
  removeStrSubstNoFromError: 'Simplify Error(StrSubstNo(...)) into Error(...)',
  addMissingCaseLines: 'Add missing case branches for enum values',
  lockRemovedFieldsCaptions: 'Lock captions of removed table fields',
  addAllObjectsPermissions: 'Add permissions for all objects in the project',
  addReferencedTablesPermissions: 'Add permissions for referenced tables',
};

const ALL_COMMANDS = { ...CLEANUP_COMMANDS, ...METADATA_COMMANDS };

/** Render an enum's allowed values with descriptions, for the tool schema. */
function describeCommands(map) {
  return Object.entries(map).map(([k, v]) => `- ${k}: ${v}`).join('\n');
}

function listAlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .alpackages, .vscode, .git
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listAlFiles(full, acc);
    else if (entry.name.toLowerCase().endsWith('.al')) acc.push(full);
  }
  return acc;
}

function resolveProject(filePath, explicit) {
  const projectPath = explicit || findProjectPath(filePath);
  if (!projectPath) {
    throw new Error(`Could not locate an AL project (no app.json found above ${filePath}). Pass projectPath explicitly.`);
  }
  return projectPath;
}

/** Shared implementation for al_cleanup and al_add_metadata. */
async function runTransform(server, args, allowed, toolName) {
  const { command, filePath, write = false, output = 'diff', projectPath: explicitProject } = args;
  if (!allowed[command]) {
    throw new Error(`Unknown command '${command}' for ${toolName}. Allowed: ${Object.keys(allowed).join(', ')}`);
  }
  if (!filePath) throw new Error('filePath is required');
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const projectPath = resolveProject(filePath, explicitProject);
  const before = args.source ?? readFileSync(filePath, 'utf8');

  const result = await server.workspaceCommand({ command, source: before, projectPath, filePath });
  const after = result.source;

  if (!after || after === before) {
    return { text: `No changes: '${command}' found nothing to modify in ${basename(filePath)}.` };
  }

  const stats = diffStats(before, after);
  let text;
  if (output === 'source') {
    text = after;
  } else if (output === 'summary') {
    text = `'${command}' would change ${basename(filePath)}: +${stats.added}/-${stats.removed} lines.`;
  } else {
    text = unifiedDiff(before, after, { label: relative(projectPath, filePath) || basename(filePath) });
  }

  if (write) {
    writeFileSync(filePath, after, 'utf8');
    text = `Applied '${command}' to ${basename(filePath)} (+${stats.added}/-${stats.removed} lines).\n\n${text}`;
  } else if (output !== 'summary') {
    text = `Preview only -- ${basename(filePath)} was NOT modified (pass write: true to apply).\n\n${text}`;
  }
  return { text };
}

export function buildTools(server) {
  return [
    {
      name: 'al_cleanup',
      description:
        'Apply a deterministic, purely syntactic AL code fix to one file using the AZ AL Dev Tools ' +
        'Roslyn engine. Use this instead of rewriting AL by hand: it is exact, and it correctly handles ' +
        'string literals, comments, #region scopes, and attribute/doc-comment ownership that text editing ' +
        'gets wrong. Returns a unified diff by default and does NOT write unless write:true.\n\n' +
        'Commands:\n' + describeCommands(CLEANUP_COMMANDS),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: Object.keys(CLEANUP_COMMANDS), description: 'The fix to apply.' },
          filePath: { type: 'string', description: 'Absolute path to the .al file.' },
          projectPath: { type: 'string', description: 'AL project root (folder with app.json). Auto-detected if omitted.' },
          write: { type: 'boolean', description: 'Write the result to disk. Default false (preview only).', default: false },
          output: { type: 'string', enum: ['diff', 'source', 'summary'], description: 'Response format. Default "diff" (cheapest).', default: 'diff' },
        },
        required: ['command', 'filePath'],
      },
      handler: (args) => runTransform(server, args, CLEANUP_COMMANDS, 'al_cleanup'),
    },

    {
      name: 'al_add_metadata',
      description:
        'Apply an AL fix that requires the symbol table (Base App and dependencies) to one file -- ' +
        'captions, tooltips, ApplicationArea, DataClassification, unused-variable removal, object-ID-to-name ' +
        'conversion. These cannot be done by text manipulation because they need real field names, ' +
        'dependency tooltips or name binding. Slower than al_cleanup (first call loads symbols, ~4s). ' +
        'Returns a unified diff by default and does NOT write unless write:true.\n\n' +
        'Commands:\n' + describeCommands(METADATA_COMMANDS),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: Object.keys(METADATA_COMMANDS), description: 'The fix to apply.' },
          filePath: { type: 'string', description: 'Absolute path to the .al file.' },
          projectPath: { type: 'string', description: 'AL project root (folder with app.json). Auto-detected if omitted.' },
          write: { type: 'boolean', description: 'Write the result to disk. Default false (preview only).', default: false },
          output: { type: 'string', enum: ['diff', 'source', 'summary'], description: 'Response format. Default "diff".', default: 'diff' },
        },
        required: ['command', 'filePath'],
      },
      handler: (args) => runTransform(server, args, METADATA_COMMANDS, 'al_add_metadata'),
    },

    {
      name: 'al_project_cleanup',
      description:
        'Apply one or more AL fixes across every .al file in a project. Transforms in memory and reports ' +
        'which files would change; writes nothing unless dryRun:false. Use for repo-wide tidy-ups ' +
        '(e.g. sortProcedures + removeEmptyLines over a whole app). Run it on a clean git working tree ' +
        'so the change is easy to review or revert.',
      inputSchema: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: { type: 'string', enum: Object.keys(ALL_COMMANDS) },
            description: 'Commands to apply in order to each file.',
          },
          projectPath: { type: 'string', description: 'AL project root containing app.json.' },
          dryRun: { type: 'boolean', description: 'Report without writing. Default true.', default: true },
          maxFiles: { type: 'number', description: 'Safety cap on files processed. Default 500.', default: 500 },
        },
        required: ['commands', 'projectPath'],
      },
      handler: async (args) => {
        const { commands, projectPath, dryRun = true, maxFiles = 500 } = args;
        if (!Array.isArray(commands) || commands.length === 0) throw new Error('commands must be a non-empty array');
        for (const c of commands) if (!ALL_COMMANDS[c]) throw new Error(`Unknown command '${c}'`);
        if (!existsSync(join(projectPath, 'app.json'))) throw new Error(`No app.json in ${projectPath} -- not an AL project root.`);

        const all = listAlFiles(projectPath);
        const files = all.slice(0, maxFiles);
        const truncated = all.length - files.length;

        const changed = [];
        const failed = [];
        for (const file of files) {
          let current;
          try { current = readFileSync(file, 'utf8'); } catch (e) { failed.push({ file, error: e.message }); continue; }
          const original = current;
          for (const command of commands) {
            try {
              const res = await server.workspaceCommand({ command, source: current, projectPath, filePath: file });
              if (res.source) current = res.source;
            } catch (e) {
              failed.push({ file, command, error: e.message });
            }
          }
          if (current !== original) {
            const stats = diffStats(original, current);
            if (!dryRun) writeFileSync(file, current, 'utf8');
            changed.push({ file: relative(projectPath, file), ...stats });
          }
        }

        const lines = [
          `${dryRun ? 'Dry run' : 'Applied'}: [${commands.join(', ')}] over ${files.length} file(s) in ${basename(projectPath)}.`,
          `${changed.length} file(s) ${dryRun ? 'would change' : 'changed'}.`,
        ];
        if (truncated > 0) lines.push(`NOTE: ${truncated} additional file(s) skipped by maxFiles=${maxFiles}.`);
        if (changed.length) {
          lines.push('');
          for (const c of changed) lines.push(`  ${c.file}  +${c.added}/-${c.removed}`);
        }
        if (failed.length) {
          lines.push('', `${failed.length} failure(s):`);
          for (const f of failed.slice(0, 20)) lines.push(`  ${relative(projectPath, f.file)}${f.command ? ` [${f.command}]` : ''}: ${f.error}`);
          if (failed.length > 20) lines.push(`  ...and ${failed.length - 20} more`);
        }
        if (dryRun && changed.length) lines.push('', 'Pass dryRun: false to write these changes.');
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'al_find_duplicates',
      description:
        'Find duplicated code blocks across an AL project using the AZ AL Dev Tools duplicate-code ' +
        'detector. Compares parsed statement structure rather than text, so it catches clones that differ ' +
        'in naming and formatting. Useful before refactoring, or to locate extract-to-procedure candidates.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'AL project root containing app.json.' },
          minNoOfStatements: { type: 'number', description: 'Minimum statements for a block to count. Default 10. Lower finds more, noisier.', default: 10 },
          skipObsoleteCodeLevel: { type: 'number', description: '0 = include obsolete code, 1 = skip pending, 2 = skip removed. Default 0.', default: 0 },
          maxGroups: { type: 'number', description: 'Cap on reported groups. Default 40.', default: 40 },
        },
        required: ['projectPath'],
      },
      handler: async (args) => {
        const { projectPath, minNoOfStatements = 10, skipObsoleteCodeLevel = 0, maxGroups = 40 } = args;
        await server.ensureProject(projectPath);
        const res = await server.request('al/findDuplicateCode', { minNoOfStatements, skipObsoleteCodeLevel, path: projectPath });
        const groups = res?.duplicates || [];
        if (groups.length === 0) {
          return { text: `No duplicated blocks of >= ${minNoOfStatements} statements found in ${basename(projectPath)}.` };
        }
        groups.sort((a, b) => (b.noOfStatements || 0) - (a.noOfStatements || 0));
        const shown = groups.slice(0, maxGroups);
        const lines = [`${groups.length} duplicate group(s) with >= ${minNoOfStatements} statements in ${basename(projectPath)}:`, ''];
        shown.forEach((g, i) => {
          lines.push(`${i + 1}. ${g.noOfStatements} statements, ${(g.ranges || []).length} occurrences:`);
          for (const r of g.ranges || []) {
            lines.push(`     ${relative(projectPath, r.filePath)}:${(r.start?.line ?? 0) + 1}-${(r.end?.line ?? 0) + 1}`);
          }
        });
        if (groups.length > shown.length) lines.push('', `...and ${groups.length - shown.length} more group(s) (raise maxGroups to see them).`);
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'al_outline',
      description:
        'Get a compact structural outline of one AL file -- objects, fields, procedures, triggers, ' +
        'controls, actions -- without reading the file. Far cheaper than reading a large AL object when ' +
        'you only need to know what is in it and where.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to the .al file.' },
          projectPath: { type: 'string', description: 'AL project root. Auto-detected if omitted.' },
          includeProperties: { type: 'boolean', description: 'Include object/field properties in the outline. Default false.', default: false },
        },
        required: ['filePath'],
      },
      handler: async (args) => {
        const { filePath, includeProperties = false } = args;
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        const projectPath = resolveProject(filePath, args.projectPath);
        const source = readFileSync(filePath, 'utf8');
        await server.ensureProject(projectPath);
        const res = await server.request('al/documentsymbols', {
          source, path: filePath, projectPath, includeProperties, isActiveDocument: false,
        });

        const root = res?.root ?? res?.symbol ?? res;
        const lines = [];
        // Label/TextConst declarations carry their whole literal in `name`, which
        // dominates the output. Keep the declaration visible but not the payload.
        const MAX_NAME = 90;
        const walk = (node, depth) => {
          if (!node || depth > 12) return;
          const kids = node.childSymbols || node.childNodes || node.children || [];
          let name = node.fullName || node.name || '';
          if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).trimEnd() + '...';
          const kind = kindName(node.kind ?? node.alKind);
          if (depth >= 0 && (name || kind)) {
            const loc = node.range?.start?.line ?? node.span?.start?.line;
            lines.push(`${'  '.repeat(depth)}${name || '(unnamed)'}${kind ? `  [${kind}]` : ''}${loc !== undefined ? `  :${loc + 1}` : ''}`);
          }
          for (const k of kids) walk(k, depth + 1);
        };
        walk(root, -1);

        if (lines.length === 0) {
          return { text: `No symbols returned for ${basename(filePath)}. Raw response: ${JSON.stringify(res).slice(0, 500)}` };
        }
        return { text: `Outline of ${basename(filePath)}:\n\n${lines.join('\n')}` };
      },
    },
  ];
}
