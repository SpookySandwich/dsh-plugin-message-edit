// dsh-plugin-message-tree — client half.
//
// Mimics ChatGPT's edit-message behavior: hover a past prompt to edit it,
// sending branches the conversation from that point (the host half performs
// the true rewind); ‹ 2/3 › switches between versions of the same message;
// a Versions view draws the whole tree.

// Route, CSS prefix and storage keys keep the `message-tree` spelling even
// though the package is dsh-plugin-message-edit: Moeblack's dsh-message-edit
// owns the `message-edit` names, and colliding would break both plugins when
// installed together. See lib/index.js for the full note.
const ROUTE = '/message-tree';
const VIEW_ORDER = 16;

function realGlobal() {
  try { if (typeof window !== 'undefined' && window) return window; } catch (e) {}
  try { if (typeof globalThis !== 'undefined' && globalThis) return globalThis; } catch (e) {}
  return null;
}

/* ------------------------------------------------------------- edit style -- */

// Which provider's message-edit LAYOUT to follow. All three put the controls
// below the bubble; what differs is which controls exist (only Claude offers
// retry), whether they wait for hover (ChatGPT and Claude) or stay visible
// (DeepSeek, like DSH itself), and whether the editor's Cancel/confirm sit
// inside the box or below it. Colours stay native in every preset. The choice
// is one attribute on <html>, so the stylesheet keys off it and switching
// takes effect live.
const STYLE_KEY = 'dsh-plugin-message-tree:style';
const STYLES = ['chatgpt', 'deepseek', 'claude'];
const DEFAULT_STYLE = 'chatgpt';

const styleStore = {
  value: null,
  listeners: [],
  get() {
    if (this.value === null) {
      const g = realGlobal();
      let stored = null;
      try { stored = g && g.localStorage && g.localStorage.getItem(STYLE_KEY); } catch (e) {}
      this.value = STYLES.indexOf(stored) !== -1 ? stored : DEFAULT_STYLE;
    }
    return this.value;
  },
  set(next) {
    this.value = STYLES.indexOf(next) !== -1 ? next : DEFAULT_STYLE;
    const g = realGlobal();
    try { if (g && g.localStorage) g.localStorage.setItem(STYLE_KEY, this.value); } catch (e) {}
    syncStyleAttribute();
    for (let i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](); } catch (e) {}
    }
  },
  subscribe(fn) {
    const listeners = this.listeners;
    listeners.push(fn);
    return function () {
      const at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  },
};

function syncStyleAttribute() {
  const g = realGlobal();
  const root = g && g.document && g.document.documentElement;
  if (root) root.setAttribute('data-mtx-style', styleStore.get());
}

/* ----------------------------------------------------------- active path -- */

// A version IS a whole session, so "which version am I looking at" is just
// "which session is open". Reopening a conversation lands on whichever session
// the sidebar points at — normally the family root — so a branch you had
// selected is silently dropped and the ring snaps back to 1/N.
//
// Remember the last session viewed for each family, keyed by the family's root,
// and restore it when you land back on that root. Recording happens for every
// family member you view, so walking the ring back to the root records the root
// and the restore then correctly does nothing (no ping-pong).
const PATH_KEY = 'dsh-plugin-message-tree:active-path';
const PATH_LIMIT = 200;

const activePathStore = {
  map: null,
  read() {
    if (this.map === null) {
      let parsed = null;
      try {
        const g = realGlobal();
        const raw = g && g.localStorage && g.localStorage.getItem(PATH_KEY);
        parsed = raw ? JSON.parse(raw) : null;
      } catch (e) {}
      this.map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    return this.map;
  },
  get(rootId) {
    if (!rootId) return undefined;
    const v = this.read()[rootId];
    return typeof v === 'string' ? v : undefined;
  },
  set(rootId, sessionId) {
    if (!rootId || !sessionId) return;
    const map = this.read();
    if (map[rootId] === sessionId) return;
    map[rootId] = sessionId;
    // Bound the map so a long-lived profile cannot grow it without limit.
    // Object key order is insertion order for string keys, so the oldest
    // entries are at the front.
    const keys = Object.keys(map);
    if (keys.length > PATH_LIMIT) {
      for (let i = 0; i < keys.length - PATH_LIMIT; i++) delete map[keys[i]];
    }
    try {
      const g = realGlobal();
      if (g && g.localStorage) g.localStorage.setItem(PATH_KEY, JSON.stringify(map));
    } catch (e) {}
  },
};

/** The family root for `sessionId`: walk parents until one has none. */
function rootOf(versions, sessionId) {
  if (!versions || sessionId === undefined) return undefined;
  const byId = new Map(versions.map(function (v) { return [v.sessionId, v]; }));
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

// Families already restored in this page load. Without this the restore would
// re-fire on every re-render and fight a deliberate walk back to the root.
const restoredFamilies = new Set();
// Restores that have been triggered but whose navigation has not landed yet.
// While a root is in here we must not record it as the selection.
const pendingRestore = new Set();

/* --------------------------------------------------------------- prefs -- */

// Behaviour toggles, persisted next to the style choice. Both default to the
// behaviour the user asked for rather than the old one.
const PREFS_KEY = 'dsh-plugin-message-tree:prefs';
const PREFS_DEFAULTS = {
  // Restore the last-viewed branch when reopening a conversation.
  rememberPath: true,
  // Cancel a still-running turn before an edit forks the conversation.
  stopOnEdit: true,
};

const prefsStore = {
  value: null,
  listeners: [],
  get() {
    if (this.value === null) {
      let parsed = null;
      try {
        const g = realGlobal();
        const raw = g && g.localStorage && g.localStorage.getItem(PREFS_KEY);
        parsed = raw ? JSON.parse(raw) : null;
      } catch (e) {}
      const out = {};
      for (const k in PREFS_DEFAULTS) {
        out[k] = parsed && typeof parsed[k] === 'boolean' ? parsed[k] : PREFS_DEFAULTS[k];
      }
      this.value = out;
    }
    return this.value;
  },
  set(patch) {
    const next = Object.assign({}, this.get(), patch);
    this.value = next;
    try {
      const g = realGlobal();
      if (g && g.localStorage) g.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch (e) {}
    for (let i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](); } catch (e) {}
    }
  },
  subscribe(fn) {
    const listeners = this.listeners;
    listeners.push(fn);
    return function () {
      const at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  },
};

function usePrefs() {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return prefsStore.subscribe(force); }, []);
  return prefsStore.get();
}

function useStyle() {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return styleStore.subscribe(force); }, []);
  return styleStore.get();
}

/* ------------------------------------------------------- timeline store -- */

// One cached tree per session, shared by bubbles and the Versions view.
const treeStore = {
  bySession: new Map(),
  listeners: [],
  get(sessionId) {
    return this.bySession.get(sessionId) || null;
  },
  notify() {
    for (let i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](); } catch (e) {}
    }
  },
  subscribe(fn) {
    const listeners = this.listeners;
    listeners.push(fn);
    return function () {
      const at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  },
  async load(sessionId) {
    const g = realGlobal();
    if (!g || typeof g.fetch !== 'function') return;
    const entry = this.bySession.get(sessionId);
    if (entry && entry.loading) return;
    this.bySession.set(sessionId, Object.assign({ versions: null }, entry, { loading: true }));
    try {
      const res = await g.fetch(ROUTE + '?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      this.bySession.set(sessionId, { versions: data.versions, loading: false, error: null });
    } catch (e) {
      this.bySession.set(sessionId, { versions: null, loading: false, error: String(e && e.message || e) });
    }
    this.notify();
  },
  ensure(sessionId) {
    if (!this.bySession.has(sessionId)) this.load(sessionId);
  },
  invalidate() {
    this.bySession.clear();
    this.notify();
  },
};

function useTree(sessionId) {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return treeStore.subscribe(force); }, []);
  React.useEffect(function () { if (sessionId) treeStore.ensure(sessionId); }, [sessionId]);
  return sessionId ? treeStore.get(sessionId) : null;
}

/**
 * The ‹ › ring for the message at `turn` while viewing `sessionId`.
 *
 * Versions are whole sessions: an edit creates a child rewound to before the
 * turn. Walking up from the current session, sessions whose edit targets a
 * LATER turn still inherit this one, so they are skipped; landing on a
 * session that targets exactly this turn means we are viewing one of its
 * alternatives, whose original lives in that session's parent.
 */
function ringFor(versions, sessionId, turn) {
  if (!versions) return null;
  const byId = new Map(versions.map(function (v) { return [v.sessionId, v]; }));
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
  function walksToFork(start) {
    let x = start;
    const seen = new Set();
    while (x && !seen.has(x.sessionId)) {
      seen.add(x.sessionId);
      if (x.sessionId === fork.sessionId) return true;
      if (typeof x.targetTurn !== 'number' || x.targetTurn !== turn) return false;
      x = x.parentSessionId ? byId.get(x.parentSessionId) : null;
    }
    return false;
  }
  // A deleted (ghost) version still anchors the fork and still bridges the
  // parent walks above, but it cannot be opened, so it never appears among
  // the alternatives: the ring renumbers over the survivors.
  const alternatives = versions
    .filter(function (v) {
      return !v.deleted && (v.sessionId === fork.sessionId || (v.targetTurn === turn && walksToFork(v)));
    })
    .sort(function (a, b) {
      return a.createdAt - b.createdAt || String(a.sessionId).localeCompare(String(b.sessionId));
    });
  if (alternatives.length < 2) return null;
  let index = alternatives.findIndex(function (v) { return v.sessionId === cursor.sessionId; });
  if (index === -1) index = alternatives.findIndex(function (v) { return v.sessionId === sessionId; });
  if (index === -1) index = 0;
  return { alternatives: alternatives, index: index };
}

/* ------------------------------------------------------------ mutations -- */

function openWhenListed(sessions, sessionId) {
  const list = sessions.list;
  if (!list || typeof list.getSnapshot !== 'function') { sessions.open(sessionId); return; }
  if (list.getSnapshot().byId[sessionId] !== undefined) { sessions.open(sessionId); return; }
  const stop = list.subscribe(function () {
    if (list.getSnapshot().byId[sessionId] !== undefined) {
      stop();
      sessions.open(sessionId);
    }
  });
}

async function mutate(operation) {
  const g = realGlobal();
  const res = await g.fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(operation),
  });
  const body = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

/* ---------------------------------------------------------------- utils -- */

function contentText(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block && block.type === 'text' && typeof block.text === 'string') {
      out += (out ? '\n' : '') + block.text;
    }
  }
  return out;
}

function firstTextBlockIndex(content) {
  if (!Array.isArray(content)) return -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] && content[i].type === 'text') return i;
  }
  return -1;
}

function imageCount(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] && content[i].type === 'image') n += 1;
  }
  return n;
}

function clip(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function timeLabel(ms) {
  try {
    const d = new Date(ms);
    const p = function (n) { return n < 10 ? '0' + n : String(n); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (e) {
    return '';
  }
}

/* ---------------------------------------------------------- graph layout -- */

const CARD_W = 176;
const SLOT_X = 206;
const SLOT_Y = 132;

/**
 * Tidy tree layout: leaves claim successive horizontal slots, parents center
 * over their children, siblings ordered by creation time.
 */
function layoutVersions(versions) {
  const byId = new Map(versions.map(function (v) { return [v.sessionId, v]; }));
  const children = new Map();
  const roots = [];
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    if (v.parentSessionId && byId.has(v.parentSessionId)) {
      if (!children.has(v.parentSessionId)) children.set(v.parentSessionId, []);
      children.get(v.parentSessionId).push(v);
    } else {
      roots.push(v);
    }
  }
  children.forEach(function (list) {
    list.sort(function (a, b) { return a.createdAt - b.createdAt; });
  });
  roots.sort(function (a, b) { return a.createdAt - b.createdAt; });
  const pos = new Map();
  let cursor = 0;
  function walk(v, depth) {
    const kids = children.get(v.sessionId) || [];
    if (kids.length === 0) {
      pos.set(v.sessionId, { x: cursor * SLOT_X, y: depth * SLOT_Y });
      cursor += 1;
      return;
    }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < kids.length; i++) {
      walk(kids[i], depth + 1);
      const p = pos.get(kids[i].sessionId);
      if (p.x < lo) lo = p.x;
      if (p.x > hi) hi = p.x;
    }
    pos.set(v.sessionId, { x: (lo + hi) / 2, y: depth * SLOT_Y });
  }
  for (let i = 0; i < roots.length; i++) walk(roots[i], 0);
  const edges = [];
  children.forEach(function (kids, parentId) {
    for (let i = 0; i < kids.length; i++) {
      edges.push({ from: parentId, to: kids[i].sessionId, onPath: !!kids[i].onCurrentPath });
    }
  });
  return { pos: pos, edges: edges, byId: byId };
}

function edgePath(x1, y1, x2, y2) {
  const dy = Math.max(26, (y2 - y1) * 0.5);
  return 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + (y1 + dy) + ', ' + x2 + ' ' + (y2 - dy) + ', ' + x2 + ' ' + y2;
}

/** Bring the Chat view forward; the first conversation tab is always Chat. */
function showChat() {
  const g = realGlobal();
  if (!g || !g.document) return;
  const tab = g.document.querySelector('[role=tab]');
  if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
}

/**
 * After a graph click lands in a session, glide the chat to the version's own
 * message and flash it. Polls because the session view mounts asynchronously.
 */
function flashTurn(sessionId, turn, tries) {
  const g = realGlobal();
  if (!g || !g.document) return;
  const el = g.document.querySelector(
    '.mtx-row[data-session="' + sessionId + '"][data-turn="' + String(turn) + '"]');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('mtx-flash');
    void el.offsetWidth;
    el.classList.add('mtx-flash');
    return;
  }
  if (tries > 0) setTimeout(function () { flashTurn(sessionId, turn, tries - 1); }, 160);
}

/* ------------------------------------------------------------------ css -- */

const CSS = [
  // User bubble replica: right-aligned rounded panel like the host's, with a
  // hover-revealed edit control to its left, ChatGPT-style.
  '.mtx-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}',
  '.mtx-line{display:flex;align-items:flex-start;gap:8px;max-width:min(85%,720px)}',
  '.mtx-edit-btn{flex:none;margin-top:8px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;transition:opacity 120ms ease,background 120ms ease}',
  '.mtx-row:hover .mtx-edit-btn{opacity:1}',
  '.mtx-edit-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.mtx-bubble{background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,150,.14));border-radius:16px;padding:10px 16px;font-size:15px;line-height:26px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}',
  '.mtx-img{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px}',

  // Inline editor, ChatGPT-style: the bubble grows into an editing surface
  // with Cancel / Send below-right.
  '.mtx-editor{width:min(85%,720px);background:var(--dsw-alias-interactive-bg-hover,rgba(140,140,150,.14));border-radius:16px;padding:12px 16px;display:flex;flex-direction:column;gap:10px}',
  '.mtx-textarea{width:100%;min-height:72px;resize:vertical;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:15px;line-height:26px}',
  '.mtx-editor-actions{display:flex;justify-content:flex-end;gap:8px}',
  '.mtx-btn{padding:6px 16px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));background:transparent;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}',
  '.mtx-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.mtx-btn[data-primary]{background:var(--dsw-alias-accent-primary,#4b8dff);border-color:transparent;color:#fff}',
  '.mtx-btn[data-primary]:hover{filter:brightness(1.08)}',
  '.mtx-btn[disabled]{opacity:.5;cursor:default}',
  '.mtx-error{font-size:12px;color:var(--dsw-alias-status-error,#e5484d)}',

  // Version ring, under the bubble: ‹ 2/3 ›.
  '.mtx-ring{display:flex;align-items:center;gap:2px;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
  '.mtx-ring button{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:14px}',
  '.mtx-ring button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.mtx-ring button[disabled]{opacity:.35;cursor:default}',

  // Versions graph: a pannable canvas with spring-arranged cards and bezier
  // edges. Cursor communicates state: grab on canvas, pointer on cards.
  '.mtx-graph{position:relative;height:100%;overflow:hidden;cursor:grab;background-image:radial-gradient(color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 22%,transparent) 1px,transparent 1px);background-size:26px 26px;touch-action:none;user-select:none}',
  '.mtx-graph[data-panning]{cursor:grabbing}',
  '.mtx-world{position:absolute;left:0;top:0;will-change:transform}',
  '.mtx-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}',
  '.mtx-edge{fill:none;stroke:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 45%,transparent);stroke-width:1.5}',
  '.mtx-edge[data-path]{stroke:var(--dsw-alias-accent-primary,#4b8dff);stroke-width:2}',
  '.mtx-card{position:absolute;left:0;top:0;width:176px;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:13px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 10%,var(--dsw-alias-bg-primary,rgba(30,30,34,.9)));box-shadow:0 2px 10px rgba(0,0,0,.14);cursor:pointer;will-change:transform;transition:box-shadow 180ms ease,border-color 180ms ease}',
  '.mtx-card:hover{box-shadow:0 6px 22px rgba(0,0,0,.24);border-color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 55%,transparent)}',
  '.mtx-card[data-current]{border-color:var(--dsw-alias-accent-primary,#4b8dff);box-shadow:0 0 0 1px var(--dsw-alias-accent-primary,#4b8dff),0 6px 24px color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 30%,transparent)}',
  '.mtx-card[data-dragging]{cursor:grabbing;box-shadow:0 14px 34px rgba(0,0,0,.3);z-index:3}',
  '.mtx-card[data-deleted]{opacity:.55;border-style:dashed;cursor:default}',
  '.mtx-card[data-deleted]:hover{box-shadow:0 2px 10px rgba(0,0,0,.14);border-color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 30%,transparent)}',
  '.mtx-card-icon{flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 18%,transparent);color:var(--dsw-alias-label-secondary,#bbb)}',
  '.mtx-card[data-path] .mtx-card-icon{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 20%,transparent);color:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.mtx-card-main{min-width:0;flex:1}',
  '.mtx-card-title{font-size:12.5px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.mtx-card-sub{font-size:11px;line-height:15px;margin-top:2px;color:var(--dsw-alias-label-tertiary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
  '.mtx-graph-tools{position:absolute;top:12px;right:14px;display:flex;gap:6px;z-index:4}',
  '.mtx-tool{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 30%,transparent);background:var(--dsw-alias-bg-primary,rgba(30,30,34,.85));color:var(--dsw-alias-label-secondary,#bbb);cursor:pointer;font-size:14px}',
  '.mtx-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.mtx-empty{position:absolute;left:0;right:0;bottom:26px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px;pointer-events:none}',
  '.mtx-graph .mtx-link{position:absolute;right:14px;bottom:10px;font-size:12px;color:var(--dsw-alias-label-tertiary);text-decoration:none;z-index:4}',
  '.mtx-link:hover{color:var(--dsw-alias-label-primary)}',
  '.mtx-error{font-size:12px;color:var(--dsw-alias-status-error,#e5484d)}',
  '.mtx-graph .mtx-error{position:absolute;left:14px;top:16px;z-index:4}',

  // Flash highlight when a graph click lands on its message.
  '@keyframes mtx-flash-kf{0%,55%{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 22%,transparent)}100%{background:transparent}}',
  '.mtx-flash .mtx-bubble{animation:mtx-flash-kf 1.4s ease-out}',

  /* ---- action row, below the bubble ------------------------------------ */
  // All three references put the message controls BELOW the bubble, not
  // beside it. What differs is which controls exist and whether they are
  // always visible or revealed on hover.
  '.mtx-actions{display:flex;align-items:center;gap:2px;margin-top:1px}',
  '.mtx-act{width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
  '.mtx-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.mtx-act[disabled]{opacity:.4;cursor:default}',
  // ChatGPT and Claude reveal the controls on hover; DeepSeek keeps them out,
  // which is also how DSH itself behaves.
  'html[data-mtx-style=chatgpt] .mtx-actions,html[data-mtx-style=claude] .mtx-actions{opacity:0;transition:opacity 120ms ease}',
  'html[data-mtx-style=chatgpt] .mtx-row:hover .mtx-actions,html[data-mtx-style=chatgpt] .mtx-row:focus-within .mtx-actions,',
  'html[data-mtx-style=claude] .mtx-row:hover .mtx-actions,html[data-mtx-style=claude] .mtx-row:focus-within .mtx-actions{opacity:1}',
  // Only Claude offers a retry control on the user message.
  '.mtx-act[data-act=retry]{display:none}',
  'html[data-mtx-style=claude] .mtx-act[data-act=retry]{display:inline-flex}',

  /* ---- editor button placement ----------------------------------------- */
  // ChatGPT and DeepSeek keep Cancel/Send INSIDE the editor box. Claude puts
  // them OUTSIDE, below it, and names the primary action Save.
  '.mtx-editor-outside{display:none;justify-content:flex-end;align-items:center;gap:8px;margin-top:8px;width:min(85%,720px)}',
  'html[data-mtx-style=claude] .mtx-editor-actions{display:none}',
  'html[data-mtx-style=claude] .mtx-editor-outside{display:flex}',


  /* ---- settings section ------------------------------------------------ */
  '.mtx-set{display:flex;flex-direction:column;gap:12px;max-width:560px;font-size:14px;color:var(--dsw-alias-label-primary)}',
  '.mtx-set-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.mtx-set-label{font-size:13px}',
  '.mtx-select{border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 34%,transparent);background:var(--dsw-alias-bg-primary,rgba(30,30,34,.6));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px;outline:none;cursor:pointer}',
  '.mtx-set-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.mtx-preview{margin-top:2px;padding:18px 16px 16px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 7%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 16%,transparent);pointer-events:none}',
  '.mtx-preview .mtx-editor{margin-top:12px}',
  '.mtx-preview .mtx-textarea{min-height:auto}',
  '.mtx-preview .mtx-actions{opacity:1!important}',
  '.mtx-set-link{align-self:flex-end;font-size:12px;color:var(--dsw-alias-label-tertiary);text-decoration:none;pointer-events:auto}',
  '.mtx-set-link:hover{color:var(--dsw-alias-label-primary)}',
].join('');

return {
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    ctx.effect(function () { return styles.insert(CSS); });
    // Reflect the chosen edit style onto <html> now and on every change.
    ctx.effect(function () { syncStyleAttribute(); return styleStore.subscribe(syncStyleAttribute); });

    let sessions = null;
    try { sessions = ctx.get('sessions'); } catch (e) {}

    // Session-list state straight from the service, so this works no matter
    // what props the host chooses to pass slot components.
    function useSessionList() {
      const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
      React.useEffect(function () {
        if (!sessions || !sessions.list || typeof sessions.list.subscribe !== 'function') return undefined;
        return sessions.list.subscribe(force);
      }, []);
      return sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
        ? sessions.list.getSnapshot()
        : { byId: {} };
    }

    const I18N_NS = 'dsh-plugin-message-tree';
    const I18N = {
      en: {
        view: 'Versions',
        edit: 'Edit message',
        cancel: 'Cancel',
        send: 'Send',
        save: 'Save',
        copy: 'Copy',
        copied: 'Copied',
        retry: 'Retry this turn',
        regen: 'Regenerate from here',
        original: 'Original conversation',
        edited: 'Edited turn {turn}',
        retried: 'Regenerated turn {turn}',
        branch: 'Branch',
        refresh: 'Refresh',
        fit: 'Center view',
        empty: 'No versions yet — edit any of your messages to branch this conversation. Drag to pan, scroll to zoom.',
        images: '{count} image(s) kept as-is',
        nav: 'Message Edit',
        styleLabel: 'Edit interface style',
        styleHint: 'Where the message controls sit and which ones appear. Changes apply live.',
        style_chatgpt: 'ChatGPT',
        style_deepseek: 'DeepSeek',
        style_claude: 'Claude',
        styleDesc_chatgpt: 'Copy and edit under the bubble, revealed on hover. Cancel and Send sit inside the editor.',
        styleDesc_deepseek: 'Copy and edit under the bubble, always visible — closest to DSH itself. Cancel and Send sit inside the editor.',
        styleDesc_claude: 'Retry, edit and copy under the bubble, revealed on hover. Cancel and Save sit below the editor.',
        deletedVersion: 'Deleted version',
        rememberPathLabel: 'Remember the version I was viewing',
        rememberPathHint: 'Reopening a conversation returns to the branch you last had open instead of the original. Off means it always opens the first version.',
        stopOnEditLabel: 'Stop the running reply when I edit',
        stopOnEditHint: 'Editing or retrying cancels every reply still being generated in this conversation before branching, including other versions, so no superseded answer keeps spending tokens. This also lets you edit mid-reply. Off leaves them running.',
        previewUser: 'Rewrite this paragraph to be more concise.',
      },
      zh: {
        view: '版本',
        edit: '编辑消息',
        cancel: '取消',
        send: '发送',
        save: '保存',
        copy: '复制',
        copied: '已复制',
        retry: '重试本轮',
        regen: '从这里重新生成',
        original: '原始对话',
        edited: '编辑了第 {turn} 轮',
        retried: '重新生成第 {turn} 轮',
        branch: '分支',
        refresh: '刷新',
        fit: '居中显示',
        empty: '还没有版本——编辑任意一条你的消息即可创建分支。拖动平移，滚轮缩放。',
        images: '{count} 张图片将原样保留',
        nav: '消息编辑',
        styleLabel: '编辑界面风格',
        styleHint: '消息操作按钮的位置与种类。修改即时生效。',
        style_chatgpt: 'ChatGPT',
        style_deepseek: 'DeepSeek',
        style_claude: 'Claude',
        styleDesc_chatgpt: '气泡下方为复制与编辑，悬停时显示；「取消 / 发送」位于编辑框内部。',
        styleDesc_deepseek: '气泡下方为复制与编辑，始终显示——最接近 DSH 原生；「取消 / 发送」位于编辑框内部。',
        styleDesc_claude: '气泡下方为重试、编辑与复制，悬停时显示；「取消 / 保存」位于编辑框下方。',
        deletedVersion: '已删除的版本',
        rememberPathLabel: '记住我正在查看的版本',
        rememberPathHint: '重新打开会话时回到上次查看的分支，而不是最初那条。关闭后始终打开第一个版本。',
        stopOnEditLabel: '编辑时中止正在生成的回复',
        stopOnEditHint: '编辑或重试时，先取消该会话中所有仍在生成的回复（包括其它版本）再分支，避免被取代的回答继续消耗额度；同时允许在回复过程中直接编辑。关闭后它们会继续跑完。',
        previewUser: '把这段话改写得更简洁一些。',
      },
    };
    let t = function (key, params) {
      let out = I18N.en[key] || key;
      if (params) for (const k in params) out = out.replace('{' + k + '}', String(params[k]));
      return out;
    };
    try {
      const locale = ctx.get('locale');
      if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(function () { return locale.register(I18N_NS, I18N); });
        t = locale.bind(I18N_NS);
      }
    } catch (e) {}

    function PencilIcon() {
      return React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('path', {
          d: 'M11.1 2.4a1.6 1.6 0 012.3 2.3l-7.2 7.2-3 .8.8-3 7.1-7.3z',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
        }));
    }

    function CopyIcon() {
      return React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('rect', {
          x: 5.4, y: 5.4, width: 8.2, height: 8.2, rx: 2,
          stroke: 'currentColor', strokeWidth: 1.3,
        }),
        React.createElement('path', {
          d: 'M10.6 5.2V4.2a1.8 1.8 0 00-1.8-1.8H4.2a1.8 1.8 0 00-1.8 1.8v4.6a1.8 1.8 0 001.8 1.8h1',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }));
    }

    function RetryIcon() {
      return React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('path', {
          d: 'M13.2 8a5.2 5.2 0 11-1.6-3.75',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M13.4 2.3v3.1h-3.1',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    /** Ring beneath a bubble: ‹ i/m › switching whole version sessions. */
    function VersionRing(props) {
      const ring = props.ring;
      if (!ring) return null;
      const go = function (delta) {
        const next = ring.alternatives[ring.index + delta];
        if (next && sessions) openWhenListed(sessions, next.sessionId);
      };
      return React.createElement('div', { className: 'mtx-ring' },
        React.createElement('button', {
          type: 'button', disabled: ring.index <= 0,
          onClick: function () { go(-1); },
        }, '‹'),
        React.createElement('span', null, (ring.index + 1) + '/' + ring.alternatives.length),
        React.createElement('button', {
          type: 'button', disabled: ring.index >= ring.alternatives.length - 1,
          onClick: function () { go(1); },
        }, '›')
      );
    }

    function UserMessageView(props) {
      const node = props.node;
      const data = node.data || {};
      const text = contentText(data.content);
      const images = imageCount(data.content);
      const sessionId = props.sessionId !== undefined ? props.sessionId : (node.sessionId);
      // location.turn is a turn-group object ({turn, start, end, steps}); the
      // turn number lives one level down.
      const rawTurn = node.location ? node.location.turn : undefined;
      const turn = typeof rawTurn === 'number' ? rawTurn
        : (rawTurn && typeof rawTurn.turn === 'number' ? rawTurn.turn : undefined);
      const list = useSessionList();
      const summary = sessionId !== undefined ? list.byId[sessionId] : undefined;
      const running = !!(summary && summary.running);
      const tree = useTree(sessionId);
      const ring = typeof turn === 'number' ? ringFor(tree && tree.versions, sessionId, turn) : null;

      // Remember which branch of this family is open, and restore it when we
      // land back on the family root. Runs per bubble, so every step is either
      // idempotent or guarded — see activePathStore.
      const versions = tree && tree.versions;
      const prefs = usePrefs();
      React.useEffect(function () {
        if (!prefs.rememberPath) return;
        if (!versions || sessionId === undefined) return;
        const root = rootOf(versions, sessionId);
        if (!root) return;
        if (sessionId !== root) {
          // Arrived at a branch: that is now the remembered view, and any
          // restore we kicked off has landed.
          pendingRestore.delete(root);
          activePathStore.set(root, sessionId);
          return;
        }
        // On the root. Don't record while a restore we triggered is still in
        // flight, or we would overwrite the target with the root we are leaving.
        if (pendingRestore.has(root)) return;
        const remembered = activePathStore.get(root);
        if (!remembered || remembered === root) return;
        if (restoredFamilies.has(root)) {
          // Already restored once this page load and the user walked back to
          // the root deliberately — honour that as the new selection.
          activePathStore.set(root, root);
          return;
        }
        // Never chase a branch that no longer exists.
        if (!versions.some(function (v) { return v.sessionId === remembered; })) return;
        restoredFamilies.add(root);
        pendingRestore.add(root);
        if (sessions) openWhenListed(sessions, remembered);
      }, [versions, sessionId, sessions, prefs.rememberPath]);

      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [copied, setCopied] = React.useState(false);

      // Editing used to require an idle session, because forking calls
      // `runMaintenance`, which throws while a turn is live. With stopOnEdit the
      // host cancels that turn first, so editing mid-answer is allowed — and is
      // the point: it stops the superseded turn instead of leaving it streaming.
      const canEdit = (!running || prefs.stopOnEdit)
        && sessionId !== undefined && typeof turn === 'number' && text !== '' && !editing;

      function beginEdit() {
        setDraft(text);
        setError(null);
        setEditing(true);
      }

      async function submit() {
        const blockIndex = firstTextBlockIndex(data.content);
        // An unchanged draft is still a resend: it branches and regenerates.
        if (blockIndex === -1 || draft.trim() === '') { setEditing(false); return; }
        setBusy(true);
        setError(null);
        try {
          const result = await mutate({
            action: 'edit',
            sessionId: sessionId,
            eventSeq: data.seq,
            blockIndex: blockIndex,
            text: draft,
            stopPrevious: prefs.stopOnEdit,
          });
          treeStore.invalidate();
          setEditing(false);
          if (sessions) openWhenListed(sessions, result.sessionId);
        } catch (e) {
          setError(String(e && e.message || e));
        }
        setBusy(false);
      }

      async function retry() {
        if (typeof turn !== 'number') return;
        setBusy(true);
        setError(null);
        try {
          const result = await mutate({
            action: 'retry', sessionId: sessionId, turn: turn, stopPrevious: prefs.stopOnEdit,
          });
          treeStore.invalidate();
          if (sessions) openWhenListed(sessions, result.sessionId);
        } catch (e) {
          setError(String(e && e.message || e));
        }
        setBusy(false);
      }

      function copy() {
        const g = realGlobal();
        try {
          if (g && g.navigator && g.navigator.clipboard) g.navigator.clipboard.writeText(text);
        } catch (e) {}
        setCopied(true);
        setTimeout(function () { setCopied(false); }, 1200);
      }

      if (editing) {
        // Both action rows are rendered; CSS shows the one this preset wants —
        // inside the box (ChatGPT, DeepSeek) or below it (Claude).
        const cancelButton = function (key) {
          return React.createElement('button', {
            key: key, type: 'button', className: 'mtx-btn', disabled: busy,
            onClick: function () { setEditing(false); },
          }, t('cancel'));
        };
        const confirmButton = function (key, label) {
          return React.createElement('button', {
            key: key, type: 'button', className: 'mtx-btn', 'data-primary': '',
            disabled: busy || draft.trim() === '',
            onClick: submit,
          }, label);
        };
        return React.createElement('div', { className: 'mtx-row' },
          React.createElement('div', { className: 'mtx-editor' },
            React.createElement('textarea', {
              className: 'mtx-textarea',
              value: draft,
              autoFocus: true,
              onChange: function (e) { setDraft(e.target.value); },
              onKeyDown: function (e) {
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              },
            }),
            images > 0 ? React.createElement('div', { className: 'mtx-img' }, t('images', { count: images })) : null,
            error ? React.createElement('div', { className: 'mtx-error' }, error) : null,
            React.createElement('div', { className: 'mtx-editor-actions' },
              cancelButton('c-in'), confirmButton('s-in', t('send'))
            )
          ),
          React.createElement('div', { className: 'mtx-editor-outside' },
            cancelButton('c-out'), confirmButton('s-out', t('save'))
          )
        );
      }

      return React.createElement('div', { className: 'mtx-row', 'data-turn': turn, 'data-session': sessionId },
        React.createElement('div', { className: 'mtx-line' },
          React.createElement('div', { className: 'mtx-bubble' },
            text,
            images > 0 ? React.createElement('div', { className: 'mtx-img' }, t('images', { count: images })) : null
          )
        ),
        // The controls sit under the bubble in all three references. Which
        // ones exist, and whether they wait for hover, is what differs.
        React.createElement('div', { className: 'mtx-actions' },
          React.createElement(VersionRing, { ring: ring }),
          React.createElement('button', {
            type: 'button', className: 'mtx-act', 'data-act': 'retry',
            title: t('retry'), disabled: !canEdit || busy, onClick: retry,
          }, RetryIcon()),
          React.createElement('button', {
            type: 'button', className: 'mtx-act', 'data-act': 'edit',
            title: t('edit'), disabled: !canEdit, onClick: beginEdit,
          }, PencilIcon()),
          React.createElement('button', {
            type: 'button', className: 'mtx-act', 'data-act': 'copy',
            title: copied ? t('copied') : t('copy'), onClick: copy,
          }, CopyIcon())
        ),
        error ? React.createElement('div', { className: 'mtx-error' }, error) : null
      );
    }

    /**
     * The Versions view: a live graph. Cards spring into a tidy tree, edges
     * follow every frame, the canvas pans and zooms, and clicking a card
     * jumps straight to that version's message.
     */
    function VersionsView(props) {
      const sessionId = props.sessionId;
      const tree = useTree(sessionId);
      const titles = useSessionList().byId;
      const versions = (tree && tree.versions) || [];

      const graphRef = React.useRef(null);
      const worldRef = React.useRef(null);
      const cardEls = React.useRef(new Map());
      const edgeEls = React.useRef(new Map());
      const springs = React.useRef(new Map());
      const layoutRef = React.useRef(null);
      const viewRef = React.useRef({ x: 60, y: 42, scale: 1 });
      const dragRef = React.useRef(null);
      const rafRef = React.useRef(0);
      const fittedRef = React.useRef(false);

      const layoutKey = versions.map(function (v) {
        return v.sessionId + ':' + (v.parentSessionId || '') + ':' + (v.onCurrentPath ? 1 : 0);
      }).join('|');
      const layout = React.useMemo(function () { return layoutVersions(versions); }, [layoutKey]);
      layoutRef.current = layout;

      function applyView() {
        const el = worldRef.current;
        const view = viewRef.current;
        if (el) el.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')';
      }

      function renderFrame() {
        springs.current.forEach(function (s, id) {
          const el = cardEls.current.get(id);
          if (el) el.style.transform = 'translate(' + (s.x - CARD_W / 2) + 'px,' + s.y + 'px)';
        });
        const lay = layoutRef.current;
        if (!lay) return;
        for (let i = 0; i < lay.edges.length; i++) {
          const e = lay.edges[i];
          const el = edgeEls.current.get(e.from + '>' + e.to);
          const a = springs.current.get(e.from);
          const b = springs.current.get(e.to);
          if (!el || !a || !b) continue;
          const fromEl = cardEls.current.get(e.from);
          const h = fromEl ? fromEl.offsetHeight : 58;
          el.setAttribute('d', edgePath(a.x, a.y + h, b.x, b.y));
        }
      }

      function kick() {
        if (rafRef.current) return;
        let last = 0;
        const step = function (now) {
          rafRef.current = 0;
          const dt = last === 0 ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
          last = now;
          let alive = false;
          springs.current.forEach(function (s, id) {
            const d = dragRef.current;
            if (d && d.kind === 'node' && d.id === id) { alive = true; return; }
            const k = 190, c = 24;
            s.vx += ((s.tx - s.x) * k - s.vx * c) * dt;
            s.vy += ((s.ty - s.y) * k - s.vy * c) * dt;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            if (Math.abs(s.vx) + Math.abs(s.vy) + Math.abs(s.tx - s.x) + Math.abs(s.ty - s.y) > 0.5) alive = true;
            else { s.x = s.tx; s.y = s.ty; s.vx = 0; s.vy = 0; }
          });
          renderFrame();
          if (alive) rafRef.current = requestAnimationFrame(step);
        };
        rafRef.current = requestAnimationFrame(step);
      }

      function fitView() {
        const el = graphRef.current;
        const lay = layoutRef.current;
        if (!el || !lay) return;
        let lo = Infinity, hi = -Infinity, bot = 100;
        lay.pos.forEach(function (p) {
          lo = Math.min(lo, p.x - CARD_W / 2);
          hi = Math.max(hi, p.x + CARD_W / 2);
          bot = Math.max(bot, p.y + 90);
        });
        if (lo === Infinity) { lo = 0; hi = CARD_W; }
        const w = el.clientWidth || 600;
        const h = el.clientHeight || 400;
        const scale = Math.min(1, (w - 70) / Math.max(1, hi - lo), (h - 70) / bot);
        viewRef.current = {
          x: (w - (hi - lo) * scale) / 2 - lo * scale,
          y: Math.max(30, (h - bot * scale) / 2),
          scale: scale,
        };
        applyView();
      }

      // Retarget springs on every layout change; new cards are born at their
      // parent's position so they visibly grow out of it.
      React.useEffect(function () {
        const lay = layout;
        const alive = new Set();
        lay.pos.forEach(function (p, id) {
          alive.add(id);
          let s = springs.current.get(id);
          if (!s) {
            const v = lay.byId.get(id);
            const pp = v && v.parentSessionId ? lay.pos.get(v.parentSessionId) : null;
            const born = pp || p;
            springs.current.set(id, { x: born.x, y: born.y, vx: 0, vy: 0, tx: p.x, ty: p.y });
          } else {
            s.tx = p.x;
            s.ty = p.y;
          }
        });
        springs.current.forEach(function (_, id) { if (!alive.has(id)) springs.current.delete(id); });
        if (!fittedRef.current && lay.pos.size > 0) {
          fittedRef.current = true;
          fitView();
        }
        applyView();
        kick();
        return function () {
          if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
        };
      }, [layout]);

      // Wheel zoom around the pointer (non-passive so we may preventDefault).
      React.useEffect(function () {
        const el = graphRef.current;
        if (!el) return undefined;
        const onWheel = function (ev) {
          ev.preventDefault();
          const view = viewRef.current;
          const rect = el.getBoundingClientRect();
          const mx = ev.clientX - rect.left;
          const my = ev.clientY - rect.top;
          const next = Math.min(1.8, Math.max(0.3, view.scale * Math.exp(-ev.deltaY * 0.0013)));
          const f = next / view.scale;
          view.x = mx - (mx - view.x) * f;
          view.y = my - (my - view.y) * f;
          view.scale = next;
          applyView();
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return function () { el.removeEventListener('wheel', onWheel); };
      }, []);

      function openVersion(id) {
        const lay = layoutRef.current;
        const v = lay && lay.byId.get(id);
        if (!v || v.deleted || !sessions) return;
        openWhenListed(sessions, v.sessionId);
        showChat();
        if (typeof v.targetTurn === 'number') flashTurn(v.sessionId, v.targetTurn, 45);
      }

      function onPointerDown(ev) {
        if (ev.button !== 0) return;
        const cardEl = ev.target.closest ? ev.target.closest('.mtx-card') : null;
        if (ev.target.closest && ev.target.closest('.mtx-tool,.mtx-link')) return;
        if (cardEl) {
          const id = cardEl.getAttribute('data-id');
          const s = springs.current.get(id);
          if (!s) return;
          dragRef.current = { kind: 'node', id: id, moved: false, sx: ev.clientX, sy: ev.clientY, ox: s.x, oy: s.y, el: cardEl };
        } else {
          const view = viewRef.current;
          dragRef.current = { kind: 'pan', moved: false, sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y };
          graphRef.current.setAttribute('data-panning', '');
        }
        try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
      }

      function onPointerMove(ev) {
        const d = dragRef.current;
        if (!d) return;
        const dx = ev.clientX - d.sx;
        const dy = ev.clientY - d.sy;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 5) {
          d.moved = true;
          if (d.kind === 'node') d.el.setAttribute('data-dragging', '');
        }
        if (!d.moved) return;
        if (d.kind === 'pan') {
          viewRef.current.x = d.ox + dx;
          viewRef.current.y = d.oy + dy;
          applyView();
        } else {
          const s = springs.current.get(d.id);
          const sc = viewRef.current.scale;
          if (s) { s.x = d.ox + dx / sc; s.y = d.oy + dy / sc; s.vx = 0; s.vy = 0; renderFrame(); }
        }
      }

      function onPointerUp() {
        const d = dragRef.current;
        dragRef.current = null;
        if (graphRef.current) graphRef.current.removeAttribute('data-panning');
        if (!d) return;
        if (d.kind === 'node') {
          d.el.removeAttribute('data-dragging');
          if (d.moved) kick();
          else openVersion(d.id);
        }
      }

      function cardTitle(v) {
        if (v.deleted) return t('deletedVersion');
        if (!v.parentSessionId) return t('original');
        if (v.operation === 'edit') return t('edited', { turn: v.targetTurn });
        if (v.operation === 'retry') return t('retried', { turn: v.targetTurn });
        return t('branch');
      }

      return React.createElement('div', {
        className: 'mtx-graph',
        ref: graphRef,
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onPointerCancel: onPointerUp,
      },
        React.createElement('div', { className: 'mtx-world', ref: worldRef },
          React.createElement('svg', { className: 'mtx-edges' },
            layout.edges.map(function (e) {
              const key = e.from + '>' + e.to;
              const a = springs.current.get(e.from) || layout.pos.get(e.from);
              const b = springs.current.get(e.to) || layout.pos.get(e.to);
              return React.createElement('path', {
                key: key,
                className: 'mtx-edge',
                'data-path': e.onPath || undefined,
                d: a && b ? edgePath(a.x, a.y + 58, b.x, b.y) : undefined,
                ref: function (el) { if (el) edgeEls.current.set(key, el); else edgeEls.current.delete(key); },
              });
            })
          ),
          versions.map(function (v) {
            const s = springs.current.get(v.sessionId) || layout.pos.get(v.sessionId) || { x: 0, y: 0 };
            const summary = titles[v.sessionId];
            const sub = (v.after !== undefined ? '“' + clip(v.after, 44) + '” · ' : '')
              + (!v.parentSessionId && summary && summary.displayTitle ? clip(summary.displayTitle, 24) + ' · ' : '')
              + timeLabel(v.createdAt);
            return React.createElement('div', {
              key: v.sessionId,
              className: 'mtx-card',
              'data-id': v.sessionId,
              'data-current': v.current || undefined,
              'data-path': v.onCurrentPath || undefined,
              'data-deleted': v.deleted || undefined,
              style: { transform: 'translate(' + (s.x - CARD_W / 2) + 'px,' + s.y + 'px)' },
              ref: function (el) { if (el) cardEls.current.set(v.sessionId, el); else cardEls.current.delete(v.sessionId); },
            },
              React.createElement('span', { className: 'mtx-card-icon' },
                v.deleted ? '∅' : v.parentSessionId ? (v.operation === 'retry' ? '↻' : '✎') : '●'),
              React.createElement('span', { className: 'mtx-card-main' },
                React.createElement('span', { className: 'mtx-card-title' }, cardTitle(v)),
                React.createElement('span', { className: 'mtx-card-sub' }, sub)
              )
            );
          })
        ),
        React.createElement('div', { className: 'mtx-graph-tools' },
          React.createElement('button', {
            type: 'button', className: 'mtx-tool', title: t('fit'),
            onClick: function () { fitView(); },
          }, '⌖'),
          React.createElement('button', {
            type: 'button', className: 'mtx-tool', title: t('refresh'),
            onClick: function () { treeStore.load(sessionId); },
          }, '↻')
        ),
        tree && tree.error ? React.createElement('div', { className: 'mtx-error' }, tree.error) : null,
        versions.length <= 1 ? React.createElement('div', { className: 'mtx-empty' }, t('empty')) : null,
        React.createElement('a', {
          className: 'mtx-link',
          href: 'https://github.com/SpookySandwich/dsh-plugin-message-edit',
          target: '_blank', rel: 'noreferrer',
        }, 'GitHub ↗')
      );
    }

    // Settings: pick the edit-interface style, with a live preview that
    // renders in the currently-selected look.
    function Toggle(props) {
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'mtx-set-row' },
          React.createElement('span', { className: 'mtx-set-label' }, props.label),
          React.createElement('input', {
            type: 'checkbox', checked: props.checked, onChange: props.onChange,
          })
        ),
        React.createElement('div', { className: 'mtx-set-hint' }, props.hint)
      );
    }

    function StyleSettings() {
      const style = useStyle();
      const prefs = usePrefs();
      return React.createElement('div', { className: 'mtx-set' },
        React.createElement('div', { className: 'mtx-set-row' },
          React.createElement('span', { className: 'mtx-set-label' }, t('styleLabel')),
          React.createElement('select', {
            className: 'mtx-select', value: style,
            onChange: function (e) { styleStore.set(e.target.value); },
          },
            STYLES.map(function (s) {
              return React.createElement('option', { key: s, value: s }, t('style_' + s));
            })
          )
        ),
        React.createElement('div', { className: 'mtx-set-hint' }, t('styleDesc_' + style)),
        React.createElement(Toggle, {
          label: t('rememberPathLabel'),
          hint: t('rememberPathHint'),
          checked: prefs.rememberPath,
          onChange: function (e) { prefsStore.set({ rememberPath: e.target.checked }); },
        }),
        React.createElement(Toggle, {
          label: t('stopOnEditLabel'),
          hint: t('stopOnEditHint'),
          checked: prefs.stopOnEdit,
          onChange: function (e) { prefsStore.set({ stopOnEdit: e.target.checked }); },
        }),
        React.createElement('div', { className: 'mtx-preview' },
          React.createElement('div', { className: 'mtx-row' },
            React.createElement('div', { className: 'mtx-line' },
              React.createElement('div', { className: 'mtx-bubble' }, t('previewUser'))
            ),
            React.createElement('div', { className: 'mtx-actions' },
              React.createElement('div', { className: 'mtx-ring' },
                React.createElement('button', { type: 'button', disabled: true }, '‹'),
                React.createElement('span', null, '2/3'),
                React.createElement('button', { type: 'button', disabled: true }, '›')
              ),
              React.createElement('span', { className: 'mtx-act', 'data-act': 'retry' }, RetryIcon()),
              React.createElement('span', { className: 'mtx-act', 'data-act': 'edit' }, PencilIcon()),
              React.createElement('span', { className: 'mtx-act', 'data-act': 'copy' }, CopyIcon())
            )
          ),
          React.createElement('div', { className: 'mtx-editor' },
            React.createElement('div', { className: 'mtx-textarea' }, t('previewUser')),
            React.createElement('div', { className: 'mtx-editor-actions' },
              React.createElement('span', { className: 'mtx-btn' }, t('cancel')),
              React.createElement('span', { className: 'mtx-btn', 'data-primary': '' }, t('send'))
            )
          ),
          React.createElement('div', { className: 'mtx-editor-outside' },
            React.createElement('span', { className: 'mtx-btn' }, t('cancel')),
            React.createElement('span', { className: 'mtx-btn', 'data-primary': '' }, t('save'))
          )
        ),
        React.createElement('a', {
          className: 'mtx-set-link',
          href: 'https://github.com/SpookySandwich/dsh-plugin-message-edit',
          target: '_blank', rel: 'noreferrer',
        }, 'GitHub ↗')
      );
    }

    try {
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'message-tree', order: 210, label: function () { return t('nav'); } },
          StyleSettings
        );
      });
    } catch (e) {}

    // Shadow only the plain user bubble; steering and context rows keep the
    // host renderer. A collision with another user-bubble plugin degrades to
    // "they win" rather than failing this plugin's other registrations.
    slots.inject('conversation.chat.node', function () {
      try {
        return slots.register(
          { name: 'conversation.chat.node', key: 'user', priority: -1 },
          UserMessageView
        );
      } catch (e) {
        return function () {};
      }
    });

    slots.inject('conversation.view', function () {
      return slots.register(
        {
          name: 'conversation.view',
          id: 'message-tree',
          order: VIEW_ORDER,
          label: function () { return t('view'); },
          inject: function (sessionId) { return { sessionId: sessionId }; },
        },
        VersionsView
      );
    });
  }
};
