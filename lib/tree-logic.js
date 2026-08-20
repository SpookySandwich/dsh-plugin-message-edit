// Pure helpers shared by the host (where to hang a new branch) and tests.
// The client copies `ringFor` — keep the two in sync.

/**
 * Walk up through versions of the same turn and stop at the first session
 * that is NOT itself an edit of that turn. New siblings hang off that node
 * so repeated edits of one message fan out instead of chaining.
 */
export function attachParentId(nodesById, sourceId, targetTurn) {
  let id = sourceId;
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = nodesById.get(id);
    if (!node) return id;
    if (node.targetTurn !== targetTurn) return id;
    if (!node.parentSessionId) return id;
    id = node.parentSessionId;
  }
  return sourceId;
}

/**
 * The ‹ › ring for the message at `turn` while viewing `sessionId`.
 *
 * Collects the original message's session plus every version of that same
 * turn, even when older builds chained them (A→B→C) instead of fanning
 * out as siblings.
 */
export function ringFor(versions, sessionId, turn) {
  if (!versions) return null;
  const byId = new Map(versions.map((v) => [v.sessionId, v]));
  let cursor = byId.get(sessionId);
  if (!cursor) return null;
  while (cursor.parentSessionId && typeof cursor.targetTurn === 'number' && cursor.targetTurn > turn) {
    const parent = byId.get(cursor.parentSessionId);
    if (!parent) break;
    cursor = parent;
  }
  let fork = cursor;
  while (fork.parentSessionId && typeof fork.targetTurn === 'number' && fork.targetTurn === turn) {
    const parent = byId.get(fork.parentSessionId);
    if (!parent) break;
    fork = parent;
  }
  const walksToFork = (start) => {
    let x = start;
    const seen = new Set();
    while (x && !seen.has(x.sessionId)) {
      seen.add(x.sessionId);
      if (x.sessionId === fork.sessionId) return true;
      if (typeof x.targetTurn !== 'number' || x.targetTurn !== turn) return false;
      x = x.parentSessionId ? byId.get(x.parentSessionId) : null;
    }
    return false;
  };
  const alternatives = versions
    .filter((v) => v.sessionId === fork.sessionId || (v.targetTurn === turn && walksToFork(v)))
    .sort((a, b) => a.createdAt - b.createdAt || String(a.sessionId).localeCompare(String(b.sessionId)));
  if (alternatives.length < 2) return null;
  let index = alternatives.findIndex((v) => v.sessionId === cursor.sessionId);
  if (index === -1) index = alternatives.findIndex((v) => v.sessionId === sessionId);
  if (index === -1) index = 0;
  return { alternatives, index };
}
