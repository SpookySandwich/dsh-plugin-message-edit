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
      : name === 'sessions' && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller') ? { open() {} } : undefined,
    effect: fn => fn(),
  });
  assert.deepEqual(registered, ['settings.section', 'conversation.chat.node', 'conversation.view']);
});

test('a missing slots service fails visibly instead of silently disabling the module', () => {
  const { plugin } = load();
  assert.throws(() => plugin.apply({ get: () => undefined }), /Missing DSH slots service.*inject/);
});

test('Cordis waits for the asynchronous session service before applying the client', async t => {
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
  ctx.provide('sessions', { open() {} });
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
    } : name === 'sessions' ? { open() {} } : undefined,
    effect: fn => fn(),
  });
  assert.deepEqual(registered, ['settings.section', 'conversation.view']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /editing is unavailable/);
});

// The host's slots registry lets exactly one entry declare a child slot. The
// composer's entry already declares `conversation.input.attachments`, so asking
// for it throws — and losing the user view over that would take the edit button,
// the version ring and the attachment cards with it.
test('a child slot another entry already declared does not cost the user view', () => {
  const { plugin, warnings } = load();
  const registered = [];
  plugin.apply({
    get: name => name === 'slots' ? {
      inject: (_name, register) => register(),
      register(spec) {
        if (spec.children) throw new Error('slot "conversation.input.attachments" is already declared');
        registered.push(spec);
        return () => {};
      },
    } : name === 'sessions' ? { open() {} } : undefined,
    effect: fn => fn(),
  });
  assert.deepEqual(registered.map(spec => spec.name),
    ['settings.section', 'conversation.chat.node', 'conversation.view']);
  const user = registered.find(spec => spec.name === 'conversation.chat.node');
  assert.equal(user.key, 'user');
  assert.equal(user.priority, -1, 'The bubble still shadows the host renderer');
  assert.equal(Object.hasOwn(user, 'children'), false, 'The retry declares no children');
  assert.deepEqual(warnings, [], 'Recovering from the collision is not a visible failure');
});

test('the user view asks for the attachment slot when nothing declared it yet', () => {
  const { plugin } = load();
  const registered = [];
  plugin.apply({
    get: name => name === 'slots' ? {
      inject: (_name, register) => register(),
      register(spec) { registered.push(spec); return () => {}; },
    } : name === 'sessions' ? { open() {} } : undefined,
    effect: fn => fn(),
  });
  const user = registered.find(spec => spec.name === 'conversation.chat.node');
  // The declaration object is built inside the bundle's realm, so compare its
  // fields rather than the object identity.
  assert.deepEqual(Object.keys(user.children), ['conversation.input.attachments']);
  assert.equal(user.children['conversation.input.attachments'].kind, 'single');
  assert.equal(user.children['conversation.input.attachments'].scope, 'session-maybe');
});
