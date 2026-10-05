import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkPublishSource } from './check-publish-source.mjs';
import { releaseSource, verifyArchive } from './release-integrity.mjs';

const pkg = { name: 'release-test' };
const bytes = Buffer.from('immutable published archive');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const commit = 'a'.repeat(40);
const metadata = { name: pkg.name, version: '1.2.1', dist: { integrity } };
const record = {
  package: pkg.name, version: '1.2.1', sourceCommit: commit, integrity,
  reason: 'npm-10.9.3-linked-worktree-gitHead-omission', reproducedFromNormalClone: true,
};

test('ordinary npm source needs no recovery record', () => {
  assert.equal(releaseSource({ ...metadata, version: '1.3.0', gitHead: commit }, pkg, '1.3.0').commit, commit);
});

test('only the reproduced 1.2.1 artifact can recover missing npm gitHead', () => {
  assert.equal(releaseSource(metadata, pkg, '1.2.1', record).commit, commit);
  assert.throws(() => releaseSource(metadata, pkg, '1.2.1'), /Missing committed/);
  assert.throws(() => releaseSource({ ...metadata, version: '1.2.2' }, pkg, '1.2.2', { ...record, version: '1.2.2' }), /no source commit/);
  for (const change of [
    { package: 'wrong' }, { version: '1.2.0' }, { integrity: `sha512-${'B'.repeat(86)}==` },
    { sourceCommit: 'unknown' }, { reason: 'unexplained' }, { reproducedFromNormalClone: false },
  ]) assert.throws(() => releaseSource(metadata, pkg, '1.2.1', { ...record, ...change }));
});

test('both downloads must match the recorded bytes, not only registry metadata', () => {
  verifyArchive(bytes, integrity, 'npm archive');
  verifyArchive(bytes, integrity, 'GitHub archive');
  assert.throws(() => verifyArchive(Buffer.from('changed npm bytes'), integrity, 'npm archive'), /npm archive differs/);
  assert.throws(() => verifyArchive(Buffer.from('changed GitHub bytes'), integrity, 'GitHub archive'), /GitHub archive differs/);
  assert.throws(() => verifyArchive(bytes, 'md5-abc', 'archive'), /Unsupported/);
});

test('publish guard accepts a clean normal clone and rejects dirty or linked worktrees', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-release-guard-'));
  const repository = join(temporary, 'repository');
  const linked = join(temporary, 'linked');
  const git = (...args) => execFileSync('git', args, {
    cwd: temporary, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    git('init', repository);
    writeFileSync(join(repository, 'source.txt'), 'committed\nsecond\n');
    git('-C', repository, 'add', 'source.txt');
    git('-C', repository, '-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    assert.equal(checkPublishSource(repository), git('-C', repository, 'rev-parse', 'HEAD'));
    git('-C', repository, 'config', 'core.autocrlf', 'true');
    writeFileSync(join(repository, 'source.txt'), 'committed\r\nsecond\n');
    assert.equal(checkPublishSource(repository), git('-C', repository, 'rev-parse', 'HEAD'));
    writeFileSync(join(repository, 'source.txt'), 'changed\n');
    assert.throws(() => checkPublishSource(repository), /Commit all release inputs/);
    git('-C', repository, 'add', 'source.txt');
    writeFileSync(join(repository, 'source.txt'), 'committed\nsecond\n');
    assert.throws(() => checkPublishSource(repository), /Commit all release inputs/);
    git('-C', repository, 'restore', '--staged', 'source.txt');
    git('-C', repository, 'restore', 'source.txt');
    writeFileSync(join(repository, 'untracked.txt'), 'uncommitted\n');
    assert.throws(() => checkPublishSource(repository), /Commit all release inputs/);
    git('-C', repository, 'worktree', 'add', '--detach', linked, 'HEAD');
    assert.throws(() => checkPublishSource(linked), /linked worktrees omit npm gitHead/);
  } finally {
    // Remove only the exact directory created by mkdtemp above.
    rmSync(temporary, { recursive: true, force: true });
  }
});
