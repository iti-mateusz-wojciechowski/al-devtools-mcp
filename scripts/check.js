#!/usr/bin/env node
// Preflight check: can this machine run the server?
//
// Run `npm run check` before registering. Verifies Node version, that both
// required VS Code extensions are present, that the language server binary
// exists for this platform, and that it actually starts and answers a request.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const PASS = '  [ok]  ';
const FAIL = '  [XX]  ';
const WARN = '  [--]  ';

let failed = 0;
const ok = (m) => console.log(PASS + m);
const bad = (m, hint) => { failed++; console.log(FAIL + m); if (hint) console.log('         ' + hint); };
const warn = (m) => console.log(WARN + m);

console.log('\nal-devtools-mcp preflight check\n');

// --- Node ---
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} is too old`, 'Requires Node 18 or later.');

// --- platform ---
const plat = platform();
if (['win32', 'darwin', 'linux'].includes(plat)) ok(`Platform ${plat}`);
else bad(`Platform ${plat} is not supported by the language server`, 'Only win32, darwin and linux binaries ship.');

// --- extensions ---
function findExt(prefix) {
  const roots = [
    join(homedir(), '.vscode', 'extensions'),
    join(homedir(), '.vscode-insiders', 'extensions'),
    join(homedir(), '.vscode-server', 'extensions'),
  ].filter(existsSync);
  const hits = [];
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      if (name.startsWith(prefix)) hits.push(join(root, name));
    }
  }
  return hits.sort();
}

const devtoolsOverride = process.env.AL_DEVTOOLS_EXT_PATH;
const alOverride = process.env.AL_EXT_PATH;

const devtoolsHits = devtoolsOverride ? [devtoolsOverride] : findExt('andrzejzwierzchowski.al-code-outline-');
const alHits = alOverride ? [alOverride] : findExt('ms-dynamics-smb.al-');

const devtools = devtoolsHits[devtoolsHits.length - 1];
const alExt = alHits[alHits.length - 1];

if (devtools) {
  ok(`AZ AL Dev Tools: ${devtools}${devtoolsOverride ? ' (from AL_DEVTOOLS_EXT_PATH)' : ''}`);
  if (devtoolsHits.length > 1) warn(`${devtoolsHits.length} versions installed; newest is used`);
} else {
  bad('AZ AL Dev Tools extension not found',
    'Install "AZ AL Dev Tools/AL Code Outline" (andrzejzwierzchowski.al-code-outline) in VS Code, or set AL_DEVTOOLS_EXT_PATH.');
}

if (alExt) {
  ok(`AL Language: ${alExt}${alOverride ? ' (from AL_EXT_PATH)' : ''}`);
  if (alHits.length > 1) warn(`${alHits.length} versions installed; newest is used`);
} else {
  bad('AL Language extension not found',
    'Install "AL Language" (ms-dynamics-smb.al) in VS Code, or set AL_EXT_PATH.');
}

// --- server binary ---
let exe;
if (devtools) {
  exe = join(devtools, 'bin', 'netcore', plat, 'AZALDevToolsServer.NetCore' + (plat === 'win32' ? '.exe' : ''));
  if (existsSync(exe)) ok(`Language server binary present`);
  else bad(`Language server binary missing at ${exe}`, 'The installed extension may be too old, or built without this platform.');
}

// --- compiler assemblies ---
if (alExt) {
  const dll = join(alExt, 'bin', plat, 'Microsoft.Dynamics.Nav.CodeAnalysis.dll');
  if (existsSync(dll)) ok('Microsoft.Dynamics.Nav.CodeAnalysis.dll present');
  else warn(`CodeAnalysis dll not at expected path (${dll}) -- layout may differ in this AL version`);
}

// --- live handshake ---
if (failed === 0) {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', 'src', 'index.js');
  console.log('\n  starting server and listing tools...');
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const done = (code) => { try { child.kill(); } catch {} process.exit(code); };
  const timer = setTimeout(() => { bad('Server did not respond within 30s'); done(1); }, 30_000);

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 1) {
        ok(`MCP handshake: ${m.result?.serverInfo?.name} v${m.result?.serverInfo?.version}`);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      } else if (m.id === 2) {
        clearTimeout(timer);
        ok(`Tools available: ${m.result.tools.map((t) => t.name).join(', ')}`);
        console.log('\n  All checks passed. Register with:  npm run register\n');
        done(0);
      }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write('         ' + d));
  child.on('error', (e) => { clearTimeout(timer); bad(`Could not start server: ${e.message}`); done(1); });

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'preflight', version: '0' } },
  }) + '\n');
} else {
  console.log(`\n  ${failed} check(s) failed -- fix the above before registering.\n`);
  process.exit(1);
}
