#!/usr/bin/env node
// Tests for al_project_cleanup's workspace-mode pass.
//
// Self-contained: builds throwaway AL projects under the OS temp directory, so it needs
// no target repo and writes nothing outside its own scratch space. Only syntactic
// commands are used -- they need no symbol packages, which keeps this runnable anywhere
// the two extensions are installed.
//
// What is actually at risk here, and therefore what is asserted:
//   - workspace mode writes (the engine, not us, does the walking)
//   - a dry run restores every file byte-for-byte, at scale
//   - includeFiles/excludeFiles really scope the run -- the engine matches them in two
//     different formats and ignores a wrong one silently, so a passing assertion is the
//     only thing standing between us and a no-op
//   - bad input is rejected before anything is written

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DevToolsServer } from '../src/devtools.js';
import { buildTools } from '../src/tools.js';

let pass = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

function header(t) {
  console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Build a throwaway AL project of `n` deliberately messy codeunits. */
function makeProject(root, n) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'app.json'), JSON.stringify({
    id: 'f0000000-0000-4000-8000-00000000000a',
    name: 'ProjectCleanupTest', publisher: 'Test', version: '1.0.0.0',
    platform: '25.0.0.0', application: '25.0.0.0', runtime: '14.0',
    idRanges: [{ from: 50000, to: 50000 + Math.max(n, 1) }],
  }, null, 2), 'utf8');

  const files = [];
  for (let i = 0; i < n; i++) {
    const p = join(root, 'src', `Probe${i}.Codeunit.al`);
    // Uppercase keywords (fixKeywordsCase), a redundant begin..end (removeBeginEnd),
    // and Zeta before Alpha (sortProcedures).
    writeFileSync(p, `CODEUNIT ${50000 + i} "Probe ${i}"
{
    PROCEDURE Zeta()
    VAR
        n: Integer;
    BEGIN
        IF n > ${i} THEN
        BEGIN
            n := n + 1;
        END;
    END;

    PROCEDURE Alpha()
    BEGIN
        Message('probe ${i}');
    END;
}
`, 'utf8');
    files.push(p);
  }
  return files;
}

const scratch = mkdtempSync(join(tmpdir(), 'al-devtools-test-'));
const server = new DevToolsServer({ idleTimeoutMs: 0, requestTimeoutMs: 900_000, log: () => {} });
const tool = buildTools(server).find((t) => t.name === 'al_project_cleanup');
const CMDS = ['fixKeywordsCase', 'removeBeginEnd', 'sortProcedures'];

try {
  // ---------------------------------------------------------------- small project
  const root = join(scratch, 'small');
  const [F1, F2] = makeProject(root, 2);
  const M1 = readFileSync(F1, 'utf8');
  const M2 = readFileSync(F2, 'utf8');
  const reset = () => { writeFileSync(F1, M1, 'utf8'); writeFileSync(F2, M2, 'utf8'); };

  header('dryRun restores, and reports what it would have done');
  let r = await tool.handler({ commands: CMDS, projectPath: root, dryRun: true });
  check('F1 restored byte-for-byte', readFileSync(F1, 'utf8') === M1);
  check('F2 restored byte-for-byte', readFileSync(F2, 'utf8') === M2);
  check('reports 2 files would change', /^2 file\(s\) would change/m.test(r.text), r.text);
  check('names both files', r.text.includes('Probe0.Codeunit.al') && r.text.includes('Probe1.Codeunit.al'));

  header('dryRun: false writes, and the transform is correct');
  reset();
  r = await tool.handler({ commands: CMDS, projectPath: root, dryRun: false });
  const applied = readFileSync(F1, 'utf8');
  check('reports 2 files changed', /^2 file\(s\) changed/m.test(r.text), r.text);
  check('keywords lowercased', applied.includes('codeunit 50000') && applied.includes('procedure Zeta'));
  check('redundant begin..end removed', !applied.includes('then begin'), JSON.stringify(applied));
  check('procedures sorted (Alpha before Zeta)', applied.indexOf('procedure Alpha') < applied.indexOf('procedure Zeta'));

  header('includeFiles scopes the run');
  reset();
  r = await tool.handler({ commands: CMDS, projectPath: root, dryRun: false, includeFiles: [F1] });
  check('included file changed', readFileSync(F1, 'utf8') !== M1);
  check('unlisted file untouched', readFileSync(F2, 'utf8') === M2);
  check('scope reported as selected', /1 selected file/.test(r.text), r.text);

  header('includeFiles accepts project-relative paths');
  reset();
  await tool.handler({ commands: CMDS, projectPath: root, dryRun: false, includeFiles: ['src/Probe0.Codeunit.al'] });
  check('relative include changed F1', readFileSync(F1, 'utf8') !== M1);
  check('relative include left F2 alone', readFileSync(F2, 'utf8') === M2);

  // The engine wants project-relative forward slashes here and silently ignores an
  // absolute path, so this asserts the normalisation, not just the plumbing.
  header('excludeFiles skips a file, given an absolute path');
  reset();
  await tool.handler({ commands: CMDS, projectPath: root, dryRun: false, excludeFiles: [F2] });
  check('non-excluded file changed', readFileSync(F1, 'utf8') !== M1);
  check('excluded file untouched', readFileSync(F2, 'utf8') === M2, JSON.stringify(readFileSync(F2, 'utf8').slice(0, 40)));

  header('a second run over clean code is a no-op');
  r = await tool.handler({ commands: CMDS, projectPath: root, dryRun: false });
  const settled = readFileSync(F1, 'utf8');
  r = await tool.handler({ commands: CMDS, projectPath: root, dryRun: false });
  check('reports 0 files changed', /^0 file\(s\) changed/m.test(r.text), r.text);
  check('file unchanged', readFileSync(F1, 'utf8') === settled);

  header('invalid input is rejected before anything is written');
  reset();
  for (const [label, args] of [
    ['unknown command', { commands: ['notARealCommand'], projectPath: root }],
    ['empty commands', { commands: [], projectPath: root }],
    ['commands not an array', { commands: 'fixKeywordsCase', projectPath: root }],
    ['missing includeFiles entry', { commands: CMDS, projectPath: root, includeFiles: ['src/Nope.al'] }],
    ['includeFiles not an array', { commands: CMDS, projectPath: root, includeFiles: 'src/Probe0.Codeunit.al' }],
    ['excludeFiles outside project', { commands: CMDS, projectPath: root, excludeFiles: [join(scratch, 'elsewhere.al')] }],
    ['not an AL project root', { commands: CMDS, projectPath: scratch }],
  ]) {
    let threw = false;
    try { await tool.handler(args); } catch { threw = true; }
    check(`${label} rejected`, threw);
  }
  check('nothing written while rejecting', readFileSync(F1, 'utf8') === M1 && readFileSync(F2, 'utf8') === M2);

  // ---------------------------------------------------------------- scale
  header('scale: 400 dirty files, dry run restores every one');
  const bigRoot = join(scratch, 'big');
  const bigFiles = makeProject(bigRoot, 400);
  const before = new Map(bigFiles.map((p) => [p, sha(readFileSync(p, 'utf8'))]));

  const started = Date.now();
  r = await tool.handler({ commands: CMDS, projectPath: bigRoot, dryRun: true });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const notRestored = bigFiles.filter((p) => sha(readFileSync(p, 'utf8')) !== before.get(p));
  check('every file restored', notRestored.length === 0, `${notRestored.length} left modified`);
  check('reports all 400 would change', /^400 file\(s\) would change/m.test(r.text), r.text.split('\n')[1]);
  console.log(`  (400 files x ${CMDS.length} commands, dry run: ${secs}s)`);

  header('scale: apply writes all 400');
  await tool.handler({ commands: CMDS, projectPath: bigRoot, dryRun: false });
  const changed = bigFiles.filter((p) => sha(readFileSync(p, 'utf8')) !== before.get(p)).length;
  check('400 files changed on disk', changed === 400, `${changed} changed`);
} finally {
  server.stop('test done');
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${'='.repeat(72)}`);
console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
