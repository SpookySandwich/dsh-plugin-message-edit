// dsh-plugin-message-tree — client half.
//
// Mimics ChatGPT's edit-message behavior: hover a past prompt to edit it,
// sending branches the conversation from that point (the host half performs
// the true rewind); ‹ 2/3 › switches between versions of the same message;
// a Versions view draws the whole tree.

const ROUTE = '/message-tree';
const VIEW_ORDER = 16;

function realGlobal() {
  try { if (typeof window !== 'undefined' && window) return window; } catch (e) {}
  try { if (typeof globalThis !== 'undefined' && globalThis) return globalThis; } catch (e) {}
  return null;
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
  let anchor = cursor;
  let current = cursor;
  if (typeof cursor.targetTurn === 'number' && cursor.targetTurn === turn && cursor.parentSessionId) {
    const parent = byId.get(cursor.parentSessionId);
    if (parent) anchor = parent;
  }
  const alternatives = [anchor].concat(versions
    .filter(function (v) { return v.parentSessionId === anchor.sessionId && v.targetTurn === turn; })
    .sort(function (a, b) { return a.createdAt - b.createdAt; }));
  if (alternatives.length < 2) return null;
  let index = alternatives.findIndex(function (v) { return v.sessionId === current.sessionId; });
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

  // Versions view.
  '.mtx-tree{height:100%;overflow:auto;padding:20px 26px 80px;font-size:14px;color:var(--dsw-alias-label-primary)}',
  '.mtx-tree-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}',
  '.mtx-tree-title{font-size:15px;font-weight:600;flex:1}',
  '.mtx-node{display:flex;align-items:flex-start;gap:10px;padding:7px 10px;border-radius:9px;cursor:pointer}',
  '.mtx-node:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.mtx-node[data-current]{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4b8dff) 12%,transparent)}',
  '.mtx-dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:8px;background:var(--dsw-alias-label-tertiary)}',
  '.mtx-node[data-path] .mtx-dot{background:var(--dsw-alias-accent-primary,#4b8dff)}',
  '.mtx-node-body{min-width:0;flex:1}',
  '.mtx-node-title{font-size:13.5px;line-height:20px}',
  '.mtx-node-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mtx-empty{color:var(--dsw-alias-label-tertiary);padding:30px 0;text-align:center}',
  '.mtx-foot{margin-top:18px;display:flex;justify-content:flex-end}',
  '.mtx-link{font-size:12px;color:var(--dsw-alias-label-tertiary);text-decoration:none}',
  '.mtx-link:hover{color:var(--dsw-alias-label-primary)}',
].join('');

return {
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    ctx.effect(function () { return styles.insert(CSS); });

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
        regen: 'Regenerate from here',
        original: 'Original conversation',
        edited: 'Edited turn {turn}',
        retried: 'Regenerated turn {turn}',
        branch: 'Branch',
        refresh: 'Refresh',
        empty: 'No versions yet — edit any of your messages to branch this conversation.',
        images: '{count} image(s) kept as-is',
      },
      zh: {
        view: '版本',
        edit: '编辑消息',
        cancel: '取消',
        send: '发送',
        regen: '从这里重新生成',
        original: '原始对话',
        edited: '编辑了第 {turn} 轮',
        retried: '重新生成第 {turn} 轮',
        branch: '分支',
        refresh: '刷新',
        empty: '还没有版本——编辑任意一条你的消息即可创建分支。',
        images: '{count} 张图片将原样保留',
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

      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      const canEdit = !running && sessionId !== undefined && typeof turn === 'number' && text !== '' && !editing;

      function beginEdit() {
        setDraft(text);
        setError(null);
        setEditing(true);
      }

      async function submit() {
        const blockIndex = firstTextBlockIndex(data.content);
        if (blockIndex === -1 || draft.trim() === '' || draft === text) { setEditing(false); return; }
        setBusy(true);
        setError(null);
        try {
          const result = await mutate({
            action: 'edit',
            sessionId: sessionId,
            eventSeq: data.seq,
            blockIndex: blockIndex,
            text: draft,
          });
          treeStore.invalidate();
          setEditing(false);
          if (sessions) openWhenListed(sessions, result.sessionId);
        } catch (e) {
          setError(String(e && e.message || e));
        }
        setBusy(false);
      }

      if (editing) {
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
              React.createElement('button', {
                type: 'button', className: 'mtx-btn', disabled: busy,
                onClick: function () { setEditing(false); },
              }, t('cancel')),
              React.createElement('button', {
                type: 'button', className: 'mtx-btn', 'data-primary': '', disabled: busy || draft.trim() === '',
                onClick: submit,
              }, t('send'))
            )
          )
        );
      }

      return React.createElement('div', { className: 'mtx-row' },
        React.createElement('div', { className: 'mtx-line' },
          canEdit ? React.createElement('button', {
            type: 'button', className: 'mtx-edit-btn', title: t('edit'),
            onClick: beginEdit,
          }, PencilIcon()) : null,
          React.createElement('div', { className: 'mtx-bubble' },
            text,
            images > 0 ? React.createElement('div', { className: 'mtx-img' }, t('images', { count: images })) : null
          )
        ),
        React.createElement(VersionRing, { ring: ring })
      );
    }

    /** The Versions view: the whole tree, indented, current path marked. */
    function VersionsView(props) {
      const sessionId = props.sessionId;
      const tree = useTree(sessionId);
      const titles = useSessionList().byId;
      const versions = (tree && tree.versions) || [];
      return React.createElement('div', { className: 'mtx-tree' },
        React.createElement('div', { className: 'mtx-tree-head' },
          React.createElement('span', { className: 'mtx-tree-title' }, t('view')),
          React.createElement('button', {
            type: 'button', className: 'mtx-btn',
            onClick: function () { treeStore.load(sessionId); },
          }, t('refresh'))
        ),
        tree && tree.error ? React.createElement('div', { className: 'mtx-error' }, tree.error) : null,
        versions.length <= 1
          ? React.createElement('div', { className: 'mtx-empty' }, t('empty'))
          : versions.map(function (v) {
            let title;
            if (!v.parentSessionId) title = t('original');
            else if (v.operation === 'edit') title = t('edited', { turn: v.targetTurn });
            else if (v.operation === 'retry') title = t('retried', { turn: v.targetTurn });
            else title = t('branch');
            const summary = titles[v.sessionId];
            const sub = (v.after !== undefined ? '“' + clip(v.after, 60) + '” · ' : '')
              + (summary && summary.displayTitle ? clip(summary.displayTitle, 30) + ' · ' : '')
              + timeLabel(v.createdAt);
            return React.createElement('div', {
              key: v.sessionId,
              className: 'mtx-node',
              'data-current': v.current || undefined,
              'data-path': v.onCurrentPath || undefined,
              style: { marginLeft: (v.depth * 22) + 'px' },
              onClick: function () { if (sessions) openWhenListed(sessions, v.sessionId); },
            },
              React.createElement('span', { className: 'mtx-dot' }),
              React.createElement('span', { className: 'mtx-node-body' },
                React.createElement('div', { className: 'mtx-node-title' }, title),
                React.createElement('div', { className: 'mtx-node-sub' }, sub)
              )
            );
          }),
        React.createElement('div', { className: 'mtx-foot' },
          React.createElement('a', {
            className: 'mtx-link',
            href: 'https://github.com/SpookySandwich/dsh-plugin-message-tree',
            target: '_blank', rel: 'noreferrer',
          }, 'GitHub ↗')
        )
      );
    }

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
