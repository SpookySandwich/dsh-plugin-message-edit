import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

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
    get: name => name === 'slots' && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots') ? slots : undefined,
    effect: fn => fn(),
  });
  assert.deepEqual(registered, ['settings.section', 'conversation.chat.node', 'conversation.view']);
});

test('a missing slots service fails visibly instead of silently disabling the module', () => {
  const { plugin } = load();
  assert.throws(() => plugin.apply({ get: () => undefined }), /Missing DSH slots service.*inject/);
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
    } : undefined,
    effect: fn => fn(),
  });
  assert.deepEqual(registered, ['settings.section', 'conversation.view']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /editing is unavailable/);
});
