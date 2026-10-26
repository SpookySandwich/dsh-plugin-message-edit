import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import React from 'react';
import * as jsx from 'react/jsx-runtime';

// Execute the published browser bundle unchanged. Only unrelated UI imports
// are doubles; dictionary lookup, catalog, fallback and interpolation are DSH.
const modules = process.env.DSH_QA_MODULES ?? fileURLToPath(new URL('../../node_modules/', import.meta.url));
const source = readFileSync(resolve(modules, '@deepseek-ai/dsh-client-locale/lib/client.js'), 'utf8');
let LocaleRuntime;
runInNewContext(source, {
  window: { __ModuleLoader__: { load({ factory }) {
    ({ LocaleRuntime } = factory(name => name === 'react' ? React : name === 'react/jsx-runtime' ? jsx : {}));
  } } },
  console,
});

export function createLocale(languages = ['en']) {
  return new LocaleRuntime({ emit() {}, effect: fn => fn() }, undefined, { languages, preference: null });
}
