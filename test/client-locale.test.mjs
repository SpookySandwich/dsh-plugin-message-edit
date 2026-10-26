import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createLocale } from './fixtures/locale-runtime.mjs';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const ns = 'dsh-plugin-message-tree';

function apply(locale) {
  let plugin, dictionaries;
  const disposers = [];
  const specs = [];
  const register = locale.register;
  locale.register = function (name, dicts) {
    assert.equal(name, ns);
    dictionaries = dicts;
    return register.call(this, name, dicts);
  };
  runInNewContext(bundle, {
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({})); } } }, console,
  });
  plugin.apply({
    get: name => ({ locale, slots: {
      inject: (_name, fn) => fn(),
      register: spec => { specs.push(spec); return () => {}; },
    }, sessions: { list: {} }, uiWorkspace: { openSession() {} } })[name],
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  locale.register = register;
  return { dictionaries, specs, dispose() { disposers.reverse().forEach(fn => fn()); } };
}

test('all 37 locale keys and placeholder multisets match the English dictionary', () => {
  const { dictionaries, dispose } = apply(createLocale());
  try {
    const keys = Object.keys(dictionaries.en).sort();
    assert.equal(keys.length, 37);
    const tokens = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const language of ['ru', 'zh']) {
      assert.deepEqual(Object.keys(dictionaries[language]).sort(), keys);
      for (const key of keys) {
        assert.ok(dictionaries[language][key].trim(), `${language}.${key} must not be empty`);
        assert.deepEqual(tokens(dictionaries[language][key]), tokens(dictionaries.en[key]), `${language}.${key}`);
      }
    }
  } finally { dispose(); }
});

test('official locale catalog selects Russian for ru-RU and translates every key with parameters', () => {
  const locale = createLocale(['ru-RU', 'en']);
  assert.equal(locale.getSnapshot().active, 'en', 'DSH starts without a Russian definition');
  const { dictionaries, specs, dispose } = apply(locale);
  const t = locale.bind(ns);
  try {
    assert.equal(locale.getSnapshot().active, 'ru');
    assert.equal(locale.getSnapshot().locales.find(item => item.id === 'ru').label, 'Русский');
    for (const [key, value] of Object.entries(dictionaries.ru)) {
      assert.equal(t(key, { turn: 7, count: 2 }), value.replaceAll('{turn}', '7').replaceAll('{count}', '2'));
    }
    assert.equal(specs.find(spec => spec.name === 'conversation.view').label(), 'Версии');
    locale.setLocale('en');
    assert.equal(t('edit'), 'Edit message');
    locale.setLocale('zh');
    assert.equal(t('view'), '版本');
    locale.setLocale('ru');
    assert.equal(t('edited', { turn: 7 }), 'Изменён ход 7');
    assert.equal(specs.find(spec => spec.name === 'settings.section').label(), 'Редактирование сообщений');
    locale.register('qa-fallback', { en: { missing: 'English {count}' } });
    assert.equal(locale.bind('qa-fallback')('missing', { count: 2 }), 'English 2');
    locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' });
    locale.setLocale('fr');
    assert.equal(t('images', { count: 2 }), '2 image(s) kept as-is');
    assert.equal(t('unknown-key'), 'unknown-key');
  } finally { dispose(); }
  assert.ok(!locale.getSnapshot().locales.some(item => item.id === 'ru'));
  assert.equal(t('edit'), 'edit', 'Disposal releases dictionaries');
});

test('an existing Russian language pack keeps its catalog entry on plugin disposal', () => {
  const locale = createLocale(['ru']);
  const remove = locale.addLanguage({ id: 'ru', label: 'Русский (pack)', fallback: 'en' });
  const { dispose } = apply(locale);
  assert.equal(locale.bind(ns)('view'), 'Версии');
  dispose();
  assert.equal(locale.getSnapshot().locales.find(item => item.id === 'ru').label, 'Русский (pack)');
  assert.equal(locale.getSnapshot().active, 'ru');
  remove();
});

test('dictionary-only locale services keep working without the catalog extension', () => {
  const locale = createLocale();
  locale.addLanguage = undefined;
  const { dispose } = apply(locale);
  assert.equal(locale.bind(ns)('edit'), 'Edit message');
  dispose();
});
