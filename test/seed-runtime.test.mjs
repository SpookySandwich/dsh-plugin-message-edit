import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { apply } from '../lib/index.js';

test('real DSH 0.1.5 constructor accepts a branch and setup clears rewound input before publication', async () => {
  const header = { version: SESSION_FORMAT_VERSION, id: 'source', createdAt: 1,
    cwd: process.cwd(), isSeeded: false, delegationDepth: 0 };
  const source = Session.create('source', undefined, header);
  const message = { id: 'original', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original' }] };
  source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
  source.append('turn/start', { turn: 1 });
  source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  const user = source.append('user/message', message, { surfaceOp: 'append' });
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const before = source.snapshotEvents();
  const sessions = new Map([['source', source]]);
  let child, queued, published = false;
  // The plugin registers one route per endpoint; address them by path.
  const routes = new Map();
  const ctx = {
    get(name) { return this[name]; }, effect(fn) { fn(); },
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {}; } },
    sessions: { get: id => sessions.get(id), flush: async () => {} },
    sessionQuery: { listSessions: async () => [...sessions.values()].map(session => ({ header: session.header })) },
    workspaceRegistry: { archivedSessionIds: [], list: () => [] },
    agents: {
      get: id => id === 'source' ? { session: source, options: { provider: 'qa', model: 'qa' }, runMaintenance: fn => fn() } : undefined,
      async create(options) {
        child = Session.create(options.sessionId, options.seed, { ...header, ...options.meta, id: options.sessionId }, options.inheritedEventCount);
        const pending = [];
        for (const event of child.snapshotEvents()) if (event.type === 'agent/inbox/spliced') {
          pending.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted);
        }
        assert.equal(pending.length, 1, 'The rewind restores the original pending input');
        const agent = { session: child,
          inbox: { clear() {
            assert.equal(published, false);
            child.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: pending.length, inserted: [], outcome: 'canceled' });
            pending.length = 0;
          } },
          followup(value) { assert.equal(pending.length, 0); queued = value; },
        };
        await options.setup({}, agent);
        published = true;
        sessions.set(child.id, child);
        return { agent, async dispose() {} };
      },
    },
  };
  apply(ctx);
  const request = Readable.from([JSON.stringify({ action: 'edit', sessionId: 'source', eventSeq: user.seq, blockIndex: 0, text: 'Edited' })]);
  request.method = 'POST'; request.url = '/message-tree';
  let status, result;
  await routes.get('/message-tree')(request, { writeHead(value) { status = value; }, end(value) { result = JSON.parse(value); } });
  assert.equal(status, 200, JSON.stringify(result));
  assert.equal(queued.content[0].text, 'Edited');
  assert.equal(child.snapshotEvents().filter(event => event.type === 'session/end-seed').length, 1);
  assert.equal(child.snapshotEvents()[child.inheritedEventCount - 1].data.sessionId, child.id);
  assert.deepEqual(source.snapshotEvents(), before);
  const restored = Session.fromRestore(child.id, structuredClone(child.snapshotEvents()), child.header, child.inheritedEventCount, 'owned');
  assert.equal(restored.inheritedEventCount, child.inheritedEventCount);
  const nativeFork = Session.create('native-fork', child.snapshotEvents(), {
    ...child.header, id: 'native-fork', parentSession: child.id,
  }, child.seq);
  sessions.set(nativeFork.id, nativeFork);
  const get = Readable.from([]);
  get.method = 'GET'; get.url = '/message-tree?sessionId=native-fork';
  await routes.get('/message-tree')(get, { writeHead(value) { status = value; }, end(value) { result = JSON.parse(value); } });
  assert.equal(status, 200, JSON.stringify(result));
  assert.equal(result.versions.find(version => version.sessionId === nativeFork.id).targetTurn, undefined,
    'A native fork must not adopt its parent\'s inherited plugin marker');
});
