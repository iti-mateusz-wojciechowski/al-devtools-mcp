# al-devtools-mcp

An MCP server that exposes the [AZ AL Dev Tools](https://github.com/anzwdev/al-code-outline)
Roslyn engine as agent tools, so an AI agent can apply **deterministic** AL code
transformations instead of rewriting AL by hand.

## Why

The AZ AL Dev Tools extension contains ~50 AL code transformations built on
Microsoft's AL compiler, but they are only reachable through the VS Code command
palette — useless to an agent. This server makes them callable.

Two benefits:

- **Correctness.** The transformations are parser-based. They handle string
  literals, comments, `#region` scopes, and attribute/doc-comment ownership that
  text editing gets wrong. An agent asked to "sort these procedures" cannot
  hallucinate the result.
- **Cost.** Sorting procedures in a 1000-line codeunit by hand means reading the
  file, rewriting it, and writing it back — thousands of tokens each way. Here it
  is one call returning a unified diff.

### What this is *not*

It deliberately does **not** wrap symbol search, object definitions, object ID
assignment, or build/compile/diagnostics. Those are already covered by
[al-mcp-server](https://www.npmjs.com/package/al-mcp-server), the official
`altool launchmcpserver`, and
[al-object-id-ninja](https://github.com/vjekob/al-object-id-ninja). Duplicating
them would cost context on every request and add no capability.

Raw syntax trees are also omitted: `al/getfullsyntaxtree` returns ~1.7 MB of JSON
for a 1100-line file, which would be a context bomb.

## Requirements

- Node.js 18+
- **AZ AL Dev Tools** extension (`andrzejzwierzchowski.al-code-outline`) — ships
  the language server binary this server drives.
- **AL Language** extension (`ms-dynamics-smb.al`) — supplies
  `Microsoft.Dynamics.Nav.CodeAnalysis.dll`, which the server loads at runtime.

Both are auto-discovered from `~/.vscode/extensions` (and `.vscode-insiders`),
newest version wins. Override with `AL_DEVTOOLS_EXT_PATH` / `AL_EXT_PATH`.

> VS Code itself does not need to be running. The language server is a standalone
> .NET process with no VS Code dependency in its protocol — the extension is only
> needed because that is where the binary ships.

## Install

```bash
npm install
```

Register with Claude Code:

```bash
claude mcp add al-devtools -- node "C:/Users/<you>/OneDrive - IT.integro sp. z o.o/_Repo/al-devtools-mcp/src/index.js"
```

Or add to `~/.claude.json` under `mcpServers`:

```json
{
  "al-devtools": {
    "type": "stdio",
    "command": "node",
    "args": ["C:/path/to/al-devtools-mcp/src/index.js"]
  }
}
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AL_MCP_IDLE_MS` | `300000` | Idle ms before the language server is shut down. |
| `AL_MCP_VERBOSE` | unset | Set to `1` for stderr logging. |
| `AL_DEVTOOLS_EXT_PATH` | auto | Override AZ AL Dev Tools extension directory. |
| `AL_EXT_PATH` | auto | Override AL Language extension directory. |

## Tools

| Tool | Purpose |
|---|---|
| `al_cleanup` | 24 purely syntactic fixes to one file: `sortProcedures`, `sortTableFields`, `sortVariables`, `removeBeginEnd`, `fixKeywordsCase`, … |
| `al_add_metadata` | 23 symbol-aware fixes to one file: `addToolTips`, `addFieldCaptions`, `addDataClassification`, `removeUnusedVariables`, `convertObjectIdsToNames`, … |
| `al_project_cleanup` | Apply commands across every `.al` file in a project. `dryRun: true` by default. |
| `al_find_duplicates` | Structural duplicate-code detection across a project. |
| `al_outline` | Compact structural outline of one file, instead of reading it. |

Total advertised schema is ~9.6 KB (~2.4k tokens) for 47 commands — commands are
enum values rather than separate tools, because tool schemas are paid for on
every request and enum values are not.

### Safety

- **Nothing is written unless you ask.** `al_cleanup` and `al_add_metadata`
  default to `write: false` and return a diff. `al_project_cleanup` defaults to
  `dryRun: true`.
- Run project-wide changes on a clean git working tree so they are easy to review
  or revert.

### Example

```
al_cleanup { command: "sortVariables", filePath: "C:/…/src/Codeunit/Foo.al" }
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

## Behaviour and resource use

The language server is spawned **lazily** on first tool call and **shut down
after an idle period** (default 5 min). This matters — measured on a 25-file
project:

| State | Working set | Private |
|---|---|---|
| Spawned, no project registered | 46 MB | 13 MB |
| Project registered, symbols loaded | 290 MB | 239 MB |
| After analysing 25 files | 433 MB | 377 MB |
| After `closesyntaxtree` on all files | 433 MB | 377 MB |

Two findings drive the design:

1. **Analysis caches ratchet upward and are never released.** The `closesyntaxtree`
   notifications reclaim nothing, and .NET GC tuning
   (`GCConserveMemory`, `gcConcurrent=0`, `GCRetainVM=0`, `GCHeapHardLimit`) moves
   working set by 0–3%. Process lifetime is the only effective lever.
2. **Restarting is cheap** — ~4–6 s to fully-loaded symbols. So idle shutdown
   costs little and resets the ratchet.

The server also kills its child on `exit`, `SIGINT`, `SIGTERM`, uncaught
exceptions, and stdin close, so it does not leave orphaned .NET processes behind.

First call after a cold start pays the symbol load (~6 s). Subsequent calls on the
same project are typically 90–450 ms.

## Testing

```bash
npm run smoke                    # uses _Repo/Approvals
npm run smoke -- "C:/path/to/AnyAlProject"
```

The smoke test drives the server over real MCP stdio and checks the handshake,
tool listing, each tool, error handling, idle shutdown, recovery after shutdown,
and that no orphaned processes remain. It is read-only.

## Known limitations

- `al_add_metadata`'s `removeUnusedVariables` can report no change even when a
  variable is unused — it needs its settings object populated, which this MVP does
  not do.
- `collectworkspacecodeactions` ("what does the extension think is fixable here")
  throws a null reference in the shipped server and is therefore not exposed.
- `getcodeanalyzersrules` returns an empty result and is not exposed.
- `sortProcedures` can leave a stray blank line after the opening `{`. Cosmetic.

Fixing the first three requires patching the language server, which means owning
its build rather than using the shipped binary — see below.

## Possible next step: own the build

This MVP uses the binary shipped inside the installed AZ AL Dev Tools extension,
so that extension must stay installed. The upstream repo is MIT licensed and
cleanly separates `language-server/` (C#) from `vscode-extension/` (TypeScript),
so an alternative is to build the language server yourself, pin it as a submodule,
and uninstall the VS Code extension entirely.

That would let you fix the limitations above and drop the extension's always-on
per-window server (measured at 378 MB and 1326 MB across two windows), replacing
it with one idle-shutdown process. It costs a .NET 10 SDK dependency and a rebuild
on each BC major release, since the server binds to
`Microsoft.Dynamics.Nav.CodeAnalysis` internals.

## Credits

All AL analysis and transformation logic belongs to
[Andrzej Zwierzchowski](https://github.com/anzwdev)'s
[al-code-outline](https://github.com/anzwdev/al-code-outline) (MIT). This project
is only an MCP adapter over its language server.

## License

MIT
