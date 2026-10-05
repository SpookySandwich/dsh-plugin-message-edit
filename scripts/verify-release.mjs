// A release is complete only when npm, the GitHub tag and its archive agree.
// Read-only: this command never publishes, tags, edits or uploads anything.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseSource, verifyArchive } from './release-integrity.mjs';

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
let source;
if (metadata && reference) await read('Source commit', () => {
  let provenance;
  if (!metadata.gitHead && version === '1.2.1') {
    provenance = JSON.parse(execFileSync('git', ['show', 'HEAD:.github/release-provenance/v1.2.1.json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  }
  source = releaseSource(metadata, pkg, version, provenance);
  const commit = github(`commits/${tag}`);
  assert.equal(commit.sha, source.commit, 'GitHub tag and verified source commit differ');
});
if (metadata && source) await read('npm archive', async () => {
  const response = await fetch(metadata.dist.tarball);
  assert.ok(response.ok, `npm archive download: HTTP ${response.status}`);
  verifyArchive(Buffer.from(await response.arrayBuffer()), source.integrity, 'npm archive');
});
if (release && source) await read('Release archive', async () => {
  assert.equal(release.draft, false, 'GitHub release is still a draft');
  assert.equal(release.tag_name, tag, 'GitHub release tag differs');
  const filename = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  const asset = release.assets.find(asset => asset.name === filename);
  assert.ok(asset, `GitHub release is missing ${filename}`);
  const response = await fetch(asset.browser_download_url);
  assert.ok(response.ok, `Archive download: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyArchive(bytes, source.integrity, 'GitHub archive');
});
if (failures.length) {
  console.error(`Incomplete release: ${pkg.name}@${version}\n${failures.map(failure => `- ${failure}`).join('\n')}`);
  process.exitCode = 1;
} else console.log(`Verified ${pkg.name}@${version}: ${source.evidence}, GitHub tag, public release and identical npm/GitHub archives.`);
