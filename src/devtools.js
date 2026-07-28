// Client for the AZ AL Dev Tools language server (AZALDevToolsServer.NetCore).
//
// The server is a standalone .NET process that speaks LSP-framed JSON-RPC over
// stdio. It has no VS Code dependency in the protocol -- the extension is only
// needed because that is where the binary ships.
//
// Lifecycle policy: spawn lazily on first use, shut down after an idle period.
// A cold start to fully-loaded symbols measures ~4s, so aggressive idle
// shutdown is cheap and it resets the server's analysis cache, which otherwise
// ratchets upward (~240MB after symbol load, ~380MB after analysing 25 files)
// and is never released.

import { spawn } from 'node:child_process';
import { readdirSync, existsSync, statSync, chmodSync, accessSync, constants } from 'node:fs';
import { join, dirname, parse as parsePath } from 'node:path';
import { homedir } from 'node:os';

const DEVTOOLS_PREFIX = 'andrzejzwierzchowski.al-code-outline-';
const AL_PREFIX = 'ms-dynamics-smb.al-';

/** Compare dotted version strings numerically, so 17.80.0 > 17.9.0. */
function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function extensionRoots() {
  const roots = [join(homedir(), '.vscode', 'extensions'), join(homedir(), '.vscode-insiders', 'extensions')];
  return roots.filter((r) => existsSync(r));
}

/** Find the newest installed extension directory matching a prefix. */
function findExtension(prefix) {
  const found = [];
  for (const root of extensionRoots()) {
    for (const name of readdirSync(root)) {
      if (name.startsWith(prefix)) found.push({ path: join(root, name), version: name.slice(prefix.length) });
    }
  }
  if (found.length === 0) return undefined;
  found.sort((a, b) => compareVersions(a.version, b.version));
  return found[found.length - 1];
}

export function discoverPaths() {
  const devtoolsPath = process.env.AL_DEVTOOLS_EXT_PATH || findExtension(DEVTOOLS_PREFIX)?.path;
  const alPath = process.env.AL_EXT_PATH || findExtension(AL_PREFIX)?.path;

  if (!devtoolsPath) {
    throw new Error(
      'AZ AL Dev Tools extension not found. Install "andrzejzwierzchowski.al-code-outline" ' +
        'or set AL_DEVTOOLS_EXT_PATH to its directory.'
    );
  }
  if (!alPath) {
    throw new Error(
      'AL Language extension not found. Install "ms-dynamics-smb.al" or set AL_EXT_PATH. ' +
        'It supplies Microsoft.Dynamics.Nav.CodeAnalysis.dll, which the server loads at runtime.'
    );
  }

  const platform = process.platform;
  const exe = join(devtoolsPath, 'bin', 'netcore', platform, 'AZALDevToolsServer.NetCore' + (platform === 'win32' ? '.exe' : ''));
  if (!existsSync(exe)) throw new Error(`Language server binary not found at ${exe}`);

  // VSIX packaging does not preserve POSIX permissions, so the shipped binary
  // arrives without the execute bit on macOS and Linux and spawning it fails with
  // EACCES. The VS Code extension chmods it on every start for the same reason.
  if (platform !== 'win32') {
    try {
      accessSync(exe, constants.X_OK);
    } catch {
      try {
        chmodSync(exe, 0o755);
      } catch (err) {
        throw new Error(
          `Language server binary at ${exe} is not executable and could not be chmod'ed: ${err.message}. ` +
            'Run: chmod +x "' + exe + '"'
        );
      }
    }
  }

  return { devtoolsPath, alPath, exe };
}

/** Walk up from a file or directory to the nearest folder containing app.json. */
export function findProjectPath(startPath) {
  let dir = startPath;
  try {
    if (statSync(dir).isFile()) dir = dirname(dir);
  } catch {
    dir = dirname(dir);
  }
  const { root } = parsePath(dir);
  while (true) {
    if (existsSync(join(dir, 'app.json'))) return dir;
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export class DevToolsServer {
  constructor({ idleTimeoutMs = 5 * 60_000, requestTimeoutMs = 180_000, log = () => {} } = {}) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;

    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.registeredProjects = new Map(); // projectPath -> Promise<void>
    this.idleTimer = undefined;
    this.startCount = 0;

    this._installExitHandlers();
  }

  // --- lifecycle ---------------------------------------------------------

  _installExitHandlers() {
    if (DevToolsServer._handlersInstalled) return;
    DevToolsServer._handlersInstalled = true;
    const kill = () => {
      for (const inst of DevToolsServer._instances) inst.stop('process exit');
    };
    process.on('exit', kill);
    process.on('SIGINT', () => { kill(); process.exit(0); });
    process.on('SIGTERM', () => { kill(); process.exit(0); });
    process.on('uncaughtException', (e) => { this.log(`uncaught: ${e?.stack || e}`); kill(); process.exit(1); });
    // If the MCP client goes away, stdin closes -- do not leave a server behind.
    process.stdin.on('close', kill);
  }

  start() {
    if (this.child) return;
    const { alPath, exe } = discoverPaths();
    this.startCount += 1;
    this.log(`starting language server (start #${this.startCount})`);

    this.child = spawn(exe, [alPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.buffer = Buffer.alloc(0);
    this.registeredProjects.clear();

    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', (d) => this.log(`server stderr: ${d.toString().slice(0, 500)}`));
    this.child.on('exit', (code, signal) => {
      this.log(`language server exited (code=${code} signal=${signal})`);
      this._failAllPending(new Error('Language server exited'));
      this.child = undefined;
      this.registeredProjects.clear();
    });
    this.child.on('error', (err) => {
      this.log(`spawn error: ${err.message}`);
      this._failAllPending(err);
      this.child = undefined;
    });

    DevToolsServer._instances.add(this);
    this._resetIdleTimer();
  }

  stop(reason = 'idle') {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    const child = this.child;
    this.child = undefined;
    this.registeredProjects.clear();
    DevToolsServer._instances.delete(this);
    if (!child) return;
    this.log(`stopping language server (${reason})`);
    this._failAllPending(new Error(`Language server stopped (${reason})`));
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
    // Windows can ignore a soft kill on a busy .NET process.
    setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch {} }, 2000).unref();
  }

  _resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.idleTimeoutMs) return;
    this.idleTimer = setTimeout(() => this.stop('idle timeout'), this.idleTimeoutMs);
    this.idleTimer.unref(); // never hold the event loop open
  }

  _failAllPending(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  // --- transport (LSP Content-Length framing) ----------------------------

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { this.buffer = this.buffer.slice(headerEnd + 4); continue; }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return; // wait for more
      const body = this.buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.slice(bodyStart + length);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id === undefined) continue; // server-initiated notification: ignore
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || 'JSON-RPC error'));
      else entry.resolve(msg.result);
    }
  }

  _write(payload) {
    const json = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  }

  notify(method, params) {
    this.start();
    this._resetIdleTimer();
    this._write({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    this.start();
    this._resetIdleTimer();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // --- workspace registration -------------------------------------------

  /**
   * Register an AL project and block until its symbols are loaded.
   *
   * Registration is mandatory: without it every workspace command fails.
   * Requesting the table list acts as the readiness barrier -- it only returns
   * once the package cache has been parsed. Cached per project per server life.
   */
  ensureProject(projectPath) {
    this.start();
    const existing = this.registeredProjects.get(projectPath);
    if (existing) return existing;

    const promise = (async () => {
      const packageCachePath = join(projectPath, '.alpackages');
      this.notify('ws/workspaceFoldersChange', {
        added: [{
          folderPath: projectPath,
          packageCachePath: existsSync(packageCachePath) ? packageCachePath : undefined,
          codeAnalyzers: [],
          additionalMandatoryAffixesPatterns: [],
        }],
        removed: undefined,
      });
      const started = Date.now();
      await this.request('al/gettableslist', { path: projectPath });
      this.log(`project ready in ${Date.now() - started}ms: ${projectPath}`);
    })();

    this.registeredProjects.set(projectPath, promise);
    promise.catch(() => this.registeredProjects.delete(projectPath)); // allow retry
    return promise;
  }

  /** Run a workspace command. Pass `source` to transform in memory (no disk writes). */
  async workspaceCommand({ command, source, projectPath, filePath, parameters = {}, includeFiles, excludeFiles, range }) {
    await this.ensureProject(projectPath);
    const result = await this.request('al/workspacecommand', {
      command, source, projectPath, filePath, parameters, includeFiles, excludeFiles, range,
    });
    if (!result) throw new Error(`No response from language server for command '${command}'`);
    if (result.error) throw new Error(result.errorMessage || `Command '${command}' failed`);
    return result;
  }
}

DevToolsServer._instances = new Set();
DevToolsServer._handlersInstalled = false;
