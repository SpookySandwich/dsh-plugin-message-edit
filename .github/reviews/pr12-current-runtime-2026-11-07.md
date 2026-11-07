# PR #12 — current-source runtime acceptance, 2026-11-07

> **Final acceptance update (2026-11-07): PASS (`v1.6.0`).**
> Alongside this baseline runtime matrix (`6342c07` / `88ba4a1`), grouped actionable status projection and click routing (`586e7e7` / `59fe628`) passed full implementation and independent verification in [`pr12-round2-actionable-status-2026-11-07.md`](pr12-round2-actionable-status-2026-11-07.md).

**Result: PASS with the two documented search caveats below.** This run validates
production revision `6342c076157df87cd1ba2e4f40e23ad3a01abdc3` on official DSH
`0.2.2-rc.1`. The new commit contains QA helpers and evidence; production code,
package metadata, release documentation and CI configuration are unchanged.
Contributor `af6ba8df9aa3e8ac05a321b87c2ba85f863e69c6` remains an ancestor.

Assigned branch: `maint-20261107-message-edit-2605505a`. The checkout is
`<task-root>/repo`, where `<task-root>` is the owned temporary directory
`dsh-20261107-2605505a-message-edit`. No publication was performed.

## Runtime and method

- Windows, official Node `24.22.2`; ZIP SHA-256 checked against the official
  SHASUMS: `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`.
- Official DSH `0.2.2-rc.1` package integrity:
  `sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==`.
- Headless Edge `156.0.4314.58`, `playwright-core@1.65.0`; initial edit/image
  smoke flow also exercised in the Poracode browser. Each browser process uses
  its own temporary profile. The Poracode tab was closed and browser control disabled.
- Real DSH Web services, persistence, renderers, native menus and plugin code.
  A module-loader wrapper exposes the actual plugin context for observation and
  native service calls; it does not replace the host stores or renderer.
- A local deterministic model counts images and streams 60 delayed chunks for
  designated QA prompts. No remote model credentials or personal DSH profile.
  The fixture's DSH subagent is application behavior under test, not delegated
  implementation work.
- The browser launcher uses a named owned home and the official loopback Web
  listener (observed `127.0.0.1:54879`). All QA endpoints reject non-loopback or
  foreign-Origin requests. Mutation endpoints check the owned session directory.

## Results

| Check | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | Passed |
| `npm test` | 95/95 passed |
| `npm run check:release-tools` | 4/4 passed |
| `node --test scripts/npm-publish.test.mjs` | 10/10 unit tests passed; no publication |
| `npm run check:package` | 13 expected package files verified |
| Dependency/peer listing | Passed |
| Official `0.2.2-rc.1`, fresh and restart | Passed |
| Official `0.2.1-rc.5`, fresh and restart | Passed |
| Official `0.2.1-rc.2`, fresh and restart | Passed |
| Lockfile-installed official `0.2.0-rc.2`, fresh and restart | Passed |
| Latest-host browser, full-text search enabled | 19 checkpoints passed |
| Latest-host restart, native operations and layout | 20 checkpoints passed across scoped resumptions |
| Default-disabled full-text search, persisted family and disposal | 10 checkpoints passed |

Every API host run exercised live/cold edits, two retained images, unchanged
source history, deterministic replies, sibling retry, nested branch markers,
and persisted seeded-child resume/retry. A final latest-host API run also checks
the final fixture request guards. The prior independent source review and its
mutation checks apply to the production revision, not these new QA helpers.

Browser results cover grouping OFF by default; immediate UI edits and selected
root; root/child snippets opening their actual source with remember ON and OFF;
local-title/content deduplication; root-ID ordinary navigation; hidden title
fallback; and exclusion of archived remembered children. Real background turns
held a stable search result in both grouping modes:

| Grouping | Samples | Missing hit samples | Extra searches | Catalog updates |
| --- | ---: | ---: | ---: | ---: |
| OFF | 379 | 0 | 0 | 11 |
| ON | 372 | 0 | 0 | 11 |

The restart matrix confirms saved preferences and relationships, cold-root UI
edits without catalog loss, nested turn-two edits, Versions card navigation,
Claude-style retry, and native root/child pin behavior. Archive combinations,
cross-workspace recorded relatives, a detached root, orphan visibility,
equal-title independent roots, a real subagent under a hidden version, and native
independent-copy separation all passed. Native copies have no recorded lineage
and remain separate. The root retains its actual workspace, pin and archive state.

At 400px, More-menu navigation reaches Versions and English, Chinese and Russian
settings controls fit. Settled tree cards do not overlap. Screenshots were
visually inspected; the narrow tree uses fit/zoom and can be small for a large
family. Actual plugin disposal restores `WorkspaceBrowser`, preserves the
native child slots/store, and removes the mounted plugin CSS. Completed phases
recorded zero page exceptions and zero HTTP error responses.

## Search caveats for the Writer

1. With a live root and only archived hidden content matches, “All conversations”
   can show the root's live styling and no Unarchive button. Clicking clears
   search and displays “Archived sessions cannot be opened. Unarchive it to
   view.” It does not navigate or unarchive. “Archived only” respects root
   visibility. Do not promise direct restoration through that grouped result.
2. With full-text search disabled, two hidden versions sharing a matching title
   produce one family result. The result chooses one matching version; it need
   not be the remembered version. In this fixture both searches selected the
   edited child, including when its sibling was remembered. Do not promise that
   ambiguous hidden-title matches preserve the remembered selection. Shared
   root/child titles and unique hidden titles passed their explicit assertions.

These are observed presentation/ambiguity limitations, not new production
changes in this run. The approved root ownership and recorded-lineage scope
remain intact.

## Reproduction

From the assigned checkout, put `<task-root>/node-v24.22.2-win-x64` first on PATH.
Set TEMP/TMP to `<task-root>`. Install the official runtimes in isolated prefixes:

```powershell
npm install --prefix ../runtime --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.2-rc.1 playwright-core@1.65.0
npm install --prefix ../runtime-rc5 --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.1-rc.5
npm install --prefix ../runtime-rc2 --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.1-rc.2
# For each prefix (and repo/node_modules for 0.2.0-rc.2):
$env:DSH_QA_MODULES = (Resolve-Path ../runtime/node_modules).Path
node scripts/run-dsh-acceptance.mjs
```

For a new browser run choose a new, disposable `message-edit-dsh-qa-*` home.
The first phase mutates fixture sessions and expects a fresh home. Later phases
reuse that home and `browser-storage.json`. Keep this storage and all raw logs
in private scratch because they contain local authentication state.

```powershell
$env:DSH_QA_MODULES = (Resolve-Path ../runtime/node_modules).Path
$env:DSH_QA_HOME = "$(Resolve-Path ..)/message-edit-dsh-qa-matrix"
$env:DSH_QA_OUTPUT = "$(Resolve-Path ..)/matrix-evidence"
$env:DSH_QA_SHA = (git rev-parse HEAD)
$env:DSH_QA_PORT = '54879'
# Separate shell: launch host and capture its log; wait for the ready URL.
node scripts/run-dsh-browser-host.mjs *> ../matrix-host.log
# Browser shell, with matching environment:
$env:DSH_QA_HOST_LOG = "$(Resolve-Path ..)/matrix-host.log"
node scripts/verify-dsh-browser.mjs
# Stop owned host/runner using process.json, then launch again with the same port.
$env:DSH_QA_STORAGE = "$(Resolve-Path ..)/matrix-evidence/browser-storage.json"
node scripts/verify-dsh-browser-restart.mjs
# Stop/restart once more with DSH_QA_FTS=off; point HOST_LOG at its new log.
node scripts/verify-dsh-browser-fts-off.mjs
```

Unset `DSH_QA_RESUME` for a complete restart phase. During this run scoped
resumptions `pin`, `edges`, and `copy` avoided replaying completed mutations.
Their cumulative result is preserved in `restart.json`; this is not a claim
that the original harness passed in one uninterrupted invocation.

## Harness corrections and evidence boundaries

Initial attempts exposed QA issues: incorrect Cordis `modify` patch key
(corrected to `id`), UTF-16 PowerShell logs, module loader replacement, hover
loss after native pin, collapsed new workspace, native-copy navigation timing,
tree entrance animation, running before host readiness, non-enumerable remote
error fields, and asynchronous plugin disposal. Failed attempts are retained in
scratch. The early animated screenshot and wrong-search-configuration run are
superseded by final passing evidence and are not committed as acceptance proof.

Final helper review tightened browser cleanup on setup failures, bounded the
tree settling wait, and applied loopback/Origin guards to the inherited fixture
endpoints. The final API/browser checks and syntax checks cover these changes.
Foreign-Origin probes received 403 for state/followup/image-only and 400 for
sidebar. All seven changed/new JavaScript helpers pass `node --check`;
`node scripts/build-client.mjs --check` reports the generated bundle up to date,
and `git diff --check` passes. The full suite preceded the final QA guard changes;
the final official API and browser runs exercise those fixture/helper changes.

Sanitized JSON, selected screenshots, command output and the process inventory
are in [the evidence directory](assets/pr12-current-runtime-2026-11-07/).
Raw auth URLs, host logs, browser-storage files, HTML dumps, personal paths and
private profiles are excluded. Evidence records the validated production SHA;
the enclosing commit changes only QA and evidence.

No claim is made for native Desktop, Linux, remote model providers, hosted CI,
or maximum-size search datasets. Earlier checks not repeated here, such as
Quote insertion, remain evidence from their own recorded revision/run.

## Resource ownership

Owned prefixes retained for parent review: `runtime`, `runtime-rc5`,
`runtime-rc2`, `node-v24.22.2-win-x64`, plus repo `node_modules`. Browser homes
`message-edit-dsh-qa-browser` and `message-edit-dsh-qa-matrix`, `matrix-evidence`,
and raw logs remain under `<task-root>`. API acceptance homes are removed by
their runner after stopping the hosts. The committed process inventory records
host and browser PIDs and final cleanup verification. No owned host, browser or
helper is intentionally left running.

Final browser host PID `61024` and runner `93944` are stopped. Cleanup verified
all 34 recorded host/runner/browser PIDs absent, no matching task Node/Edge
process, and no listener on port 54879. Older browser host/runner pairs and all
ten API host PIDs are listed in `processes.json`. Forced host shutdowns produced
launcher-shell exit code 1; those are shutdown results, not acceptance failures.
