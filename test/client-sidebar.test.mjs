import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function setup(prefs = { foldSidebar: true, rememberPath: true }) {
  const storage = new Map([['dsh-plugin-message-tree:prefs', JSON.stringify(prefs)]]);
  const cleanups = [];
  const effects = [];
  const Original = props => props;
  const entry = { component: Original, children: { native: {} }, store: {} };
  let plugin;
  const hooks = [];
  let hookIndex = 0;
  const React = {
    createElement: (type, props) => ({ type, props }),
    useReducer: () => [0, () => {}],
    useEffect: fn => effects.push(fn),
    useMemo: fn => fn(),
    useCallback(fn, deps) {
      const index = hookIndex++;
      const previous = hooks[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        hooks[index] = { value: fn, deps };
      }
      return hooks[index].value;
    },
    useRef(value) {
      const index = hookIndex++;
      return hooks[index] ||= { current: value };
    },
  };
  runInNewContext(bundle, {
    window: {
      __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } },
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    }, console,
  });
  const slots = {
    entriesOfSlot: () => [entry],
    inject(_name, fn) { const dispose = fn(); if (dispose) cleanups.push(dispose); },
    register: () => () => {},
  };
  plugin.apply({
    get: name => ({ slots, sessions: { list: {} }, uiWorkspace: { openSession() {} } })[name],
    effect: fn => fn(),
  });
  const row = (id, extra = {}) => ({ id, title: id, updatedAt: 1, running: false, retainedBy: {}, ...extra });
  let list = { phase: 'ready', ids: ['child', 'nested', 'root', 'other', 'orphan', 'subagent'], byId: {
    root: row('root'), child: row('child', { parentId: 'root', updatedAt: 10, running: true, retainedBy: { mainView: 1 } }),
    nested: row('nested', { parentId: 'child' }), other: row('other'),
    orphan: row('orphan', { parentId: 'missing' }), subagent: row('subagent', { origin: 'subagent', parentId: 'root' }),
  } };
  const workspace = { items: [{ id: 'workspace', sessionIds: ['child', 'nested', 'root', 'other'] }],
    pinnedSessionIds: ['child', 'root'], archivedSessionIds: ['nested'] };
  const opens = [];
  const viewState = { archivedFilter: 'default' };
  const statuses = new Map([['root', { running: false, completionUnread: false }],
    ['child', { running: true, completionUnread: false }]]);
  const props = {
    useSessions: selector => selector(list), useWorkspaces: selector => selector(workspace),
    useSessionStatus: selector => selector(statuses),
    useStore: selector => selector(viewState),
    open: id => opens.push(id), renderSlot() {},
    searchSessions: async () => ({ items: [{ sessionId: 'child', snippet: 'child match' }, { sessionId: 'nested' }, { sessionId: 'other' }], hasMore: false }),
  };
  function render() {
    hookIndex = 0;
    const result = entry.component(props);
    while (effects.length) effects.shift()();
    return result.props;
  }
  return { entry, Original, props, get list() { return list; }, set list(value) { list = value; }, workspace, viewState, storage, statuses, opens, render, cleanups };
}

test('folding is opt-in and preserves the original native sidebar props when disabled', () => {
  const h = setup({});
  assert.equal(h.render(), h.props);
});

test('folding projects nested versions into one row without mutating the real catalog', () => {
  const h = setup();
  const props = h.render();
  const list = props.useSessions(state => state);
  assert.deepEqual(Array.from(list.ids), ['root', 'other', 'orphan', 'subagent']);
  assert.equal(list.byId.root.title, 'root');
  assert.equal(list.byId.root.running, true);
  assert.equal(list.byId.root.updatedAt, 10);
  assert.equal(list.byId.root.retainedBy.mainView, 1);
  assert.equal(h.list.byId.root.running, false);
  assert.equal(h.list.byId.root.retainedBy.mainView, undefined);
  assert.equal(props.renderSlot, h.props.renderSlot);
  const workspace = props.useWorkspaces(state => state);
  assert.deepEqual(Array.from(workspace.items[0].sessionIds), ['root', 'other']);
  assert.deepEqual(Array.from(workspace.pinnedSessionIds), ['root']);
  assert.deepEqual(Array.from(workspace.archivedSessionIds), []);
});

test('opening the root honors rememberPath and skips archived remembered versions', () => {
  const h = setup();
  h.render().open('root');
  assert.deepEqual(h.opens, ['child']);
  h.workspace.archivedSessionIds.push('child');
  h.render().open('root');
  assert.deepEqual(h.opens, ['child', 'root']);
  const noRemember = setup({ foldSidebar: true, rememberPath: false });
  noRemember.render().open('root');
  assert.deepEqual(noRemember.opens, ['root']);
});

test('native search results are deduplicated without discarding snippets or paging metadata', async () => {
  const result = await setup().render().searchSessions('query');
  assert.deepEqual(Array.from(result.items, item => item.sessionId), ['root', 'other']);
  assert.equal(result.items[0].snippet, 'child match');
  assert.equal(result.hasMore, false);
});

test('one family search row opens the version supplying its snippet with rememberPath on or off', async () => {
  for (const rememberPath of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.list.byId.root.title = 'shared title';
    h.list.byId.child.retainedBy = {};
    h.list.byId.nested.retainedBy = { mainView: 1 };
    const props = h.render();
    const controller = new AbortController();
    const result = await props.searchSessions('shared', controller.signal);
    // Native deriveSearchResults merges local title rows with content by ID.
    const mergedIds = new Set(['root', ...result.items.map(item => item.sessionId)]);
    assert.equal(mergedIds.size, 2, 'one family plus the independent other session');
    assert.equal(result.items[0].snippet, 'child match');
    props.open(result.items[0].sessionId);
    assert.deepEqual(h.opens, ['child'], 'search intent overrides the remembered sibling');
  }
});

test('cleared search cannot redirect ordinary sidebar navigation', async () => {
  const h = setup({ foldSidebar: true, rememberPath: false });
  const props = h.render();
  const controller = new AbortController();
  await props.searchSessions('query', controller.signal);
  controller.abort();
  props.open('root');
  assert.deepEqual(h.opens, ['root']);
});

test('out-of-order search completion cannot overwrite the current click target', async () => {
  const h = setup({ foldSidebar: true, rememberPath: false });
  h.workspace.archivedSessionIds = [];
  const pending = new Map();
  h.props.searchSessions = query => new Promise(resolve => pending.set(query, resolve));
  const props = h.render();
  const first = new AbortController();
  const old = props.searchSessions('old', first.signal);
  first.abort();
  const current = props.searchSessions('new', new AbortController().signal);
  pending.get('new')({ items: [{ sessionId: 'nested', snippet: 'new' }], hasMore: false });
  await current;
  pending.get('old')({ items: [{ sessionId: 'child', snippet: 'old' }], hasMore: false });
  await old;
  props.open('root');
  assert.deepEqual(h.opens, ['nested']);
});

test('search targets are consumed on click and never implicitly open archived versions', async () => {
  const h = setup({ foldSidebar: true, rememberPath: false });
  let notified = 0;
  h.props.notifyArchivedNotOpenable = () => notified++;
  const props = h.render();
  await props.searchSessions('query', new AbortController().signal);
  props.open('root');
  props.open('root');
  assert.deepEqual(h.opens, ['child', 'root']);
  await props.searchSessions('query', new AbortController().signal);
  h.workspace.archivedSessionIds.push('child');
  props.open('root');
  assert.equal(notified, 1);
  assert.deepEqual(h.opens, ['child', 'root']);
});

test('grouping off keeps each native search target and ordinary navigation intact', async () => {
  const h = setup({ foldSidebar: false, rememberPath: false });
  const props = h.render();
  const result = await props.searchSessions('query', new AbortController().signal);
  assert.deepEqual(result.items.map(item => item.sessionId), ['child', 'nested', 'other']);
  props.open(result.items[0].sessionId);
  assert.deepEqual(h.opens, ['child']);
});

test('hidden title fallback navigates to the matching version even without content search', async () => {
  const h = setup({ foldSidebar: true, rememberPath: false });
  h.props.searchSessions = async () => { throw new Error('index disabled'); };
  h.list.byId.child.title = 'unique hidden title';
  const props = h.render();
  const result = await props.searchSessions('unique hidden', new AbortController().signal);
  props.open(result.items[0].sessionId);
  assert.deepEqual(h.opens, ['child']);
});

test('unloading restores the native component and leaves its declarations/store intact', () => {
  const h = setup();
  const children = h.entry.children;
  const store = h.entry.store;
  assert.notEqual(h.entry.component, h.Original);
  for (const dispose of h.cleanups.reverse()) dispose();
  assert.equal(h.entry.component, h.Original);
  assert.equal(h.entry.children, children);
  assert.equal(h.entry.store, store);
});

test('a cyclic or missing lineage never hangs and keeps visible rows', () => {
  const h = setup();
  h.list.byId.root.parentId = 'nested';
  assert.ok(h.render().useSessions(state => state.ids).length > 0);
});

test('a family in multiple workspaces appears only in the original conversation workspace', () => {
  const h = setup();
  h.workspace.items = [{ id: 'children', sessionIds: ['child', 'nested'] },
    { id: 'original', sessionIds: ['root', 'other'] }];
  const items = h.render().useWorkspaces(state => state.items);
  assert.deepEqual(Array.from(items[0].sessionIds), []);
  assert.deepEqual(Array.from(items[1].sessionIds), ['root', 'other']);
});

test('a child pin does not make the root appear pinned while its native action still says Pin', () => {
  const h = setup();
  h.workspace.pinnedSessionIds = ['child'];
  assert.deepEqual(Array.from(h.render().useWorkspaces(state => state.pinnedSessionIds)), []);
});

test('arrival of a missing original groups existing descendants without a reload', () => {
  const h = setup();
  const root = h.list.byId.root;
  delete h.list.byId.root;
  assert.ok(h.render().useSessions(state => state.ids).includes('child'));
  h.list.byId.root = root;
  assert.deepEqual(Array.from(h.render().useSessions(state => state.ids)), ['root', 'other', 'orphan', 'subagent']);
});

test('native status snapshots do not override aggregated child activity with an idle root', () => {
  const h = setup();
  const statuses = h.render().useSessionStatus(state => state);
  assert.equal(statuses.get('root').running, true);
  assert.equal(h.statuses.get('root').running, false);
  h.statuses.set('child', { running: false, completionUnread: true });
  assert.equal(h.render().useSessionStatus(state => state).get('root').completionUnread, true);
});

test('a grouped completion opens its unread source before the remembered sibling or original', () => {
  for (const rememberPath of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.workspace.archivedSessionIds = [];
    h.list.byId.child.retainedBy = {};
    h.list.byId.nested.retainedBy = { mainView: 1 };
    h.statuses.set('child', { running: false, completionUnread: true });
    const props = h.render();
    assert.equal(props.useSessionStatus(s => s).get('root').completionUnread, true);
    props.open('root');
    assert.deepEqual(h.opens, ['child'], 'the grouped Completed indicator must lead to its source');
    assert.equal(h.statuses.get('child').completionUnread, true, 'only the host may mark the opened session read');
  }
});

test('pending interactions outrank unread completions and remain owned by their actual session', () => {
  for (const kind of ['approval', 'plan-review', 'question']) for (const rememberPath of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.workspace.archivedSessionIds = [];
    const interaction = { kind, sessionId: 'nested', requestId: 'owned-request' };
    h.statuses.set('root', { running: false, completionUnread: true });
    h.statuses.set('child', { running: false, completionUnread: true });
    h.statuses.set('nested', { running: true, pendingInteraction: interaction });
    const props = h.render();
    assert.equal(props.useSessionStatus(s => s).get('root').pendingInteraction, interaction);
    props.open('root');
    assert.deepEqual(h.opens, ['nested']);
    assert.equal(h.statuses.get('root').completionUnread, true);
    assert.equal(h.statuses.get('child').completionUnread, true);
    assert.equal(h.statuses.get('nested').pendingInteraction, interaction);
  }
});

test('multiple actionable versions use root then catalog order within each priority without bulk acknowledgement', () => {
  const h = setup();
  h.workspace.archivedSessionIds = [];
  for (const id of ['root', 'child', 'nested']) h.statuses.set(id, { running: false, completionUnread: true });
  h.render().open('root');
  assert.equal(h.opens.at(-1), 'root');
  assert.equal(JSON.parse(h.storage.get('dsh-plugin-message-tree:active-path')).root, 'root', 'explicit root selection survives bubble restore');
  h.statuses.set('root', { running: false, completionUnread: false }); // native read acknowledgement
  h.render().open('root');
  assert.equal(h.opens.at(-1), 'child');
  assert.equal(h.statuses.get('nested').completionUnread, true);
  h.statuses.set('child', { running: false, completionUnread: false });
  h.render().open('root');
  assert.equal(h.opens.at(-1), 'nested');
  for (const id of ['root', 'child', 'nested']) h.statuses.set(id, { pendingInteraction: { kind: 'approval', sessionId: id } });
  const props = h.render();
  assert.equal(props.useSessionStatus(s => s).get('root').pendingInteraction.sessionId, 'root');
  props.open('root');
  assert.equal(h.opens.at(-1), 'root');
});

test('archived, removed, blank, byId-only and subagent flags cannot create an unreachable family indicator', () => {
  for (const exclude of ['archived', 'removed', 'blank', 'byId-only', 'subagent']) {
    const h = setup({ foldSidebar: true, rememberPath: false });
    h.statuses.set('child', { running: false, completionUnread: true, pendingInteraction: { kind: 'approval' } });
    if (exclude === 'archived') h.workspace.archivedSessionIds.push('child');
    if (exclude === 'removed') delete h.list.byId.child;
    if (exclude === 'blank') h.list.byId.child.blank = true;
    if (exclude === 'byId-only') { h.list.ids = h.list.ids.filter(id => id !== 'child' && id !== 'nested'); }
    if (exclude === 'subagent') h.list.byId.child.origin = 'subagent';
    const props = h.render(), root = props.useSessionStatus(s => s).get('root');
    assert.equal(root.completionUnread, false, exclude);
    assert.equal(root.pendingInteraction, undefined, exclude);
    props.open('root');
    assert.deepEqual(h.opens, ['root'], exclude);
    assert.equal(h.statuses.get('child').completionUnread, true, 'projection must not delete source flags');
  }
});

test('old click handlers use refreshed status, archive and catalog snapshots', () => {
  for (const change of ['cleared', 'archived', 'removed']) {
    const h = setup({ foldSidebar: true, rememberPath: false });
    h.statuses.set('child', { running: false, completionUnread: true });
    const old = h.render();
    if (change === 'cleared') h.statuses.set('child', { running: false, completionUnread: false });
    if (change === 'archived') h.workspace.archivedSessionIds = ['child'];
    if (change === 'removed') h.list = { ...h.list, ids: h.list.ids.filter(id => id !== 'child' && id !== 'nested'), byId: { root: h.list.byId.root, other: h.list.byId.other } };
    h.render();
    old.open('root');
    assert.deepEqual(h.opens, ['root'], change);
  }
});

test('explicit root or child search hits outrank other pending and unread family members', async () => {
  for (const target of ['root', 'child']) for (const rememberPath of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.workspace.archivedSessionIds = [];
    h.statuses.set('child', { running: false, completionUnread: true });
    h.statuses.set('nested', { running: true, pendingInteraction: { kind: 'approval' } });
    h.props.searchSessions = async () => ({ items: [{ sessionId: target, snippet: 'explicit hit' }], hasMore: false });
    const props = h.render();
    await props.searchSessions('explicit', new AbortController().signal);
    props.open('root');
    assert.equal(h.opens.at(-1), target);
    props.open('root');
    assert.equal(h.opens.at(-1), 'nested', 'consumed search target must not mask pending work on the next ordinary click');
  }
});

test('unknown pending kinds and stale unread on a running version preserve ordinary navigation', () => {
  for (const rememberPath of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.statuses.set('child', { running: true, completionUnread: true, pendingInteraction: { kind: 'unknown' } });
    const props = h.render(), root = props.useSessionStatus(s => s).get('root');
    assert.equal(root.pendingInteraction, undefined);
    assert.equal(root.completionUnread, false);
    props.open('root');
    assert.deepEqual(h.opens, [rememberPath ? 'child' : 'root']);
  }
});

test('subagents outside catalog ids remain available to native child activity projection', () => {
  const h = setup();
  h.list.ids = h.list.ids.filter(id => id !== 'subagent');
  assert.equal(h.render().useSessions(state => state.byId.subagent), h.list.byId.subagent);
});

test('grouped rows count running subagents owned by hidden versions without double-counting inherited catalogs', () => {
  const h = setup();
  h.list.projectionsBySession = {
    root: { state: 'idle', values: { title: 'root', subagentCatalog: [{ id: 'shared-agent' }] } },
    child: { state: 'idle', values: { title: 'child', subagentCatalog: [{ id: 'shared-agent' }, { id: 'child-agent' }] } },
    nested: { values: { subagentCatalog: [{ id: 'child-agent' }] } },
  };
  h.list.byId['shared-agent'] = { id: 'shared-agent', origin: 'subagent', running: true, retainedBy: {} };
  h.list.byId['child-agent'] = { id: 'child-agent', origin: 'subagent', running: true, retainedBy: {} };
  const projected = h.render().useSessions(state => state);
  const catalog = projected.projectionsBySession.root.values.subagentCatalog;
  assert.deepEqual(Array.from(catalog, child => child.id), ['shared-agent', 'child-agent']);
  // Native runningChildCount reads this catalog, status map, then byId fallback.
  assert.equal(catalog.filter(child => projected.byId[child.id]?.running).length, 2);
  assert.equal(projected.projectionsBySession.root.values.title, 'root');
  assert.equal(h.list.projectionsBySession.root.values.subagentCatalog.length, 1);
});

test('searching a renamed branch or its id still finds the family when host content search is disabled', async () => {
  const h = setup();
  h.list.byId.child.title = 'Special branch title';
  h.props.searchSessions = async () => { throw new Error('content search disabled'); };
  for (const query of ['special branch', 'child']) {
    const result = await h.render().searchSessions(query);
    assert.deepEqual(Array.from(result.items, row => row.sessionId), ['root']);
  }
  await assert.rejects(h.render().searchSessions('no matching branch'), /content search disabled/);
});

test('bounded native search preserves its refine hint and cancellation', async () => {
  const h = setup();
  h.props.searchSessions = async () => ({ items: [{ sessionId: 'child', snippet: 'first' }, { sessionId: 'nested', snippet: 'second' }], hasMore: true });
  const result = await h.render().searchSessions('child');
  assert.deepEqual(Array.from(result.items, row => row.sessionId), ['root']);
  assert.equal(result.items[0].snippet, 'first');
  assert.equal(result.hasMore, true);
  h.props.searchSessions = async () => { throw new Error('aborted'); };
  await assert.rejects(h.render().searchSessions('child', { aborted: true }), /aborted/);
});

test('equal titles without recorded parentage never merge independent originals', () => {
  const h = setup();
  h.list.byId.other.title = h.list.byId.root.title;
  const ids = h.render().useSessions(state => state.ids);
  assert.ok(ids.includes('root'));
  assert.ok(ids.includes('other'));
});

test('catalog and status updates keep the search callback stable while new queries see fresh hidden versions', async () => {
  const h = setup();
  h.props.searchSessions = async () => ({ items: [], hasMore: false });
  const search = h.render().searchSessions;
  h.list = { ...h.list, ids: [...h.list.ids, 'new-child'], byId: { ...h.list.byId,
    'new-child': { ...h.list.byId.child, id: 'new-child', title: 'Fresh hidden title', parentId: 'root' },
    child: { ...h.list.byId.child, running: false },
  } };
  h.statuses.set('child', { running: false, completionUnread: true });
  assert.equal(h.render().searchSessions, search, 'native search effect must not restart for background catalog activity');
  assert.deepEqual(Array.from((await search('Fresh hidden')).items, row => row.sessionId), ['root']);
  h.props.searchSessions = async () => { throw new Error('index disabled'); };
  const fallback = h.render().searchSessions;
  assert.notEqual(fallback, search, 'a changed host search provider must be used');
  assert.deepEqual(Array.from((await fallback('Fresh hidden')).items, row => row.sessionId), ['root']);
});

test('default FTS-off shared-title search preserves ordinary navigation and the remembered path', async () => {
  for (const rememberPath of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.workspace.archivedSessionIds = [];
    h.list.byId.root.title = h.list.byId.child.title = 'Shared conversation title';
    h.list.byId.child.retainedBy = {};
    h.list.byId.nested.retainedBy = { mainView: 1 };
    h.props.searchSessions = async () => { throw new Error('SESSION_QUERY_SEARCH_DISABLED'); };
    const props = h.render();
    const result = await props.searchSessions('shared conversation', new AbortController().signal);
    assert.deepEqual(Array.from(result.items, item => item.sessionId), ['root']);
    assert.equal(result.items[0].snippet, undefined);
    props.open('root');
    assert.deepEqual(h.opens, [rememberPath ? 'nested' : 'root']);
    assert.equal(JSON.parse(h.storage.get('dsh-plugin-message-tree:active-path')).root, 'nested');
  }
});

test('workspace and root-ID matches with empty or pending search retain ordinary remember behavior', async () => {
  for (const query of ['workspace label', 'root']) for (const pending of [true, false]) for (const rememberPath of [true, false]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.workspace.items[0].title = 'Workspace label';
    let resolve;
    h.props.searchSessions = () => new Promise(done => { resolve = done; });
    const props = h.render();
    const search = props.searchSessions(query, new AbortController().signal);
    if (!pending) { resolve({ items: [], hasMore: false }); await search; }
    props.open('root');
    assert.deepEqual(h.opens, [rememberPath ? 'child' : 'root']);
    assert.equal(JSON.parse(h.storage.get('dsh-plugin-message-tree:active-path')).root, 'child');
    if (pending) { resolve({ items: [], hasMore: false }); await search; }
    props.open('root');
    assert.equal(h.opens[1], rememberPath ? 'child' : 'root', 'late completion cannot reactivate a consumed request');
  }
});

test('shared-title hits without displayed content keep ordinary navigation', async () => {
  for (const item of [{ sessionId: 'root' }, { sessionId: 'root', snippet: '' }, { sessionId: 'child' }, { sessionId: 'child', snippet: '' }]) {
    for (const rememberPath of [false, true]) {
      const h = setup({ foldSidebar: true, rememberPath });
      h.workspace.archivedSessionIds = [];
      h.list.byId.root.title = h.list.byId.child.title = 'shared title';
      h.list.byId.child.retainedBy = {};
      h.list.byId.nested.retainedBy = { mainView: 1 };
      h.props.searchSessions = async () => ({ items: [item], hasMore: false });
      const props = h.render();
      const result = await props.searchSessions('shared', new AbortController().signal);
      assert.equal(result.items.length, 1);
      props.open('root');
      assert.deepEqual(h.opens, [rememberPath ? 'nested' : 'root']);
      assert.equal(JSON.parse(h.storage.get('dsh-plugin-message-tree:active-path')).root, 'nested');
    }
  }
});

test('a displayed root-content snippet opens the original instead of its remembered edited version', async () => {
  for (const rememberPath of [true, false]) for (const rootTitleMatches of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.workspace.archivedSessionIds = [];
    h.list.byId.root.title = rootTitleMatches ? 'OriginalOnly' : 'Renamed conversation';
    h.list.byId.child.retainedBy = {};
    h.list.byId.nested.retainedBy = { mainView: 1 };
    h.props.searchSessions = async () => ({ items: [{ sessionId: 'root', snippet: 'OriginalOnly wording before the edit' }], hasMore: false });
    const props = h.render();
    const result = await props.searchSessions('OriginalOnly', new AbortController().signal);
    assert.deepEqual(Array.from(result.items, item => [item.sessionId, item.snippet]), [['root', 'OriginalOnly wording before the edit']]);
    props.open(result.items[0].sessionId);
    assert.deepEqual(h.opens, ['root']);
    assert.equal(JSON.parse(h.storage.get('dsh-plugin-message-tree:active-path')).root, 'root', 'the bubble-level restore must not undo explicit root navigation');
  }
});

test('the first displayed nonempty snippet outranks earlier hits without content and selects its root or hidden version', async () => {
  for (const target of ['nested', 'root']) for (const emptySnippet of [undefined, '']) for (const rememberPath of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.workspace.archivedSessionIds = [];
    const later = target === 'root' ? 'nested' : 'root';
    h.props.searchSessions = async () => ({ items: [
      { sessionId: 'child', ...(emptySnippet === undefined ? {} : { snippet: emptySnippet }) },
      { sessionId: target, snippet: `first displayed content from ${target}` },
      { sessionId: later, snippet: 'later content from another family member' },
      { sessionId: 'other', snippet: 'independent conversation content' },
    ], hasMore: true });
    const props = h.render();
    const result = await props.searchSessions('content', new AbortController().signal);
    assert.deepEqual(Array.from(result.items, item => [item.sessionId, item.snippet]), [
      ['root', `first displayed content from ${target}`], ['other', 'independent conversation content'],
    ]);
    assert.equal(result.hasMore, true);
    props.open('root');
    assert.deepEqual(h.opens, [target]);
  }
});

test('root workspace label and cwd matches outrank a hidden title without a content snippet', async () => {
  for (const cwd of [undefined, 'C:\\projects\\Workspace label\\', '/projects/Workspace label/']) {
    const h = setup();
    h.workspace.archivedSessionIds = [];
    h.workspace.items[0].title = 'Workspace label';
    if (cwd) { h.workspace.items = []; h.list.byId.root.cwd = cwd; }
    h.list.byId.child.title = 'Workspace label branch';
    h.list.byId.child.retainedBy = {};
    h.list.byId.nested.retainedBy = { mainView: 1 };
    h.props.searchSessions = async () => ({ items: [], hasMore: false });
    const props = h.render();
    await props.searchSessions('workspace label', new AbortController().signal);
    props.open('root');
    assert.deepEqual(h.opens, ['nested']);
  }
});

test('default archive filter drops archived snippets before choosing an openable matching version', async () => {
  const h = setup({ foldSidebar: true, rememberPath: false });
  h.workspace.archivedSessionIds = ['child'];
  h.props.searchSessions = async () => ({ items: [
    { sessionId: 'child', snippet: 'archived match' }, { sessionId: 'nested', snippet: 'live match' },
  ], hasMore: true });
  const props = h.render();
  const result = await props.searchSessions('match', new AbortController().signal);
  assert.deepEqual(Array.from(result.items, item => [item.sessionId, item.snippet]), [['root', 'live match']]);
  assert.equal(result.hasMore, true);
  props.open('root');
  assert.deepEqual(h.opens, ['nested']);
});

test('archived shared-title children cannot block the matching root or live title sibling with FTS off', async () => {
  for (const rootMatches of [true, false]) for (const rememberPath of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath });
    h.workspace.archivedSessionIds = ['child'];
    h.list.byId.child.title = h.list.byId.nested.title = 'Shared title';
    h.list.byId.root.title = rootMatches ? 'Shared title' : 'Different root';
    h.props.searchSessions = async () => { throw new Error('SESSION_QUERY_SEARCH_DISABLED'); };
    const props = h.render();
    const result = await props.searchSessions('shared title', new AbortController().signal);
    props.open(result.items[0].sessionId);
    assert.deepEqual(h.opens, [rootMatches ? 'root' : 'nested'], 'archived remembered child is skipped on the ordinary root path');
  }
});

test('an archived-only match is hidden by default and not redirected to an unrelated root when shown', async () => {
  const h = setup();
  h.workspace.archivedSessionIds = ['child'];
  h.props.searchSessions = async () => ({ items: [{ sessionId: 'child', snippet: 'unique archived content' }], hasMore: false });
  assert.equal((await h.render().searchSessions('unique archived', new AbortController().signal)).items.length, 0);
  h.viewState.archivedFilter = 'show';
  let notified = 0;
  h.props.notifyArchivedNotOpenable = () => notified++;
  const props = h.render();
  const result = await props.searchSessions('unique archived', new AbortController().signal);
  assert.equal(result.items[0].snippet, 'unique archived content');
  props.open(result.items[0].sessionId);
  assert.equal(notified, 1);
  assert.deepEqual(h.opens, []);
});

test('show-archived prefers a matching live root or sibling over an archived hit', async () => {
  for (const rootMatches of [false, true]) {
    const h = setup({ foldSidebar: true, rememberPath: false });
    h.workspace.archivedSessionIds = ['child'];
    h.viewState.archivedFilter = 'show';
    h.list.byId.root.title = rootMatches ? 'needle' : 'different';
    h.list.byId.nested.title = rootMatches ? 'unrelated' : 'needle';
    h.props.searchSessions = async () => ({ items: [{ sessionId: 'child', snippet: 'archived needle' }], hasMore: false });
    const props = h.render();
    const result = await props.searchSessions('needle', new AbortController().signal);
    assert.equal(result.items[0].snippet, undefined);
    props.open('root');
    assert.deepEqual(h.opens, [rootMatches ? 'root' : 'nested']);
  }
});

test('root-owned archive visibility also governs grouped search in default, show and only modes', async () => {
  const h = setup();
  h.workspace.archivedSessionIds = ['root'];
  h.props.searchSessions = async () => ({ items: [
    { sessionId: 'child', snippet: 'live child' }, { sessionId: 'root', snippet: 'archived root' },
  ], hasMore: false });
  assert.equal((await h.render().searchSessions('query', new AbortController().signal)).items.length, 0);
  h.viewState.archivedFilter = 'only';
  let notified = 0;
  h.props.notifyArchivedNotOpenable = () => notified++;
  const props = h.render();
  const result = await props.searchSessions('query', new AbortController().signal);
  assert.deepEqual(Array.from(result.items, item => [item.sessionId, item.snippet]), [['root', 'archived root']]);
  props.open('root');
  assert.equal(notified, 1);
  assert.deepEqual(h.opens, []);
  h.workspace.archivedSessionIds = ['child'];
  assert.equal((await h.render().searchSessions('query', new AbortController().signal)).items.length, 0, 'only-archived does not invent an archived family from a live root');
});

test('archive membership and visibility refresh search, while unchanged archive state keeps the callback stable', async () => {
  const h = setup();
  const first = h.render().searchSessions;
  h.workspace.archivedSessionIds = [...h.workspace.archivedSessionIds];
  assert.equal(h.render().searchSessions, first);
  h.workspace.archivedSessionIds.push('child');
  const archived = h.render().searchSessions;
  assert.notEqual(archived, first);
  h.workspace.archivedSessionIds.reverse();
  assert.equal(h.render().searchSessions, archived, 'archive order alone does not restart search');
  assert.deepEqual(Array.from((await archived('query', new AbortController().signal)).items, item => item.sessionId), ['other']);
  h.viewState.archivedFilter = 'show';
  const shown = h.render().searchSessions;
  assert.notEqual(shown, archived);
  assert.deepEqual(Array.from((await shown('query', new AbortController().signal)).items, item => item.sessionId), ['root', 'other']);
});

test('pending search uses the current archive membership when results arrive', async () => {
  const h = setup({ foldSidebar: true, rememberPath: false });
  let resolve;
  h.workspace.archivedSessionIds = [];
  h.props.searchSessions = () => new Promise(done => { resolve = done; });
  const pending = h.render().searchSessions('needle', new AbortController().signal);
  h.workspace.archivedSessionIds = ['child'];
  const props = h.render();
  resolve({ items: [{ sessionId: 'child', snippet: 'archived needle' }, { sessionId: 'nested', snippet: 'live needle' }], hasMore: false });
  const result = await pending;
  assert.equal(result.items[0].snippet, 'live needle');
  props.open('root');
  assert.deepEqual(h.opens, ['nested']);
});

test('cancelled search leaves a remembered sibling intact and grouping off delegates archive policy unchanged', async () => {
  const h = setup();
  h.workspace.archivedSessionIds = [];
  h.list.byId.child.retainedBy = {};
  h.list.byId.nested.retainedBy = { mainView: 1 };
  const props = h.render();
  const controller = new AbortController();
  await props.searchSessions('query', controller.signal);
  controller.abort();
  props.open('root');
  assert.deepEqual(h.opens, ['nested']);
  assert.equal(JSON.parse(h.storage.get('dsh-plugin-message-tree:active-path')).root, 'nested');
  const off = setup({ foldSidebar: false, rememberPath: true });
  off.workspace.archivedSessionIds = ['root', 'child'];
  off.viewState.archivedFilter = 'only';
  assert.equal(off.render(), off.props);
  assert.deepEqual((await off.render().searchSessions('query')).items.map(item => item.sessionId), ['child', 'nested', 'other']);
});
