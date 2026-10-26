import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, versionOf, eventTag, resolveTag, cleanSource, checkPackage, registryState, verifyBytes, ensureAsset } from './npm-publish.mjs';

const commit = 'a'.repeat(40);
const bytes = Buffer.from('registry archive, never rebuilt');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const metadata = { name: config.name, version: '1.2.3', gitHead: commit, dist: { integrity, tarball: `https://registry.npmjs.org/${config.name}/-/archive.tgz` } };
const document = { name: config.name, versions: { '1.2.3': metadata }, 'dist-tags': { latest: '1.2.3' } };
const mock = (body = document, status = 200) => async () => new Response(JSON.stringify(body), { status });

test('exact tag, package and workflow identity reject arbitrary refs and shell input', () => {
  assert.equal(versionOf('v1.2.3'), '1.2.3');
  for (const tag of ['', 'main', 'HEAD', 'refs/tags/v1.2.3', 'v01.2.3', 'v1.2.3\n', 'v1.2.3;echo bad', 'v1.2.3-rc.1', '--help', 'v1.2.3/other']) {
    assert.throws(() => versionOf(tag));
  }
  const repository = `SpookySandwich/${config.name}`;
  const env = { GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: `refs/heads/${config.branch}`, INPUT_TAG: 'v1.2.3' };
  env.GITHUB_WORKFLOW_REF = `${repository}/.github/workflows/publish.yml@${env.GITHUB_REF}`;
  assert.equal(eventTag(env), 'v1.2.3');
  for (const change of [{ GITHUB_REPOSITORY: 'fork/repo' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_WORKFLOW_REF: 'other.yml' }]) assert.throws(() => eventTag({ ...env, ...change }));
  const ref = 'refs/tags/v1.2.3';
  assert.equal(eventTag({ ...env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish.yml@${ref}` }), 'v1.2.3');
  const pkg = { name: config.name, version: '1.2.3', repository: { url: `git+https://github.com/${repository}.git` } };
  checkPackage(pkg, 'v1.2.3');
  for (const change of [{ name: 'other' }, { version: '1.2.4' }, { repository: { url: 'wrong' } }, { private: true }, { publishConfig: { registry: 'other' } }]) assert.throws(() => checkPackage({ ...pkg, ...change }, 'v1.2.3'));
});

test('registry preflight fails closed and refuses source collisions', async () => {
  assert.equal((await registryState('1.2.3', commit, mock())).metadata.gitHead, commit);
  assert.equal((await registryState('1.2.4', commit, mock())).metadata, undefined);
  assert.equal((await registryState('1.2.2', commit, mock())).distTag, 'backfill');
  assert.equal((await registryState('1.2.4', commit, mock())).distTag, 'latest');
  for (const status of [401, 403, 404, 429, 500]) await assert.rejects(registryState('1.2.4', commit, mock({}, status)), /refusing/);
  await assert.rejects(registryState('1.2.4', commit, async () => { throw Error('network'); }), /network/);
  await assert.rejects(registryState('1.2.4', commit, async () => new Response('not JSON')));
  for (const body of [{}, { ...document, versions: [] }, { ...document, versions: {} }, { ...document, 'dist-tags': {} }]) await assert.rejects(registryState('1.2.4', commit, mock(body)));
  await assert.rejects(registryState('1.2.4', commit, mock({ ...document, versions: { ...document.versions, '1.2.4': null } })), /Malformed existing/);
  for (const change of [{ gitHead: undefined }, { gitHead: 'b'.repeat(40) }, { name: 'wrong' }, { version: '9.9.9' }, { dist: { ...metadata.dist, integrity: 'sha1-wrong' } }, { dist: { ...metadata.dist, tarball: 'https://other.example/a' } }]) {
    await assert.rejects(registryState('1.2.3', commit, mock({ ...document, versions: { '1.2.3': { ...metadata, ...change } } })));
  }
});

test('archive retry verifies bytes and never overwrites a collision', async () => {
  verifyBytes(bytes, integrity);
  assert.throws(() => verifyBytes(Buffer.from('corrupt'), integrity));
  let uploads = 0;
  const asset = { name: 'package.tgz' };
  const adapter = { download: async () => bytes, upload: async data => { assert.deepEqual(data, bytes); uploads++; }, refresh: async () => ({ assets: [asset] }) };
  await ensureAsset({ assets: [] }, asset.name, bytes, integrity, adapter);
  assert.equal(uploads, 1);
  await ensureAsset({ assets: [asset] }, asset.name, bytes, integrity, adapter);
  assert.equal(uploads, 1);
  await assert.rejects(ensureAsset({ assets: [asset] }, asset.name, bytes, integrity, { ...adapter, download: async () => Buffer.from('collision') }), /integrity/);
  assert.equal(uploads, 1);
  await assert.rejects(ensureAsset({ assets: [asset, asset] }, asset.name, bytes, integrity, adapter), /Duplicate/);
});

test('real Git fixture resolves old and annotated tags, rejects unreachable tags and dirty/worktree source', () => {
  const previous = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'npm-publish-test-'));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    process.chdir(root);
    git('init', '-b', config.branch);
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    writeFileSync('source', 'original\n');
    git('add', 'source');
    git('commit', '-m', 'old source without CI helpers');
    const old = git('rev-parse', 'HEAD');
    git('tag', 'v1.2.3');
    git('tag', '-a', 'v1.2.2', '-m', 'annotated');
    writeFileSync('source', 'new\n');
    git('commit', '-am', 'current default branch');
    git('update-ref', `refs/remotes/origin/${config.branch}`, 'HEAD');
    assert.equal(resolveTag('v1.2.3'), old);
    assert.equal(resolveTag('v1.2.2'), old);
    assert.throws(() => resolveTag('v9.9.9'));
    git('checkout', '--detach', old);
    cleanSource(old);
    assert.throws(() => cleanSource(commit), /differs/);
    writeFileSync('source', 'dirty\n');
    assert.throws(() => cleanSource(old), /Tracked/);
    git('add', 'source');
    assert.throws(() => cleanSource(old));
    git('reset', '--hard', old);
    writeFileSync('untracked', 'dirty');
    assert.throws(() => cleanSource(old), /Untracked/);
    rmSync('untracked');
    const linked = join(root, 'linked');
    git('worktree', 'add', '--detach', linked, old);
    process.chdir(linked);
    assert.throws(() => cleanSource(old), /normal clone/);
    process.chdir(root);
    git('worktree', 'remove', linked);
    writeFileSync('source', 'unmerged\n');
    git('commit', '-am', 'unmerged source');
    git('tag', 'v2.0.0');
    assert.throws(() => resolveTag('v2.0.0'));
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
