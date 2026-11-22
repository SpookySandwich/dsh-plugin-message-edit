// Boot the published official host in a disposable home, verify, restart, verify.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, symlink, writeFile, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
assert.ok(process.env.DSH_QA_MODULES, 'Set DSH_QA_MODULES to an installed official @deepseek-ai/dsh node_modules directory');
const modules = resolve(process.env.DSH_QA_MODULES);
const runtime = JSON.parse(await readFile(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
const chatImport = existsSync(join(modules, '@deepseek-ai/dsh-deepseek-chat-import/package.json'));
const home = await mkdtemp(join(tmpdir(), 'message-edit-dsh-qa-'));
const profile = join(home, 'profiles', 'web');
let server;
async function stop() {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}
try {
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await symlink(join(modules, '@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), 'junction');
  await symlink(root, join(profile, 'node_modules', 'dsh-plugin-message-edit'), 'junction');
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'message-edit-qa', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-message-edit',
      ...(chatImport ? ['@deepseek-ai/dsh-deepseek-chat-import'] : [])] } } }));
  // A fixture is a separate host-only entry, not a second client package source.
  await copyFile(join(root, 'test/fixtures/dsh-acceptance.mjs'), join(profile, 'fixture.mjs'));
  const sqlite = process.env.DSH_QA_STORAGE_BACKEND === 'sqlite';
  const storagePatch = sqlite ? `- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: session-persistence-sqlite
      name: '@deepseek-ai/dsh-session-persistence-sqlite'
      config:
        root: !!js dshHomePath('sessions')
` : '';
  await writeFile(join(profile, 'cordis.patch.yml'), storagePatch + '- insert:\n    - id: offline-qa\n      name: ./fixture.mjs\n' +
    '- id: agent-default-model\n  config:\n    provider: qa-local\n    model: qa-model\n    reasoningEffort: high\n');
  for (const phase of ['fresh', 'restart']) {
    let output = '';
    server = spawn(process.execPath, ['--expose-internals', join(modules, '@deepseek-ai/dsh/lib/bin.js'),
      '--profile', 'web', '--no-open', '--port', '0'], {
      env: { ...process.env, DSH_HOME: home, DSH_QA_MODULES: modules },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    server.stdout.on('data', chunk => { output += chunk; });
    server.stderr.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 180000;
    let origin;
    while (!origin) {
      origin = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (origin) break;
      if (server.exitCode !== null || Date.now() > deadline) throw new Error(`DSH ${phase} startup failed:\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(`Official DSH ${runtime.version} acceptance: ${phase}; pid=${server.pid}; home=${home}; origin=${origin}`);
    const launchUrl = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?[^\s\x1b]+/)?.[0] ?? origin;
    const verifier = spawn(process.execPath, [join(root, 'scripts/verify-dsh-acceptance.mjs'), origin, phase, launchUrl], {
      env: { ...process.env, DSH_QA_IMPORT: chatImport ? '1' : '0' },
      stdio: 'inherit', windowsHide: true,
    });
    const timeout = setTimeout(() => verifier.kill(), 60000);
    const [code] = await once(verifier, 'exit');
    clearTimeout(timeout);
    assert.equal(code, 0, `Acceptance failed (${phase}); host output:\n${output}`);
    await stop();
    if (sqlite) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(home, 'sessions/.segments/sessions.sqlite'), { readOnly: true });
      try {
        const { forks } = db.prepare('SELECT count(*) AS forks FROM segments WHERE parent_segment_uuid IS NOT NULL').get();
        assert.ok(forks > 0, 'SQLite branches must reference their parent prefix instead of copying it');
      } finally { db.close(); }
    }
  }
} finally {
  await stop();
  assert.equal(dirname(home), resolve(tmpdir()));
  assert.ok(home.startsWith(join(resolve(tmpdir()), 'message-edit-dsh-qa-')));
  await rm(home, { recursive: true, force: true });
}
