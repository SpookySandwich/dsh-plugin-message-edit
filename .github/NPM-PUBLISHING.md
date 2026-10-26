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
These in-file repository/branch guards prevent mistakes; they are not a security
boundary against someone who can edit a workflow. npm trust does not restrict
branches. No protected environment or tag ruleset is configured by this change.
An environment and tag protections may be chosen separately by the owner; that
requires coordinated GitHub/npm settings and workflow changes, not just entering
an environment name on npm. Cross-service operations cannot atomically lock a
GitHub ref and an npm publication. Build/test dependencies run in the job that
has OIDC permission, as in npm's example; this is an accepted trust limitation.

The job runs npm ci, build, tests, existing release-tool/package checks and any
existing prepublishOnly guard, plus its own clean-normal-clone guard. npm publishes
the directory with lifecycle scripts enabled so gitHead is retained. Release
builds use Node 24, npm 11.21.1, fresh GitHub-hosted runners and no dependency cache.
The npm 11 pin preserves the pack --json output expected by historical package
checks; npm 12 changes that output and requires a separate compatibility review.

GitHub's environment is passed to npm unchanged. On dispatch, provenance and the
OIDC signing certificate describe the actual default-branch run, including its
SHA/ref and `.github/workflows/publish.yml`. The historical release source is
identified separately by npm gitHead, the immutable tag check and archive hashes.
**Dispatch provenance does not cryptographically attest the historical tag as its
source.** On a tag push the run SHA and release gitHead must agree.

Every successful path (fresh publish, existing-version retry and archive repair)
requires SLSA v1 provenance. The helper checks the subject SHA-512, repository,
workflow path, event, invocation and resolved source against the original GitHub
run/attempt. npm 11.21.1's bundled Sigstore verifier checks the signature, trust
root, transparency log, GitHub issuer, exact workflow certificate identity and
certificate source SHA/ref, repository, runner, event and invocation extensions.
A new publication must name the current run; retries verify the original run,
which may differ from the repair run. An old version without this provenance is
blocked, even if gitHead matches; investigate manually without republishing.

A valid registry package document read with `?write=true` must confirm absence.
HTTP errors (including 404), malformed data, missing gitHead and source collisions
stop the run. Version and attestation visibility use per-version/attestation
endpoints with at most 12 attempts and 2/4/8/16/30-second capped backoff (240 seconds
of waits, plus bounded requests). Only visibility 404 or absent provenance is
retried; authorization, malformed data and source/signature errors fail closed.
Visibility 404 never grants permission to publish. Existing versions require
matching gitHead, archive and verified provenance without republishing.
Older missing versions use the `backfill` npm
dist-tag to avoid downgrading `latest`; versions at or above latest use `latest`.
This workflow does not run `npm dist-tag` commands or require that extra permission.
The `backfill` dist-tag remains until a maintainer deliberately changes it.

A separate job with contents:write downloads npm's archive, verifies SHA-512 and
gitHead, and attaches those exact bytes to the existing public GitHub release.
It never rebuilds the asset or overwrites one. An existing asset must have the
same integrity. This implements the source/tag/public-release/archive requirements
of check:release even when the historical source lacks that script. The historical
missing-gitHead exception remains a manual verification path, not a CI bypass.
GitHub immutable releases cannot accept this later attachment and are rejected;
enabling immutable releases needs a separate workflow design. For an asset left
in `starter` or another unfinished state, inspect its reported ID, name and state
in GitHub. Only after confirming it is the failed upload, explicitly remove that
asset manually, then rerun. The workflow never deletes or clobbers assets. A
completed asset with a wrong digest needs investigation, not automatic replacement.

After a failed run, inspect the error and rerun the same tag. A registry-visible
same-source publication is skipped and a missing asset can be repaired. A source
collision, missing gitHead, corrupt asset or moved tag requires investigation;
never solve it by forcing a tag or republishing a version. Metadata visibility
delays fail closed and may require a rerun. Publishing is serialized across tags
and manual runs, with cancel-in-progress:false. GitHub may replace an older queued
pending run; rerun any displaced backfill. It never cancels the active publisher.

## Future releases and validation

Future `v*` pushes containing this workflow invoke it automatically. Writer pushes
the tag before creating the public release; the workflow polls for that release
with the same bounded backoff before publishing. If creation is delayed beyond
the bound, create/fix the release and explicitly rerun the failed workflow.
Writer must fetch the actual merged default-branch commit after any squash merge,
verify its version and CI, and tag that commit rather than the pre-merge local HEAD.
Writer must wait for the exact publish run and both jobs to succeed; listing runs
does not prove publication. Existing tags do not retroactively trigger the workflow. Keep the
release procedure's review and DSH acceptance requirements. CI preparation and
local mocks cannot validate npm's account trust, GitHub's signed OIDC claims or a
real publish; those require the first authorized GitHub Actions run.
Signing may leave a public Rekor entry even if npm subsequently rejects the publish.

Local checks: `node --test scripts/npm-publish.test.mjs`, `npm test`,
`npm run check:release-tools`, `npm run check:package`, and actionlint. A publish
dry run must use a clean normal clone and never serves as proof of OIDC access.

Official reference (checked 2026-10-26):
https://docs.npmjs.com/trusted-publishers/
