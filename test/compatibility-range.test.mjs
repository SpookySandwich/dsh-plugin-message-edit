import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import semver from 'semver';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('package declarations admit tested prereleases under default npm semver rules', () => {
  for (const range of [pkg.peerDependencies['@deepseek-ai/dsh'], pkg.engines.dsh]) {
    for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5', '0.2.1']) {
      assert.ok(semver.satisfies(version, range), `${version} must satisfy ${range} under default npm semver`);
    }
    for (const version of ['0.1.5-rc.2', '0.2.1-rc.3', '0.2.1-rc.6', '0.2.2-alpha.1', '0.3.0-rc.1', '0.3.0']) {
      assert.equal(semver.satisfies(version, range), false, `${version} must be excluded under default npm semver`);
    }
  }
  assert.equal(pkg.engines.dsh, pkg.peerDependencies['@deepseek-ai/dsh']);
  assert.deepEqual(lock.packages[''].peerDependencies, pkg.peerDependencies);
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
});
