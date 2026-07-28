#!/usr/bin/env node
// Register this server with Claude Code, using this checkout's own absolute path.
//
// Avoids the usual copy-paste failure: a README with someone else's absolute
// path in it. `npm run register` resolves the path here, so nothing to edit.
//
//   npm run register            register at user scope (all projects)
//   npm run register -- --local register for the current directory only
//   npm run register -- --print print the command and JSON, change nothing

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(join(here, '..', 'src', 'index.js'));

const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const scope = args.includes('--local') ? 'local' : 'user';

const cmd = `claude mcp add al-devtools --scope ${scope} -- node "${entry}"`;

console.log('\nEntry point:\n  ' + entry);
console.log('\nEquivalent command:\n  ' + cmd);
console.log('\nEquivalent ~/.claude.json entry:\n' + JSON.stringify({
  mcpServers: {
    'al-devtools': { type: 'stdio', command: 'node', args: [entry.split('\\').join('/')], env: {} },
  },
}, null, 2));

if (printOnly) {
  console.log('\n--print given, nothing changed.\n');
  process.exit(0);
}

const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', shell: true });
if (which.status !== 0) {
  console.log('\nThe `claude` CLI was not found on PATH.');
  console.log('Either install it (https://code.claude.com/docs/en/setup) and re-run this,');
  console.log('or paste the JSON above into ~/.claude.json under "mcpServers".\n');
  process.exit(1);
}

console.log('\nRegistering...');
const run = spawnSync('claude', ['mcp', 'add', 'al-devtools', '--scope', scope, '--', 'node', entry], {
  stdio: 'inherit',
  shell: true,
});
if (run.status === 0) {
  console.log('\nRegistered. Restart Claude Code, then verify with:  claude mcp list\n');
} else {
  console.log('\nRegistration failed. If the server is already registered, remove it first:');
  console.log(`  claude mcp remove al-devtools --scope ${scope}\n`);
  process.exit(run.status ?? 1);
}
