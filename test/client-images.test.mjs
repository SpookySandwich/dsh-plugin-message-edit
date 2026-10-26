import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createLocale } from './fixtures/locale-runtime.mjs';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const photo = id => ({ type: 'image', attachment: { id, attachmentId: `sha256:${id}`, name: `${id}.png`, mediaType: 'image/png' } });
const text = value => ({ type: 'text', text: value });

// Run the shipped bundle and capture the component through its actual slot
// registration. React and the DOM are real; the host services/gallery are test
// doubles. This tests delegation and UI transitions, not DSH's image loader.
async function mount(t, content, renderMessageImages, options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://message-edit.test/',
  });
  dom.window.localStorage.setItem('dsh-plugin-message-tree:style', options.style ?? 'chatgpt');
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ versions: options.versions ?? [] }) });
  const previous = new Map();
  const browserErrors = [];
  dom.window.addEventListener('error', event => browserErrors.push(event.error || event.message));
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // React DOM detects browser input support at import time.
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  let unmounted = false;
  const disposers = [];
  t.after(async () => {
    if (!unmounted) await act(async () => root.unmount());
    for (const dispose of disposers.reverse()) dispose();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(browserErrors, [], 'Browser event handlers must not throw');
  });
  let component;
  const slots = {
    inject(_name, register) { register(); },
    register(spec, view) {
      if (spec.name === 'conversation.chat.node' && spec.key === 'user') component = view;
      return () => {};
    },
  };
  let plugin;
  dom.window.__ModuleLoader__ = {
    load({ id, factory }) {
      assert.equal(id, 'dsh-plugin-message-edit');
      plugin = factory(name => {
        assert.equal(name, 'react');
        return React;
      });
    },
  };
  runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console,
    setTimeout, clearTimeout,
  }, { filename: 'lib/client.js' });
  plugin.apply({
    get(name) { return name === 'slots' ? slots : name === 'sessions' ? {
      list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: Object.fromEntries(
        ['session-test', ...(options.versions ?? []).map(version => version.sessionId)].map(id => [id, { id }])) }) },
    } : name === 'uiWorkspace' ? { openSession: options.open ?? (() => {}) } : name === 'locale' ? options.locale : undefined; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  assert.equal(typeof component, 'function', 'The user-message slot must register');
  const props = {
    sessionId: 'session-test',
    node: { data: { content, seq: 2 }, location: { turn: { turn: 1 } } },
    renderMessageImages,
    ...options.props,
  };
  await act(async () => root.render(React.createElement(component, props)));
  if (options.controls) Object.assign(options.controls, {
    async render(next) { Object.assign(props, next); await act(async () => root.render(React.createElement(component, props))); },
    async unmount() { await act(async () => root.unmount()); unmounted = true; },
  });
  return dom.window.document;
}

function gallery(calls) {
  return props => {
    calls.push(props);
    return React.createElement('div', { 'data-host-gallery': true },
      props.images.map(({ attachment }) => React.createElement('button', {
        key: attachment.id, type: 'button', 'aria-label': `Open ${attachment.id}`,
      }, React.createElement('img', { src: `/attachments/${attachment.id}`, alt: attachment.id }))));
  };
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
  for (const call of calls) {
    assert.equal(call.align, 'end');
    assert.equal(call.images.length, 2);
    assert.equal(call.images[0].attachment, first.attachment);
    assert.equal(call.images[1].attachment, second.attachment);
  }
  assert.deepEqual(content, before, 'Rendering must not rewrite message content');
});

test('an image-only message still displays its image', async t => {
  const doc = await mount(t, [photo('only')], gallery([]));
  assert.equal(doc.querySelector('img')?.alt, 'only');
});

test('DSH async image loader displays attachments without the retired gallery callback', async t => {
  const doc = await mount(t, [photo('async')], undefined, {
    props: { loadImage: async () => '/attachments/async.png' },
  });
  assert.equal(doc.querySelector('img')?.getAttribute('src'), '/attachments/async.png');
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
});

test('an image block without an attachment reports unavailable', async t => {
  const calls = [];
  const doc = await mount(t, [text('Photo'), { type: 'image' }], gallery(calls));
  assert.equal(calls.length, 0);
  assert.equal(doc.querySelector('.mtx-img')?.textContent, 'Image unavailable');
});

test('native content factory receives ordered image blocks and a working fallback without child declarations', async t => {
  const calls = [];
  const parts = [photo('red'), photo('blue')];
  const loader = async attachment => `/images/${attachment.id}.png`;
  const doc = await mount(t, parts, undefined, { props: {
    loadImage: loader,
    renderFactorySlot(name, props, options) { calls.push({ name, props }); return options.fallback; },
  } });
  assert.deepEqual([...doc.querySelectorAll('img')].map(img => img.getAttribute('src')), ['/images/red.png', '/images/blue.png']);
  assert.ok(calls.length);
  assert.equal(doc.querySelector('.mtx-native-images')?.parentElement.className, 'mtx-row');
  assert.equal(doc.querySelector('.mtx-bubble'), null, 'Image-only factory content must not acquire a second bubble');
  for (const { name, props } of calls) {
    assert.equal(name, 'conversation.chat.user.content');
    assert.equal(props.loadImage, loader);
    assert.equal(props.content.text, '');
    assert.equal(props.content.attachments[0].image.attachment, parts[0].attachment);
    assert.equal(props.content.attachments[1].image.attachment, parts[1].attachment);
  }
});

test('legacy gallery takes precedence over the factory and loader', async t => {
  const unexpected = () => assert.fail('Legacy callback should own rendering');
  const doc = await mount(t, [photo('legacy')], gallery([]), { props: { loadImage: unexpected, renderFactorySlot: unexpected } });
  assert.equal(doc.querySelector('img').alt, 'legacy');
  assert.ok(doc.querySelector('.mtx-bubble img'));
  assert.equal(doc.querySelector('.mtx-native-images'), null);
});

test('native factory content sits above the text bubble in the full message row', async t => {
  const doc = await mount(t, [text('Caption'), photo('native')], undefined, { props: {
    loadImage: async () => '/native.png',
    renderFactorySlot(_name, _props, options) { return options.fallback; },
  } });
  const row = doc.querySelector('.mtx-row');
  assert.equal(row.firstElementChild.className, 'mtx-native-images');
  assert.ok(row.firstElementChild.querySelector('img'));
  assert.equal(doc.querySelector('.mtx-bubble').textContent, 'Caption');
  assert.equal(doc.querySelector('.mtx-bubble img'), null);
});

test('cached URLs render without loading and thumbnail opens the original safely', async t => {
  const loadImage = Object.assign(() => assert.fail('Cache hit should avoid loading'), { peek: () => '/cached.png' });
  const doc = await mount(t, [photo('cached')], undefined, { props: { loadImage } });
  const opened = [];
  doc.defaultView.open = (...args) => opened.push(args);
  await act(async () => doc.querySelector('.mtx-thumb').click());
  assert.deepEqual(opened, [['/cached.png', '_blank', 'noopener,noreferrer']]);
});

test('sync loader and throwing peek are supported', async t => {
  const loadImage = Object.assign(() => '/sync.png', { peek() { throw new Error('cache miss'); } });
  const doc = await mount(t, [photo('sync')], undefined, { props: { loadImage } });
  assert.equal(doc.querySelector('img').getAttribute('src'), '/sync.png');
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('Russian fallback images show loading, open and unavailable messages through the official locale', async t => {
  const pending = deferred();
  const locale = createLocale(['ru-RU']);
  const doc = await mount(t, [photo('ru')], undefined, { locale, props: { loadImage: () => pending.promise } });
  assert.equal(doc.querySelector('[role="status"]').textContent, 'ru.png: Загрузка изображения…');
  await act(async () => pending.resolve('/ru.png'));
  assert.equal(doc.querySelector('.mtx-thumb').title, 'Открыть изображение');
  await act(async () => doc.querySelector('img').dispatchEvent(new doc.defaultView.Event('error')));
  assert.equal(doc.querySelector('[role="status"]').textContent, 'ru.png: Изображение недоступно');
});

test('Russian native-factory fallback and edit/cancel preserve images and translated retention notice', async t => {
  const locale = createLocale(['ru']);
  const doc = await mount(t, [text('Photo'), photo('one'), { type: 'image' }], undefined, { locale, props: {
    loadImage: async () => '/one.png',
    renderFactorySlot(_name, _props, options) { return options.fallback; },
  } });
  assert.ok(doc.querySelector('.mtx-native-images img'));
  assert.match(doc.body.textContent, /Изображение недоступно/);
  assert.equal(doc.querySelector('[data-act="edit"]').title, 'Редактировать сообщение');
  await act(async () => doc.querySelector('[data-act="edit"]').click());
  assert.equal(doc.querySelector('.mtx-img').textContent, 'Изображений сохранено как есть: 2');
  await act(async () => [...doc.querySelectorAll('button')].find(button => button.textContent === 'Отмена').click());
  assert.ok(doc.querySelector('.mtx-native-images img'));
});

test('Russian image retention fallback works when no image renderer is supplied', async t => {
  const doc = await mount(t, [photo('one')], undefined, { locale: createLocale(['ru']) });
  assert.equal(doc.querySelector('.mtx-img').textContent, 'Изображений сохранено как есть: 1');
});

test('pending loads never become src values; rebind ignores stale resolutions and clears a previous URL', async t => {
  const controls = {};
  const old = deferred();
  const next = deferred();
  const part = photo('same');
  const doc = await mount(t, [part], undefined, { controls, props: { loadImage: () => old.promise } });
  assert.equal(doc.querySelector('img'), null);
  assert.match(doc.body.textContent, /Loading image/);
  await controls.render({ loadImage: () => next.promise });
  await act(async () => old.resolve('/stale.png'));
  assert.equal(doc.querySelector('img'), null);
  await act(async () => next.resolve('/next.png'));
  assert.equal(doc.querySelector('img').getAttribute('src'), '/next.png');
  const last = deferred();
  await controls.render({ node: { data: { content: [photo('other')], seq: 3 } }, loadImage: () => last.promise });
  assert.equal(doc.querySelector('img'), null, 'A different attachment cannot show the previous URL');
  await act(async () => last.resolve('/last.png'));
  assert.equal(doc.querySelector('img').getAttribute('src'), '/last.png');
});

test('session rebind remounts even with the same attachment and loader', async t => {
  const controls = {};
  const pending = [deferred(), deferred()];
  let calls = 0;
  const doc = await mount(t, [photo('shared')], undefined, { controls, props: { loadImage: () => pending[calls++].promise } });
  await controls.render({ sessionId: 'another-session' });
  await act(async () => pending[0].resolve('/old-session.png'));
  assert.equal(doc.querySelector('img'), null);
  await act(async () => pending[1].resolve('/new-session.png'));
  assert.equal(doc.querySelector('img').getAttribute('src'), '/new-session.png');
});

for (const outcome of ['reject', 'throw', 'empty', 'object']) {
  test(`loader ${outcome} leaves a readable unavailable notice`, async t => {
    const loadImage = () => {
      if (outcome === 'throw') throw new Error('missing');
      if (outcome === 'reject') return Promise.reject(new Error('missing'));
      return outcome === 'empty' ? '' : {};
    };
    const doc = await mount(t, [photo('missing')], undefined, { props: { loadImage } });
    assert.equal(doc.querySelector('img'), null);
    assert.match(doc.body.textContent, /missing.png: Image unavailable/);
  });
}

test('image decode failure removes the broken thumbnail', async t => {
  const doc = await mount(t, [photo('broken')], undefined, { props: { loadImage: async () => '/broken.png' } });
  await act(async () => doc.querySelector('img').dispatchEvent(new doc.defaultView.Event('error')));
  assert.equal(doc.querySelector('img'), null);
  assert.match(doc.body.textContent, /Image unavailable/);
});

test('missing attachments do not hide good images in the same message', async t => {
  const doc = await mount(t, [photo('good'), { type: 'image' }], undefined, { props: { loadImage: async () => '/good.png' } });
  assert.equal(doc.querySelector('img').getAttribute('src'), '/good.png');
  assert.match(doc.body.textContent, /Image unavailable/);
});

test('settling a load after unmount is harmless', async t => {
  const controls = {};
  const pending = deferred();
  const doc = await mount(t, [photo('late')], undefined, { controls, props: { loadImage: () => pending.promise } });
  await controls.unmount();
  await act(async () => pending.resolve('/late.png'));
  assert.equal(doc.querySelector('img'), null);
});

test('editing cancels an outstanding load and cancelling reloads images', async t => {
  const pending = [deferred(), deferred()];
  let calls = 0;
  const doc = await mount(t, [text('Edit'), photo('edit')], undefined, { props: { loadImage: () => pending[calls++].promise } });
  await act(async () => doc.querySelector('[data-act="edit"]').click());
  await act(async () => pending[0].resolve('/obsolete.png'));
  assert.equal(doc.querySelector('img'), null);
  assert.match(doc.body.textContent, /1 image\(s\) kept as-is/);
  await act(async () => [...doc.querySelectorAll('button')].find(button => button.textContent === 'Cancel').click());
  await act(async () => pending[1].resolve('/restored.png'));
  assert.equal(doc.querySelector('img').getAttribute('src'), '/restored.png');
});

test('editing keeps the attachment notice and cancelling restores the host gallery', async t => {
  const calls = [];
  const doc = await mount(t, [text('Describe this'), photo('one')], gallery(calls));
  assert.ok(doc.querySelector('img'));
  await act(async () => doc.querySelector('[data-act="edit"]').click());
  assert.equal(doc.querySelector('textarea')?.value, 'Describe this');
  assert.equal(doc.querySelector('img'), null);
  assert.equal(doc.querySelector('.mtx-img')?.textContent, '1 image(s) kept as-is');
  const cancel = [...doc.querySelectorAll('button')].find(button => button.textContent === 'Cancel');
  assert.ok(cancel);
  await act(async () => cancel.click());
  assert.equal(doc.querySelector('textarea'), null);
  assert.equal(doc.querySelector('img')?.alt, 'one');
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
