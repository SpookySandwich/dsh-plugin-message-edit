# PR 12 implementation and official DSH 0.2.2-rc.1 validation

> **Current status (2026-11-07): FINAL ACCEPTANCE PASS (`v1.6.0`).**
> This document is preserved as a historical record from an earlier stage of PR #12 validation.
> All earlier `PAUSED`, `BLOCKED`, or intermediate findings noted below were resolved and verified passing in
> [`pr12-round2-actionable-status-2026-11-07.md`](pr12-round2-actionable-status-2026-11-07.md) and [`pr12-current-runtime-2026-11-07.md`](pr12-current-runtime-2026-11-07.md).

Parent: `1f1b3227-0688-447f-8ec6-e56b672411b8`. Implementer thread:
`2a6b0a37-ef20-4eed-bff0-a426797482f0`; focused search continuation:
`641eb8b9-059b-4a40-b27f-4d7433b18939`. Date: 2026-11-05/06 UTC.

**STATUS: BLOCKED on search-hit navigation; the search-flicker fix is ready for
independent re-review.** The parent clarified the
approved scope: one entry per recorded edit/version family, with unrelated
roots separate. DSH 0.2.2's native independent conversation copies deliberately
omit source lineage and remain separate. That behavior is a scope boundary,
not a compatibility blocker. Publication gates remain with the parent.

## Source and scope

- Contributor: ganpig (蔗蓝), `feat/fold-sidebar-versions`.
- Original PR head: `af6ba8df9aa3e8ac05a321b87c2ba85f863e69c6`.
- Actual integration base: `342f638ec3c906673b05442836e71f03792a9d55`.
  Live `gh pr view 12` and `git ls-remote origin refs/heads/master` agreed with
  those identities. Fetching master found no newer integration changes.
- Worktree: `<task-root>/repo`; branch `maint-20261105-message-edit-1f1b3227`.
- Original contributor commit and its README/development documentation are
  preserved. Grouping remains off by default. No version bump, release writing,
  publication, or changes to the main checkout's working files were performed.

## Fixes on top of the contribution

1. Keep the original's actual workspace, pin, and archive membership. Mapping
   every child's workspace membership to the root duplicated one family across
   workspaces; mapping child pins made the root appear pinned while native
   actions still offered Pin. Regressions reproduced both failures first.
2. Project the native `useSessionStatus` map as well as the session list. Native
   tree derivation prefers the status map over `summary.running`, so an idle
   original previously masked a running branch. Completion and pending status
   follow the family too. Preserve native byId-only subagent records without
   turning subagents into ordinary conversation versions. Both gaps have
   failing-before/passing-after regressions.
3. Preserve searches for a hidden branch's title or session ID, including hosts
   with full-text search disabled. Keep native snippets, cancellation and
   `hasMore`. DSH exposes one bounded search result and a refine-query hint,
   not a client paging cursor; no extra paging protocol was introduced.
4. Do not implicitly unarchive a remembered version when reopening its original.
   The existing bubble-level rememberPath effect could undo the sidebar's
   archived-target guard. A negative-control run without this guard opened the
   archived child; the fixed regression and real host check pass. Explicit
   navigation to an archived node in Versions retains its existing activation
   behavior.
5. Mark replacement user-message text as a native text-interaction source.
   DSH 0.2.2's Quote/selection machinery needs that marker. Controls and the edit
   textarea stay outside the source. The regression fails without the marker;
   real browser selection and Quote insertion pass with it.
6. Fix the previously recorded light-theme contrast defect in Versions cards,
   tools and the style selector: `--dsw-alias-bg-primary` is not a DSH token.
   Use the existing `--dsw-alias-bg-base` with `Canvas` fallback. This changes
   neither layout nor the contributor's grouping design.
7. Explicitly admit `0.2.2-rc.1` in peerDependencies and engines.dsh, aligning
   root lock metadata. Default-semver regression rejects the old declaration
   and retains previous supported prereleases while rejecting untested rc.2.
   Add the new host to the official-host CI matrix and run that matrix on Node
   24, satisfying the new host's Node >=24.9.0 requirement.

## Official runtime and API review

Live npm latest/next both reported `0.2.2-rc.1`. Source tag
`dsh-v0.2.2-rc.1` resolves to `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`.
The source checkout includes the preceding `dsh-v0.2.1-rc.5` tag for comparison.
The independently installed official npm runtime reports integrity
`sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==`.
These establish tag/package identity separately, not an npm source attestation.

Reviewed the actual source and installed package contracts used by this plugin:

- Session snapshotEvents, constructor seed/inheritedEventCount, immutable event
  envelopes and ignorable markers; agent create/resume, maintenance, inbox,
  followup and disposal; session-query observe/list and workspace attach/archive.
  The host's refactoring retains the exercised contracts. Fresh/restart real
  acceptance covers those paths, including seeded children and two images.
- Session-controller's cold list and frontend `ids`/`byId` projection,
  `parentId`, `origin`, retainedBy, title and updatedAt. Subagent projections can
  populate byId without adding an ordinary ID.
- WorkspaceBrowser slot, native store, menus, row actions, workspace/pin/archive
  sources, search results, row watermarks, and the separate native status map.
- Renderer/module registration and cleanup, uiWorkspace.openSession, locale
  registration, and the native user-content image factory/loadImage contract.
- ui-chat text-interaction source detection and the official message-quotes
  action. The new fileMentions binding belongs to the assistant renderer;
  this plugin replaces user nodes and does not call that assistant binding.

Runtime: Windows, official Node `24.22.2` and npm from its owned prefix.
Node ZIP SHA-256 verified against nodejs.org SHASUMS256:
`ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`.
The machine's default Node 22 and the user's DSH home were not used for the new
official host. Each host profile uses only the task's own scratch directory.

## Commands and automated validation

From the task checkout, with the owned Node prefix first on PATH:

```powershell
npm ci --no-audit --no-fund
npm test
npm run check:release-tools
node --test scripts/npm-publish.test.mjs
npm run check:package
git diff --check
```

Baseline unchanged PR: 63 tests pass. The full implemented suite passed 72 tests;
after adding one final guard against merging equal-title originals, the complete
sidebar file passed all 14 tests. Other files were unchanged after their passing
full run. Release helpers: 4/4. Publication-helper unit tests: 10/10. Package:
13 expected files. `git diff --check` and generated build integrity pass.
The build/prepack pipeline generates ignored `lib/client.js`; it is not committed.
Package verification performs a real npm pack lifecycle and verifies 13 files.
Publication-helper tests are unit tests, not publication operations.

Official runtime installation/acceptance commands:

```powershell
npm install --prefix ../runtime --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.2-rc.1 playwright-core
npm install --prefix ../runtime-rc5 --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.1-rc.5
# Set TEMP/TMP to the owned scratch parent and DSH_QA_MODULES to each runtime's node_modules.
node scripts/run-dsh-acceptance.mjs
```

Official 0.2.2-rc.1 and 0.2.1-rc.5, plus the lockfile-installed 0.2.0-rc.2,
pass fresh and restart acceptance. Each tests live/cold source edits, unchanged
original history, two-image retention, deterministic replies, one replayed turn,
sibling retry, nested branch markers, and persisted seeded-child resume/retry.
0.2.1-rc.2 remains admitted and in CI; it was not rerun locally in this event.
Hosted CI, Linux, native Desktop, and remote model providers were not exercised.

## Real browser evidence

Headless Microsoft Edge `156.0.4314.50` via Playwright, with the real official
Web host and a local deterministic LLM adapter. No remote model/API credentials.
Browser tool APIs became unavailable after session_move; the scripts use the
installed Edge binary. A test-only module-loader wrapper captures the real
plugin context for reading stores, opening sessions and exercising disposal;
it does not replace the host stores or renderers.

`browser-qa.mjs` and `browser-followup.mjs` pass:

- Immediate setting toggle to two rows for two unrelated originals; selected
  child highlights the original; reopening returns to the remembered child.
- Real UI edits with both images, no-refresh branch creation and nested edits.
  Feature off restores native rows (including native Show more behavior).
  Feature toggles preserve the Versions nodes and selected branch.
- Native root pin/unpin and menu contents; archive affects only the root;
  archived remembered child stays archived on reopening the family.
- Full-text child-content search deduplicates to the root after enabling the
  official session-query-sqlite `openAt: first-search` in this QA profile.
  The default official host disables content search; that initial failed check
  was a QA configuration finding, not evidence of a grouping defect.
- Native Quote action inserts selected user text into the composer; Claude
  retry creates a grouped sibling; English/Chinese/Russian settings fit 400px;
  narrow More conversation views navigation reaches Versions.

Both completed passes record zero page errors and zero HTTP errors. Initial
automation iterations corrected a loading-state navigation predicate, a native
Show more assumption, and the actual `Quote text` label; their logs are retained.
Screenshot and lifecycle diagnostics are retained in the scratch paths below.

## Cold-root diagnosis, restart, and independent-copy scope

The final `browser-lifecycle.mjs` run started after stopping/restarting the same
official host home. The original cold session was persisted, present in the
frontend catalog, and **not live** on the host. Toggling grouping off/on showed
exactly two family rows immediately, without loading that cold original or
refreshing. The owned browser's local preferences were copied to the new
ephemeral port; authentication was performed anew. This does not claim a
native Desktop or fixed-port production restart test.

Then a deliberately direct `/message-tree` HTTP edit targeted that never-opened
cold original. Its temporary resumed handle was disposed when the request
finished. DSH's `api/session-controller/src/index.ts` handles `session/disposed`
by emitting `api-session/removed`. The frontend consequently lost the original
although the persisted source still existed; its descendants became apparent
orphans and six rows were visible in this larger diagnostic family. Reloading
the catalog restored the source and two rows. This reproduces and explains the
preview discrepancy; the plugin projection correctly refuses to invent a
missing original or merge genuine orphans speculatively.

The normal lifecycle was tested next: open the cold source through DSH's own
uiWorkspace navigation, observe the live host source, then edit via the actual
message editor. The original remained catalogued throughout, the new branch
grouped immediately without refresh, and a delayed deterministic reply showed
`Running` on the original's grouped row. No grouping fix was made for the direct
cold-HTTP fixture lifecycle. This evidence does not assert that every possible
host unload race is impossible; it distinguishes the reproduced fixture path
from the tested normal cold/saved UI path.

**Independent-copy behavior:** clicking the official assistant
action **Branch into a new conversation** created
`session-d0f905cf-cbcc-455a-8e36-c3e09c248ec4`, titled `Cold: two images (1)`.
Its persisted header has `isSeeded: true` but **no `parentSession`**, and its
frontend summary has **no `parentId`**. It therefore correctly appears as a
third independent root rather than joining the two known families. The live
test's expectation of two rows failed (actual: three); this is not counted as
a pass. The rc.5→0.2.2 source diff explicitly removes
`parentSession: source.header.id` from
`packages/api/session-controller/src/commands.ts` fork creation. In
`packages/core/session/src/types.ts`, the new header contract explicitly says
ordinary forks omit this field and historical ordinary forks may retain it.

Plugin edit/retry branches continue writing their own recorded parentage and
work; historical ordinary forks with parentage remain grouped. New native forks
cannot reliably be grouped or recovered after restart from the catalog alone.
Copied titles/content are not sufficient proof of ownership, and no heuristic,
external event database, host monkey-patch, or native fork replacement was added.
The parent explicitly confirmed that these independent copies stay separate;
the approved feature covers recorded edit/version families. The failed original
two-row expectation remains recorded as an incorrect scope expectation, not a
passing test or an implemented broader fork-tracking feature. Independent
Attacker review agreed with this boundary.

Real client plugin disposal also passes: `ctx.fiber.dispose()` restores the
same native sidebar entry from `GroupedSidebar` to `WorkspaceBrowser`, keeps
its child/store identities, and removes the plugin style. An initial diagnostic
used obsolete `ctx.scope` and was corrected to the installed Cordis `fiber`
contract. The test helper also explicitly selects Chat when opening a session
whose saved view was Versions. Neither correction changed product code.

Not separately exercised in the real browser: moving a family member between
workspaces, real subagent creation, a >limit content-search dataset, and older
host browser layouts. These have focused projection/native-contract tests or
prior support evidence, not new end-to-end claims. Native row pin/archive scope,
search, normal cold startup/restart, no-refresh updates, settings locales,
narrow layout, and unload were exercised as described above.

## Scratch artifacts and resource accounting

Scratch root (retained for independent Attacker): `<task-root>`, the parent of
the task checkout. All artifact paths below are relative to that root.

Contains owned Node/runtime prefixes, upstream checkout, all baseline/negative
control/final logs, `qa-host.mjs`, browser scripts, `screenshots/`, JSON evidence,
and `message-edit-dsh-qa-browser` (persisted official host home).
Browser storage/authentication files are local QA artifacts and are not committed.

Acceptance host PIDs, all stopped by the runner:
0.2.2-rc.1 `71924`, `40780`; 0.2.0-rc.2 `10696`, `29892`;
0.2.1-rc.5 `112596`, `13788`. Their three unique automated homes were removed
by the existing runner. Browser QA hosts `36064`, `98892` were stopped before
restarts. Final host `5028` / runner `85716` was stopped after lifecycle capture.
Final process inventory found no node.exe or msedge.exe process with the owned
scratch path in its command line. Playwright browsers were closed in finally
blocks; the initial failed launch-helper calls exited before a context was
created. Individual early browser subprocess PIDs were not logged, so no exact
historical browser PID list is claimed. Retained QA resource file:
`qa-resources.jsonl`; current host identity: `qa-host-pid.json` (stopped).

Useful evidence files:

- `browser-qa-evidence.json`, `browser-followup-evidence.json`,
  `browser-lifecycle-evidence.json`, `inspect-current.log`.
- `screenshots/03-grouped.png`, `05-search.png`, `06-quote.png`,
  `07-settings-{en,zh,ru}-400.png`, `08-versions-400.png`,
  `10-running-family.png`, `11-versions-final.png`.
- The final Versions screenshot honestly shows the separate new native fork.
  Early screenshots retain the pre-fix contrast evidence; some intermediate
  locale captures include a native archive toast.

Final live recheck: PR still OPEN at the original contributor SHA, remote master
still at the actual integration base, and `gh pr checks 12` reports no checks.
All changes remain local. Independent Attacker reviewed `13cd6b4`: 73/73 tests
in a clean export, 13 package files, eight caught mutations, and real Edge
grouping checks on 0.2.1-rc.5 and 0.2.0-rc.2. Its latest-host restart/UI-edit
check retained the root and grouped the new child; the fixture model failed
in that run, so it does not establish successful model completion. See
`attacker/attack1.json`, `attacker/smoke-rc5.json`, and `attacker/smoke-020.json`.
Writer release/version work remains separate.

## Focused search continuation

Attacker's `attack3.json` measured two extra searches and 14/252 samples without
the hit during a 60-chunk background turn with grouping enabled. Grouping off
had zero extra searches and zero missing-hit samples. The official native
search effect clears results when its `searchSessions` callback changes.

The continuation reproduced both bugs against the old built bundle before
changing product code (`search-before.log`): catalog replacement changed the
callback identity, and a child content hit returned the root ID. The committed
fix keeps the callback stable across catalog/status updates while reading the
latest catalog for new results and disabled-index fallback. Its regression
replaces the catalog, changes status, then invokes the same callback against a
new hidden-version title. Changing the host search provider still replaces the
callback. Existing cancellation, error, snippet and hasMore tests remain passing.

Final full `npm test`: 74/74 passed (`search-final-tests.log`). Final
`npm run check:package`: 13 files (`search-final-package.log`). No dependency
or lock changes, README edits, version bump, or publication.

The rejected navigation candidate retained the actual first matched version and
its snippet while deduplicating remote hits by family. It also retained hidden
versions in projected `byId`, with originals first for main-view detection.
Its full suite passed 75/75, and real Edge content-only search clicks opened the
matching version with rememberPath both on and off (`search-clicks.json`). The
first click harness timed out on the target's saved Versions view; selecting
Chat made the text assertion pass. Those are candidate-only results, not claims
about the final committed navigation behavior.

**Why that candidate was withdrawn:** real official 0.2.2-rc.1 Web search for
`Cold` returned three rows for two families: the independent native copy, the
original `Cold: two images`, and a hidden version of that same original with
snippet `Direct cold API diagnostic.` (`search-merge-probe.json`). Native
`deriveSearchResults` first adds local title/workspace/ID matches from projected
`list.ids`, then merges remote hits by exact session ID. Retaining the hidden hit
therefore duplicates a locally matching original. Resolving the two native
search sources as one family without redirecting ordinary row navigation needs
further implementation and regression coverage. The old wrong-target behavior
remains in the committed code; this is a real remaining blocker, not an approved
scope exclusion. No global target mapping or host patch was added.

The rejected candidate is preserved in the repository as
[`pr12-search-target-candidate.patch`](pr12-search-target-candidate.patch), a diff
against `13cd6b4`. It also includes the committed callback fix, so it must not
be blindly applied on top of this continuation. The candidate is evidence only;
its navigation changes are not active in the source or build. Scratch copies
and raw QA artifacts may be removed during parent cleanup; the reproduction and
measured results here and in the adjacent evidence note remain in the branch.

The candidate's 60-chunk Edge run recorded OFF: 253 samples, ON: 251 samples,
both with zero extra searches, zero missing hits and 19 catalog notifications
(`search-browser.json`). Final-code streaming validation is recorded separately
in `search-final-streams.json`: OFF 248 samples, ON 253 samples, both zero extra
searches and zero missing hits, each with 19 catalog notifications; zero page
errors and zero HTTP errors. An intermediate attempt overlapped the npm build,
which cleared the search input during the run; its invalid measurement is kept
as `search-streams-build-interference.json`, not counted as a product pass.
All browser work used the official Web host, owned persisted home, and local
deterministic model. Maximum-size search datasets were not exercised.

Unverified reviewer leads remain outside these fixes: unread status on an unseen
hidden version, subagent count under a hidden child, and root-based archive
visibility. No mark-all-read, batch archive/delete, or speculative policy change
was introduced. This continuation does not claim native Desktop, remote-provider,
hosted CI, or Linux validation.

Continuation cleanup completed at 00:56:44 UTC on 2026-11-06: owned host PID
11640 and runner PID 62848 stopped. Browser instances closed in finally blocks;
the final exact-task-path node.exe/msedge.exe scan returned no remaining
processes. Resource and scratch deletion are left to the parent as requested.
