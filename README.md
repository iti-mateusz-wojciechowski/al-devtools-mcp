# al-devtools-mcp

An MCP server that exposes the [AZ AL Dev Tools](https://github.com/anzwdev/al-code-outline)
Roslyn engine as agent tools, so an AI agent can apply **deterministic** AL code
transformations to Business Central code instead of rewriting it by hand.

```
al_cleanup { command: "sortVariables", filePath: "…/src/Codeunit/Foo.al" }
```

```diff
Preview only -- Foo.al was NOT modified (pass write: true to apply).

--- src/Codeunit/Foo.al
+++ src/Codeunit/Foo.al
@@ -12,6 +12,6 @@
     var
-        Zebra: Integer;
-        Cust: Record Customer;
+        Cust: Record Customer;
+        Zebra: Integer;
```

## Why

The AZ AL Dev Tools extension contains ~50 AL code transformations built on
Microsoft's AL compiler, but they are only reachable from the VS Code command
palette — useless to an agent. This server makes them callable.

**Correctness.** The transformations are parser-based. They handle string literals,
comments, `#region` scopes, and attribute/doc-comment ownership that text editing
gets wrong. Asked to sort procedures, an agent cannot hallucinate the result — and
`sortVariables` applies AL's actual convention (complex types first, then simple
types by type then name), not alphabetical order.

**Cost.** Sorting procedures in a 1000-line codeunit by hand means reading the
file, rewriting it, and writing it back — thousands of tokens each way. Here it is
one call returning a unified diff.

### What this is not

It deliberately does **not** wrap symbol search, object definitions, object ID
assignment, or build/compile/diagnostics. Those are already covered by
[al-mcp-server](https://www.npmjs.com/package/al-mcp-server), the official
`altool launchmcpserver`, and
[al-object-id-ninja](https://github.com/vjekob/al-object-id-ninja). Duplicating
them would cost context on every request and add no capability.

Raw syntax trees are omitted too: `al/getfullsyntaxtree` returns ~1.7 MB of JSON
for a 1100-line file.

## Requirements

| | |
|---|---|
| Node.js | 18 or later (tested on 22) |
| OS | Windows, macOS or Linux |
| VS Code extension | **AZ AL Dev Tools / AL Code Outline** (`andrzejzwierzchowski.al-code-outline`) |
| VS Code extension | **AL Language** (`ms-dynamics-smb.al`) |

Both extensions are found automatically in `~/.vscode/extensions` (also
`.vscode-insiders` and `.vscode-server`); the newest installed version wins.

Why each is needed: AZ AL Dev Tools ships the language server binary this project
drives, and the AL Language extension supplies
`Microsoft.Dynamics.Nav.CodeAnalysis.dll`, which that server loads at runtime.
Neither is redistributed here.

> **VS Code does not need to be running.** The language server is a standalone
> .NET process with no VS Code dependency in its protocol — the extensions are
> only needed because that is where the binaries ship.

## Install

```bash
git clone https://github.com/iti-mateusz-wojciechowski/al-devtools-mcp.git
cd al-devtools-mcp
npm install
npm run check
```

`npm run check` is a preflight: it verifies your Node version, locates both
extensions, confirms the server binary exists for your platform, then starts the
server and lists the tools. Fix anything it reports before continuing.

```
al-devtools-mcp preflight check

  [ok]  Node 22.19.0
  [ok]  Platform win32
  [ok]  AZ AL Dev Tools: …/andrzejzwierzchowski.al-code-outline-17.80.0
  [ok]  AL Language: …/ms-dynamics-smb.al-18.0.2498801
  [ok]  Language server binary present
  [ok]  Microsoft.Dynamics.Nav.CodeAnalysis.dll present
  [ok]  MCP handshake: al-devtools v0.1.0
  [ok]  Tools available: al_cleanup, al_add_metadata, …
```

Then register it:

```bash
npm run register
```

This resolves **this checkout's** absolute path for you, so there is no path to
edit by hand. Options:

```bash
npm run register              # user scope: available in every project
npm run register -- --local   # current directory only
npm run register -- --print   # print the command and JSON, change nothing
```

Restart Claude Code, then confirm:

```bash
claude mcp list
# al-devtools: node /your/path/to/src/index.js - ✓ Connected
```

<details>
<summary>Manual registration (no <code>claude</code> CLI)</summary>

`npm run register -- --print` prints the exact JSON for your checkout. Add it to
`~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "al-devtools": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/al-devtools-mcp/src/index.js"],
      "env": {}
    }
  }
}
```

Use forward slashes on Windows too. Back the file up before editing it.
</details>

<details>
<summary>Other MCP clients</summary>

Nothing here is Claude-specific — it is a standard stdio MCP server. Point any
MCP client at `node /absolute/path/to/src/index.js`.
</details>

### Configuration

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `AL_MCP_IDLE_MS` | `300000` | Idle ms before the language server is shut down. |
| `AL_MCP_VERBOSE` | unset | Set to `1` for stderr logging. |
| `AL_DEVTOOLS_EXT_PATH` | auto | Override the AZ AL Dev Tools extension directory. |
| `AL_EXT_PATH` | auto | Override the AL Language extension directory. |

The two path overrides matter if your extensions live somewhere non-standard — a
portable VS Code install, a devcontainer, or a CI runner with no VS Code at all
(copy the two extension folders in and point these at them).

## Tools

| Tool | Purpose |
|---|---|
| `al_cleanup` | 24 purely syntactic fixes to one file: `sortProcedures`, `sortTableFields`, `sortVariables`, `removeBeginEnd`, `fixKeywordsCase`, … |
| `al_add_metadata` | 23 symbol-aware fixes to one file: `addToolTips`, `addFieldCaptions`, `addDataClassification`, `removeUnusedVariables`, `convertObjectIdsToNames`, … |
| `al_project_cleanup` | Apply commands across every `.al` file in a project. `dryRun: true` by default. |
| `al_find_duplicates` | Structural duplicate-code detection across a project. |
| `al_outline` | Compact structural outline of one file, instead of reading it. |

Total advertised schema is ~9.6 KB (~2.4k tokens) for 47 commands. Commands are
enum values rather than separate tools, because tool schemas are paid for on every
request and enum values are not.

`projectPath` is optional on the per-file tools — the nearest ancestor directory
containing `app.json` is used.

### Safety

- **Nothing is written unless you ask.** `al_cleanup` and `al_add_metadata` default
  to `write: false` and return a diff. `al_project_cleanup` defaults to
  `dryRun: true`.
- Run project-wide changes on a clean git working tree so they are easy to review
  or revert.

## File map

| Path | Purpose |
|---|---|
| `src/index.js` | MCP server entry point: protocol wiring, tool dispatch, logging. |
| `src/devtools.js` | Language server client: path discovery, spawn, LSP framing, workspace registration, idle shutdown, orphan cleanup. |
| `src/tools.js` | The five tool definitions, their command enums, and handlers. |
| `src/diff.js` | Unified diff generator (LCS with prefix/suffix trimming). |
| `src/symbolKinds.js` | 165 AL symbol kind numbers to names; generated from the extension. |
| `scripts/check.js` | Preflight diagnostics (`npm run check`). |
| `scripts/register.js` | Path-resolving registration helper (`npm run register`). |
| `test/smoke.js` | End-to-end MCP test (`npm run smoke`). |

## Behaviour and resource use

The language server is spawned **lazily** on first tool call and **shut down after
an idle period** (default 5 min). That matters — measured on a 25-file project:

| State | Working set | Private |
|---|---|---|
| Spawned, no project registered | 46 MB | 13 MB |
| Project registered, symbols loaded | 290 MB | 239 MB |
| After analysing 25 files | 433 MB | 377 MB |
| After `closesyntaxtree` on all files | 433 MB | 377 MB |

Two findings drive the design:

1. **Analysis caches ratchet upward and are never released.** The
   `closesyntaxtree` notifications reclaim nothing, and .NET GC tuning
   (`GCConserveMemory`, `gcConcurrent=0`, `GCRetainVM=0`, `GCHeapHardLimit`) moves
   working set by 0–3%. Process lifetime is the only effective lever.
2. **Restarting is cheap** — ~4–6 s to fully-loaded symbols. So idle shutdown
   costs little and resets the ratchet.

The server kills its child on `exit`, `SIGINT`, `SIGTERM`, uncaught exceptions and
stdin close, so it does not leave orphaned .NET processes behind.

First call after a cold start pays the symbol load (~6 s). Subsequent calls on the
same project are typically 90–450 ms.

## Testing

```bash
npm run smoke                                  # uses a default sample project path
npm run smoke -- "/path/to/any/AL/project"     # any folder with app.json
```

The smoke test drives the server over real MCP stdio and checks the handshake,
tool listing, each tool, error handling, idle shutdown, recovery after shutdown,
and that no orphaned processes remain. It is read-only.

## Verified with

| | |
|---|---|
| AZ AL Dev Tools | 17.80.0 |
| AL Language | 18.0 (BC 28 toolchain) |
| Symbol packages | BC 27.x (`Microsoft_Base Application` 27.4/27.5) |
| Node.js | 22.19.0 |
| OS | Windows 11 |

macOS and Linux binaries ship with the extension and paths are handled, but only
Windows has been exercised.

## Troubleshooting

**`npm run check` cannot find an extension.** Install the missing extension in VS
Code, or set `AL_DEVTOOLS_EXT_PATH` / `AL_EXT_PATH` to the folders.

**`claude mcp list` shows "Failed to connect".** Run `npm run check` — it
reproduces the startup independently. If check passes but the client does not
connect, confirm the registered path matches `npm run register -- --print`.

**A command returns "no changes" when you expect a change.** Many commands are
genuinely no-ops on already-clean code. Confirm with a file you know violates the
rule. Note `removeUnusedVariables` is a known limitation below.

**Everything is slow.** The first call per project loads Base App symbols (~6 s),
and it recurs after an idle shutdown. Raise `AL_MCP_IDLE_MS` if you call it in
bursts with long gaps.

## Known limitations

- `removeUnusedVariables` can report no change even when a variable is unused — it
  needs its settings object populated, which this version does not do.
- `collectworkspacecodeactions` ("what does the extension think is fixable here")
  throws a null reference in the shipped language server, so it is not exposed.
- `getcodeanalyzersrules` returns an empty result and is not exposed.
- `sortProcedures` can leave a stray blank line after the opening `{`. Cosmetic.
- Only Windows is exercised in testing.

Fixing the first three requires patching the language server, which means owning
its build rather than using the shipped binary — see below.

## Possible next step: own the build

This version uses the binary shipped inside the installed AZ AL Dev Tools
extension, so that extension must stay installed. The upstream repo is MIT
licensed and cleanly separates `language-server/` (C#) from `vscode-extension/`
(TypeScript), so an alternative is to build the language server yourself, pin it as
a submodule, and drop the VS Code extension entirely.

That would allow fixing the limitations above and would replace the extension's
always-on per-window server (measured at 378 MB and 1326 MB across two windows)
with one idle-shutdown process. It costs a .NET 10 SDK dependency and a rebuild on
each BC major release, since the server binds to
`Microsoft.Dynamics.Nav.CodeAnalysis` internals.

## Credits

All AL parsing, analysis and transformation logic belongs to
[Andrzej Zwierzchowski](https://github.com/anzwdev)'s
[al-code-outline](https://github.com/anzwdev/al-code-outline) (MIT). This project
is only an MCP adapter over its language server. See [NOTICE](NOTICE).

## License

MIT — see [LICENSE](LICENSE).
