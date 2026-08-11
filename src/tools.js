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

import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, basename, resolve, isAbsolute, dirname, sep } from 'node:path';
import { findProjectPath } from './devtools.js';
import { unifiedDiff, diffStats } from './diff.js';
import { kindName } from './symbolKinds.js';

// Purely syntactic rewrites. Fast, and safe to run without reading symbols.
//
// Cite only CodeCop IDs verified against the published rule list: a wrong ID sends
// an agent to a tool that cannot fix its diagnostic, which is worse than no ID.
export const CLEANUP_COMMANDS = {
  sortProcedures: 'Sort procedures alphabetically (respects #region scopes; attributes and doc comments travel with each procedure)',
  sortTriggers: 'Sort triggers alphabetically',
  sortProperties: 'Sort object properties into canonical order',
  sortTableFields: 'Sort table fields by field ID',
  sortVariables: 'Sort var declarations into AL canonical order, complex types first, then simple types by type then name (CodeCop AA0021)',
  sortUsings: 'Sort namespace using statements (CodeCop AA0477)',
  sortReportColumns: 'Sort report columns',
  sortCustomizations: 'Sort the Customizations property',
  removeBeginEnd: 'Remove begin..end around single statements (CodeCop AA0005)',
  removeEmptyLines: 'Remove redundant empty lines',
  removeEmptySections: 'Remove empty sections',
  removeEmptyTriggers: 'Remove empty triggers',
  removeProceduresSemicolon: 'Remove redundant semicolons after procedure declarations',
  collapseEmptyBrackets: 'Collapse empty { } brackets',
  trimTrailingWhitespace: 'Trim trailing whitespace',
  oneStatementPerLine: 'Split multiple statements onto separate lines',
  addParentheses: 'Add missing parentheses to parameterless calls (CodeCop AA0008)',
  fixKeywordsCase: 'Normalise keyword casing to lowercase (CodeCop AA0241)',
  fixIdentifiersCase: 'Normalise identifier and keyword casing (CodeCop AA0241)',
  formatDocument: 'Apply standard AL document formatting',
  addUsingRegion: 'Wrap using statements in a #region',
  updateUsingsList: 'Remove unused using statements',
};

// Need the symbol table (Base App / dependencies) loaded, so slower and richer.
export const METADATA_COMMANDS = {
  addDataClassification: 'Add missing DataClassification to fields (emits CustomerContent)',
  removeRedundantDataClassification: 'Remove DataClassification that matches the object default',
  addAppAreas: 'Add missing ApplicationArea to page controls and actions',
  removeRedundantAppAreas: 'Remove ApplicationArea that duplicates the object default',
  addTableDataCaptionFields: 'Add the DataCaptionFields property to tables',
  addDropDownFieldGroups: 'Add DropDown field groups',
  convertObjectIdsToNames: 'Replace numeric object IDs with object names',
  removeUnusedVariables: 'Remove variables that are declared but never referenced (CodeCop AA0137)',
  removeWith: 'Remove "with" statements, qualifying members explicitly (CodeCop AA0040 flags nested "with")',
  makeFlowFieldsReadOnly: 'Mark FlowFields as Editable = false',
  removeStrSubstNoFromError: 'Simplify Error(StrSubstNo(...)) into Error(...) (CodeCop AA0231)',
  addMissingCaseLines: 'Add missing case branches for enum values',
  addAllObjectsPermissions: 'Add permissions for every object in the project that is missing one',
  addReferencedTablesPermissions: 'Add tabledata permissions for referenced tables',
};

/**
 * Engine commands deliberately NOT exposed, and why.
 *
 * The engine offers ~50 commands; these are withheld because their output is wrong
 * or actively conflicts with house AL conventions. Not exposing them is stronger
 * than documenting a warning: an agent cannot misuse a tool it cannot see, and the
 * schema stays smaller. Each is one line away from being restored if the upstream
 * behaviour changes.
 *
 * Verified by direct test unless marked (inferred).
 *
 *   addFieldCaptions        Sets Caption to the field name verbatim, workspace prefix
 *                           included -- a field named "Contoso Freight Amount" gets
 *                           Caption = 'Contoso Freight Amount'. Captions must state
 *                           intent, and this leaks the prefix into the UI.
 *   addObjectCaptions       (inferred) same generator family as addFieldCaptions.
 *   addEnumCaptions         (inferred) same generator family.
 *   addPageControlCaptions  (inferred) same generator family.
 *   lockRemovedFieldsCaptions (inferred) same caption family.
 *
 *   addToolTips             Page-oriented: adds ToolTips to page fields and does
 *                           nothing on a table/tableextension. House convention puts
 *                           the ToolTip on the table field so every page inherits it.
 *   addTooTipsEndingDots    Operates on page-level ToolTips, same mismatch.
 *   refreshToolTips         Same.
 *   setPageFieldToolTip     Same.
 *
 *   sortPermissions         Sorts correctly but corrupts indentation: emits
 *                           "Permissions =         codeunit ... ," on the property
 *                           line and puts the second entry at column 0.
 *   sortPermissionSetList   (inferred) unverified and adjacent to the above defect.
 *
 * Note addAllObjectsPermissions IS exposed -- tested against a permission set missing
 * four codeunits, it added all four with correct indentation.
 */
export const EXCLUDED_COMMANDS = [
  'addFieldCaptions', 'addObjectCaptions', 'addEnumCaptions', 'addPageControlCaptions',
  'lockRemovedFieldsCaptions', 'addToolTips', 'addTooTipsEndingDots', 'refreshToolTips',
  'setPageFieldToolTip', 'sortPermissions', 'sortPermissionSetList',
];

const ALL_COMMANDS = { ...CLEANUP_COMMANDS, ...METADATA_COMMANDS };

// A workspace command walks the whole project, so the per-request default -- sized
// for one file -- does not apply. A 9-command pass over 624 files measures under a
// minute, but the expensive commands scale with the tree and a slow disk or a cold
// symbol cache moves that a lot. Generous on purpose: overshooting costs nothing on
// a run that succeeds, while undershooting means killing the engine mid-write.
const PROJECT_COMMAND_TIMEOUT_MS = Number(process.env.AL_MCP_PROJECT_TIMEOUT_MS ?? 15 * 60_000);

/** Render an enum's allowed values with descriptions, for the tool schema. */
function describeCommands(map) {
  return Object.entries(map).map(([k, v]) => `- ${k}: ${v}`).join('\n');
}

// Directories skipped when snapshotting. Everything else is walked, dot-directories
// included: the snapshot is what a dry run is rolled back from, so a file the engine
// writes but we never recorded stays modified afterwards. Each entry therefore has to
// earn its place by being somewhere AL project source cannot live -- VCS internals,
// AL build artifacts, or a JavaScript dependency tree. `bin` and `obj` were here too,
// but those are .NET conventions with no meaning to an AL project, and a hand-authored
// folder that happens to be called `bin` is likelier than a generated one.
const SNAPSHOT_SKIP_DIRS = new Set([
  '.git', '.alpackages', '.alcache', '.snapshots', '.coverage', '.output', 'node_modules',
]);

function listAlFilesForSnapshot(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SNAPSHOT_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      listAlFilesForSnapshot(join(dir, entry.name), acc);
    } else if (entry.name.toLowerCase().endsWith('.al')) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

/**
 * Normalise a path to this platform's native separators.
 *
 * The language server rejects forward-slash paths on Windows ("Workspace command
 * <x> error during processing file ..."), while Node's fs accepts them happily --
 * so an unnormalised path passes the existence check and then fails deep in the
 * engine with an opaque message. Agents and JSON configs routinely use forward
 * slashes, so normalise every path on the way in.
 */
function nativePath(p) {
  if (p === undefined || p === null) return p;
  const abs = resolve(p);
  // 8.3 short components ("C:\Users\PIOTR~1.GWO\...") are a second way to spell a
  // path the engine cannot match against its own file list: workspace commands come
  // back with a bare "Object reference not set to an instance of an object.".
  // realpathSync.native expands them to the long form. Only the existing prefix can
  // be resolved, so fall back to the plain absolute path.
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/**
 * Is `abs` inside `projectPath`?
 *
 * Not `relative(...).startsWith('..')` -- that also rejects a project-root file
 * legitimately named `..config.al`. Compare on a path separator boundary instead.
 */
function insideProject(projectPath, abs) {
  const rel = relative(projectPath, abs);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

// Projects with an al_project_cleanup pass in flight.
//
// Workspace mode writes to the whole tree and a dry run rolls it back from a
// snapshot, so anything else writing into the same project between those two moments
// gets silently reverted -- and clients do issue tool calls in parallel. One run per
// project at a time, and no single-file write across one.
const activeProjectRuns = new Set();

function resolveProject(filePath, explicit) {
  const projectPath = nativePath(explicit) || findProjectPath(filePath);
  if (!projectPath) {
    throw new Error(`Could not locate an AL project (no app.json found above ${filePath}). Pass projectPath explicitly.`);
  }
  return projectPath;
}

/** Shared implementation for al_cleanup and al_add_metadata. */
async function runTransform(server, args, allowed, toolName) {
  const { command, write = false, output = 'diff', projectPath: explicitProject } = args;
  if (!allowed[command]) {
    throw new Error(`Unknown command '${command}' for ${toolName}. Allowed: ${Object.keys(allowed).join(', ')}`);
  }
  if (!args.filePath) throw new Error('filePath is required');
  const filePath = nativePath(args.filePath);
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const projectPath = resolveProject(filePath, explicitProject);
  // A preview is fine mid-run (it only reads), but a write would land inside the
  // window a project dry run rolls back, and be reverted without a word.
  if (write && activeProjectRuns.has(projectPath)) {
    throw new Error(
      `al_project_cleanup is running over ${basename(projectPath)}; a write now would be rolled back by its restore. Retry when it finishes.`
    );
  }
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
        'Sort, reformat and mechanically fix one AL file -- members, casing, begin..end, empty lines, ' +
        'parentheses, formatting. Fixes CodeCop AA0005, AA0008, AA0021, AA0241, AA0477. Purely syntactic, so ' +
        'no symbol table and fast. Parses AL with the AZ AL Dev Tools Roslyn engine rather than editing text, ' +
        'so string literals, comments, #region scopes and attribute/doc-comment ownership survive. Returns a ' +
        'unified diff; does NOT write unless write:true.\n\n' +
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
        'Fix one AL file where real field names, name binding or the project-wide object list are needed: ' +
        'removes unused variables (CodeCop AA0137) and "with" statements (AA0040), simplifies ' +
        'Error(StrSubstNo(...)) (AA0231), adds ApplicationArea, DataClassification and permission-set ' +
        'entries. Despite the name it both adds and removes; the split from al_cleanup is that these load the ' +
        'symbol table (Base App and dependencies), so the first call costs ~4s. Returns a unified diff; does ' +
        'NOT write unless write:true.\n\n' +
        'Caption and ToolTip generators are withheld: they echo the field name, prefix included, and target ' +
        'page-field ToolTips (AA0218) rather than the table-field ToolTips (AA0234) pages inherit. Write that ' +
        'text yourself.\n\n' +
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
        'Apply any al_cleanup or al_add_metadata commands across a whole AL project in one pass. Use this ' +
        'rather than looping a per-file tool when a fix applies to more than one file -- it hands the file walk ' +
        'to the engine, which builds the semantic model once per command instead of once per file. Measured on ' +
        'a 624-file app, a 9-command pass takes ~28s this way against ~100min looping per file.\n\n' +
        'Pass includeFiles to scope the run (e.g. just the files in your diff); omit it for the whole project. ' +
        'Reports which files changed, with per-file line counts.\n\n' +
        'dryRun (the default) reports without leaving changes behind, but it is not a read-only operation: the ' +
        'engine only writes to disk, so a dry run writes and then restores the original contents from an ' +
        'in-memory snapshot. Run it on a clean git working tree. mtimes of files that would change are bumped.',
      inputSchema: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: { type: 'string', enum: Object.keys(ALL_COMMANDS) },
            description: 'Commands to apply, in order. Each runs once across the whole file set.',
          },
          projectPath: { type: 'string', description: 'AL project root containing app.json.' },
          includeFiles: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Restrict the run to these .al files (absolute, or relative to projectPath). Omit to process ' +
              'every .al file in the project. Use it to clean only the files you changed. Passing an empty ' +
              'array selects nothing and does nothing -- it is not the same as omitting it.',
          },
          excludeFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Skip these .al files (absolute, or relative to projectPath).',
          },
          dryRun: { type: 'boolean', description: 'Report, then restore the original contents. Default true.', default: true },
        },
        required: ['commands', 'projectPath'],
      },
      handler: async (args) => {
        const { commands, dryRun = true } = args;
        const projectPath = nativePath(args.projectPath);
        if (!Array.isArray(commands) || commands.length === 0) throw new Error('commands must be a non-empty array');
        for (const c of commands) if (!ALL_COMMANDS[c]) throw new Error(`Unknown command '${c}'`);
        if (!existsSync(join(projectPath, 'app.json'))) throw new Error(`No app.json in ${projectPath} -- not an AL project root.`);

        const asList = (list, label) => {
          if (list === undefined || list === null) return undefined;
          if (!Array.isArray(list)) throw new Error(`${label} must be an array of file paths`);
          return list;
        };

        // An explicitly empty includeFiles means "these files, and there are none of
        // them" -- the shape a caller lands on the day its diff comes back empty.
        // Folding it into undefined would turn that into "the whole project", which is
        // the one interpretation nobody asking for a scoped run could want.
        const requested = asList(args.includeFiles, 'includeFiles');
        if (requested && requested.length === 0) {
          return { text: `Nothing to do: includeFiles was empty, so no files were selected in ${basename(projectPath)}.` };
        }

        // The two lists are matched differently by the engine, and getting either wrong
        // fails silently rather than erroring -- hence the normalisation here.
        //
        // includeFiles: absolute native paths, compared against the engine's own file
        // list (this is what the VS Code extension sends for "uncommitted files").
        const includeFiles = requested?.map((f) => {
          const abs = nativePath(isAbsolute(f) ? f : join(projectPath, f));
          if (!existsSync(abs)) throw new Error(`includeFiles entry not found: ${f}`);
          // Both of these matter because the engine drops an entry it cannot match
          // without complaining: one bad path quietly shrinks the run, and a list of
          // them turns it into a no-op reported as a success over N "selected" files.
          if (!insideProject(projectPath, abs)) throw new Error(`includeFiles entry is outside the project: ${f}`);
          if (!abs.toLowerCase().endsWith('.al')) throw new Error(`includeFiles entry is not a .al file: ${f}`);
          return abs;
        });

        // excludeFiles: project-relative, forward slashes. Absolute paths and
        // backslash-separated paths are accepted and then quietly ignored, so anything
        // that is not already a glob gets rewritten into the one form that works.
        // An empty list here is simply "exclude nothing" -- it widens nothing.
        const excluded = asList(args.excludeFiles, 'excludeFiles');
        const excludeFiles = excluded?.length ? excluded.map((f) => {
          if (f.includes('*')) return f; // glob: the engine's own matcher handles it
          const abs = nativePath(isAbsolute(f) ? f : join(projectPath, f));
          if (!existsSync(abs)) throw new Error(`excludeFiles entry not found: ${f}`);
          if (!insideProject(projectPath, abs)) throw new Error(`excludeFiles entry is outside the project: ${f}`);
          return relative(projectPath, abs).split('\\').join('/');
        }) : undefined;

        // One pass per project at a time. Taken after validation, so a rejected call
        // never leaves the project locked.
        if (activeProjectRuns.has(projectPath)) {
          throw new Error(`al_project_cleanup is already running over ${basename(projectPath)}. Wait for it to finish.`);
        }
        activeProjectRuns.add(projectPath);

        try {
          // Workspace mode writes straight to disk and reports only a count, so the
          // before/after contents needed for a diff -- and for undoing a dry run --
          // have to come from a snapshot taken here. 624 files of AL is ~1MB; cheap.
          //
          // Kept as raw bytes rather than decoded text. AL sources are meant to be
          // UTF-8, but a legacy file saved in an ANSI codepage decodes to U+FFFD
          // replacement characters, and writing that string back does not restore the
          // file -- it rewrites it, lossily, as the very operation promising to leave
          // it alone. Bytes in, bytes out, and the comparison is exact for free.
          const snapshot = new Map();
          for (const file of listAlFilesForSnapshot(projectPath)) {
            try { snapshot.set(file, readFileSync(file)); } catch { /* unreadable: not ours to restore */ }
          }

          // Files the engine added. Recomputed on demand rather than passed in: a
          // rollback from the `finally` has no diff pass behind it to have listed them.
          const listCreated = () => {
            try { return listAlFilesForSnapshot(projectPath).filter((f) => !snapshot.has(f)); } catch { return []; }
          };

          const restore = () => {
            let restored = 0;
            let removed = 0;
            for (const [file, original] of snapshot) {
              let current;
              try { current = readFileSync(file); } catch { /* gone, or unreadable */ }
              // Only rewrite what actually differs -- restoring every file would bump
              // mtimes across the project and invalidate downstream review markers.
              if (current?.equals(original)) continue;
              try {
                // A deleted file is a changed file. Treating ENOENT as "nothing to do"
                // would leave the rollback quietly incomplete, so put it back, and its
                // directory with it.
                if (current === undefined) mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, original);
                restored++;
              } catch { /* unwritable: nothing further we can do */ }
            }
            // A file the engine added is part of what the run did, so undoing the run
            // undoes it too. Safe to delete unconditionally only because the project
            // is held exclusively for the duration.
            for (const file of listCreated()) {
              try { rmSync(file); removed++; } catch { /* already gone */ }
            }
            return { restored, removed };
          };

          const failed = [];
          let abandoned;
          let settled = false;
          try {
            for (const command of commands) {
              try {
                await server.workspaceCommand({
                  command, source: '', projectPath, filePath: undefined, includeFiles, excludeFiles,
                  timeoutMs: PROJECT_COMMAND_TIMEOUT_MS,
                });
              } catch (e) {
                failed.push({ command, error: e.message });
                if (e.code === 'ETIMEDOUT') {
                  // Giving up on the response does not stop the engine: it still holds
                  // the project and is still writing into it, so diffing or rolling
                  // back around it would race. Kill the process first -- a file left
                  // half-written by the kill is one the snapshot can put back -- then
                  // abandon the remaining commands.
                  abandoned = command;
                  server.stop(`timed out running '${command}'`);
                  break;
                }
              }
            }

            const changed = [];
            for (const [file, before] of snapshot) {
              let after;
              try { after = readFileSync(file); } catch { continue; }
              if (after.equals(before)) continue;
              // Decoding is safe here: the line counts are for the report only, and
              // the bytes the restore uses are untouched by it.
              changed.push({
                file: relative(projectPath, file),
                ...diffStats(before.toString('utf8'), after.toString('utf8')),
              });
            }
            const created = listCreated();

            const rolledBack = dryRun ? restore() : undefined;
            settled = true;

            const scope = includeFiles ? `${includeFiles.length} selected file(s)` : `${snapshot.size} file(s)`;
            const lines = [
              `${dryRun ? 'Dry run' : 'Applied'}: [${commands.join(', ')}] over ${scope} in ${basename(projectPath)}.`,
              `${changed.length} file(s) ${dryRun ? 'would change' : 'changed'}.`,
            ];
            if (changed.length) {
              lines.push('');
              changed.sort((a, b) => a.file.localeCompare(b.file));
              for (const c of changed) lines.push(`  ${c.file}  +${c.added}/-${c.removed}`);
            }
            if (created.length) {
              lines.push('', dryRun
                ? `${created.length} new .al file(s) were created and removed again by the rollback:`
                : `NOTE: ${created.length} new .al file(s) appeared and were left in place:`);
              for (const f of created.slice(0, 20)) lines.push(`  ${relative(projectPath, f)}`);
              if (created.length > 20) lines.push(`  ...and ${created.length - 20} more`);
            }
            if (failed.length) {
              lines.push('', `${failed.length} command(s) failed:`);
              for (const f of failed) lines.push(`  [${f.command}]: ${f.error}`);
            }
            if (abandoned) {
              const skipped = commands.slice(commands.indexOf(abandoned) + 1);
              lines.push('', `ABANDONED after '${abandoned}' timed out. The language server was stopped mid-command to`);
              lines.push('stop it writing; it restarts on the next call.');
              if (skipped.length) lines.push(`Not run: ${skipped.join(', ')}.`);
              lines.push(dryRun
                ? `Rollback still ran: ${rolledBack.restored} file(s) restored${rolledBack.removed ? `, ${rolledBack.removed} removed` : ''}. Confirm with git status.`
                : 'The project is left PARTIALLY transformed. Review with git diff before going further.');
            }
            if (dryRun && changed.length && !abandoned) lines.push('', 'Pass dryRun: false to write these changes.');
            return { text: lines.join('\n') };
          } finally {
            // A throw after the engine has already written would otherwise leave a
            // "dry" run's changes on disk.
            if (dryRun && !settled) {
              const { restored, removed } = restore();
              if (restored || removed) {
                server.log?.(`rolled back a failed dry run: ${restored} file(s) restored, ${removed} removed`);
              }
            }
          }
        } finally {
          activeProjectRuns.delete(projectPath);
        }
      },
    },

    {
      name: 'al_find_duplicates',
      description:
        'Find duplicated code blocks across an AL project using the AZ AL Dev Tools duplicate-code ' +
        'detector. Compares parsed statement structure rather than text, so it catches clones that differ ' +
        'in naming and formatting. Use it before a refactor, or to locate extract-to-procedure candidates.',
      annotations: { title: 'Find duplicated AL code', readOnlyHint: true },
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
        const { minNoOfStatements = 10, skipObsoleteCodeLevel = 0, maxGroups = 40 } = args;
        const projectPath = nativePath(args.projectPath);
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
        'Get a compact structural outline of one AL file -- objects, fields, procedures, triggers, controls, ' +
        'actions, each with its line number. Call this before reading a large AL object, then read only the ' +
        'lines you need. Parses the file as it exists on disk, so unlike symbol- or package-based lookups it ' +
        'reflects uncommitted edits and objects that do not compile yet.',
      annotations: { title: 'Outline an AL file', readOnlyHint: true },
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
        const { includeProperties = false } = args;
        const filePath = nativePath(args.filePath);
        if (!filePath) throw new Error('filePath is required');
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
