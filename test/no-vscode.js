// Prove the server works with VS Code completely closed.
//
// Why this test exists: the AZ AL Dev Tools *extension* starts its own copy of the
// language server on activation (onLanguage:al / workspaceContains:app.json), so it
// is reasonable to suspect this project depends on VS Code running. It does not --
// it spawns its own copy of the same binary. That is easy to assert but harder to
// believe, so this test refuses to run unless VS Code is actually gone.
//
// Usage (from a plain terminal, NOT VS Code's integrated one):
//   node test/no-vscode.js "C:/path/to/AL/project"
//
// Read-only: every call is preview / dryRun.

import { spawn, execSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, relative, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(join(here, '..', 'src', 'index.js'));

let failures = 0;
const pass = (m) => console.log(`  [PASS]  ${m}`);
const fail = (m) => { failures++; console.log(`  [FAIL]  ${m}`); };
const info = (m) => console.log(`          ${m}`);
const hdr = (s) => console.log('\n' + '='.repeat(72) + `\n${s}\n` + '='.repeat(72));

function psCount(name) {
  try {
    return parseInt(execSync(
      `powershell -NoProfile -Command "(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Measure-Object).Count"`,
      { encoding: 'utf8' }).trim(), 10);
  } catch { return -1; }
}

function alServerProcs() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'AZALDevToolsServer.NetCore.exe'\\" | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter \\"ProcessId = $($_.ParentProcessId)\\" -EA SilentlyContinue; '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $(if($p){$p.Name}else{'dead'}) }"`,
      { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [pid, ppid, parent] = l.trim().split('|');
      return { pid: +pid, ppid: +ppid, parent };
    });
  } catch { return []; }
}

// ---------------------------------------------------------------- preconditions
hdr('Preconditions -- VS Code must be closed');

if (process.platform !== 'win32') {
  console.log('This test\'s process assertions are Windows-only.');
  process.exit(1);
}

for (const name of ['Code', 'Code - Insiders']) {
  const n = psCount(name);
  if (n > 0) {
    fail(`${n} ${name}.exe process(es) still running`);
    info('Close VS Code completely (all windows) and re-run from a plain terminal.');
    info('If you are running this in VS Code\'s integrated terminal, that is why.');
    process.exit(1);
  }
}
pass('No VS Code process running');

const preexisting = alServerProcs();
if (preexisting.length > 0) {
  fail(`${preexisting.length} AZALDevToolsServer process(es) already running: ${preexisting.map((p) => `${p.pid}(parent ${p.parent})`).join(', ')}`);
  info('Something else is holding one. Kill them, then re-run so the test starts clean.');
  process.exit(1);
}
pass('No pre-existing AZALDevToolsServer process');

// ---------------------------------------------------------------- target project
const PROJECT = process.argv[2] && resolve(process.argv[2]);
if (!PROJECT || !existsSync(join(PROJECT, 'app.json'))) {
  fail(`Pass a folder containing app.json. Got: ${PROJECT || '(nothing)'}`);
  process.exit(1);
}
pass(`Target project: ${PROJECT}`);

function alFiles(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) alFiles(p, acc);
    else if (e.name.toLowerCase().endsWith('.al')) acc.push(p);
  }
  return acc;
}
const files = alFiles(PROJECT);
if (files.length === 0) { fail('No .al files in project'); process.exit(1); }
pass(`${files.length} .al file(s) found`);

// ---------------------------------------------------------------- MCP client
const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AL_MCP_VERBOSE: '1' },
});
let buf = '', nextId = 1;
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('          | ' + d));

const send = (method, params) => {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 240_000);
  });
};
const call = async (name, args) => {
  const r = await send('tools/call', { name, arguments: args });
  return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error), isError: !!r.result?.isError };
};

(async () => {
  hdr('MCP handshake with VS Code absent');
  const init = await send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'no-vscode-test', version: '0' },
  });
  init.result?.serverInfo ? pass(`Handshake: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`) : fail('No handshake');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await send('tools/list', {});
  const tools = list.result?.tools || [];
  tools.length === 5 ? pass(`tools/list returned ${tools.length} tools`) : fail(`Expected 5 tools, got ${tools.length}`);

  hdr('Tool calls with VS Code absent');

  // outline
  let t0 = Date.now();
  let r = await call('al_outline', { filePath: files[0] });
  const outlineLines = r.text.split('\n').length;
  !r.isError && outlineLines > 3
    ? pass(`al_outline: ${outlineLines} lines of structure in ${Date.now() - t0}ms (cold start included)`)
    : fail(`al_outline: ${r.text.slice(0, 200)}`);

  // the definitive process check -- must be OUR child
  hdr('Process provenance');
  const during = alServerProcs();
  if (during.length === 0) {
    fail('No AZALDevToolsServer running, yet calls succeeded -- unexplained');
  } else {
    for (const p of during) info(`AZALDevToolsServer PID ${p.pid}, parent ${p.ppid} (${p.parent})`);
    const ours = during.filter((p) => p.ppid === child.pid);
    ours.length === 1
      ? pass(`Language server PID ${ours[0].pid} is a child of this test's MCP server (node PID ${child.pid})`)
      : fail(`Expected exactly 1 server parented to ${child.pid}, found ${ours.length}`);
    during.some((p) => p.parent.startsWith('Code'))
      ? fail('A VS Code-parented server exists -- VS Code is running after all')
      : pass('No VS Code-parented language server exists');
  }

  // a syntactic transform
  hdr('Transformations');
  const cmds = ['sortProperties', 'sortTableFields', 'sortProcedures', 'removeEmptyLines', 'sortVariables'];
  const hits = [];
  for (const f of files) {
    for (const c of cmds) {
      const res = await call('al_cleanup', { command: c, filePath: f, output: 'summary' });
      if (res.isError) { fail(`${c} on ${basename(f)}: ${res.text.slice(0, 160)}`); continue; }
      if (!res.text.startsWith('No changes')) hits.push({ f, c });
    }
  }
  pass(`Ran ${files.length * cmds.length} transform calls with no errors`);
  if (hits.length) {
    info(`${hits.length} produced a change; showing one diff:`);
    r = await call('al_cleanup', { command: hits[0].c, filePath: hits[0].f });
    !r.isError && r.text.includes('@@')
      ? pass(`Diff produced for ${hits[0].c} on ${basename(hits[0].f)}`)
      : fail('Expected a unified diff');
    console.log('\n' + r.text.split('\n').slice(2).join('\n').slice(0, 700) + '\n');
  } else {
    info('No command changed anything (project already clean) -- still a valid pass');
  }

  // symbol-dependent path: proves Base App packages loaded without VS Code
  const meta = await call('al_add_metadata', { command: 'addFieldCaptions', filePath: files[0], output: 'summary' });
  !meta.isError
    ? pass(`al_add_metadata ran (symbol table loaded without VS Code): ${meta.text.slice(0, 90)}`)
    : fail(`al_add_metadata: ${meta.text.slice(0, 200)}`);

  // duplicates + project sweep
  const dup = await call('al_find_duplicates', { projectPath: PROJECT, minNoOfStatements: 5 });
  !dup.isError ? pass(`al_find_duplicates: ${dup.text.split('\n')[0]}`) : fail(`al_find_duplicates: ${dup.text.slice(0, 200)}`);

  const sweep = await call('al_project_cleanup', { commands: ['sortProperties', 'removeEmptyLines'], projectPath: PROJECT, dryRun: true });
  !sweep.isError ? pass(`al_project_cleanup dry run: ${sweep.text.split('\n')[1] || ''}`) : fail(`al_project_cleanup: ${sweep.text.slice(0, 200)}`);

  // ---------------------------------------------------------------- teardown
  hdr('Teardown');
  child.stdin.end();
  child.kill();
  await new Promise((res) => setTimeout(res, 4000));
  const leftover = alServerProcs();
  leftover.length === 0
    ? pass('No AZALDevToolsServer processes remain')
    : fail(`${leftover.length} orphaned process(es): ${leftover.map((p) => p.pid).join(', ')}`);

  hdr(failures === 0
    ? 'RESULT: PASS -- fully functional with VS Code closed'
    : `RESULT: FAIL -- ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  fail('Unhandled: ' + e.message);
  try { child.kill(); } catch {}
  process.exit(1);
});
