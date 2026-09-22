import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { MESSAGE_TREE_ATTACHMENT_PATH, apply } from '../lib/index.js';

// Exercise the public HTTP route with both documented DSH session shapes.
// Lifecycle/model execution is a double; real-runtime acceptance is separate.
function harness(modern, resumed = false) {
  const records = new Map();
  const agents = new Map();
  const creations = [];
  const attached = [];
  const admissions = [];
  const staged = new Map();
  const hostPaths = new Map();
  let modalities = ['text', 'image'];
  let reads = 0;
  let resumes = 0;
  const routes = new Map();
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
  append(root, 'request/header', { header: { config: { provider: 'qa', model: 'qa', reasoningEffort: 'max' } } });
  const originalImage = { type: 'image', attachment: { attachmentId: 'sha256:qa-image' } };
  const originalFile = { type: 'file', attachment: { attachmentId: 'sha256:qa-file', name: 'qa.log', bytes: 2048 } };
  const prompt = value => ({ id: `message-${value}`, role: 'user', source: { kind: 'user' }, content: [
    { type: 'text', text: value }, structuredClone(originalImage), structuredClone(originalFile),
  ] });
  const sourceAgent = agentFor(root);
  sourceAgent.followup(prompt('original'));
  sourceAgent.followup(prompt('later'));
  if (resumed) { root.live = false; agents.delete('source'); }
  const ctx = {
    get(name) { return this[name]; },
    effect(fn) { fn(); },
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {}; } },
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
    // Attachment admission: the deployment's own entry point is a double here.
    // It records what a wire image carried and mints a deterministic reference.
    attachments: {
      async admitPromptContent(content) {
        admissions.push(structuredClone(content));
        return content.map((part, index) => ({
          type: 'image',
          attachment: { attachmentId: `sha256:admitted-${index}`, ...part.name === undefined ? {} : { name: part.name } },
        }));
      },
      // The real store validates the reference it is handed — a sha256 digest and
      // a display name that is already the stored leaf name — and refuses
      // anything it did not write, so a traversal attempt never becomes a path.
      fileHostPath(ref) {
        const leaf = ref.name.slice(Math.max(ref.name.lastIndexOf('/'), ref.name.lastIndexOf('\\')) + 1);
        if (leaf !== ref.name) throw new Error('File attachment reference is invalid.');
        return hostPaths.get(ref.attachmentId);
      },
    },
    // Staged upload receipts live under the receiving Agent, exactly as the
    // real service stages them.
    fileUploads: {
      resolve(_agent, receiptId) { return staged.get(receiptId); },
    },
    llm: {
      async resolveModelInfo() { return { inputModalities: modalities }; },
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
          assert.equal(options.inheritedEventCount, options.seed.length,
            'DSH 0.1.5 requires the complete constructor seed to be inherited');
        } else assert.ok(Number.isSafeInteger(options.meta.seedLength));
        const agent = agentFor(record, options.agentOptions);
        // A durable inbox reconstructed from the rewound seed still contains
        // the old input. Setup must clear it before create publishes the agent.
        let pending = modern;
        agent.inbox = { clear() { pending = false; } };
        await options.setup?.({}, agent);
        assert.equal(pending, false, 'Inherited pending input must not auto-run');
        return { agent, async dispose() { records.delete(options.sessionId); agents.delete(options.sessionId); } };
      },
    },
  };
  apply(ctx);
  async function send(method, url, body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    req.url = url;
    let status, payload;
    const handler = routes.get(new URL(url, 'http://message-tree.local').pathname);
    assert.ok(handler, `no route registered for ${url}`);
    await handler(req, {
      writeHead(code) { status = code; },
      end(json) { payload = json === undefined ? undefined : JSON.parse(json); },
    });
    return { status, body: payload };
  }
  async function request(method, body, id = 'source') {
    return send(method, `/message-tree?sessionId=${encodeURIComponent(id)}`, body);
  }
  /** The attachment-path route: one stored reference in, one host path out. */
  async function attachmentRequest(attachmentId, extra = {}) {
    const query = new URLSearchParams({ sessionId: 'source', ...extra });
    if (attachmentId !== undefined) query.set('attachmentId', attachmentId);
    return send('GET', `${MESSAGE_TREE_ATTACHMENT_PATH}?${query.toString()}`);
  }
  return { request, send, attachmentRequest, records, agents, creations, attached, prompt, append, staged, admissions, hostPaths,
    setModalities(next) { modalities = next; },
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
      // The client renders file attachments too, so the branch must carry them.
      assert.deepEqual(message.content[2], before[2].data.content[2]);
      assert.deepEqual(h.records.get('source').events, before, 'The original history remains unchanged');
      assert.equal(child.events.filter(event => event.type === 'user/message').length, 1);
      assert.equal(child.session.header.parentSession, 'source');
      assert.equal(modern ? child.session.inheritedEventCount : child.session.header.seedLength, modern ? 2 : 1);
      assert.equal(child.events[1].type, 'message-tree/version');
      assert.equal(child.events[1].ignorable, true);
      assert.deepEqual(h.attached, [childId]);
      assert.equal(h.creations[0].agentOptions.reasoningEffort, 'max');
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

/* --------------------------------------------- editable attachments (edit) */

/** The edited message content the branch actually published. */
function editedBlocks(h, sessionId) {
  return h.records.get(sessionId).events.findLast(event => event.type === 'user/message').data.content;
}

test('an edit replaces the attachment set and keeps the message layout', async () => {
  const h = harness(true);
  const kept = { type: 'file', attachment: { attachmentId: 'sha256:kept-file', name: 'kept.log', bytes: 3 } };
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'edited',
    attachments: [kept, { type: 'image', attachment: { attachmentId: 'sha256:kept-image' } }] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const blocks = editedBlocks(h, result.body.sessionId);
  assert.deepEqual(blocks.map(block => block.type), ['file', 'image', 'text']);
  assert.equal(blocks[0].attachment.attachmentId, 'sha256:kept-file');
  assert.equal(blocks[1].attachment.attachmentId, 'sha256:kept-image');
  assert.equal(blocks[2].text, 'edited');
  // The source message keeps its own copy of the attachments.
  assert.deepEqual(h.records.get('source').events[2].data.content.map(block => block.type), ['text', 'image', 'file']);
});

test('an empty attachment set removes every attachment from the edit', async () => {
  const h = harness(true);
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'text only',
    attachments: [] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(editedBlocks(h, result.body.sessionId), [{ type: 'text', text: 'text only' }]);
});

test('an omitted attachment set still preserves the original attachments', async () => {
  const h = harness(true);
  const before = structuredClone(h.records.get('source').events[2].data.content);
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'legacy client' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const blocks = editedBlocks(h, result.body.sessionId);
  assert.equal(blocks[0].text, 'legacy client');
  assert.deepEqual(blocks[1], before[1]);
  assert.deepEqual(blocks[2], before[2]);
});

test('a staged upload receipt becomes a durable file reference', async () => {
  const h = harness(true);
  h.staged.set('receipt-1', { attachmentId: 'sha256:staged-file', name: 'upload.log', bytes: 9 });
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'with upload',
    attachments: [{ type: 'file', receiptId: 'receipt-1' }] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const blocks = editedBlocks(h, result.body.sessionId);
  assert.equal(blocks[0].attachment.attachmentId, 'sha256:staged-file');
  assert.equal(blocks[0].attachment.name, 'upload.log');
  assert.equal(h.admissions.length, 0, 'A receipt is a file; only images are admitted as wire uploads');
});

test('a wire image is admitted through the deployment attachment service', async () => {
  const h = harness(true);
  const data = Buffer.from('png-bytes').toString('base64');
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'with image',
    attachments: [{ type: 'image', data, mediaType: 'image/png', name: 'new.png' }] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(h.admissions, [[{ type: 'image', data, mediaType: 'image/png', name: 'new.png' }]]);
  const blocks = editedBlocks(h, result.body.sessionId);
  assert.equal(blocks[0].attachment.attachmentId, 'sha256:admitted-0');
  assert.equal(blocks[0].attachment.name, 'new.png');
});

test('a wire image is refused when the branch model cannot take images', async () => {
  const h = harness(true);
  h.setModalities(['text']);
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'with image',
    attachments: [{ type: 'image', data: Buffer.from('x').toString('base64'), mediaType: 'image/png' }] });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /不支持图片输入/);
  assert.equal(h.creations.length, 0, 'A refused upload must not leave a half-created branch');
});

test('a kept image is replayed even when the model cannot take images', async () => {
  const h = harness(true);
  h.setModalities(['text']);
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'unchanged image',
    attachments: [{ type: 'image', attachment: { attachmentId: 'sha256:qa-image' } }] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(editedBlocks(h, result.body.sessionId)[0].attachment.attachmentId, 'sha256:qa-image');
});

test('an expired receipt is reported without creating a branch', async () => {
  const h = harness(true);
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'lost upload',
    attachments: [{ type: 'file', receiptId: 'receipt-missing' }] });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /已失效/);
  assert.equal(h.creations.length, 0);
});

for (const [label, attachments] of [
  ['a non-array attachment list', 'nope'],
  ['an unknown attachment type', [{ type: 'audio' }]],
  ['a file entry with neither receipt nor reference', [{ type: 'file' }]],
  ['a reference without an attachmentId', [{ type: 'file', attachment: { name: 'x.log' } }]],
  ['an image entry with neither attachment nor data', [{ type: 'image', mediaType: 'image/png' }]],
]) {
  test(`${label} is rejected as a bad request`, async () => {
    const h = harness(true);
    const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'bad attachment',
      attachments });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(h.creations.length, 0);
  });
}

test('an attachment failure names the attachment, not the request body', async () => {
  const h = harness(true);
  const result = await h.request('POST', { action: 'edit', sessionId: 'source', eventSeq: 2, blockIndex: 0, text: 'no reference',
    attachments: [{ type: 'file' }] });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /receiptId/);
  assert.doesNotMatch(result.body.error, /JSON/, 'The body was valid JSON; only the entry was incomplete');
});

/* ------------------------------------------------- open a file attachment -- */

const FILE_ID = `sha256:${'a'.repeat(64)}`;

test('a stored file attachment resolves to its host path', async () => {
  const h = harness(true);
  h.hostPaths.set(FILE_ID, 'C:/Users/qa/.dsh/attachments/v1/files/aa/' + 'a'.repeat(64) + '/qa.log');
  const result = await h.attachmentRequest(FILE_ID, { name: 'qa.log', bytes: '2048' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.path, 'C:/Users/qa/.dsh/attachments/v1/files/aa/' + 'a'.repeat(64) + '/qa.log');
});

test('a reference the store cannot place is reported instead of guessed', async () => {
  const h = harness(true);
  const result = await h.attachmentRequest(FILE_ID, { name: 'qa.log' });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /宿主路径/);
});

for (const [label, attachmentId, extra] of [
  ['a malformed digest', 'sha256:not-a-digest', { name: 'qa.log' }],
  ['a missing attachment id', undefined, { name: 'qa.log' }],
  ['a path-traversal attempt', `sha256:${'a'.repeat(64)}`, { name: '../../../etc/passwd' }],
]) {
  test(`${label} is refused before the store is consulted`, async () => {
    const h = harness(true);
    h.hostPaths.set(FILE_ID, 'C:/somewhere/qa.log');
    const result = await h.attachmentRequest(attachmentId, extra);
    // The digest gate rejects the first two outright; the traversal attempt
    // reaches the store, which refuses a name it never stored.
    assert.equal(result.status, label === 'a path-traversal attempt' ? 409 : 400, JSON.stringify(result.body));
  });
}

test('the attachment route only answers GET', async () => {
  const h = harness(true);
  const result = await h.send('POST', `${MESSAGE_TREE_ATTACHMENT_PATH}?sessionId=source&attachmentId=${FILE_ID}`);
  assert.equal(result.status, 405);
});
