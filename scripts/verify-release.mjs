// A release is complete only when npm, the GitHub tag and its archive agree.
// Read-only: this command never publishes, tags, edits or uploads anything.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = process.argv[2] ?? pkg.version;
assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, 'Pass an exact release version');
const repository = pkg.repository.url.replace(/^git\+https:\/\/github\.com\//, '').replace(/\.git$/, '');
assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
const tag = `v${version}`;
const failures = [];
function github(path) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${path}`], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
}
async function read(label, job) {
  try { return await job(); }
  catch (error) { failures.push(`${label}: ${error.stderr?.toString().trim() || error.message}`); }
}
const [metadata, reference, release] = await Promise.all([
  read('npm', async () => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${version}`);
    assert.ok(response.ok, `${pkg.name}@${version}: HTTP ${response.status}`);
    return response.json();
  }),
  read('GitHub tag', () => github(`git/ref/tags/${tag}`)),
  read('GitHub release', () => github(`releases/tags/${tag}`)),
]);
if (metadata && reference) await read('Source commit', () => {
  assert.ok(metadata.gitHead, 'npm metadata has no source commit');
  const commit = github(`commits/${tag}`);
  assert.equal(commit.sha, metadata.gitHead, 'GitHub tag and npm gitHead differ');
});
if (release && metadata) await read('Release archive', async () => {
  assert.equal(release.draft, false, 'GitHub release is still a draft');
  const filename = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  const asset = release.assets.find(asset => asset.name === filename);
  assert.ok(asset, `GitHub release is missing ${filename}`);
  const response = await fetch(asset.browser_download_url);
  assert.ok(response.ok, `Archive download: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, digest] = metadata.dist.integrity.split('-');
  assert.ok(['sha512', 'sha256'].includes(algorithm), 'Unsupported npm integrity algorithm');
  assert.equal(createHash(algorithm).update(bytes).digest('base64'), digest, 'GitHub archive differs from the published npm artifact');
});
if (failures.length) {
  console.error(`Incomplete release: ${pkg.name}@${version}\n${failures.map(failure => `- ${failure}`).join('\n')}`);
  process.exitCode = 1;
} else console.log(`Verified ${pkg.name}@${version}: npm source, GitHub tag, public release and identical archive.`);
