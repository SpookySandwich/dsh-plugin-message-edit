import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function releaseSource(metadata, pkg, version, provenance) {
  assert.equal(metadata.name, pkg.name, 'npm package name differs');
  assert.equal(metadata.version, version, 'npm package version differs');
  if (metadata.gitHead) {
    assert.match(metadata.gitHead, /^[a-f0-9]{40}$/, 'Invalid npm gitHead');
    return { commit: metadata.gitHead, integrity: metadata.dist.integrity, evidence: 'npm gitHead' };
  }

  // This is a single historical recovery, not a general missing-gitHead bypass.
  assert.equal(version, '1.2.1', 'npm metadata has no source commit');
  assert.ok(provenance, 'Missing committed 1.2.1 provenance record');
  assert.equal(provenance.package, pkg.name, 'Provenance package differs');
  assert.equal(provenance.version, '1.2.1', 'Provenance version differs');
  assert.equal(provenance.reason, 'npm-10.9.3-linked-worktree-gitHead-omission');
  assert.equal(provenance.reproducedFromNormalClone, true, 'Archive reproduction is not verified');
  assert.match(provenance.sourceCommit, /^[a-f0-9]{40}$/, 'Invalid provenance source commit');
  assert.match(provenance.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, 'Invalid provenance integrity');
  assert.equal(metadata.dist.integrity, provenance.integrity, 'npm integrity differs from committed provenance');
  return { commit: provenance.sourceCommit, integrity: provenance.integrity, evidence: 'reproduced 1.2.1 archive' };
}

export function verifyArchive(bytes, integrity, label) {
  assert.match(integrity ?? '', /^(sha512|sha256)-[A-Za-z0-9+/]+={0,2}$/, 'Unsupported npm integrity');
  const [algorithm, digest] = integrity.split('-');
  assert.equal(createHash(algorithm).update(bytes).digest('base64'), digest, `${label} differs from the recorded npm artifact`);
}
