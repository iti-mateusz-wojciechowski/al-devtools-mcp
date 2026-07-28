// Server-level instructions, returned in the MCP initialize result.
//
// Clients inject this into the model's system prompt, so it is the only place
// this server can express things a per-tool description cannot reach:
//
//   1. Cross-tool preference ("use al_cleanup instead of hand-editing"). A tool
//      description can only argue for itself; it is not read while the model is
//      deciding to call Edit.
//   2. Ordering ("al_outline before reading a large file"). Nothing in al_outline's
//      own schema fires when the model has already decided to read a file.
//   3. Discovery under lazy tool loading. Some harnesses match deferred tools on
//      name plus a one-line summary and fetch full descriptions on demand, so the
//      command enums are invisible at selection time. The analyzer IDs and verbs
//      below are the searchable surface in that case.
//
// Paid for on every request, like a tool schema -- keep it short and specific.
// Trigger conditions, not a feature tour.
export const SERVER_INSTRUCTIONS = `Deterministic AL code fixes, backed by the AZ AL Dev Tools Roslyn engine (the same parser the AL extension uses).

Reach for this server when:

- An AL analyzer diagnostic has a mechanical fix. AA0005, AA0008, AA0021, AA0241, AA0477 -> al_cleanup. AA0040, AA0137, AA0231 -> al_add_metadata. Fix it with the tool rather than by hand.
- You are about to edit an .al file to sort members, normalise casing, remove begin..end, strip unused variables, remove "with", or add ApplicationArea / DataClassification / permission-set entries. Use al_cleanup or al_add_metadata instead of Edit: they parse AL, so string literals, comments, #region scopes and attribute/doc-comment ownership survive. Text editing corrupts those.
- You need to know what is inside a large .al file. Call al_outline first and then read only the line ranges you need; do not read a 2000-line object to find one procedure.
- A fix applies to a whole app rather than one file -> al_project_cleanup.
- You are about to extract a procedure or start a refactor -> al_find_duplicates shows the clones worth folding together.

Nothing is written unless you ask: al_cleanup and al_add_metadata preview by default and return a unified diff (pass write:true to apply), and al_project_cleanup defaults to dryRun:true. Reviewing the diff before applying is normal, but do not preview twice -- when the intent is clear and the working tree is clean, pass write:true on the first call.

Caption and ToolTip generators are deliberately absent because their output echoes field names and targets the wrong object; write that text yourself.

This server does not do symbol lookup, object IDs, build, or diagnostics. Other AL MCP servers cover those.`;
