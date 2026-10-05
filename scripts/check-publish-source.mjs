// npm 10.9.3 reads .git/HEAD directly and omits gitHead in linked worktrees.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkPublishSource(root) {
  const options = { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  assert.ok(lstatSync(join(root, '.git')).isDirectory(), 'Publish from a normal clean clone with a .git directory; linked worktrees omit npm gitHead');
  assert.ok(lstatSync(join(root, '.git', 'HEAD')).isFile(), 'The normal clone must have .git/HEAD');
  const git = (...args) => execFileSync('git', args, options).trim();
  assert.equal(realpathSync(git('rev-parse', '--show-toplevel')), realpathSync(root), 'Publish from the repository root');
  // Compare normalized Git content: a generated file can have mixed line
  // endings on Windows while representing exactly the committed blob.
  assert.equal(git('diff', '--name-only', 'HEAD'), '', 'Commit all release inputs before publishing from a clean clone');
  assert.equal(git('diff', '--cached', '--name-only', 'HEAD'), '', 'Commit all release inputs before publishing from a clean clone');
  assert.equal(git('ls-files', '--others', '--exclude-standard'), '', 'Commit all release inputs before publishing from a clean clone');
  const commit = git('rev-parse', 'HEAD');
  assert.match(commit, /^[a-f0-9]{40}$/, 'The release needs a committed source revision');
  return commit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Publish source verified: ${checkPublishSource(fileURLToPath(new URL('..', import.meta.url)))}`); }
  catch (error) { console.error(`Publish blocked: ${error.message}`); process.exitCode = 1; }
}
