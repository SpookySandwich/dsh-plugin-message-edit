import { attachParentId, ringFor, rootOf, ancestorChainFromLog, collectFamily } from '../lib/tree-logic.js';

function node(id, parentSessionId, targetTurn) {
  return { sessionId: id, parentSessionId, targetTurn, createdAt: 0 };
}

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log('      got ', got);
    console.log('      want', want);
  }
}

const byId = new Map([
  ['A', { targetTurn: undefined, parentSessionId: undefined }],
  ['B', { targetTurn: 1, parentSessionId: 'A' }],
  ['C', { targetTurn: 1, parentSessionId: 'B' }], // buggy chain from older builds
  ['D', { targetTurn: 2, parentSessionId: 'B' }],
]);

check('first edit of turn 1 hangs off A', attachParentId(byId, 'A', 1), 'A');
check('second edit of turn 1 hangs off A, not B', attachParentId(byId, 'B', 1), 'A');
check('third edit of turn 1 hangs off A, not C', attachParentId(byId, 'C', 1), 'A');
check('edit of a later turn hangs off the current session', attachParentId(byId, 'B', 2), 'B');

const chained = [
  { sessionId: 'A', createdAt: 1 },
  { sessionId: 'B', parentSessionId: 'A', targetTurn: 1, createdAt: 2 },
  { sessionId: 'C', parentSessionId: 'B', targetTurn: 1, createdAt: 3 },
];
const ringC = ringFor(chained, 'C', 1);
check('chained third edit is 3/3, not 2/2', {
  ids: ringC.alternatives.map((v) => v.sessionId),
  index: ringC.index,
  n: ringC.alternatives.length,
}, { ids: ['A', 'B', 'C'], index: 2, n: 3 });

const siblings = [
  { sessionId: 'A', createdAt: 1 },
  { sessionId: 'B', parentSessionId: 'A', targetTurn: 1, createdAt: 2 },
  { sessionId: 'C', parentSessionId: 'A', targetTurn: 1, createdAt: 3 },
  { sessionId: 'D', parentSessionId: 'A', targetTurn: 1, createdAt: 4 },
];
const ringD = ringFor(siblings, 'D', 1);
check('sibling edits of turn 1 are 4/4', {
  ids: ringD.alternatives.map((v) => v.sessionId),
  index: ringD.index,
  n: ringD.alternatives.length,
}, { ids: ['A', 'B', 'C', 'D'], index: 3, n: 4 });

const later = [
  node('A', undefined, undefined),
  { sessionId: 'B', parentSessionId: 'A', targetTurn: 1, createdAt: 2 },
  { sessionId: 'E', parentSessionId: 'B', targetTurn: 2, createdAt: 3 },
];
later[0].createdAt = 1;
const ringE = ringFor(later, 'E', 2);
check('a later-turn edit rings against its own parent, not turn 1', {
  ids: ringE.alternatives.map((v) => v.sessionId),
  n: ringE.alternatives.length,
}, { ids: ['B', 'E'], n: 2 });

const ringTurn1OnE = ringFor(later, 'E', 1);
check('turn 1 ring while viewing a turn-2 child still sees A/B', {
  ids: ringTurn1OnE.alternatives.map((v) => v.sessionId),
  n: ringTurn1OnE.alternatives.length,
}, { ids: ['A', 'B'], n: 2 });

/* ---- active path: family root resolution ------------------------------- */
// The remembered "which version was I viewing" is keyed by the family root, so
// every branch of one conversation must agree on that key.

const family = [
  node('A', undefined, undefined),
  node('B', 'A', 1),
  node('C', 'A', 1),
  node('D', 'C', 2),
];

check('root of the root is itself', rootOf(family, 'A'), 'A');
check('root of a direct branch is the root', rootOf(family, 'B'), 'A');
check('root of a nested branch is still the root', rootOf(family, 'D'), 'A');
check('every branch agrees on one key',
  [...new Set(family.map((v) => rootOf(family, v.sessionId)))], ['A']);
check('unknown session has no root', rootOf(family, 'ZZ'), undefined);
check('missing versions has no root', rootOf(null, 'A'), undefined);

// A broken parent link must not hang the walk.
const cyclic = [
  { sessionId: 'X', parentSessionId: 'Y', targetTurn: 1, createdAt: 0 },
  { sessionId: 'Y', parentSessionId: 'X', targetTurn: 1, createdAt: 0 },
];
check('a parent cycle terminates instead of hanging',
  typeof rootOf(cyclic, 'X'), 'string');

// A parent that is not in the list (e.g. a deleted session) stops the walk at
// the last node we can actually see, rather than returning undefined.
const orphan = [node('P', 'GONE', 1)];
check('a dangling parent stops at the visible node', rootOf(orphan, 'P'), 'P');


/* ---- deletion holes ----------------------------------------------------- */
// Versions are ordinary sidebar sessions now, so the user can delete one.
// The host tree() only ever returns SURVIVING sessions (dsh traceSession
// rebuilds the family from surviving headers), so these model deletion by
// simply omitting the deleted node from the versions list.

// 10 same-turn siblings: root A plus versions V2..V10 all hang off A.
const ten = [{ sessionId: 'A', createdAt: 1 }];
for (let i = 2; i <= 10; i++) ten.push({ sessionId: 'V' + i, parentSessionId: 'A', targetTurn: 1, createdAt: i });

// Delete V5 (a middle sibling). Viewing V6: ring must renumber to 9 with no gap.
const afterDelete = ten.filter((v) => v.sessionId !== 'V5');
const ringAfter = ringFor(afterDelete, 'V6', 1);
check('deleting a sibling renumbers the ring instead of breaking it', {
  n: ringAfter.alternatives.length,
  hasHole: ringAfter.alternatives.some((v) => v.sessionId === 'V5'),
  index: ringAfter.index,
}, { n: 9, hasHole: false, index: 4 });

// Delete the fork original A itself. Siblings can no longer reach the fork:
// the ring disappears (null) rather than crashing.
const noRoot = ten.filter((v) => v.sessionId !== 'A');
check('deleting the fork original degrades to no ring, not a crash',
  ringFor(noRoot, 'V6', 1), null);

// Chain: A -> B (edit turn 1) -> C (edit turn 2 made from B). Delete B.
// From C, the walk up hits the hole and stops; turn-1 ring vanishes cleanly.
const chain = [
  { sessionId: 'A', createdAt: 1 },
  { sessionId: 'C', parentSessionId: 'B', targetTurn: 2, createdAt: 3 },
];
check('a hole in the parent chain yields no ring, not a crash',
  ringFor(chain, 'C', 1), null);

// rootOf across the same hole must terminate at the last visible node.
check('rootOf stops at the hole instead of crashing', rootOf(chain, 'C'), 'C');


/* ---- deletion bridging -------------------------------------------------- */
// A version's seed inherits its ancestors' message-tree/version markers, so a
// deleted ancestor's identity survives in its descendants' logs. The host
// rebuilds the family through holes and emits ghost entries (deleted: true);
// the ring skips ghosts but still uses them as fork anchors and chain links.

function marker(ownerParentId, targetTurn, time) {
  return { data: { effect: { targetTurn }, inverse: { sessionId: ownerParentId } }, time };
}

// Chain A -> B -> C -> S: S's log carries [B's, C's, S's] markers.
const chainMarkers = [marker('A', 1, 2), marker('B', 2, 3), marker('C', 3, 4)];
check('ancestor chain recovered from one log, nearest first',
  ancestorChainFromLog('C', chainMarkers).map((l) => l.sessionId), ['C', 'B', 'A']);
check('a same-turn sibling sees only the fork original',
  ancestorChainFromLog('A', [marker('A', 1, 2)]).map((l) => l.sessionId), ['A']);
check('a root session has no chain', ancestorChainFromLog(undefined, []), []);

// collectFamily bridges a deleted middle link C between B and D.
const bridged = collectFamily('A', [
  { id: 'A', createdAt: 1, ghost: false },
  { id: 'B', parentId: 'A', createdAt: 2, ghost: false },
  { id: 'C', parentId: 'B', createdAt: 3, ghost: true },
  { id: 'D', parentId: 'C', createdAt: 4, ghost: false },
]);
check('a deleted chain link keeps the family one tree', {
  order: bridged.map((n) => n.entry.id),
  depths: bridged.map((n) => n.depth),
  ghost: bridged.map((n) => !!n.entry.ghost),
}, { order: ['A', 'B', 'C', 'D'], depths: [0, 1, 2, 3], ghost: [false, false, true, false] });

// A parentId nobody has an entry for is synthesized as a bare ghost, and
// unrelated sessions in the corpus are never pulled in.
const synth = collectFamily('A', [
  { id: 'V2', parentId: 'A', createdAt: 2, ghost: false },
  { id: 'V3', parentId: 'A', createdAt: 3, ghost: false },
  { id: 'other', createdAt: 9, ghost: false },
]);
check('a deleted original is synthesized as the ghost root', {
  order: synth.map((n) => n.entry.id),
  rootGhost: !!synth[0].entry.ghost,
}, { order: ['A', 'V2', 'V3'], rootGhost: true });

// Ring over ten siblings whose ORIGINAL was deleted: the ghost anchors the
// fork but is not a page, so survivors renumber ‹k/9›.
const ghosted = [{ sessionId: 'A', deleted: true, createdAt: 1 }];
for (let i = 2; i <= 10; i++) ghosted.push({ sessionId: 'V' + i, parentSessionId: 'A', targetTurn: 1, createdAt: i });
const ghostRing = ringFor(ghosted, 'V6', 1);
check('ghost original anchors the fork without being a page', {
  n: ghostRing.alternatives.length,
  hasGhost: ghostRing.alternatives.some((v) => v.deleted),
  index: ghostRing.index,
}, { n: 9, hasGhost: false, index: 4 });

// Old-build chains: A -> B(del, turn 1) -> C(turn 1). The ghost bridges the
// walk, so the ring still pairs C with the surviving original.
const ghostChain = [
  { sessionId: 'A', createdAt: 1 },
  { sessionId: 'B', parentSessionId: 'A', targetTurn: 1, createdAt: 2, deleted: true },
  { sessionId: 'C', parentSessionId: 'B', targetTurn: 1, createdAt: 3 },
];
const ghostChainRing = ringFor(ghostChain, 'C', 1);
check('a ghost chain link still connects survivors into one ring', {
  ids: ghostChainRing.alternatives.map((v) => v.sessionId),
  index: ghostChainRing.index,
}, { ids: ['A', 'C'], index: 1 });

console.log(`
${failed === 0 ? 'all passed' : failed + ' failed'}`);
process.exit(failed === 0 ? 0 : 1);
