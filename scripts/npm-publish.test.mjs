import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, versionOf, eventTag, resolveTag, cleanSource, checkPackage, registryState, verifyBytes, ensureAsset, pollReady, waitPublication, verifyProvenance, certificatePolicy, publishDirectory } from './npm-publish.mjs';

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
  assert.throws(() => checkPackage({ ...pkg, gitHead: commit }, 'v1.2.3'), /generated/);
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
  const asset = { name: 'package.tgz', state: 'uploaded', id: 10 };
  const adapter = { download: async () => bytes, upload: async data => { assert.deepEqual(data, bytes); uploads++; }, refresh: async () => ({ assets: [asset] }) };
  await ensureAsset({ assets: [] }, asset.name, bytes, integrity, adapter);
  assert.equal(uploads, 1);
  await ensureAsset({ assets: [asset] }, asset.name, bytes, integrity, adapter);
  assert.equal(uploads, 1);
  await assert.rejects(ensureAsset({ assets: [asset] }, asset.name, bytes, integrity, { ...adapter, download: async () => Buffer.from('collision') }), /integrity/);
  assert.equal(uploads, 1);
  await assert.rejects(ensureAsset({ assets: [asset, asset] }, asset.name, bytes, integrity, adapter), /Duplicate/);
  await assert.rejects(ensureAsset({ assets: [{ ...asset, state: 'starter' }] }, asset.name, bytes, integrity, adapter), /unfinished.*No automatic overwrite/);
  assert.equal(uploads, 1);
});

const repositoryURL = `https://github.com/SpookySandwich/${config.name}`;
const workflowCommit = 'b'.repeat(40); // Deliberately different from release gitHead.
const publishingRun = { id: 123, run_attempt: 1, repository: { full_name: `SpookySandwich/${config.name}` },
  path: '.github/workflows/publish.yml', event: 'workflow_dispatch', head_branch: config.branch, head_sha: workflowCommit };
const invocation = `${repositoryURL}/actions/runs/123/attempts/1`;
const provenanceType = 'https://slsa.dev/provenance/v1';
const published = { ...metadata, dist: { ...metadata.dist, attestations: {
  url: `https://registry.npmjs.org/-/npm/v1/attestations/${config.name}@1.2.3`, provenance: { predicateType: provenanceType },
} } };
function statementFixture() {
  const ref = `refs/heads/${config.branch}`;
  return { _type: 'https://in-toto.io/Statement/v1', predicateType: provenanceType,
    subject: [{ name: `pkg:npm/${config.name}@1.2.3`, digest: { sha512: createHash('sha512').update(bytes).digest('hex') } }],
    predicate: { buildDefinition: {
      buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: { workflow: { ref, repository: repositoryURL, path: '.github/workflows/publish.yml' } },
      internalParameters: { github: { event_name: 'workflow_dispatch' } },
      resolvedDependencies: [{ uri: `git+${repositoryURL}@${ref}`, digest: { gitCommit: workflowCommit } }],
    }, runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' }, metadata: { invocationId: invocation } } } };
}
const bundleDocument = statement => ({ attestations: [{ predicateType: provenanceType, bundle: {
  dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
} }] });

test('npm publication inherits the actual GitHub environment without source overrides', () => {
  let calls = 0;
  publishDirectory('backfill', (command, args, options) => {
    calls++;
    assert.equal(command, 'npm');
    assert.deepEqual(args, ['publish', '--access=public', '--provenance', '--registry=https://registry.npmjs.org', '--tag=backfill']);
    assert.deepEqual(options, { stdio: 'inherit' });
    assert.equal(Object.hasOwn(options, 'env'), false);
  });
  assert.equal(calls, 1);
});

test('dispatch provenance follows original workflow context while release gitHead remains independent', async () => {
  let verifications = 0;
  const options = { getRun: async path => { assert.equal(path, 'actions/runs/123/attempts/1'); return publishingRun; },
    verify: async (bundle, context) => {
      verifications++;
      assert.equal(context.sha, workflowCommit);
      assert.notEqual(context.sha, metadata.gitHead);
      const policy = certificatePolicy(context);
      assert.equal(policy.certificateIssuer, 'https://token.actions.githubusercontent.com');
      assert.ok(new RegExp(policy.certificateIdentityURI).test(context.workflow));
      assert.ok(!new RegExp(policy.certificateIdentityURI).test(context.workflow.replace('github.com', 'githubXcom')));
      assert.ok(policy.certificateOIDs['1.3.6.1.4.1.57264.1.13'].includes(Buffer.from(workflowCommit)));
      assert.ok(!policy.certificateOIDs['1.3.6.1.4.1.57264.1.13'].includes(Buffer.from(commit)));
    } };
  assert.equal(await verifyProvenance(bundleDocument(statementFixture()), metadata, { ...options, expectedInvocation: invocation }), true);
  // A repair from another workflow run accepts the original verified invocation.
  assert.equal(await verifyProvenance(bundleDocument(statementFixture()), metadata, options), true);
  assert.equal(verifications, 2);
  await assert.rejects(verifyProvenance(bundleDocument(statementFixture()), metadata, { ...options, expectedInvocation: `${repositoryURL}/actions/runs/999/attempts/1` }), /Fresh publish/);
  for (const mutate of [
    s => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = commit; },
    s => { s.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/tags/v1.2.3'; },
    s => { s.predicate.buildDefinition.externalParameters.workflow.path = 'other.yml'; },
    s => { s.subject[0].digest.sha512 = '0'.repeat(128); },
    s => { s.predicate.runDetails.metadata.invocationId = 'https://github.com/fork/repo/actions/runs/123/attempts/1'; },
  ]) {
    const statement = statementFixture(); mutate(statement);
    await assert.rejects(verifyProvenance(bundleDocument(statement), metadata, options));
  }
  await assert.rejects(verifyProvenance(bundleDocument(statementFixture()), metadata, { ...options, verify: async () => { throw Error('certificate source mismatch'); } }), /certificate source mismatch/);
});

test('tag-push provenance must match the release commit as well as the original run', async () => {
  const statement = statementFixture();
  const ref = 'refs/tags/v1.2.3';
  statement.predicate.buildDefinition.externalParameters.workflow.ref = ref;
  statement.predicate.buildDefinition.internalParameters.github.event_name = 'push';
  statement.predicate.buildDefinition.resolvedDependencies = [{ uri: `git+${repositoryURL}@${ref}`, digest: { gitCommit: commit } }];
  const run = { ...publishingRun, event: 'push', head_branch: 'v1.2.3', head_sha: commit };
  assert.equal(await verifyProvenance(bundleDocument(statement), metadata, { getRun: async () => run, verify: async () => {} }), true);
  await assert.rejects(verifyProvenance(bundleDocument(statement), metadata, { getRun: async () => ({ ...run, head_sha: workflowCommit }), verify: async () => {} }));
});

test('uncached preflight and bounded polling tolerate delayed version and attestation visibility', async () => {
  await registryState('1.2.4', commit, async url => {
    assert.equal(url, `https://registry.npmjs.org/${config.name}?write=true`);
    return new Response(JSON.stringify(document));
  });
  const responses = [new Response('{}', { status: 404 }), new Response(JSON.stringify(metadata)),
    new Response(JSON.stringify(published)), new Response('{}', { status: 404 }),
    new Response(JSON.stringify(published)), new Response(JSON.stringify({ attestations: [] })),
    new Response(JSON.stringify(published)), new Response(JSON.stringify(bundleDocument(statementFixture())))];
  const sleeps = [];
  const result = await waitPublication('1.2.3', commit, {
    attempts: 5, sleep: async ms => sleeps.push(ms), fetcher: async url => {
      assert.ok([`https://registry.npmjs.org/${config.name}/1.2.3`, published.dist.attestations.url].includes(url));
      assert.ok(responses.length); return responses.shift();
    }, provenance: (doc, meta) => verifyProvenance(doc, meta, { getRun: async () => publishingRun, verify: async () => {} }),
  });
  assert.equal(result.gitHead, commit);
  assert.deepEqual(sleeps, [2000, 4000, 8000, 16000]);
  assert.equal(responses.length, 0);
});

test('fresh, existing-version retry and archive all require provenance; errors cannot become absence', async () => {
  for (const path of ['fresh', 'existing-version retry', 'archive']) {
    let calls = 0;
    await assert.rejects(waitPublication('1.2.3', commit, { attempts: 3, sleep: async () => {}, fetcher: async () => {
      calls++; return new Response(JSON.stringify(metadata));
    } }), /verified provenance not ready/, path);
    assert.equal(calls, 3);
  }
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(waitPublication('1.2.3', commit, { sleep: async () => {}, fetcher: async () => { calls++; return new Response('{}', { status }); } }), /Version read HTTP/);
    assert.equal(calls, 1);
  }
  await assert.rejects(waitPublication('1.2.3', commit, { fetcher: mock({ ...metadata, gitHead: workflowCommit }) }), /gitHead/);
  await assert.rejects(waitPublication('1.2.3', commit, { fetcher: mock({ ...published, dist: { ...published.dist, attestations: { url: 'https://evil.example', provenance: { predicateType: provenanceType } } } }) }), /Unexpected attestation URL/);
});

test('release visibility wait is bounded and surfaces errors without retrying mutations', async () => {
  let reads = 0;
  const release = { tag_name: 'v1.2.3', draft: false };
  assert.equal(await pollReady('release', async () => ++reads === 3 ? release : null, { attempts: 3, sleep: async () => {} }), release);
  await assert.rejects(pollReady('release', async () => null, { attempts: 2, sleep: async () => {} }), /not ready after 2/);
  await assert.rejects(pollReady('release', async () => { throw Error('HTTP 403'); }), /HTTP 403/);
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
