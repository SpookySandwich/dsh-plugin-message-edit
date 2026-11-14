// Run against test/fixtures/dsh-acceptance.mjs in a disposable local DSH home.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { deepseekExportEntries } from '../test/fixtures/deepseek-export.mjs';
const base = process.argv[2] ?? 'http://127.0.0.1:61587';
const phase = process.argv[3];
assert.ok(phase === undefined || phase === 'fresh' || phase === 'restart', 'Phase must be fresh or restart');
const url = new URL(base);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a local acceptance server');
async function state() {
  const response = await fetch(`${base}/qa/state`);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
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
// On the second invocation this must resume an already persisted seeded child,
// not only read its log while creating another child from an unseeded root.
const persistedBranch = before.sessions.find(session => session.header.isSeeded && !session.live
  && session.events.some(event => event.type === 'message-tree/version' && event.data.sessionId === session.header.id));
if (phase === 'restart') assert.ok(persistedBranch, 'Restart must restore a previously persisted seeded branch');
if (phase === 'fresh') assert.equal(persistedBranch, undefined, 'Fresh acceptance must start without old branches');
if (persistedBranch) {
  const marker = persistedBranch.events.find(event => event.type === 'message-tree/version' && event.data.sessionId === persistedBranch.header.id);
  await post({ action: 'retry', sessionId: persistedBranch.header.id, turn: marker.data.effect.targetTurn });
  console.log('Persisted seeded branch resumed and retried successfully.');
}
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
  assert.equal(child.events.filter(event => event.type === 'turn/start').length, 1, 'The inherited inbox must not replay extra turns');
  assert.equal(child.events[child.inheritedEventCount - 1].data.sessionId, child.header.id);
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

if (process.env.DSH_QA_IMPORT === '1') {
  const require = createRequire(join(process.env.DSH_QA_MODULES, '@deepseek-ai/dsh-deepseek-chat-import/package.json'));
  const { zipSync } = require('fflate');
  const sharp = require('sharp');
  const imported = session => session.header.parentSession === undefined
    && session.events.some(event => event.type === 'session/title' && event.data.title.startsWith('Imported QA:'));
  let source = before.sessions.find(imported);
  if (phase === 'restart') assert.ok(source, 'Restart must reuse the persisted imported history');
  if (!source) {
    const image = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#2563eb' } }).png().toBuffer();
    const workspace = before.workspaces.find(workspace => workspace.sessionIds.includes('session-qa-live'));
    assert.ok(workspace);
    // The official importer is owner-only; bootstrap this runner's local cookie.
    const auth = await fetch(process.argv[4] ?? base, { redirect: 'manual' });
    const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const upload = await fetch(`${base}/api/deepseek-chat-import/archive?workspaceId=${encodeURIComponent(workspace.id)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie },
      body: zipSync(deepseekExportEntries(image)),
    });
    assert.equal(upload.status, 200);
    const lines = (await upload.text()).trim().split('\n').map(line => JSON.parse(line));
    const outcome = lines.find(line => line.type === 'outcome')?.outcome;
    assert.equal(outcome?.ok, true, JSON.stringify(lines));
    assert.equal(outcome.value.sessionIds.length, 1, JSON.stringify(outcome));
    source = (await state()).sessions.find(imported);
  }
  assert.ok(source);
  assert.equal(source.live, false, 'Import and observation must not create a live agent');
  assert.equal(source.events.some(event => event.type === 'request/header'), false);
  assert.ok(source.events.some(event => event.type === 'tool/result'));
  assert.ok(source.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'));
  assert.ok(!JSON.stringify(source.events).includes('Unselected original DeepSeek branch'));
  const id = source.header.id;
  for (const turn of [1, 2]) for (const action of ['edit', 'retry']) {
    const start = source.events.find(event => event.type === 'turn/start' && event.data.turn === turn);
    const original = source.events.find(event => isUser(event) && event.seq > start.seq);
    const blockIndex = original.data.content.findIndex(block => block.type === 'text');
    const result = await post({ action, sessionId: id, eventSeq: original.seq, blockIndex,
      text: `Edited imported turn ${turn}`, turn });
    const after = await state();
    const child = after.sessions.find(session => session.header.id === result.sessionId);
    const user = child.events.findLast(isUser);
    assert.equal(user.data.content[blockIndex].text, action === 'edit' ? `Edited imported turn ${turn}` : original.data.content[blockIndex].text);
    assert.deepEqual(user.data.content.filter(block => block.type !== 'text'), original.data.content.filter(block => block.type !== 'text'));
    assert.deepEqual(child.events.slice(0, start.seq), source.events.slice(0, start.seq), 'Preserve the imported tool/image prefix exactly');
    assert.equal(child.events[child.inheritedEventCount - 1].data.sessionId, child.header.id);
    assert.equal(child.events.filter(event => event.type === 'session/end-seed').length, 1);
    assert.equal(child.header.parentSession, id);
    assert.equal(child.header.agentPreset, 'standard', 'Imported branches must record the configured default preset');
    assert.equal(child.header.cwd, source.header.cwd);
    assert.ok(after.workspaces.some(workspace => workspace.sessionIds.includes(id) && workspace.sessionIds.includes(child.header.id)));
    const request = child.events.findLast(event => event.type === 'request/header').data.header;
    const tools = request.tools.map(tool => tool.name);
    for (const name of ['read', 'write', 'edit', 'grep', 'glob', 'web_fetch', 'todo_write', 'subagent', 'workflow']) {
      assert.ok(tools.includes(name), `Default preset tool ${name} must be available to imported ${action} turn ${turn}`);
    }
    const route = request.config;
    assert.equal(route.provider, 'qa-local');
    assert.equal(route.model, 'qa-model');
    assert.equal(route.reasoningEffort, 'high');
    assert.ok(child.events.findLast(event => event.type === 'assistant/message').data.message.content
      .some(block => block.text?.includes('Received 1 images')));
    const preserved = after.sessions.find(session => session.header.id === id);
    assert.equal(preserved.live, false, 'Release the temporary resumed source agent');
    assert.deepEqual(preserved.events.slice(0, source.events.length), source.events);
    // Observation/resume may append the host's seed boundary and permission
    // defaults. It must never append a model turn or change imported messages.
    assert.ok(preserved.events.slice(source.events.length).every(event =>
      ['session/end-seed', 'permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)));
    assert.equal(preserved.events.some(event => event.type === 'request/header'), false);
    const tree = await (await fetch(`${base}/message-tree?sessionId=${result.sessionId}`)).json();
    assert.equal(tree.versions.find(version => version.sessionId === child.header.id).targetTurn, turn);
    assert.equal(tree.versions.find(version => version.sessionId === id).targetTurn, undefined);
  }
  console.log(`Imported history (${phase}): real ZIP upload, headerless edit/retry, tool prefix, image/file retention, error turn, workspace, default preset tools, model reply and version tree passed.`);
}
