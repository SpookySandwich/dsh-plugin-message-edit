import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { apply } from '../lib/index.js';

// Exercise the public HTTP route with both documented DSH session shapes.
// Lifecycle/model execution is a double; real-runtime acceptance is separate.
function harness(modern, resumed = false) {
  const records = new Map();
  const agents = new Map();
  const creations = [];
  const attached = [];
  let reads = 0;
  let resumes = 0;
  let route;
  function makeSession(id, events, meta = {}, inheritedEventCount = 0) {
    const header = { id, createdAt: 1, cwd: '/qa', ...meta };
    if (modern) header.isSeeded ??= false;
    const session = { id, header, snapshotCalls: 0 };
    if (modern) {
      session.inheritedEventCount = inheritedEventCount;
      session.snapshotEvents = () => { session.snapshotCalls++; return Object.freeze([...events]); };
      Object.defineProperty(session, 'seq', { get: () => events.length });
      Object.defineProperty(session, 'events', { get: () => { throw new Error('retired .events read'); } });
    } else session.events = events;
    const record = { session, events, live: true };
    records.set(id, record);
    return record;
  }
  function append(record, type, data) {
    record.events.push({ seq: record.events.length, time: record.events.length + 10, type, data });
  }
  function agentFor(record, options = { provider: 'qa', model: 'qa' }) {
    const agent = {
      session: record.session, options,
      runMaintenance: job => job(), cancel() {}, whenIdle: async () => {},
      followup(message) {
        const turn = (record.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0) + 1;
        append(record, 'turn/start', { turn });
        append(record, 'user/message', message);
        append(record, 'turn/end', { turn });
      },
    };
    agents.set(record.session.id, agent);
    return agent;
  }
  const root = makeSession('source', []);
  append(root, 'request/header', { header: { config: { provider: 'qa', model: 'qa' } } });
  const originalImage = { type: 'image', attachment: { attachmentId: 'sha256:qa-image' } };
  const prompt = value => ({ id: `message-${value}`, role: 'user', source: { kind: 'user' }, content: [
    { type: 'text', text: value }, structuredClone(originalImage),
  ] });
  const sourceAgent = agentFor(root);
  sourceAgent.followup(prompt('original'));
  sourceAgent.followup(prompt('later'));
  if (resumed) { root.live = false; agents.delete('source'); }
  const ctx = {
    get(name) { return this[name]; },
    effect(fn) { fn(); },
    webServer: { register(spec) { route = spec.handler; return () => {}; } },
    sessions: {
      get(id) { const record = records.get(id); return record?.live ? record.session : undefined; },
      flush: async () => {},
    },
    sessionPersistence: {},
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [{ sessionIds: [...records.keys()], attachSession: async id => attached.push(id) }],
    },
    sessionQuery: {
      listSessions: async () => [...records.values()].map(({ session }) => ({ header: session.header })),
      async readSession(id) {
        reads++;
        const record = records.get(id);
        if (!record) throw new Error('not found');
        return { [modern ? 'session' : 'header']: record.session.header, events: structuredClone(record.events),
          ...(modern ? { inheritedEventCount: record.session.inheritedEventCount } : {}) };
      },
    },
    agents: {
      get: id => agents.get(id),
      async resume({ resumeSessionId, agentOptions }) {
        resumes++;
        const record = records.get(resumeSessionId);
        record.live = true;
        return { agent: agentFor(record, agentOptions), async dispose() { record.live = false; agents.delete(resumeSessionId); } };
      },
      async create(options) {
        creations.push(options);
        const record = makeSession(options.sessionId, structuredClone(options.seed), options.meta, options.inheritedEventCount);
        if (modern) {
          assert.equal(options.meta.isSeeded, true);
          assert.equal(options.meta.seedLength, undefined);
          assert.ok(Number.isSafeInteger(options.inheritedEventCount));
        } else assert.ok(Number.isSafeInteger(options.meta.seedLength));
        const agent = agentFor(record, options.agentOptions);
        return { agent, async dispose() { records.delete(options.sessionId); agents.delete(options.sessionId); } };
      },
    },
  };
  apply(ctx);
  async function request(method, body, id = 'source') {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    req.url = `/message-tree?sessionId=${encodeURIComponent(id)}`;
    let status, payload;
    await route(req, {
      writeHead(code) { status = code; },
      end(json) { payload = json === undefined ? undefined : JSON.parse(json); },
    });
    return { status, body: payload };
  }
  return { request, records, agents, creations, attached, prompt, append,
    get reads() { return reads; }, get resumes() { return resumes; } };
}

for (const modern of [false, true]) {
  for (const resumed of [false, true]) {
    test(`${modern ? 'modern' : 'legacy'} ${resumed ? 'resumed' : 'live'}: edit preserves images and rewinds history`, async () => {
      const h = harness(modern, resumed);
      const before = structuredClone(h.records.get('source').events);
      const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'edited' });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.queuedTurns, 1);
      const childId = result.body.sessionId;
      const child = h.records.get(childId);
      const message = child.events.findLast(event => event.type === 'user/message').data;
      assert.equal(message.content[0].text, 'edited');
      assert.deepEqual(message.content[1], before[2].data.content[1]);
      assert.deepEqual(h.records.get('source').events, before, 'The original history remains unchanged');
      assert.equal(child.events.filter(event => event.type === 'user/message').length, 1);
      assert.equal(child.session.header.parentSession, 'source');
      assert.equal(modern ? child.session.inheritedEventCount : child.session.header.seedLength, 1);
      assert.equal(child.events[1].type, 'message-tree/version');
      assert.equal(child.events[1].ignorable, true);
      assert.deepEqual(h.attached, [childId]);
      assert.equal(h.resumes, resumed ? 1 : 0);
      const tree = await h.request('GET', undefined, childId);
      assert.equal(tree.status, 200, JSON.stringify(tree.body));
      assert.equal(tree.body.versions.find(version => version.sessionId === childId).targetTurn, 1);
    });
  }

  test(`${modern ? 'modern' : 'legacy'}: nested and repeated edits preserve the correct fork anchor`, async () => {
    const h = harness(modern);
    const edited = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'B' });
    const b = edited.body.sessionId;
    h.agents.get(b).followup(h.prompt('second turn on B'));
    const target = h.records.get(b).events.findLast(event => event.type === 'user/message');
    const later = await h.request('POST', { action: 'edit', sessionId: b, eventSeq: target.seq, blockIndex: 0, text: 'C' });
    assert.equal(later.status, 200, JSON.stringify(later.body));
    const c = later.body.sessionId;
    const tree = await h.request('GET', undefined, c);
    const version = tree.body.versions.find(entry => entry.sessionId === c);
    assert.equal(version.targetTurn, 2, 'Ignore the inherited turn-1 version marker');
    assert.equal(version.parentSessionId, b);
    const retried = await h.request('POST', { action: 'retry', sessionId: c, turn: 2, stopPrevious: true });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    const d = h.records.get(retried.body.sessionId);
    assert.equal(d.session.header.parentSession, b, 'Repeated turn-2 versions are siblings');
    assert.equal(d.events.findLast(event => event.type === 'user/message').data.content[0].text, 'C');
  });
}

test('tree cache sees new live events without re-snapshotting an unchanged log', async () => {
  const h = harness(true);
  await h.request('GET');
  const source = h.records.get('source').session;
  const calls = source.snapshotCalls;
  await h.request('GET');
  assert.equal(source.snapshotCalls, calls);
  h.agents.get('source').followup(h.prompt('third'));
  const tree = await h.request('GET');
  assert.equal(tree.body.versions[0].turns.length, 3);
});

test('tree cache refreshes cold logs even though the creation timestamp is unchanged', async () => {
  const h = harness(true, true);
  await h.request('GET');
  const record = h.records.get('source');
  h.append(record, 'turn/start', { turn: 3 });
  h.append(record, 'user/message', h.prompt('cold third'));
  h.append(record, 'turn/end', { turn: 3 });
  const tree = await h.request('GET');
  assert.equal(tree.body.versions[0].turns.length, 3);
});

test('unreadable live history returns an actionable error without creating a branch', async () => {
  const h = harness(true);
  h.records.get('source').session.snapshotEvents = () => undefined;
  const result = await h.request('POST', { action: 'retry', sessionId: 'source', turn: 1 });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /snapshotEvents\(\)/);
  assert.equal(h.creations.length, 0);
});

test('invalid edit targets are rejected without creating a branch', async () => {
  const h = harness(true);
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 0, blockIndex: 0, text: 'bad' });
  assert.equal(result.status, 409);
  assert.equal(h.creations.length, 0);
});
