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
  // A deleted (ghost) version still anchors the fork and still bridges the
  // parent walks above, but it cannot be opened, so it never appears among
  // the alternatives: the ring renumbers over the survivors.
  const alternatives = versions
    .filter((v) => !v.deleted && (v.sessionId === fork.sessionId || (v.targetTurn === turn && walksToFork(v))))
    .sort((a, b) => a.createdAt - b.createdAt || String(a.sessionId).localeCompare(String(b.sessionId)));
  if (alternatives.length < 2) return null;
  let index = alternatives.findIndex((v) => v.sessionId === cursor.sessionId);
  if (index === -1) index = alternatives.findIndex((v) => v.sessionId === sessionId);
  if (index === -1) index = 0;
  return { alternatives, index };
}

/**
 * The family root for `sessionId`: walk parentSessionId links until one has
 * none. Used to key the remembered active path, so every branch of a
 * conversation shares one entry.
 *
 * Mirrors rootOf() in plugin.client.js; kept here so it is testable.
 */
export function rootOf(versions, sessionId) {
  if (!versions || sessionId === undefined) return undefined;
  const byId = new Map(versions.map((v) => [v.sessionId, v]));
  let cursor = byId.get(sessionId);
  if (!cursor) return undefined;
  const seen = new Set();
  while (cursor.parentSessionId && !seen.has(cursor.sessionId)) {
    seen.add(cursor.sessionId);
    const parent = byId.get(cursor.parentSessionId);
    if (!parent) break;
    cursor = parent;
  }
  return cursor.sessionId;
}

/**
 * Reconstruct a session's ancestor chain from its own event log, bridging
 * ancestors whose sessions were deleted.
 *
 * A version's seed inherits its parent's events, which include the parent's
 * own `message-tree/version` marker — and, transitively, the markers of every
 * ancestor back to the root (the root has none). So `markers`, the
 * message-tree/version events of ONE session's full log in seq order, lays
 * out the ancestry: the last marker is the session's own, the one before it
 * belongs to the parent, and so on; each marker's `inverse.sessionId` names
 * its owner's parent. The information survives deletion because it lives in
 * the descendant's log, not the ancestor's.
 *
 * @param parentId - the session's `header.parentSession`.
 * @param markers - message-tree/version events of the session's log, seq order.
 * @returns ancestors nearest-first, each `{ sessionId, marker? }`; the last
 *   entry is the family root (no marker). Empty for a root session.
 */
export function ancestorChainFromLog(parentId, markers) {
  const chain = [];
  const seen = new Set();
  let id = parentId;
  let at = markers.length - 2; // markers.at(-1) is the session's own
  while (id !== undefined && id !== null && !seen.has(id)) {
    seen.add(id);
    const marker = at >= 0 ? markers[at] : undefined;
    chain.push(marker === undefined ? { sessionId: id } : { sessionId: id, marker });
    id = marker === undefined ? undefined
      : marker.data && marker.data.inverse ? marker.data.inverse.sessionId : undefined;
    at -= 1;
  }
  return chain;
}

/**
 * Flatten one conversation family from `rootId` downward, bridging deleted
 * sessions.
 *
 * `entries` is every node known to exist — surviving session headers plus
 * ghost decorations recovered from descendants' logs — as
 * `{ id, parentId?, createdAt, ghost? }`. Edges come from `parentId` and are
 * keyed by the raw id, so a surviving child still hangs under its deleted
 * parent. A `parentId` with no entry of its own gets a bare ghost entry, so
 * a family fragmented by deletion stays one tree with tombstones at the
 * holes.
 *
 * @returns `[{ entry, depth }]` in depth-first order, siblings by createdAt.
 */
export function collectFamily(rootId, entries) {
  const byId = new Map();
  for (const entry of entries) byId.set(entry.id, entry);
  for (const entry of entries) {
    if (entry.parentId !== undefined && !byId.has(entry.parentId)) {
      byId.set(entry.parentId, { id: entry.parentId, ghost: true, createdAt: 0 });
    }
  }
  if (!byId.has(rootId)) byId.set(rootId, { id: rootId, ghost: true, createdAt: 0 });
  const childrenByParent = new Map();
  for (const entry of byId.values()) {
    if (entry.parentId === undefined) continue;
    const list = childrenByParent.get(entry.parentId) ?? [];
    list.push(entry);
    childrenByParent.set(entry.parentId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
  }
  const out = [];
  const seen = new Set();
  const visit = (id, depth) => {
    if (seen.has(id)) return;
    seen.add(id);
    const entry = byId.get(id);
    if (entry === undefined) return;
    out.push({ entry, depth });
    for (const child of childrenByParent.get(id) ?? []) visit(child.id, depth + 1);
  };
  visit(rootId, 0);
  return out;
}
