import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const photo = id => ({ type: 'image', attachment: { id, mimeType: 'image/png' } });
const text = value => ({ type: 'text', text: value });

// Run the shipped bundle and capture the component through its actual slot
// registration. React and the DOM are real; the host services/gallery are test
// doubles. This tests delegation and UI transitions, not DSH's image loader.
async function mount(t, content, renderMessageImages) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://message-edit.test/',
  });
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
    fetch: async () => ({ ok: true, json: async () => ({ versions: [] }) }),
  }, { filename: 'lib/client.js' });
  plugin.apply({
    get(name) { return name === 'slots' ? slots : undefined; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  assert.equal(typeof component, 'function', 'The user-message slot must register');
  const props = {
    sessionId: 'session-test',
    node: { data: { content, seq: 2 }, location: { turn: { turn: 1 } } },
    renderMessageImages,
  };
  await act(async () => root.render(React.createElement(component, props)));
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

test('an image block without an attachment uses the existing placeholder', async t => {
  const calls = [];
  const doc = await mount(t, [text('Photo'), { type: 'image' }], gallery(calls));
  assert.equal(calls.length, 0);
  assert.equal(doc.querySelector('.mtx-img')?.textContent, '1 image(s) kept as-is');
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
