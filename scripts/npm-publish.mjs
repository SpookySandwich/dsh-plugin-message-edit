// Kept outside the release checkout: old tags need not contain CI helpers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

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
  const document = await (await request(`${registry}/${config.name}?write=true`, fetcher)).json();
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

export async function pollReady(label, read, { attempts = 12, sleep = delay } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await read(); // Auth/network/malformed/collision errors fail immediately.
    if (result) return result;
    if (attempt + 1 < attempts) await sleep(Math.min(2000 * 2 ** attempt, 30_000));
  }
  throw Error(`${label} not ready after ${attempts} attempts; inspect and rerun, never republish blindly`);
}

async function existingRelease(tag) {
  return pollReady(`Public GitHub release ${tag}`, async () => {
    let release;
    try { release = gh(`releases/tags/${tag}`); }
    catch (error) {
      if (/\(HTTP 404\)/.test(error.stderr?.toString() ?? '')) return null;
      throw error;
    }
    assert.equal(release.tag_name, tag);
    if (release.draft) return null;
    assert.equal(release.immutable, false, 'Immutable release cannot accept an archive; review release policy manually');
    return release;
  });
}

const predicateType = 'https://slsa.dev/provenance/v1';
const repositoryURL = `https://github.com/${repository}`;

// Verify the original publishing run, not necessarily this retry/repair run.
export function provenanceContext(statement, metadata, publishingRun) {
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
  assert.equal(statement.predicateType, predicateType);
  assert.deepEqual(statement.subject, [{ name: `pkg:npm/${config.name}@${metadata.version}`,
    digest: { sha512: Buffer.from(metadata.dist.integrity.slice(7), 'base64').toString('hex') } }], 'Attestation subject differs from npm archive');
  const { buildDefinition: build, runDetails } = statement.predicate;
  assert.equal(build.buildType, 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1');
  assert.equal(runDetails.builder.id, 'https://github.com/actions/runner/github-hosted');
  assert.equal(publishingRun.repository.full_name, repository);
  assert.equal(publishingRun.path, '.github/workflows/publish.yml', 'Unexpected publishing workflow');
  assert.match(publishingRun.head_sha, /^[a-f0-9]{40}$/);
  const event = publishingRun.event;
  assert.ok(['workflow_dispatch', 'push'].includes(event), 'Unexpected publishing event');
  const ref = event === 'workflow_dispatch' ? `refs/heads/${config.branch}` : `refs/tags/v${metadata.version}`;
  assert.equal(publishingRun.head_branch, event === 'workflow_dispatch' ? config.branch : `v${metadata.version}`);
  assert.deepEqual(build.externalParameters.workflow, { ref, repository: repositoryURL, path: '.github/workflows/publish.yml' });
  assert.equal(build.internalParameters.github.event_name, event);
  assert.deepEqual(build.resolvedDependencies, [{ uri: `git+${repositoryURL}@${ref}`, digest: { gitCommit: publishingRun.head_sha } }], 'Provenance must describe the actual workflow run, not a substituted release checkout');
  const invocation = `${repositoryURL}/actions/runs/${publishingRun.id}/attempts/${publishingRun.run_attempt}`;
  assert.equal(runDetails.metadata.invocationId, invocation);
  if (event === 'push') assert.equal(publishingRun.head_sha, metadata.gitHead, 'Tag push must run at the release source');
  return { ref, sha: publishingRun.head_sha, event, invocation, workflow: `${repositoryURL}/.github/workflows/publish.yml@${ref}` };
}

function derString(text) {
  const bytes = Buffer.from(text);
  assert.ok(bytes.length < 256);
  return Buffer.concat([Buffer.from(bytes.length < 128 ? [0x0c, bytes.length] : [0x0c, 0x81, bytes.length]), bytes]);
}

export function certificatePolicy(context) {
  const oid = suffix => `1.3.6.1.4.1.57264.1.${suffix}`;
  return {
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    certificateIdentityURI: `^${context.workflow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    certificateOIDs: Object.fromEntries([
      [9, context.workflow], [11, 'github-hosted'], [12, repositoryURL],
      [13, context.sha], [14, context.ref], [20, context.event], [21, context.invocation],
    ].map(([suffix, value]) => [oid(suffix), derString(value)])),
  };
}

async function verifySignature(bundle, context) {
  // Reuse the Sigstore verifier shipped in the exact npm version installed in
  // both jobs. No dependencies or scripts are loaded from the release checkout.
  assert.equal(run('npm', ['--version']), '11.21.1');
  const requireNpm = createRequire(join(run('npm', ['root', '--global']), 'npm', 'package.json'));
  await requireNpm('sigstore').verify(bundle, certificatePolicy(context));
}

export async function verifyProvenance(document, metadata, { getRun = async path => gh(path), verify = verifySignature, expectedInvocation } = {}) {
  assert.ok(Array.isArray(document.attestations), 'Malformed attestation document');
  const matches = document.attestations.filter(item => item.predicateType === predicateType);
  if (!matches.length) return false; // Bounded propagation wait, never success.
  assert.equal(matches.length, 1, 'Ambiguous provenance');
  const bundle = matches[0].bundle;
  assert.equal(bundle.dsseEnvelope.payloadType, 'application/vnd.in-toto+json');
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString());
  const invocation = statement.predicate?.runDetails?.metadata?.invocationId;
  const prefix = `${repositoryURL}/actions/runs/`;
  assert.ok(invocation?.startsWith(prefix), 'Unexpected attestation run repository');
  const match = /^(\d+)\/attempts\/(\d+)$/.exec(invocation.slice(prefix.length));
  assert.ok(match, 'Invalid attestation run');
  if (expectedInvocation) assert.equal(invocation, expectedInvocation, 'Fresh publish must attest this run');
  const publishingRun = await getRun(`actions/runs/${match[1]}/attempts/${match[2]}`);
  const context = provenanceContext(statement, metadata, publishingRun);
  await verify(bundle, context); // Signature, trust root, transparency log, issuer/SAN and source OIDs.
  return true;
}

export async function waitPublication(version, commit, { fetcher = fetch, provenance = verifyProvenance, ...pollOptions } = {}) {
  return pollReady(`npm ${config.name}@${version} and verified provenance`, async () => {
    const response = await fetcher(`${registry}/${config.name}/${version}`, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (response.status === 404) return null; // Only a visibility wait, never permission to publish.
    assert.equal(response.status, 200, `Version read HTTP ${response.status}`);
    const metadata = await response.json();
    verifyMetadata(metadata, version, commit);
    const attestation = metadata.dist.attestations;
    if (!attestation) return null;
    assert.equal(attestation.provenance?.predicateType, predicateType, 'Missing SLSA provenance');
    assert.equal(attestation.url, `${registry}/-/npm/v1/attestations/${config.name}@${version}`, 'Unexpected attestation URL');
    const result = await fetcher(attestation.url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (result.status === 404) return null;
    assert.equal(result.status, 200, `Attestation read HTTP ${result.status}`);
    if (!await provenance(await result.json(), metadata)) return null;
    return metadata;
  }, pollOptions);
}

export async function ensureAsset(release, filename, bytes, integrity, adapter) {
  const matches = release.assets.filter(asset => asset.name === filename);
  assert.ok(matches.length <= 1, 'Duplicate release assets');
  if (matches.length) {
    assert.equal(matches[0].state, 'uploaded', `Asset ${filename} is unfinished (id ${matches[0].id}); inspect it in GitHub and explicitly remove only the failed asset before rerunning. No automatic overwrite or deletion.`);
    verifyBytes(await adapter.download(matches[0]), integrity);
    return; // Never overwrite an existing asset, even on retries.
  }
  await adapter.upload(bytes);
  const refreshed = await adapter.refresh();
  const asset = refreshed.assets.find(item => item.name === filename);
  assert.ok(asset, 'Uploaded archive missing');
  assert.equal(asset.state, 'uploaded', `Asset ${filename} upload is unfinished; inspect and manually recover before rerunning`);
  verifyBytes(await adapter.download(asset), integrity);
}

export function publishDirectory(distTag, execute = run) {
  assert.ok(['latest', 'backfill'].includes(distTag));
  // Inherit all GitHub context directly; never substitute the release checkout.
  execute('npm', ['publish', '--access=public', '--provenance', `--registry=${registry}`, `--tag=${distTag}`], { stdio: 'inherit' });
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
  const release = await existingRelease(tag); // Writer pushes the tag before creating the release.
  let state = await registryState(version, commit);
  if (mode === 'publish') {
    assert.equal(process.versions.node.split('.')[0], '24', 'Release runtime must be Node 24');
    assert.equal(run('npm', ['--version']), '11.21.1', 'Use the reviewed npm version');
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
    let expectedInvocation;
    if (!state.metadata) {
      // Preserve GitHub's actual run context, including SHA/REF. On dispatch the
      // attested source is the default-branch run; gitHead identifies release source.
      publishDirectory(state.distTag);
      cleanSource(commit);
      expectedInvocation = `${repositoryURL}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`;
    }
    state.metadata = await waitPublication(version, commit, { provenance: (document, metadata) => verifyProvenance(document, metadata, { expectedInvocation }) });
    await archiveBytes(state.metadata);
    console.log(`Verified npm ${config.name}@${version} at ${commit}`);
    return;
  }
  state.metadata = await waitPublication(version, commit);
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
  const verified = await waitPublication(version, commit);
  assert.equal(verified.dist.integrity, state.metadata.dist.integrity, 'Registry integrity changed');
  console.log(`Verified public release ${tag}: gitHead, tag and identical npm/GitHub archive bytes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
