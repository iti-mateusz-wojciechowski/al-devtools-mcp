// Reaches the model's system prompt, so unlike a tool description it is read before
// the model has decided what to do. Paid for on every request: carry only the
// diagnostic routing and the call-this-first ordering, and let descriptions do the rest.
export const SERVER_INSTRUCTIONS = `Deterministic AL fixes via the AZ AL Dev Tools Roslyn engine.

Prefer these tools over hand-editing .al text: they parse AL, so literals, comments, #region scopes and attribute ownership survive.

Analyzer routing: AA0005, AA0008, AA0021, AA0241, AA0477 -> al_cleanup. AA0040, AA0137, AA0231 -> al_add_metadata.

Call al_outline before reading a large .al file, then read only the lines you need. al_project_cleanup for whole-app fixes, al_find_duplicates before a refactor.

Previews are the default; pass write:true (or dryRun:false) once the intent is clear rather than previewing the same change twice.`;
