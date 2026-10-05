# Release procedure

Publishing to npm and pushing code do not create a GitHub release. A release
is complete only after its source, tag and downloadable archives agree.

1. Update `package.json`, the root version in `package-lock.json`, both READMEs,
   and `.github/release-notes/vVERSION.md`. Run `npm ci`, `npm test`,
   `npm run check:release-tools`, and `npm run check:package`, plus the applicable
   isolated DSH acceptance checks.
2. Commit the reviewed changes, push that exact commit, and wait for CI. Make
   a fresh **normal clone** and check out that commit. Its `.git` must be a
   directory, not a linked-worktree file: npm 10.9.3 reads `.git/HEAD` directly
   and silently omits `gitHead` when publishing from a linked worktree.
3. In that clone run `npm ci`, `npm run build`, and
   `node scripts/check-publish-source.mjs`. The guard requires a normal clone
   with no tracked or untracked changes. Publish the directory with
   `npm publish`; its `prepublishOnly` hook repeats the guard. Do not bypass
   lifecycle scripts or publish a separately packed tarball. Never reuse an
   already published version for different content.
4. Read the published npm metadata and require `gitHead` to equal the reviewed
   commit. Download npm's `dist.tarball` and verify `dist.integrity`. Create
   `vVERSION` at that commit and a GitHub release with the reviewed notes and
   the **same downloaded `.tgz` bytes**. A historical backfill also uses the
   existing npm archive, never a rebuild of current source.
5. Run `npm run check:release -- VERSION`. This read-only check verifies npm
   availability, source provenance, the tag, a public GitHub release, and the
   hashes of both downloaded archives. Resolve every failure before announcing
   that the release is complete.

The sole missing-`gitHead` exception is the immutable 1.2.1 release, published
with npm 10.9.3 from a linked worktree. Its committed
`.github/release-provenance/v1.2.1.json` records the exact source commit and npm
SHA-512 integrity after an independent fresh normal clone at that commit
reproduced the published archive byte for byte. The verifier reads that record
from Git `HEAD`, requires its package/version to match, and requires the tag,
npm integrity, downloaded npm archive, and downloaded GitHub archive to agree.
An uncommitted record cannot enable the exception. Other missing source
commits fail verification. Published 1.2.0 has npm `gitHead` and uses the normal
verification path.

For DSH 0.1.5-rc.2, retain plugin 1.1.0. Current source targets DSH 0.2.0-rc.2.
