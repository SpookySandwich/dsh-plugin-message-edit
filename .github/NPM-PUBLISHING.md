# npm trusted publishing setup

This infrastructure does not change a plugin version. Merge the reviewed workflow
to `master` before configuring npm. Existing release tags stay at their original
commits; do not recreate or move them to pick up the workflow.

## One-time account setup (package maintainer)

Open https://www.npmjs.com/package/dsh-plugin-message-edit/access and sign in,
including any 2FA challenge. In package Settings / Trusted publishing, add GitHub
Actions with these exact, case-sensitive values:

| Field | Value |
| --- | --- |
| Organization or user | `SpookySandwich` |
| Repository | `dsh-plugin-message-edit` |
| Workflow filename | `publish.yml` (no directory prefix) |
| Environment name | Leave blank (this workflow has no environment) |
| Allowed actions | Enable direct `npm publish` (stage-only is insufficient) |

No npm token secret is needed. Do not change publishing access or revoke existing
credentials until the first real OIDC publish has succeeded. npm's current rule
requires a first successful publish **within two days of creating the trust**;
an already-published no-op or dry run does not validate it. If it expires, delete
and recreate the configuration when ready. Login and 2FA are human steps.

## Backfill an existing release

In GitHub Actions, choose **Publish npm → Run workflow**, select `master`, and
enter the existing exact tag, for example `v1.4.1`. The tag must point to a commit
reachable from `master`, match package.json and package-lock.json, and already
have a public GitHub release. Only stable `vMAJOR.MINOR.PATCH` tags are supported.
The workflow creates neither tags nor releases. Finish reviewing the release and
its applicable DSH acceptance evidence before dispatching.

Helpers come from the immutable `github.workflow_sha` in a separate checkout.
Release source is checked out at the resolved 40-character commit in a normal
clone. Historical tags therefore need no new scripts. The workflow checks that
the remote tag still resolves to that commit before publication and attachment.
Protect release tags from changes; cross-service operations cannot atomically
lock a GitHub ref and an npm publication.

The job runs npm ci, build, tests, existing release-tool/package checks and any
existing prepublishOnly guard, plus its own clean-normal-clone guard. npm publishes
the directory with lifecycle scripts enabled so gitHead is retained. Release
builds use Node 24, npm 11.21.1, fresh GitHub-hosted runners and no dependency cache.
The npm 11 pin preserves the pack --json output expected by historical package
checks; npm 12 changes that output and requires a separate compatibility review.

The executing workflow remains `.github/workflows/publish.yml`: on dispatch its
workflow/OIDC identity refers to `refs/heads/master`, even while the checked-out
source is historical. Immediately around npm publish, GITHUB_SHA/GITHUB_REF name
the resolved source commit/tag for npm's provenance source fields; they do not
change GitHub's signed workflow identity (`job_workflow_ref`/`workflow_ref`). No
reusable workflow or impersonated historical workflow is involved.

A valid public registry package document must confirm the version is absent.
HTTP errors (including 404), malformed data, missing gitHead and source collisions
stop the run. An existing version with the same gitHead and valid archive is
verified without republishing. Older missing versions use the `backfill` npm
dist-tag to avoid downgrading `latest`; versions at or above latest use `latest`.
This workflow does not run `npm dist-tag` commands or require that extra permission.

A separate job with contents:write downloads npm's archive, verifies SHA-512 and
gitHead, and attaches those exact bytes to the existing public GitHub release.
It never rebuilds the asset or overwrites one. An existing asset must have the
same integrity. This implements the source/tag/public-release/archive requirements
of check:release even when the historical source lacks that script. The historical
missing-gitHead exception remains a manual verification path, not a CI bypass.

After a failed run, inspect the error and rerun the same tag. A registry-visible
same-source publication is skipped and a missing asset can be repaired. A source
collision, missing gitHead, corrupt asset or moved tag requires investigation;
never solve it by forcing a tag or republishing a version. Metadata visibility
delays fail closed and may require a rerun. Publishing is serialized across tags
and manual runs, with cancel-in-progress:false. GitHub may replace an older queued
pending run; rerun any displaced backfill. It never cancels the active publisher.

## Future releases and validation

Future `v*` pushes containing this workflow invoke it automatically; the public
GitHub release must exist before the publish step (otherwise rerun after release
creation). Existing tags do not retroactively trigger the new workflow. Keep the
release procedure's review and DSH acceptance requirements. CI preparation and
local mocks cannot validate npm's account trust, GitHub's signed OIDC claims or a
real publish; those require the first authorized GitHub Actions run.

Local checks: `node --test scripts/npm-publish.test.mjs`, `npm test`,
`npm run check:release-tools`, `npm run check:package`, and actionlint. A publish
dry run must use a clean normal clone and never serves as proof of OIDC access.

Official reference (checked 2026-10-26):
https://docs.npmjs.com/trusted-publishers/
