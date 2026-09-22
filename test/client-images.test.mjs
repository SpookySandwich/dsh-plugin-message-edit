import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const photo = id => ({ type: 'image', attachment: { id, mimeType: 'image/png' } });
const file = (name, bytes) => ({ type: 'file', attachment: { attachmentId: `sha256:${name}`, name, bytes } });
const text = value => ({ type: 'text', text: value });

// Host atoms loaded by the plugin. The real package is not a dependency of this
// repository and its bundle imports CSS modules Node cannot load, so — like the
// host services and the gallery below — it is a test double. Each call is
// recorded so the assertions can prove the plugin passes the right arguments.
function hostAtoms(calls) {
  return {
    FileTypeIcon: props => {
      calls.icons.push(props);
      return React.createElement('span', { 'data-file-icon': props.path, className: props.className });
    },
    fileExtension: name => {
      calls.extensions.push(name);
      const dot = name.lastIndexOf('.');
      return dot < 0 ? '' : name.slice(dot + 1);
    },
    fileSizeText: bytes => {
      calls.sizes.push(bytes);
      return `${bytes}B`;
    },
    JsonBlock: ({ label, payload }) => React.createElement('div', { 'data-json-block': label }, JSON.stringify(payload)),
  };
}

// Run the shipped bundle and capture the component through its actual slot
// registration. React and the DOM are real; the host services, the gallery and
// the host atoms are test doubles. This tests delegation and UI transitions, not
// DSH's own image loader or file icons.
async function mount(t, content, renderMessageImages, options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://message-edit.test/',
  });
  dom.window.localStorage.setItem('dsh-plugin-message-tree:style', options.style ?? 'chatgpt');
  const requests = [];
  dom.window.fetch = async (url, init) => {
    const target = String(url);
    requests.push({ url: target, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    if (target.includes('/message-tree/attachment')) {
      // The host resolves a stored reference to its own path; without one the
      // deployment has no host file to open.
      if (options.attachmentPath === undefined) {
        return { ok: false, status: 409, json: async () => ({ error: '当前部署没有为文件附件提供宿主路径。' }) };
      }
      return { ok: true, status: 200, json: async () => ({ path: options.attachmentPath }) };
    }
    return { ok: true, status: 200, json: async () => ({ sessionId: 'child-1', queuedTurns: 1, versions: options.versions ?? [] }) };
  };
  // jsdom has no object-URL registry; the plugin only needs a stable string.
  if (typeof dom.window.URL.createObjectURL !== 'function') dom.window.URL.createObjectURL = () => 'blob:preview';
  if (typeof dom.window.URL.revokeObjectURL !== 'function') dom.window.URL.revokeObjectURL = () => {};
  const previous = new Map();
  const browserErrors = [];
  const consoleErrors = [];
  dom.window.addEventListener('error', event => browserErrors.push(event.error || event.message));
  // The bundle runs in a bare VM context with this console injected, and the
  // module loader below hands it the *test's* React, so both consoles are
  // collected while the component is mounted.
  const sandboxConsole = Object.assign({}, console, {
    error(...args) { consoleErrors.push(args.map(String).join(' ')); },
    warn(...args) { consoleErrors.push(args.map(String).join(' ')); },
  });
  const realConsoleError = console.error;
  console.error = (...args) => {
    const error = new Error('warning');
    consoleErrors.push(args.map(String).join(' ') + '\n' + String(error.stack).split('\n').slice(2, 8).join('\n'));
  };
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // React DOM detects browser input support at import time.
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  const disposers = [];
  t.after(async () => {
    await act(async () => root.unmount());
    for (const dispose of disposers.reverse()) dispose();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(browserErrors, [], 'Browser event handlers must not throw');
    const keyWarnings = consoleErrors.filter(entry => /unique "key"/.test(entry));
    assert.deepEqual(keyWarnings, [], `Rendered lists must carry keys:\n${keyWarnings.join('\n')}`);
    console.error = realConsoleError;
  });
  let component;
  const slots = {
    inject(_name, register) { register(); },
    register(spec, view) {
      if (spec.name === 'conversation.chat.node' && spec.key === 'user') component = view;
      return () => {};
    },
  };
  const modules = { react: React };
  // `atoms: 'missing'` models a shell that does not seed the primitives module:
  // the plugin's require misses the module table and it must degrade, not throw.
  if (options.atoms !== 'missing') modules['@deepseek-ai/dsh-client-ui-primitives'] = hostAtoms(options.calls ?? {
    icons: [], extensions: [], sizes: [],
  });
  let plugin;
  dom.window.__ModuleLoader__ = {
    load({ id, factory }) {
      assert.equal(id, 'dsh-plugin-message-edit');
      plugin = factory(name => {
        assert.ok(Object.hasOwn(modules, name), `unexpected require("${name}")`);
        return modules[name];
      });
    },
  };
  runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console: sandboxConsole,
    setTimeout, clearTimeout,
    // The bundle runs in a bare VM context, so the browser globals the edit box
    // uses must be handed in explicitly.
    URL: dom.window.URL, FileReader: dom.window.FileReader,
    AbortController: dom.window.AbortController, Blob: dom.window.Blob,
  }, { filename: 'lib/client.js' });
  plugin.apply({
    get(name) { return name === 'slots' ? slots : name === 'sessions' ? {
      open: options.open ?? (() => {}),
      list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: Object.fromEntries(
        ['session-test', ...(options.versions ?? []).map(version => version.sessionId)].map(id => [id, { id }])) }) },
    } : name === 'fileUpload' ? options.fileUpload : name === 'sidebarRight' ? options.sidebarRight : undefined; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  assert.equal(typeof component, 'function', 'The user-message slot must register');
  const props = {
    sessionId: 'session-test',
    node: { data: { content, seq: 2 }, location: { turn: { turn: 1 } } },
    renderMessageImages,
    ...options.loadImage === undefined ? {} : { loadImage: options.loadImage },
  };
  await act(async () => root.render(React.createElement(component, props)));
  const document = dom.window.document;
  document.requests = requests;
  return document;
}

function gallery(calls) {
  return props => {
    calls.push(props);
    // Durable references are identified by `attachmentId`; the older fixtures use
    // a plain `id`. The host's own gallery keys off the former.
    const identity = attachment => attachment.attachmentId ?? attachment.id;
    return React.createElement('div', { 'data-host-gallery': true },
      props.images.map(({ attachment }) => React.createElement('button', {
        key: identity(attachment), type: 'button', 'aria-label': `Open ${identity(attachment)}`,
      }, React.createElement('img', { src: `/attachments/${identity(attachment)}`, alt: identity(attachment) }))));
  };
}

function cardKinds(row) {
  return [...row.children].map(element => element.hasAttribute('data-host-gallery') ? 'image' : 'file');
}

test('text and multiple images render through the host gallery in attachment order', async t => {
  const calls = [];
  const first = photo('first');
  const second = photo('second');
  const content = [text('Please compare'), first, text(' these photos'), second];
  const before = structuredClone(content);
  const doc = await mount(t, content, gallery(calls));
  assert.match(doc.querySelector('.mtx-bubble').textContent, /Please compare[\s\S]*these photos/);
  assert.deepEqual([...doc.querySelectorAll('img')].map(img => img.alt), ['first', 'second']);
  assert.equal(doc.querySelector('.mtx-img'), null);
  assert.ok(calls.length > 0);
  // Text between two images does not split the run: the attachment row holds
  // every attachment, so the images stay one gallery call. Assertions compare
  // attachment identity (the plugin runs in another realm, so deepEqual on
  // arrays it built would compare prototypes) and stay render-count invariant —
  // the stores settle and re-render the component.
  for (const call of calls) {
    assert.equal(call.align, 'end');
    assert.equal(call.images.length, 2);
    assert.equal(call.images[0].attachment, first.attachment);
    assert.equal(call.images[1].attachment, second.attachment);
  }
  assert.deepEqual(content, before, 'Rendering must not rewrite message content');
});

test('consecutive images share one host gallery call', async t => {
  const calls = [];
  const first = photo('first');
  const second = photo('second');
  const doc = await mount(t, [text('two'), first, second], gallery(calls));
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.images.length, 2);
    assert.equal(call.images[0].attachment, first.attachment);
    assert.equal(call.images[1].attachment, second.attachment);
  }
  assert.deepEqual([...doc.querySelectorAll('img')].map(img => img.alt), ['first', 'second']);
});

test('an image-only message still displays its image', async t => {
  const doc = await mount(t, [photo('only')], gallery([]));
  assert.equal(doc.querySelector('img')?.alt, 'only');
});

test('a file attachment renders the host file card', async t => {
  const calls = { icons: [], extensions: [], sizes: [] };
  const doc = await mount(t, [file('diagnostic-T2026.log', 114820), text('kk')], gallery([]), { calls });
  const card = doc.querySelector('.mtx-file');
  assert.ok(card, 'A file attachment must render instead of disappearing');
  assert.equal(doc.querySelectorAll('.mtx-file').length, 1, 'One card per attachment');
  assert.equal(card.getAttribute('title'), 'diagnostic-T2026.log');
  assert.equal(card.querySelector('.mtx-file-name').textContent, 'diagnostic-T2026.log');
  assert.equal(card.querySelector('.mtx-file-meta').textContent, 'LOG 114820B');
  assert.equal(card.querySelector('[data-file-icon]').getAttribute('data-file-icon'), 'diagnostic-T2026.log');
  assert.deepEqual([...new Set(calls.extensions)], ['diagnostic-T2026.log']);
  assert.deepEqual([...new Set(calls.sizes)], [114820]);
  assert.match(doc.querySelector('.mtx-bubble').textContent, /kk/);
});

test('a file-only message still shows its card', async t => {
  const doc = await mount(t, [file('卡片-export.json', 148441)], gallery([]));
  assert.equal(doc.querySelector('.mtx-file-name').textContent, '卡片-export.json');
  assert.equal(doc.querySelector('.mtx-file-meta').textContent, 'JSON 148441B');
  assert.equal(doc.querySelector('.mtx-bubble').textContent, '');
});

test('images and files keep their original block order', async t => {
  const calls = [];
  const doc = await mount(t, [photo('a'), file('notes.txt', 10), photo('b')], gallery(calls), {
    calls: { icons: [], extensions: [], sizes: [] },
  });
  const row = doc.querySelector('[data-message-attachments]');
  assert.deepEqual(cardKinds(row), ['image', 'file', 'image']);
  assert.ok(calls.length > 0);
  for (const call of calls) assert.equal(call.images.length, 1, 'A file must break the image run');
  assert.deepEqual([...doc.querySelectorAll('img')].map(img => img.alt), ['a', 'b']);
});

test('a file card without bytes omits the size but keeps the name', async t => {
  const doc = await mount(t, [{ type: 'file', attachment: { attachmentId: 'sha256:x', name: 'no-size.txt' } }], gallery([]));
  assert.equal(doc.querySelector('.mtx-file-name').textContent, 'no-size.txt');
  assert.equal(doc.querySelector('.mtx-file-meta').textContent, 'TXT');
});

test('a shell without the host atoms still shows the file name', async t => {
  const doc = await mount(t, [file('qa.log', 2048)], gallery([]), { atoms: 'missing' });
  assert.equal(doc.querySelector('.mtx-file-name').textContent, 'qa.log');
  assert.equal(doc.querySelector('[data-file-icon]'), null);
  assert.equal(doc.querySelector('.mtx-file-meta'), null);
});

test('an unknown block type is shown instead of dropped', async t => {
  const doc = await mount(t, [text('look'), { type: 'audio', source: 'clip.mp3' }], gallery([]));
  const box = doc.querySelector('[data-json-block]');
  assert.ok(box, 'An unknown block must leave a trace');
  assert.equal(box.textContent, JSON.stringify({ type: 'audio', source: 'clip.mp3' }));
  assert.match(doc.querySelector('.mtx-bubble').textContent, /look/);
});

test('an unknown block still leaves a trace without the host atoms', async t => {
  const doc = await mount(t, [{ type: 'audio' }], gallery([]), { atoms: 'missing' });
  assert.equal(doc.querySelector('.mtx-block').textContent, 'Additional content');
});

for (const callback of [undefined, null, 'unavailable']) {
  test(`missing/non-function host renderer falls back safely (${String(callback)})`, async t => {
    const doc = await mount(t, [text('Photo'), photo('one')], callback);
    assert.equal(doc.querySelector('img'), null);
    assert.equal(doc.querySelector('.mtx-img')?.textContent, '1 image(s) kept as-is');
  });
}

test('text-only messages do not invoke the gallery or display an image notice', async t => {
  const calls = [];
  const doc = await mount(t, [text('Hello')], gallery(calls));
  assert.equal(calls.length, 0);
  assert.equal(doc.querySelector('.mtx-bubble').textContent, 'Hello');
  assert.equal(doc.querySelector('.mtx-img'), null);
  assert.equal(doc.querySelector('[data-message-attachments]'), null);
});

test('an image block without an attachment uses the existing placeholder', async t => {
  const calls = [];
  const doc = await mount(t, [text('Photo'), { type: 'image' }], gallery(calls));
  assert.equal(calls.length, 0);
  assert.equal(doc.querySelector('.mtx-img')?.textContent, '1 image(s) kept as-is');
});

test('editing shows the attachment as a removable chip and cancelling restores the gallery', async t => {
  const calls = [];
  const doc = await mount(t, [text('Describe this'), photo('one')], gallery(calls));
  assert.ok(doc.querySelector('img'));
  await act(async () => doc.querySelector('[data-act="edit"]').click());
  assert.equal(doc.querySelector('textarea')?.value, 'Describe this');
  assert.equal(doc.querySelector('[data-host-gallery]'), null, 'The transcript gallery gives way to the editor');
  assert.deepEqual(chipList(doc), [{ kind: 'image', name: 'Image', upload: null }]);
  const cancel = [...doc.querySelectorAll('button')].find(button => button.textContent === 'Cancel');
  assert.ok(cancel);
  await act(async () => cancel.click());
  assert.equal(doc.querySelector('textarea'), null);
  assert.equal(doc.querySelector('img')?.alt, 'one');
});

test('editing a message with a file shows the file chip', async t => {
  const doc = await mount(t, [file('qa.log', 2048), text('describe this')], gallery([]), {
    calls: { icons: [], extensions: [], sizes: [] },
  });
  assert.equal(doc.querySelector('.mtx-file-name').textContent, 'qa.log');
  await act(async () => doc.querySelector('[data-act="edit"]').click());
  assert.deepEqual(chipList(doc), [{ kind: 'file', name: 'qa.log', upload: 'ready' }]);
  assert.equal(doc.querySelector('[data-edit-attachments] .mtx-file-meta').textContent, 'LOG 2048B');
  const cancel = [...doc.querySelectorAll('button')].find(button => button.textContent === 'Cancel');
  await act(async () => cancel.click());
  assert.equal(doc.querySelector('.mtx-file-name').textContent, 'qa.log');
});

/* --------------------------------------------------- editable attachments -- */

function uploadService(calls, outcome = 'envelope') {
  return {
    upload(sessionId, blob, name, signal, onProgress) {
      calls.push({ sessionId, name, signal });
      if (onProgress) onProgress({ loaded: 1, total: 4 });
      if (outcome === 'reject') return Promise.reject(new Error('upload refused'));
      if (outcome === 'failed') {
        return Promise.resolve({
          ok: false,
          error: { code: 'session/attachment-invalid', message: 'File was not uploaded for this session.', details: {} },
        });
      }
      const value = { receiptId: `receipt-${name}`, file: { attachmentId: `sha256:${name}`, name, bytes: 2 } };
      // The raw browser route answers a result envelope; the remote fallback
      // answers the bare value.
      return Promise.resolve(outcome === 'bare' ? value : { ok: true, value });
    },
  };
}

const send = async doc => {
  const button = [...doc.querySelectorAll('button')].find(entry => entry.textContent === 'Send');
  assert.ok(button, 'The editor must offer Send');
  await act(async () => button.click());
};

const editRequest = doc => doc.requests.find(entry => entry.body !== undefined && entry.body.action === 'edit');

// Reading a picked image is genuinely asynchronous (FileReader), so its submit
// lands a turn of the event loop later.
const settle = async doc => {
  for (let attempt = 0; attempt < 10 && editRequest(doc) === undefined; attempt += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
};

const enterEdit = async doc => act(async () => doc.querySelector('[data-act="edit"]').click());

/** The editor's own attachment chips, in render order. */
const chipList = doc => Array.from(doc.querySelectorAll('[data-edit-attachments] > [data-draft]'), element => ({
  kind: element.classList.contains('mtx-thumb') ? 'image' : 'file',
  name: element.querySelector('.mtx-file-name')?.textContent
    ?? element.querySelector('img')?.getAttribute('alt')
    ?? element.querySelector('.mtx-thumb-empty')?.textContent
    ?? '',
  upload: element.getAttribute('data-upload'),
}));

/** Drop one file on the editor, the way a user drags it in. */
const dropFile = async (doc, picked) => {
  const event = new doc.defaultView.Event('drop', { bubbles: true, cancelable: true });
  event.dataTransfer = { types: ['Files'], files: [picked] };
  await act(async () => doc.querySelector('.mtx-editor').dispatchEvent(event));
};

/** Pick files through the editor's own file input. */
const pickFiles = async (doc, files) => {
  const input = doc.querySelector('.mtx-file-input');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => input.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })));
};

test('the edit box lists the message attachments as removable chips', async t => {
  const doc = await mount(t, [file('qa.log', 2048), text('describe this')], gallery([]));
  await enterEdit(doc);
  assert.deepEqual(chipList(doc), [{ kind: 'file', name: 'qa.log', upload: 'ready' }]);
  assert.equal(doc.querySelector('[data-edit-attachments] .mtx-file-meta').textContent, 'LOG 2048B');
  assert.ok(doc.querySelector('[data-act="attach"]'), 'Adding attachments is offered in the action row');
  assert.ok(doc.querySelector('[data-remove]'), 'Every chip carries a remove button');
});

test('an existing image attachment resolves its preview through the host loader', async t => {
  const ref = { attachmentId: 'sha256:pic', mediaType: 'image/png', name: 'pic.png' };
  const asked = [];
  const loadImage = attachment => { asked.push(attachment); return Promise.resolve('https://host/pic'); };
  loadImage.peek = () => undefined;
  const doc = await mount(t, [text('look'), { type: 'image', attachment: ref }], gallery([]), { loadImage });
  await enterEdit(doc);
  assert.deepEqual(asked, [ref]);
  assert.equal(doc.querySelector('[data-edit-attachments] img').getAttribute('src'), 'https://host/pic');
  assert.deepEqual(chipList(doc), [{ kind: 'image', name: 'pic.png', upload: null }]);
});

test('an image the host cannot resolve keeps a named placeholder', async t => {
  const doc = await mount(t, [text('look'), { type: 'image', attachment: { attachmentId: 'sha256:x', name: 'x.png' } }], gallery([]));
  await enterEdit(doc);
  assert.equal(doc.querySelector('[data-edit-attachments] img'), null);
  assert.equal(doc.querySelector('.mtx-thumb-empty').textContent, 'x.png');
});

test('removing a chip submits the remaining set', async t => {
  const doc = await mount(t, [file('a.log', 1), file('b.log', 2), text('keep one')], gallery([]));
  await enterEdit(doc);
  const dropped = doc.querySelectorAll('[data-remove]')[1];
  await act(async () => dropped.click());
  assert.deepEqual(chipList(doc), [{ kind: 'file', name: 'a.log', upload: 'ready' }]);
  await send(doc);
  const request = editRequest(doc);
  assert.deepEqual(request.body.attachments, [{ type: 'file', attachment: file('a.log', 1).attachment }]);
  assert.equal(request.body.text, 'keep one');
});

test('removing every chip submits an empty set', async t => {
  const doc = await mount(t, [file('only.log', 1), text('text stays')], gallery([]));
  await enterEdit(doc);
  await act(async () => doc.querySelector('[data-remove]').click());
  assert.equal(doc.querySelector('[data-edit-attachments]'), null);
  await send(doc);
  assert.deepEqual(editRequest(doc).body.attachments, []);
});

test('a dropped file uploads and submits its staged receipt', async t => {
  const calls = [];
  const doc = await mount(t, [text('add a file')], gallery([]), { fileUpload: uploadService(calls) });
  await enterEdit(doc);
  await dropFile(doc, new doc.defaultView.File(['hello'], 'new.log', { type: 'text/plain' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'session-test');
  assert.equal(calls[0].name, 'new.log');
  assert.deepEqual(chipList(doc), [{ kind: 'file', name: 'new.log', upload: 'ready' }]);
  await send(doc);
  assert.deepEqual(editRequest(doc).body.attachments, [{ type: 'file', receiptId: 'receipt-new.log' }]);
});

test('a failed upload stays visible and can be retried', async t => {
  const calls = [];
  const doc = await mount(t, [text('add a file')], gallery([]), { fileUpload: uploadService(calls, 'failed') });
  await enterEdit(doc);
  await pickFiles(doc, [new doc.defaultView.File(['hello'], 'flaky.log', { type: 'text/plain' })]);
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(chipList(doc), [{ kind: 'file', name: 'flaky.log', upload: 'error' }]);
  const retry = doc.querySelector('[data-retry]');
  assert.ok(retry, 'A failed upload offers a retry');
  assert.match(retry.textContent, /retry/i);
  await send(doc);
  assert.equal(editRequest(doc), undefined, 'An unfinished upload must not be submitted');
  assert.match(doc.querySelector('.mtx-error').textContent, /没有上传完成/);
});

// The browser route answers `{ok, value}` while the remote fallback answers the
// value itself. Reading only one of them left `receiptId` undefined, JSON
// dropped the key, and the host rejected the whole request.
test('a bare upload answer also yields the staged receipt', async t => {
  const calls = [];
  const doc = await mount(t, [text('add a file')], gallery([]), { fileUpload: uploadService(calls, 'bare') });
  await enterEdit(doc);
  await dropFile(doc, new doc.defaultView.File(['hello'], 'bare.log', { type: 'text/plain' }));
  assert.deepEqual(chipList(doc), [{ kind: 'file', name: 'bare.log', upload: 'ready' }]);
  await send(doc);
  assert.deepEqual(editRequest(doc).body.attachments, [{ type: 'file', receiptId: 'receipt-bare.log' }]);
});

test('a picked image is encoded on submit', async t => {
  const doc = await mount(t, [text('add an image')], gallery([]));
  await enterEdit(doc);
  await pickFiles(doc, [new doc.defaultView.File([new Uint8Array([1, 2, 3])], 'new.png', { type: 'image/png' })]);
  assert.deepEqual(chipList(doc), [{ kind: 'image', name: 'new.png', upload: null }]);
  await send(doc);
  await settle(doc);
  const [part] = editRequest(doc).body.attachments;
  assert.equal(part.type, 'image');
  assert.equal(part.mediaType, 'image/png');
  assert.equal(part.name, 'new.png');
  assert.equal(part.data, Buffer.from([1, 2, 3]).toString('base64'));
});

test('an edit without the host loader still lists and submits the attachments', async t => {
  const doc = await mount(t, [file('qa.log', 2048), text('describe this')], gallery([]));
  await enterEdit(doc);
  assert.deepEqual(chipList(doc), [{ kind: 'file', name: 'qa.log', upload: 'ready' }]);
  await send(doc);
  assert.deepEqual(editRequest(doc).body.attachments, [{ type: 'file', attachment: file('qa.log', 2048).attachment }]);
});

/* ------------------------------------------- open a file in the sidebar -- */

const SHA = 'a'.repeat(64);
const storedFile = (name, bytes) => ({ type: 'file', attachment: { attachmentId: `sha256:${SHA}`, name, bytes } });
const settleOpen = async () => { await act(async () => { await Promise.resolve(); }); };

test('clicking a file card opens the host document preview on the attachment', async t => {
  const opened = [];
  const hostPath = `C:\\Users\\qa\\.dsh\\attachments\\v1\\files\\aa\\${SHA}\\qa.log`;
  const doc = await mount(t, [storedFile('qa.log', 2048), text('see attached')], gallery([]), {
    attachmentPath: hostPath,
    sidebarRight: { openResource: (address, options) => opened.push({ address, options }) },
  });
  const card = doc.querySelector('[data-open-file]');
  assert.ok(card, 'A transcript file card must be clickable');
  assert.equal(card.tagName, 'BUTTON');
  await act(async () => card.click());
  await settleOpen();
  // The address grammar is the host's own `sessionFileAddress`: session scope,
  // backslashes normalized, the drive colon kept literal.
  assert.deepEqual(opened.map(entry => entry.address),
    [`dsh-resource://file/session/session-test/C:/Users/qa/.dsh/attachments/v1/files/aa/${SHA}/qa.log`]);
  assert.match(doc.requests.find(entry => entry.url.includes('/message-tree/attachment')).url,
    /attachmentId=sha256%3A/, 'The reference travels as a query, never as a path');
  assert.equal(doc.querySelector('.mtx-error'), null);
});

test('a host path with spaces is encoded segment by segment', async t => {
  const opened = [];
  const doc = await mount(t, [storedFile('my file.log', 1), text('x')], gallery([]), {
    attachmentPath: `C:\\Users\\a b\\.dsh\\attachments\\v1\\files\\aa\\${SHA}\\my file.log`,
    sidebarRight: { openResource: address => opened.push(address) },
  });
  await act(async () => doc.querySelector('[data-open-file]').click());
  await settleOpen();
  assert.deepEqual(opened,
    [`dsh-resource://file/session/session-test/C:/Users/a%20b/.dsh/attachments/v1/files/aa/${SHA}/my%20file.log`]);
});

test('a file the host cannot place reports the reason on the bubble', async t => {
  const opened = [];
  const doc = await mount(t, [storedFile('qa.log', 1), text('x')], gallery([]), {
    sidebarRight: { openResource: address => opened.push(address) },
  });
  await act(async () => doc.querySelector('[data-open-file]').click());
  await settleOpen();
  assert.deepEqual(opened, []);
  assert.match(doc.querySelector('.mtx-error').textContent, /宿主路径/);
});

test('a surface without a sidebar says so instead of failing silently', async t => {
  const doc = await mount(t, [storedFile('qa.log', 1), text('x')], gallery([]), { attachmentPath: 'C:/qa.log' });
  await act(async () => doc.querySelector('[data-open-file]').click());
  await settleOpen();
  assert.match(doc.querySelector('.mtx-error').textContent, /sidebar/i);
});

test('version navigation opens the selected sibling', async t => {
  const opened = [];
  const doc = await mount(t, [text('Hello')], gallery([]), { open: id => opened.push(id), versions: [
    { sessionId: 'session-test', createdAt: 1 },
    { sessionId: 'sibling', parentSessionId: 'session-test', targetTurn: 1, createdAt: 2 },
  ] });
  const ring = doc.querySelector('.mtx-ring');
  assert.ok(ring, 'Version navigation must render');
  assert.match(ring.textContent, /1\/2/);
  await act(async () => ring.querySelectorAll('button')[1].click());
  assert.deepEqual(opened, ['sibling']);
});
