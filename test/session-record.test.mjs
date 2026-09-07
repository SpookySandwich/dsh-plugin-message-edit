import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionEvents, sessionEventCount, sessionRecord } from '../lib/session-record.js';

test('live snapshot API takes precedence over a retired events getter', () => {
  const events = Object.freeze([]);
  const live = {
    header: { id: 'live', isSeeded: false }, seq: 0, inheritedEventCount: 0,
    snapshotEvents() { assert.equal(this, live); return events; },
    get events() { throw new Error('retired API'); },
  };
  assert.equal(sessionEvents(live), events);
  assert.equal(sessionRecord(live).events, events);
});

test('cache counts do not materialize a modern live log', () => {
  assert.equal(sessionEventCount({ seq: 42, snapshotEvents() { throw new Error('unnecessary copy'); } }), 42);
});

test('modern readSession snapshots carry their header in session', () => {
  const header = { id: 'cold', isSeeded: false };
  const record = sessionRecord({ session: header, events: [], inheritedEventCount: 0 });
  assert.equal(record.header, header);
});

test('missing or malformed histories fail visibly instead of becoming empty logs', () => {
  for (const source of [null, {}, { events: {} }, { snapshotEvents: () => null }]) {
    assert.throws(() => sessionEvents(source), /snapshotEvents\(\).*events/);
  }
});

test('seeded modern records require a valid inherited cut', () => {
  for (const cut of [undefined, -1, 2, 0.5]) {
    assert.throws(() => sessionRecord({
      header: { id: 'seeded', isSeeded: true }, events: [{}], inheritedEventCount: cut,
    }), /继承事件边界无效/);
  }
});
