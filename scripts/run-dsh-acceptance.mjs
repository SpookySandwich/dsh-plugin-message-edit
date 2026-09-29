// Boot the published official host in a disposable home, verify, restart, verify.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
assert.ok(process.env.DSH_QA_MODULES, 'Set DSH_QA_MODULES to an official @deepseek-ai/dsh@0.2.0-rc.2 node_modules directory');
const modules = resolve(process.env.DSH_QA_MODULES);
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
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-message-edit'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: offline-qa\n      name: ${JSON.stringify(join(root, 'test/fixtures/dsh-acceptance.mjs'))}\n`);
  for (const phase of ['fresh', 'restart']) {
    let output = '';
    server = spawn(process.execPath, ['--expose-internals', join(modules, '@deepseek-ai/dsh/lib/bin.js'),
      '--profile', 'web', '--no-open', '--port', '0'], {
      env: { ...process.env, DSH_HOME: home, DSH_QA_MODULES: modules },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    server.stdout.on('data', chunk => { output += chunk; });
    server.stderr.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 60000;
    let origin;
    while (!origin) {
      origin = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (origin) break;
      if (server.exitCode !== null || Date.now() > deadline) throw new Error(`DSH ${phase} startup failed:\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(`Official DSH acceptance: ${phase}`);
    const verifier = spawn(process.execPath, [join(root, 'scripts/verify-dsh-acceptance.mjs'), origin], {
      stdio: 'inherit', windowsHide: true,
    });
    const timeout = setTimeout(() => verifier.kill(), 60000);
    const [code] = await once(verifier, 'exit');
    clearTimeout(timeout);
    assert.equal(code, 0, `Acceptance failed (${phase}); host output:\n${output}`);
    await stop();
  }
} finally {
  await stop();
  assert.equal(dirname(home), resolve(tmpdir()));
  assert.ok(home.startsWith(join(resolve(tmpdir()), 'message-edit-dsh-qa-')));
  await rm(home, { recursive: true, force: true });
}
