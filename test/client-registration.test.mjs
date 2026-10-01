import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function load() {
  let plugin;
  const warnings = [];
  runInNewContext(bundle, {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({})); } } },
    console: { warn: (...args) => warnings.push(args) },
  });
  return { plugin, warnings };
}

test('declared client dependencies make the UI services available for registration', () => {
  const { plugin } = load();
  const registered = [];
  // This loader double follows the relevant DSH dependency contract: services
  // are available only when their providing client module is injected.
  const slots = {
    inject: (_name, register) => register(),
    register: spec => { registered.push(spec.name); return () => {}; },
  };
  plugin.apply({
    get: name => name === 'slots' && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer') ? slots
      : name === 'sessions' && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller') ? { list: {} }
      : name === 'uiWorkspace' && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace') ? { openSession() {} }
      : undefined,
    effect: fn => fn(),
  });
  assert.deepEqual(registered, ['settings.section', 'conversation.chat.node', 'conversation.view']);
});

test('a missing slots service fails visibly instead of silently disabling the module', () => {
  const { plugin } = load();
  assert.throws(() => plugin.apply({ get: () => undefined }), /Missing DSH slots service.*inject/);
});

test('a missing workspace navigation owner fails visibly', () => {
  const { plugin } = load();
  const slots = { inject() {} };
  const sessions = { list: {} }; // DSH 0.2 sessions intentionally has no open() method.
  assert.throws(() => plugin.apply({
    get: name => name === 'slots' ? slots : name === 'sessions' ? sessions : undefined,
    effect: fn => fn(),
  }), /Missing DSH sessions or uiWorkspace navigation service/);
});

test('Cordis waits for both session data and workspace navigation before applying the client', async t => {
  const { plugin } = load();
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const registered = [];
  ctx.provide('slots', {
    inject: (_name, register) => register(),
    register: spec => { registered.push(spec.name); return () => {}; },
  });
  ctx.provide('locale', {});
  const fiber = ctx.plugin(plugin);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fiber.state, 0, 'Client remains pending until the session controller is ready');
  assert.deepEqual(registered, []);
  ctx.provide('sessions', { list: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fiber.state, 0, 'Client also waits for the workspace navigation owner');
  assert.deepEqual(registered, []);
  ctx.provide('uiWorkspace', { openSession() {} });
  await fiber;
  assert.equal(fiber.state, 2);
  assert.deepEqual(registered, ['settings.section', 'conversation.chat.node', 'conversation.view']);
});

test('a user-renderer collision is reported while the other UI entries still register', () => {
  const { plugin, warnings } = load();
  const registered = [];
  plugin.apply({
    get: name => name === 'slots' ? {
      inject: (_name, register) => register(),
      register(spec) {
        if (spec.name === 'conversation.chat.node') throw new Error('duplicate renderer');
        registered.push(spec.name);
        return () => {};
      },
    } : name === 'sessions' ? { list: {} }
      : name === 'uiWorkspace' ? { openSession() {} }
      : undefined,
    effect: fn => fn(),
  });
  assert.deepEqual(registered, ['settings.section', 'conversation.view']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /editing is unavailable/);
});
