// Isolated official-host browser QA launcher. Never use a personal DSH_HOME.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, symlink, writeFile, copyFile, readFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
assert.ok(process.env.DSH_QA_MODULES && process.env.DSH_QA_HOME);
const modules = resolve(process.env.DSH_QA_MODULES);
const home = resolve(process.env.DSH_QA_HOME);
assert.match(home, /[\\/]message-edit-dsh-qa-[^\\/]+$/);
const profile = join(home, 'profiles', 'web');
await mkdir(join(profile, 'node_modules'), { recursive: true });
for (const [source, name] of [[join(modules, '@deepseek-ai'), '@deepseek-ai'], [root, 'dsh-plugin-message-edit']]) {
  try { await symlink(source, join(profile, 'node_modules', name), 'junction'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'message-edit-browser-qa', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-message-edit'] } } }));
for (const name of ['dsh-acceptance.mjs', 'dsh-browser-acceptance.mjs'])
  await copyFile(join(root, 'test/fixtures', name), join(profile, name));
await writeFile(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: offline-qa\n      name: ./dsh-browser-acceptance.mjs\n' +
  (process.env.DSH_QA_FTS === 'off' ? '' : '- id: session-query-sqlite\n  config:\n    path: ":memory:"\n    openAt: first-search\n'));
const runtime = JSON.parse(await readFile(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
const server = spawn(process.execPath, ['--expose-internals', join(modules, '@deepseek-ai/dsh/lib/bin.js'),
  '--profile', 'web', '--no-open', '--port', process.env.DSH_QA_PORT || '0'], {
  env: { ...process.env, DSH_HOME: home, DSH_QA_MODULES: modules },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const processInfo = { runner: process.pid, host: server.pid, home, modules, version: runtime.version, started: new Date().toISOString() };
await writeFile(join(home, 'process.json'), JSON.stringify(processInfo));
await appendFile(join(home, 'processes.jsonl'), JSON.stringify(processInfo) + '\n');
server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.kill());
server.on('exit', code => { process.exitCode = code ?? 1; });
