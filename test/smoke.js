// End-to-end smoke test: drives the MCP server over stdio like a real client.
// Read-only -- every call is preview/dryRun, nothing in the target repo is written.

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'index.js');

const PROJECT = process.argv[2]
  || 'C:\\Users\\mateusz.wojciechowsk\\OneDrive - IT.integro sp. z o.o\\_Repo\\Approvals';

function firstAlFile(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) { const f = firstAlFile(full); if (f) return f; }
    else if (e.name.toLowerCase().endsWith('.al')) return full;
  }
  return undefined;
}

function serverCount() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-Process AZALDevToolsServer.NetCore -EA SilentlyContinue | Measure-Object).Count"',
      { encoding: 'utf8' });
    return parseInt(out.trim(), 10);
  } catch { return -1; }
}

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AL_MCP_VERBOSE: '1', AL_MCP_IDLE_MS: '8000' },
});

let outBuf = '';
let nextId = 1;
const pending = new Map();

child.stdout.on('data', (d) => {
  outBuf += d.toString('utf8');
  let idx;
  while ((idx = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, idx).trim();
    outBuf = outBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`  | ${d.toString()}`));

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
    }, 240_000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
async function call(name, args) {
  const r = await send('tools/call', { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error || r.result);
  return { text, isError: !!r.result?.isError };
}
const header = (s) => console.log('\n' + '='.repeat(76) + `\n${s}\n` + '='.repeat(76));

(async () => {
  const baseline = serverCount();
  console.log(`AZALDevToolsServer processes before test: ${baseline}`);

  header('1. MCP handshake');
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.0' },
  });
  console.log('serverInfo:  ', JSON.stringify(init.result?.serverInfo));
  console.log('capabilities:', JSON.stringify(init.result?.capabilities));
  notify('notifications/initialized', {});

  header('2. tools/list');
  const list = await send('tools/list', {});
  const tools = list.result?.tools || [];
  for (const t of tools) {
    const enumVals = t.inputSchema?.properties?.command?.enum
      || t.inputSchema?.properties?.commands?.items?.enum;
    console.log(`  ${t.name}${enumVals ? ` (${enumVals.length} commands)` : ''} -- schema ${JSON.stringify(t.inputSchema).length} bytes`);
  }
  const totalSchema = JSON.stringify(tools).length;
  console.log(`\n  advertised surface: ${tools.length} tools, ${totalSchema} bytes (~${Math.round(totalSchema / 4)} tokens)`);

  if (!existsSync(PROJECT)) { console.log(`\nProject not found: ${PROJECT}`); child.kill(); process.exit(1); }
  const target = firstAlFile(PROJECT);
  if (!target) { console.log('\nNo .al files found in project'); child.kill(); process.exit(1); }
  console.log(`  target: ${target} (${statSync(target).size} bytes)`);

  header('3. al_cleanup sortProcedures (preview diff) -- includes cold start');
  let t0 = Date.now();
  let r = await call('al_cleanup', { command: 'sortProcedures', filePath: target });
  console.log(`(${Date.now() - t0}ms, isError=${r.isError})`);
  console.log(r.text.slice(0, 900));

  header('4. al_cleanup removeEmptyLines (warm, summary output)');
  t0 = Date.now();
  r = await call('al_cleanup', { command: 'removeEmptyLines', filePath: target, output: 'summary' });
  console.log(`(${Date.now() - t0}ms) ${r.text}`);

  header('5. al_outline');
  t0 = Date.now();
  r = await call('al_outline', { filePath: target });
  console.log(`(${Date.now() - t0}ms, isError=${r.isError})`);
  console.log(r.text.split('\n').slice(0, 22).join('\n'));
  console.log(`  ... outline ${r.text.length} bytes vs file ${statSync(target).size} bytes`);

  header('6. al_find_duplicates');
  t0 = Date.now();
  r = await call('al_find_duplicates', { projectPath: PROJECT, minNoOfStatements: 8 });
  console.log(`(${Date.now() - t0}ms, isError=${r.isError})`);
  console.log(r.text.slice(0, 800));

  header('7. al_project_cleanup (dry run -- writes nothing)');
  t0 = Date.now();
  r = await call('al_project_cleanup', { commands: ['sortProcedures'], projectPath: PROJECT, dryRun: true });
  console.log(`(${Date.now() - t0}ms, isError=${r.isError})`);
  console.log(r.text.slice(0, 900));

  header('8. error handling');
  r = await call('al_cleanup', { command: 'notARealCommand', filePath: target });
  console.log(`bogus command -> isError=${r.isError}: ${r.text.slice(0, 130)}`);
  r = await call('al_cleanup', { command: 'sortProcedures', filePath: join(PROJECT, 'DoesNotExist.al') });
  console.log(`missing file  -> isError=${r.isError}: ${r.text.slice(0, 130)}`);

  header('9. idle shutdown (AL_MCP_IDLE_MS=8000)');
  console.log(`servers running now: ${serverCount()}`);
  console.log('waiting 12s for idle timeout...');
  await new Promise((res) => setTimeout(res, 12_000));
  const afterIdle = serverCount();
  console.log(`after idle: ${afterIdle} (baseline ${baseline}) -> ${afterIdle === baseline ? 'RELEASED' : 'STILL RUNNING'}`);

  header('10. recovery after idle shutdown');
  t0 = Date.now();
  r = await call('al_cleanup', { command: 'sortProcedures', filePath: target, output: 'summary' });
  console.log(`(${Date.now() - t0}ms, isError=${r.isError}) ${r.text}`);

  header('11. orphan check on exit');
  child.stdin.end();
  child.kill();
  await new Promise((res) => setTimeout(res, 4000));
  const after = serverCount();
  console.log(`after MCP exit: ${after} (baseline ${baseline}) -> ${after === baseline ? 'NO ORPHANS' : 'ORPHAN LEAK'}`);
  process.exit(0);
})().catch((e) => { console.error('SMOKE FAILED:', e.message); try { child.kill(); } catch {} process.exit(1); });
