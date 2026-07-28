// Minimal unified-diff generator.
//
// The language server always returns the whole transformed file. Returning that
// verbatim is what makes naive wrappers expensive: sorting three procedures in a
// 1000-line codeunit costs ~12k tokens of source to say ~50 tokens of change.
// Diffing host-side is the single biggest token saving in this server.

/** Longest-common-subsequence table walk, on lines. */
function lcsBacktrack(a, b) {
  const n = a.length;
  const m = b.length;
  // Trim identical prefix/suffix first -- keeps the DP table small in the
  // common case where a transform touches a few lines of a large file.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const rows = midA.length;
  const cols = midB.length;

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'eq', line: a[i] });

  if (rows === 0 || cols === 0) {
    for (const line of midA) ops.push({ type: 'del', line });
    for (const line of midB) ops.push({ type: 'add', line });
  } else {
    const table = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        table[i][j] = midA[i] === midB[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (midA[i] === midB[j]) { ops.push({ type: 'eq', line: midA[i] }); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) { ops.push({ type: 'del', line: midA[i] }); i++; }
      else { ops.push({ type: 'add', line: midB[j] }); j++; }
    }
    while (i < rows) { ops.push({ type: 'del', line: midA[i] }); i++; }
    while (j < cols) { ops.push({ type: 'add', line: midB[j] }); j++; }
  }

  for (let i = endA; i < n; i++) ops.push({ type: 'eq', line: a[i] });
  return ops;
}

/**
 * Build a unified diff. Returns '' when the inputs are identical.
 * @param {string} before
 * @param {string} after
 * @param {{label?: string, context?: number}} [opts]
 */
export function unifiedDiff(before, after, opts = {}) {
  if (before === after) return '';
  const label = opts.label || 'file';
  const context = opts.context ?? 3;

  const a = before.split('\n');
  const b = after.split('\n');
  const ops = lcsBacktrack(a, b);

  // Group ops into hunks around runs of changes.
  const changedIdx = [];
  ops.forEach((op, i) => { if (op.type !== 'eq') changedIdx.push(i); });
  if (changedIdx.length === 0) return '';

  const hunks = [];
  let current = [changedIdx[0]];
  for (let k = 1; k < changedIdx.length; k++) {
    if (changedIdx[k] - current[current.length - 1] <= context * 2) current.push(changedIdx[k]);
    else { hunks.push(current); current = [changedIdx[k]]; }
  }
  hunks.push(current);

  const out = [`--- ${label}`, `+++ ${label}`];
  for (const hunk of hunks) {
    const from = Math.max(0, hunk[0] - context);
    const to = Math.min(ops.length - 1, hunk[hunk.length - 1] + context);

    let oldStart = 1;
    let newStart = 1;
    for (let i = 0; i < from; i++) {
      if (ops[i].type !== 'add') oldStart++;
      if (ops[i].type !== 'del') newStart++;
    }
    let oldCount = 0;
    let newCount = 0;
    const body = [];
    for (let i = from; i <= to; i++) {
      const op = ops[i];
      if (op.type === 'eq') { body.push(' ' + op.line); oldCount++; newCount++; }
      else if (op.type === 'del') { body.push('-' + op.line); oldCount++; }
      else { body.push('+' + op.line); newCount++; }
    }
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...body);
  }
  return out.join('\n');
}

/** Count added/removed lines, for a compact summary alongside the diff. */
export function diffStats(before, after) {
  if (before === after) return { added: 0, removed: 0 };
  const ops = lcsBacktrack(before.split('\n'), after.split('\n'));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  return { added, removed };
}
