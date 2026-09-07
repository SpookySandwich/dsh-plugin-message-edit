// Run against test/fixtures/dsh-acceptance.mjs in a disposable local DSH home.
import assert from 'node:assert/strict';
const base = process.argv[2] ?? 'http://127.0.0.1:61587';
const url = new URL(base);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a local acceptance server');
async function state() {
  const response = await fetch(`${base}/qa/state`);
  assert.equal(response.status, 200);
  return response.json();
}
async function post(body) {
  const response = await fetch(`${base}/message-tree`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
const before = await state();
const isUser = event => event.type === 'user/message' && event.data.source.kind === 'user';
for (const id of ['session-qa-live', 'session-qa-cold']) {
  const source = before.sessions.find(session => session.header.id === id);
  assert.ok(source, 'The acceptance fixture must be mounted');
  const original = source.events.find(isUser);
  const result = await post({
    action: 'edit', sessionId: id, eventSeq: original.seq, blockIndex: 0,
    text: 'Edited in real DSH; retain both images.', stopPrevious: true,
  });
  const after = await state();
  const child = after.sessions.find(session => session.header.id === result.sessionId);
  assert.equal(child.header.isSeeded, true);
  assert.ok(Number.isSafeInteger(child.inheritedEventCount));
  const edited = child.events.findLast(isUser);
  assert.equal(edited.data.content[0].text, 'Edited in real DSH; retain both images.');
  assert.deepEqual(edited.data.content.filter(block => block.type === 'image'), original.data.content.filter(block => block.type === 'image'));
  assert.equal(child.events.filter(isUser).length, 1);
  assert.ok(child.events.findLast(event => event.type === 'assistant/message')?.data.message.content
    .some(block => block.text?.includes('Received 2 images')));
  const preserved = after.sessions.find(session => session.header.id === id).events;
  assert.deepEqual(preserved.slice(0, source.events.length), source.events);
  assert.equal(preserved.filter(isUser).length, 2);
  const treeResponse = await fetch(`${base}/message-tree?sessionId=${result.sessionId}`);
  assert.equal(treeResponse.status, 200);
  const tree = await treeResponse.json();
  assert.equal(tree.versions.find(version => version.sessionId === result.sessionId).targetTurn, 1);
  const retried = await post({ action: 'retry', sessionId: result.sessionId, turn: 1, stopPrevious: true });
  const retriedState = await state();
  assert.equal(retriedState.sessions.find(session => session.header.id === retried.sessionId).header.parentSession, id);
  const continuation = await fetch(`${base}/qa/followup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: result.sessionId, text: 'A later turn after the first branch.' }),
  });
  assert.equal(continuation.status, 200);
  const continued = (await state()).sessions.find(session => session.header.id === result.sessionId);
  const laterUser = continued.events.findLast(isUser);
  const nested = await post({ action: 'edit', sessionId: result.sessionId, eventSeq: laterUser.seq,
    blockIndex: 0, text: 'Nested turn-two edit.', stopPrevious: true });
  await state();
  const nestedTree = await (await fetch(`${base}/message-tree?sessionId=${nested.sessionId}`)).json();
  const nestedVersion = nestedTree.versions.find(version => version.sessionId === nested.sessionId);
  assert.equal(nestedVersion.targetTurn, 2, 'The inherited turn-1 marker must not hide the new turn-2 marker');
  assert.equal(nestedVersion.parentSessionId, result.sessionId);
  console.log(JSON.stringify({ source: id, sourceWasLive: source.live, child: result.sessionId,
    result: 'edit, images, local model reply, source preservation, tree, sibling retry, nested branch passed' }));
}
