// Kept outside the release checkout: old tags need not contain CI helpers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const config = { name: 'dsh-plugin-message-edit', branch: 'master' };
const repository = `SpookySandwich/${config.name}`;
const registry = 'https://registry.npmjs.org';
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
})?.trim();
const git = (...args) => run('git', args);
const gh = path => JSON.parse(run('gh', ['api', `repos/${repository}/${path}`]));

export function versionOf(tag) {
  assert.equal(typeof tag, 'string', 'Tag is required');
  assert.equal(tag, tag.trim(), 'Tag must not contain surrounding whitespace');
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Only exact stable vMAJOR.MINOR.PATCH tags are allowed');
  return tag.slice(1);
}

export function eventTag(env) {
  assert.equal(env.GITHUB_REPOSITORY, repository, 'Unexpected repository');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/publish.yml@${env.GITHUB_REF}`, 'Unexpected workflow identity');
  let tag;
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    assert.equal(env.GITHUB_REF, `refs/heads/${config.branch}`, 'Dispatch must run the default branch workflow');
    tag = env.INPUT_TAG;
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Unsupported event');
    assert.ok(env.GITHUB_REF?.startsWith('refs/tags/'), 'Push must be a tag');
    tag = env.GITHUB_REF.slice('refs/tags/'.length);
  }
  versionOf(tag);
  return tag;
}

export function resolveTag(tag) {
  versionOf(tag);
  const commit = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  assert.match(commit, /^[a-f0-9]{40}$/);
  git('merge-base', '--is-ancestor', commit, `refs/remotes/origin/${config.branch}`);
  return commit;
}

function unchangedRemoteTag(tag, commit) {
  const refs = git('ls-remote', '--tags', `https://github.com/${repository}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
    .split('\n').filter(Boolean).map(line => line.split(/\s+/));
  const peeled = refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const direct = refs.find(([, ref]) => ref === `refs/tags/${tag}`);
  assert.equal((peeled ?? direct)?.[0], commit, 'Remote release tag moved or disappeared');
}

export function cleanSource(commit) {
  assert.ok(lstatSync('.git').isDirectory(), 'Use a normal clone, not a linked worktree');
  assert.ok(lstatSync('.git/HEAD').isFile());
  assert.equal(git('rev-parse', '--show-prefix'), '', 'Use the repository root');
  assert.equal(git('rev-parse', 'HEAD'), commit, 'Checkout differs from resolved tag');
  assert.equal(git('diff', '--name-only', 'HEAD'), '', 'Tracked source changed');
  assert.equal(git('diff', '--cached', '--name-only', 'HEAD'), '', 'Index changed');
  assert.equal(git('ls-files', '--others', '--exclude-standard'), '', 'Untracked release inputs');
}

export function checkPackage(pkg, tag) {
  assert.equal(pkg.name, config.name, 'Wrong package');
  assert.equal(pkg.version, versionOf(tag), 'Tag/package version mismatch');
  assert.equal(pkg.repository?.url, `git+https://github.com/${repository}.git`, 'Wrong package repository');
  assert.ok(!pkg.private, 'Package is private');
  assert.ok(!Object.hasOwn(pkg, 'gitHead'), 'gitHead must be generated from the checkout');
  assert.ok(!pkg.publishConfig, 'Review publishConfig before enabling this workflow');
}

async function request(url, fetcher = fetch, redirect = 'error') {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000), redirect, headers: { 'Cache-Control': 'no-cache' } });
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}; refusing to infer unpublished status`);
  return response;
}

export function verifyMetadata(metadata, version, commit) {
  assert.equal(metadata.name, config.name, 'Registry package differs');
  assert.equal(metadata.version, version, 'Registry version differs');
  assert.equal(metadata.gitHead, commit, 'Published version has different or missing gitHead');
  assert.match(metadata.dist?.integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/, 'Missing SHA-512 integrity');
  const url = new URL(metadata.dist.tarball);
  assert.equal(url.origin, registry, 'Unexpected tarball origin');
  assert.equal(url.username + url.password, '', 'Unexpected tarball credentials');
}

export function verifyBytes(bytes, integrity) {
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, integrity, 'Archive integrity mismatch');
}

export async function registryState(version, commit, fetcher = fetch) {
  // A valid existing package document is required. 404/auth/network/malformed
  // responses are never evidence that a version is safe to publish.
  const document = await (await request(`${registry}/${config.name}`, fetcher)).json();
  assert.equal(document.name, config.name, 'Invalid registry package document');
  assert.ok(document.versions && typeof document.versions === 'object' && !Array.isArray(document.versions), 'Invalid registry versions');
  assert.ok(Object.keys(document.versions).length, 'Expected an existing npm package');
  const metadata = document.versions[version];
  if (Object.hasOwn(document.versions, version)) {
    assert.ok(metadata && typeof metadata === 'object', 'Malformed existing version');
    verifyMetadata(metadata, version, commit);
  }
  const latest = document['dist-tags']?.latest;
  assert.ok(latest && document.versions[latest], 'Missing latest version');
  versionOf(`v${latest}`);
  const older = version.split('.').map(BigInt).reduce((order, n, i) => order || (n < BigInt(latest.split('.')[i]) ? -1 : n > BigInt(latest.split('.')[i]) ? 1 : 0), 0) < 0;
  return { metadata, distTag: older ? 'backfill' : 'latest' };
}

async function archiveBytes(metadata) {
  const bytes = Buffer.from(await (await request(metadata.dist.tarball)).arrayBuffer());
  verifyBytes(bytes, metadata.dist.integrity);
  return bytes;
}

function existingRelease(tag) {
  const release = gh(`releases/tags/${tag}`);
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false, 'Existing release must be public');
  return release;
}

export async function ensureAsset(release, filename, bytes, integrity, adapter) {
  const matches = release.assets.filter(asset => asset.name === filename);
  assert.ok(matches.length <= 1, 'Duplicate release assets');
  if (matches.length) {
    verifyBytes(await adapter.download(matches[0]), integrity);
    return; // Never overwrite an existing asset, even on retries.
  }
  await adapter.upload(bytes);
  const refreshed = await adapter.refresh();
  const asset = refreshed.assets.find(item => item.name === filename);
  assert.ok(asset, 'Uploaded archive missing');
  verifyBytes(await adapter.download(asset), integrity);
}

async function main(mode) {
  if (mode === 'resolve') {
    const tag = eventTag(process.env);
    const commit = resolveTag(tag);
    if (process.env.GITHUB_EVENT_NAME === 'push') assert.equal(process.env.GITHUB_SHA, commit, 'Push revision differs from tag');
    unchangedRemoteTag(tag, commit);
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\ncommit=${commit}\n`);
    return;
  }
  assert.ok(['publish', 'archive'].includes(mode), 'Unknown mode');
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  const tag = process.env.RELEASE_TAG;
  const version = versionOf(tag);
  const commit = process.env.RELEASE_COMMIT;
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(resolveTag(tag), commit);
  unchangedRemoteTag(tag, commit);
  cleanSource(commit);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  checkPackage(pkg, tag);
  const release = existingRelease(tag); // Fail before publishing if release is absent.
  let state = await registryState(version, commit);
  if (mode === 'publish') {
    assert.equal(process.versions.node.split('.')[0], '24', 'Release runtime must be Node 24');
    assert.equal(run('npm', ['--version']), '12.2.1', 'Use the reviewed npm version');
    const npm = args => run('npm', args, { stdio: 'inherit' });
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
    npm(['ci', '--no-audit', '--no-fund', `--registry=${registry}`]);
    npm(['run', 'build', '--if-present']);
    npm(['test']);
    npm(['run', 'check:release-tools', '--if-present']);
    npm(['run', 'check:package']);
    if (pkg.scripts.prepublishOnly) npm(['run', 'prepublishOnly']);
    cleanSource(commit);
    unchangedRemoteTag(tag, commit);
    state = await registryState(version, commit);
    if (!state.metadata) {
      // Provenance source is the immutable release checkout. Workflow/OIDC
      // identity remains the executing publish.yml (default branch on dispatch).
      run('npm', ['publish', '--access=public', '--provenance', `--registry=${registry}`, `--tag=${state.distTag}`], {
        stdio: 'inherit', env: { ...process.env, GITHUB_SHA: commit, GITHUB_REF: `refs/tags/${tag}` },
      });
      cleanSource(commit);
      state = await registryState(version, commit);
      assert.ok(state.metadata, 'Published metadata not visible yet; rerun to verify, never blindly republish');
      assert.ok(state.metadata.dist.attestations?.url, 'New OIDC publication is missing provenance');
    }
    await archiveBytes(state.metadata);
    console.log(`Verified npm ${config.name}@${version} at ${commit}`);
    return;
  }
  assert.ok(state.metadata, 'Version must already be published');
  const bytes = await archiveBytes(state.metadata);
  const filename = `${config.name}-${version}.tgz`;
  const archivePath = join(process.env.RUNNER_TEMP, filename);
  unchangedRemoteTag(tag, commit);
  await ensureAsset(release, filename, bytes, state.metadata.dist.integrity, {
    download: async asset => {
      assert.ok(asset.browser_download_url.startsWith(`https://github.com/${repository}/releases/download/${tag}/`), 'Unexpected asset URL');
      return Buffer.from(await (await request(asset.browser_download_url, fetch, 'follow')).arrayBuffer());
    },
    upload: async data => {
      writeFileSync(archivePath, data, { flag: 'wx' });
      run('gh', ['release', 'upload', tag, archivePath, '--repo', repository]);
    },
    refresh: async () => existingRelease(tag),
  });
  unchangedRemoteTag(tag, commit);
  const verified = await registryState(version, commit);
  assert.equal(verified.metadata?.dist.integrity, state.metadata.dist.integrity, 'Registry integrity changed');
  console.log(`Verified public release ${tag}: gitHead, tag and identical npm/GitHub archive bytes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
