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
//   - an empty includeFiles narrows to nothing rather than widening to everything
//   - the restore puts original bytes back, not a re-encoding of them
//   - bad input is rejected before anything is written
//   - one run per project, and no single-file write across one
//   - the rollback covers files the engine deleted or created, not just edited
//   - a timed-out command stops the engine instead of racing its writes
//
// The rollback and timeout cases run against a stub server rather than the engine:
// none of the exposed commands delete a file or hang on demand, and a test that
// cannot provoke the failure it names is not testing anything.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DevToolsServer } from '../src/devtools.js';
import { buildTools } from '../src/tools.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const realTools = buildTools(server);
const tool = realTools.find((t) => t.name === 'al_project_cleanup');
const fileTool = realTools.find((t) => t.name === 'al_cleanup');
const CMDS = ['fixKeywordsCase', 'removeBeginEnd', 'sortProcedures'];

/**
 * al_project_cleanup wired to a fake engine.
 *
 * The handler only ever asks the server to run a command, to log, and to stop, so a
 * stub covers every path the real engine cannot be made to take on demand: deleting
 * a file, creating one, or hanging until the request times out.
 */
function stubbed({ onCommand, onStop }) {
  const calls = [];
  const srv = {
    workspaceCommand: async (req) => { calls.push(req); return onCommand?.(req) ?? {}; },
    log: () => {},
    stop: (reason) => { calls.push({ stopped: reason }); onStop?.(reason); },
  };
  return { calls, tool: buildTools(srv).find((t) => t.name === 'al_project_cleanup') };
}

const timeout = () => { const e = new Error('Timed out after 1ms waiting for al/workspacecommand'); e.code = 'ETIMEDOUT'; throw e; };

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

  // An empty includeFiles is what a caller scoping to "the files in my diff" produces
  // on the day the diff is empty. Treating it as "unscoped" would rewrite the whole
  // project, so the no-op is asserted with dryRun off, where getting it wrong is
  // unrecoverable.
  header('an empty includeFiles selects nothing, not everything');
  reset();
  r = await tool.handler({ commands: CMDS, projectPath: root, dryRun: false, includeFiles: [] });
  check('F1 untouched', readFileSync(F1, 'utf8') === M1);
  check('F2 untouched', readFileSync(F2, 'utf8') === M2);
  check('says nothing was selected', /Nothing to do: includeFiles was empty/.test(r.text), r.text);
  // The asymmetry is the point: an empty exclusion list excludes nothing, which is
  // already the unscoped run, so it must not short-circuit the way include does.
  reset();
  r = await tool.handler({ commands: CMDS, projectPath: root, dryRun: false, excludeFiles: [] });
  check('an empty excludeFiles still runs', /^2 file\(s\) changed/m.test(r.text), r.text);

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
  // Has to exist, or the containment check is never reached and the case passes on
  // the not-found branch instead -- proving nothing about where the file lives.
  const OUTSIDER = join(scratch, 'elsewhere.al');
  writeFileSync(OUTSIDER, 'codeunit 50999 "Outside" { }\n', 'utf8');
  for (const [label, args] of [
    ['unknown command', { commands: ['notARealCommand'], projectPath: root }],
    ['empty commands', { commands: [], projectPath: root }],
    ['commands not an array', { commands: 'fixKeywordsCase', projectPath: root }],
    ['missing includeFiles entry', { commands: CMDS, projectPath: root, includeFiles: ['src/Nope.al'] }],
    ['includeFiles not an array', { commands: CMDS, projectPath: root, includeFiles: 'src/Probe0.Codeunit.al' }],
    // The engine ignores an unmatched includeFiles entry in silence, so an unchecked
    // one shrinks the run -- or empties it, and still reports N "selected" files.
    ['includeFiles outside project', { commands: CMDS, projectPath: root, includeFiles: [OUTSIDER] }],
    ['includeFiles not a .al file', { commands: CMDS, projectPath: root, includeFiles: ['app.json'] }],
    ['excludeFiles outside project', { commands: CMDS, projectPath: root, excludeFiles: [OUTSIDER] }],
    ['not an AL project root', { commands: CMDS, projectPath: scratch }],
  ]) {
    let threw = false;
    try { await tool.handler(args); } catch { threw = true; }
    check(`${label} rejected`, threw);
  }
  check('nothing written while rejecting', readFileSync(F1, 'utf8') === M1 && readFileSync(F2, 'utf8') === M2);

  // "Outside the project" has to be decided on a path separator, not on a `..`
  // prefix: `relative()` returns `..odd.al` for a root-level file of that name, and
  // a string-prefix test rejects it as an escape attempt.
  header('a leading-dots filename is not mistaken for an escape');
  reset();
  const ODD = join(root, '..odd.al');
  writeFileSync(ODD, 'CODEUNIT 50099 "Odd"\n{\n}\n', 'utf8');
  let oddErr = '';
  try {
    await tool.handler({ commands: CMDS, projectPath: root, dryRun: true, excludeFiles: ['..odd.al'] });
  } catch (e) { oddErr = e.message; }
  check('..odd.al accepted as a project-relative exclude', oddErr === '', oddErr);
  rmSync(ODD);

  // -------------------------------------------------------- encoding fidelity
  //
  // The restore path is the only thing standing between a dry run and a modified
  // tree, so it has to put the original *bytes* back, not a re-encoding of them.
  // A source saved in a legacy ANSI codepage decodes to U+FFFD replacements, and
  // writing that back corrupts the file irreversibly -- while reporting success.
  //
  // Both probes are deliberately dirty AL, and the assertion that each is reported
  // as would-change is load-bearing: it proves the engine really rewrote the file
  // and the restore really ran, rather than the bytes surviving untouched.
  header('a dry run restores non-UTF-8 and BOM files byte-for-byte');
  const encRoot = join(scratch, 'encoding');
  makeProject(encRoot, 0);
  const dirty = (name) => `CODEUNIT 50000 "${name}"
{
    PROCEDURE A()
    VAR
        n: Integer;
    BEGIN
        IF n > 1 THEN
        BEGIN
            n := 1;
        END;
    END;
}
`;
  // "Zazolc" with cp1250 diacritics -- valid Windows-1250, invalid UTF-8.
  const ansiFile = join(encRoot, 'src', 'Ansi.Codeunit.al');
  writeFileSync(ansiFile, Buffer.concat([
    Buffer.from('// Za'), Buffer.from([0xbf, 0xf3, 0xb3, 0xe6]), Buffer.from('\n'),
    Buffer.from(dirty('Ansi'), 'utf8'),
  ]));
  const bomFile = join(encRoot, 'src', 'Bom.Codeunit.al');
  writeFileSync(bomFile, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(dirty('Bom').replace('50000', '50001'), 'utf8'),
  ]));

  const ansiBefore = readFileSync(ansiFile);
  const bomBefore = readFileSync(bomFile);
  r = await tool.handler({ commands: CMDS, projectPath: encRoot, dryRun: true });
  check('the ANSI file was rewritten by the engine', r.text.includes('Ansi.Codeunit.al'), r.text);
  check('the BOM file was rewritten by the engine', r.text.includes('Bom.Codeunit.al'), r.text);
  check('ANSI file restored byte-for-byte', readFileSync(ansiFile).equals(ansiBefore),
    `${ansiBefore.length} -> ${readFileSync(ansiFile).length} bytes`);
  check('BOM file restored byte-for-byte', readFileSync(bomFile).equals(bomBefore),
    `${bomBefore.length} -> ${readFileSync(bomFile).length} bytes`);

  // ------------------------------------------------------------ exclusive access
  //
  // A dry run rolls the tree back from a snapshot, so anything else writing into the
  // project between snapshot and restore is silently reverted. Clients do issue tool
  // calls in parallel, so the window has to be closed rather than documented.
  header('a project run holds the project exclusively');
  reset();
  const slow = stubbed({ onCommand: () => sleep(150) });
  const inFlight = slow.tool.handler({ commands: CMDS, projectPath: root, dryRun: true });

  let secondErr = '';
  try { await tool.handler({ commands: CMDS, projectPath: root, dryRun: true }); } catch (e) { secondErr = e.message; }
  check('a second project run is refused', /already running/.test(secondErr), secondErr);

  let writeErr = '';
  try {
    await fileTool.handler({ command: 'fixKeywordsCase', filePath: F1, projectPath: root, write: true });
  } catch (e) { writeErr = e.message; }
  check('a single-file write is refused', /rolled back by its restore/.test(writeErr), writeErr);

  // The guard must not be broader than the hazard: a preview writes nothing, so it
  // has no reason to be blocked.
  let previewErr = '';
  try {
    await fileTool.handler({ command: 'fixKeywordsCase', filePath: F1, projectPath: root, write: false });
  } catch (e) { previewErr = e.message; }
  check('a preview is not blocked', !/already running|rolled back by its restore/.test(previewErr), previewErr);

  await inFlight;
  r = await tool.handler({ commands: CMDS, projectPath: root, dryRun: true });
  check('the lock is released when the run ends', /^2 file\(s\) would change/m.test(r.text), r.text);

  // ------------------------------------------------------- rollback completeness
  header('a dry run rolls back deletions and creations, not just edits');
  reset();
  const NEWFILE = join(root, 'src', 'Spawned.Codeunit.al');
  const mutate = stubbed({
    onCommand: () => {
      if (existsSync(F2)) rmSync(F2);                                     // engine deleted a file
      writeFileSync(NEWFILE, 'codeunit 50098 "Spawned" { }\n', 'utf8');   // and added one
      writeFileSync(F1, M1.toLowerCase(), 'utf8');                        // and edited one
    },
  });
  r = await mutate.tool.handler({ commands: ['fixKeywordsCase'], projectPath: root, dryRun: true });
  check('the deleted file is back', existsSync(F2) && readFileSync(F2, 'utf8') === M2);
  check('the edited file is back', readFileSync(F1, 'utf8') === M1);
  check('the created file is gone', !existsSync(NEWFILE));
  check('the report mentions the rollback of the new file', /created and removed again/.test(r.text), r.text);

  header('an apply keeps what the engine created');
  reset();
  r = await mutate.tool.handler({ commands: ['fixKeywordsCase'], projectPath: root, dryRun: false });
  check('the created file survives', existsSync(NEWFILE));
  check('the report says it was left in place', /left in place/.test(r.text), r.text);
  rmSync(NEWFILE);
  reset();

  // ------------------------------------------------------------------- timeouts
  //
  // Abandoning the *request* does not abandon the command: the engine still holds the
  // project and is still writing into it, so diffing or restoring around it races.
  header('a timed-out command stops the engine and abandons the rest');
  reset();
  const hung = stubbed({
    onCommand: (req) => {
      writeFileSync(F1, M1.toLowerCase(), 'utf8'); // it got some writing done first
      if (req.command === 'removeBeginEnd') timeout();
    },
  });
  r = await hung.tool.handler({ commands: CMDS, projectPath: root, dryRun: true });
  const issued = hung.calls.filter((c) => c.command).map((c) => c.command);
  check('commands after the timeout are not issued', issued.join() === 'fixKeywordsCase,removeBeginEnd', issued.join());
  check('the server was stopped', hung.calls.some((c) => c.stopped), JSON.stringify(hung.calls.map((c) => c.stopped)));
  check('the report says it was abandoned', /ABANDONED after 'removeBeginEnd'/.test(r.text), r.text);
  check('the report names what did not run', /Not run: sortProcedures/.test(r.text), r.text);
  check('the rollback still ran', readFileSync(F1, 'utf8') === M1);

  header('a timed-out apply warns instead of pretending to be clean');
  reset();
  r = await hung.tool.handler({ commands: CMDS, projectPath: root, dryRun: false });
  check('says the project is partially transformed', /PARTIALLY transformed/.test(r.text), r.text);
  check('the write is left in place', readFileSync(F1, 'utf8') === M1.toLowerCase());

  // The rollback lives in a `finally` so that an unexpected throw after the engine has
  // written still undoes a dry run. A stop() that throws is the reachable version of
  // that: killing a process is not guaranteed to succeed.
  header('an unexpected throw mid-run still rolls a dry run back');
  reset();
  const brokenStop = stubbed({
    onCommand: () => { writeFileSync(F1, M1.toLowerCase(), 'utf8'); timeout(); },
    onStop: () => { throw new Error('kill failed'); },
  });
  let threw = false;
  try { await brokenStop.tool.handler({ commands: CMDS, projectPath: root, dryRun: true }); } catch { threw = true; }
  check('the failure is reported, not swallowed', threw);
  check('the tree is rolled back anyway', readFileSync(F1, 'utf8') === M1);
  let afterErr = '';
  try { await tool.handler({ commands: CMDS, projectPath: root, dryRun: true }); } catch (e) { afterErr = e.message; }
  check('the lock is released even when the run throws', !/already running/.test(afterErr), afterErr);

  // --------------------------------------------------------------- server budget
  //
  // The idle timer is armed when a request is *sent*, so before this it would fire
  // partway through a single long command and kill the engine mid-write.
  header('the idle timer waits for outstanding requests');
  const idle = new DevToolsServer({ idleTimeoutMs: 60, log: () => {} });
  let stops = 0;
  idle.stop = () => { stops++; };
  idle.pending.set(1, { resolve() {}, reject() {}, timer: setTimeout(() => {}, 0) });
  idle._resetIdleTimer();
  await sleep(300);
  check('does not fire while a request is outstanding', stops === 0, `${stops} stop(s)`);
  idle.pending.clear();
  await sleep(300);
  check('fires once nothing is outstanding', stops > 0, `${stops} stop(s)`);
  clearTimeout(idle.idleTimer);

  header('a timed-out request is tagged so callers can tell it apart');
  const impatient = new DevToolsServer({ idleTimeoutMs: 0, requestTimeoutMs: 1, log: () => {} });
  let code;
  try { await impatient.request('al/gettableslist', { path: root }); } catch (e) { code = e.code; }
  check('error carries code ETIMEDOUT', code === 'ETIMEDOUT', String(code));
  impatient.stop('test done');

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
