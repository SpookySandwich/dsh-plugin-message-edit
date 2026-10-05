# Release procedure

Publishing to npm and pushing code do not create a GitHub release. A release
is complete only after its tag and downloadable archive have been verified.

1. Update `package.json`, the root version in `package-lock.json`, both READMEs,
   and `.github/release-notes/vVERSION.md`. Run `npm ci`, `npm test`, and
   `npm run check:package`, plus the applicable isolated DSH acceptance checks.
2. Commit the reviewed changes, push that exact commit, and wait for CI. Build
   and publish from the clean committed checkout so npm records the correct
   `gitHead`. Never reuse an already published version for different content.
3. Create `vVERSION` at npm's recorded `gitHead`. Create the GitHub release with
   the reviewed notes and attach the **same `.tgz` bytes published to npm**.
   For a historical backfill, download the existing npm `dist.tarball` and
   verify its `dist.integrity`; do not rebuild an old version from current code.
4. Run `npm run check:release -- VERSION`. It checks npm availability, the tag's
   source commit, a public GitHub release, and the attached archive's integrity.
   Resolve every failure before announcing that the release is complete.

The check is read-only. Older npm versions without `gitHead` cannot pass its
source provenance check; inspect those historical releases separately. The
published 1.2.0 versions have `gitHead` and can be backfilled exactly.

For DSH 0.1.5-rc.2, retain plugin 1.1.0. Current source targets DSH 0.2.0-rc.2.
