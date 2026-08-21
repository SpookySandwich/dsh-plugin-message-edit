import { attachParentId, ringFor, rootOf } from '../lib/tree-logic.js';

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

console.log(`
${failed === 0 ? 'all passed' : failed + ' failed'}`);
process.exit(failed === 0 ? 0 : 1);
