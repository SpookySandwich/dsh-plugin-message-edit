# PR 12 search navigation and activity resolution — 2026-11-06

> **Current status (2026-11-07): FINAL ACCEPTANCE PASS (`v1.6.0`).**
> This document is preserved as a historical record from an earlier stage of PR #12 validation.
> All earlier `PAUSED`, `BLOCKED`, or intermediate findings noted below were resolved and verified passing in
> [`pr12-round2-actionable-status-2026-11-07.md`](pr12-round2-actionable-status-2026-11-07.md) and [`pr12-current-runtime-2026-11-07.md`](pr12-current-runtime-2026-11-07.md).

Historical acceptance for `5a07e63`: Attacker subsequently found three source
defects. See [Round 1 source corrections](pr12-round1-source-fixes-2026-11-06.md).
The later changes have local test coverage; their browser acceptance is paused.

**STATUS: DONE — local implementation ready for independent review.** This
record supersedes the search blocker in `pr12-search-evidence.md` and
`pr12-dsh-0.2.2-rc.1.md`; those records and the rejected candidate patch remain
historical evidence. No publication or release/version writing was performed.

Parent: `37a091ad-502c-43d6-bc7b-82d926144743`. Implementer:
`59a507df-22d9-4c3a-9d92-d85ace86555b`.

## Integration identity and scope

- Integration base and current remote master:
  `342f638ec3c906673b05442836e71f03792a9d55`.
- Original ganpig contribution, retained intact in ancestry:
  `af6ba8df9aa3e8ac05a321b87c2ba85f863e69c6`.
- Starting implementation HEAD:
  `8466e4a038f4da2b4a1c4a2e43e5b0e1143349a2` (after `13cd6b4`).
- Branch: `maint-20261106-message-edit-37a091ad`, supplied `<task-root>/repo`.
  No second task checkout or session directory change.
- `git ls-remote`, subsequent `git fetch origin master refs/pull/12/head`, and
  `gh pr view 12 --json number,state,headRefOid,baseRefOid,author,comments,reviews,statusCheckRollup`
  agreed: PR OPEN, original contributor head, unchanged base, no comments,
  reviews, or checks at inspection.
- Grouping stays OFF by default. Only recorded parentage participates. A real
  native independent copy has no parent and remains separate. No title/content
  lineage inference, family archive operation, or mark-all-read behavior added.
- Only client source, sidebar regressions, and acceptance evidence changed in
  this continuation. Writer owns version, README compatibility, and changelog.

## Reproduction, root cause, and changes

Before editing source, official 0.2.2-rc.1 with full-text search enabled showed
the hidden child's `NeedleAlbatross` content snippet but opened `session-qa-live`
instead of `session-69e2045a-9b12-449a-9908-f2e71858ba89`. Browser errors: zero.
The content-click and hidden-title fallback regressions both failed before the
fix, returning `root` instead of `child`.

The native `deriveSearchResults` merges immediate title/workspace/ID matches
from `list.ids` and remote content hits by exact ID. Keeping a child ID creates
a second family row when the root title matches. Returning only the root ID
loses the actual match target. The fix keeps root IDs for native deduplication
and stores each row's first matching version alongside that specific search
request, in the sidebar component's ref. Clicking uses that request's target
and snippet together, overriding rememberPath for that click. Native query
cleanup aborts the request; an aborted request cannot redirect ordinary rows.
Each request owns its own target map, so late results cannot replace the current
query's targets. A click consumes the map. The stable callback fix in `8466e4a`
is retained, including current-catalog reads. Archived targets produce the
native archived notification and are not implicitly opened/unarchived.

The official source confirms `openSearchResult` calls `setQuery('')` then
`open(sessionId)` synchronously, before the search effect's abort cleanup.
This ordering and AbortController cleanup are also present in the published
0.2.0-rc.2, 0.2.1-rc.2, and 0.2.1-rc.5 client bundles. No DOM interception,
global navigation-target map, native-host patch, or replacement search UI is
part of the product fix.

A second real-host reproduction started a real local DSH subagent under a
hidden version. Grouping OFF showed `1 subagent running`; ON showed none.
Native `runningChildCount` reads `projectionsBySession[root].values.subagentCatalog`,
which previously contained only the original's children. The sidebar projection
now unions the family's catalogs by child ID, preserving native byId-only
subagent records and other root projection values. Inherited catalogs cannot
double-count a child. Its regression failed before the change and passes after;
the real grouped row now shows `1 subagent running`, and the child's durable
assistant reply contains the final `chunk 59` with the expected parent identity.

## Official compatibility review

Live npm `latest` and `next`: `0.2.2-rc.1`. Upstream tag
`dsh-v0.2.2-rc.1`: `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`.
Reviewed rc.5→rc.1 source changes for the native search merger, browser search
effect/open ordering, session lineage/catalog, and session headers. Native
independent forks now omit parentSession; plugin edits retain recorded lineage.
The native running-count projection remains compatible across the installed
hosts. Existing quote/image/seed compatibility work remains in the retained
implementation and is covered by the full suite and host acceptance.

The retained manifest, lock metadata, and CI matrix already explicitly admit
`0.2.2-rc.1`; no further declaration edit was needed. The existing default-npm-
semver regression passes for the four supported prereleases, rejects untested
prereleases, and checks lock/manifest agreement. No `includePrerelease` shortcut.

## Validation

Owned official Node 24.22.2 ZIP verified against nodejs.org SHASUMS256:
`ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`.
`npm ci` installed the unchanged lockfile. With the owned Node prefix on PATH:

```powershell
npm test                                      # 81/81; zero failed/skipped
npm run check:release-tools                    # 4/4
node --test scripts/npm-publish.test.mjs        # 10/10; unit tests only
npm run check:package                          # 13 expected runtime files
git diff --check                               # pass
# TEMP and TMP point to the owned task root; DSH_QA_MODULES selects each prefix.
node scripts/run-dsh-acceptance.mjs
```

All four official hosts passed both fresh and restart acceptance:
0.2.0-rc.2 (lockfile runtime), 0.2.1-rc.2, 0.2.1-rc.5, 0.2.2-rc.1.
Assertions cover live/cold edits, two images, deterministic model completion,
unchanged source history, seeded replay boundaries, sibling retry, nested edits,
and resuming/retrying a persisted seeded child. Generated client integrity and
real npm-pack contents passed; no package or lock drift.

Real browser: Windows, headless Microsoft Edge **156.0.4314.58**, official Web
host, deterministic local model. The QA-only response interceptor exposes the
real plugin context; it does not replace the host stores/renderers or product
navigation. Full-text search is opt-in in the isolated profile (`path: ':memory:'`,
`openAt: first-search`). All production defaults remain untouched.

- Fresh and final-restart matrices: grouping ON/OFF × rememberPath ON/OFF.
  A unique child-content hit opens that child after viewing its sibling.
  Query `Live` matches the original title and both children's content: grouping
  ON gives two rows (one family and the native independent copy); OFF gives
  four. Clicking the family opens the version supplying its displayed snippet.
  Clearing search restores ordinary navigation/remember behavior.
- Final 60-chunk background stream: OFF **330 samples**, ON **330 samples**;
  both have **zero missing-hit samples and zero extra searches**. Catalog
  notifications: OFF 13, ON 11. Both real subagents completed successfully.
- Real UI edit after final restart retains the original in the catalog, preserves
  both images, completes its local reply, and groups immediately without reload.
- Actual 400px drawer search opens the matching child. Final settled screenshot
  has no horizontal overflow; 1280px and 400px images were visually inspected.
- Search, stream, subagent, and UI-edit passes record zero page/HTTP errors.

## Unread, archive, workspace semantics and limits

Real unread check: a hidden version finishing while another family is viewed
shows Completed on its root. Merely opening the original leaves that unseen
version unread; opening the completed version clears the marker. This follows
the native per-session read contract. No synthetic clearing was added.

Real root archive check: only the original enters `archivedSessionIds`; the
grouped entry disappears under the default filter. Unarchiving it restores the
same family. Other versions are not batch-archived. This root-owned behavior
must be explained in Writer's feature documentation.

Attempting to attach the version to a workspace with a different directory was
rejected by the official registry: its cwd resolves to the original workspace.
Membership stayed unchanged and the family appeared once. The QA endpoint
reported that expected refusal as HTTP 500 (recorded separately from successful
browser passes). Cross-directory movement is **not claimed as a passing flow**;
no invalid membership or log mutation was forced. Existing projection tests
cover catalogs containing family members in distinct workspaces.

No new Native Desktop, remote-provider, Linux, hosted-CI, maximum-search-dataset,
or older-host browser-layout claim. Older hosts have new fresh/restart HTTP
acceptance plus reviewed native search contracts, not new browser matrices.
Early harness attempts corrected a missing required SQLite path, scoped the
context interceptor to the plugin's section of a combined response, waited for
actual UI navigation instead of optimistic text, and reopened/waited for the
narrow drawer. Those attempts are not counted as passes. One PowerShell display
of a redirected JSON log mishandled Unicode; the original UTF-8 JSON artifacts
were read directly with Node and are intact. The initial baseline JSON was
overwritten by a passing probe; its failed-before observation is preserved in
the tool transcript and the sanitized evidence's explicit baseline entry.

## Evidence and handoff

- [Sanitized results](assets/pr12-search-20261106.json)
- [Wide combined title/content search](assets/pr12-search-20261106-wide.png)
- [400px search](assets/pr12-search-20261106-narrow.png)
- [400px opened matching version](assets/pr12-search-20261106-open.png)

Reusable task-root artifacts: `node-v24.22.2-win-x64/`, `runtime/`, `runtime-rc5/`,
`runtime-rc2/`, `upstream/`, `message-edit-dsh-qa-browser/`, `qa-host.mjs`,
`qa-addon.mjs`, `qa-browser-lib.mjs`, `search-matrix.mjs`, `activity-probe.mjs`,
`lifecycle-probe.mjs`, `ui-edit-probe.mjs`, `narrow-final.mjs`, and JSON evidence.
`qa-resources.jsonl` records exact browser PIDs/profile paths and closing events.
Local auth URLs/logs stay in scratch and must not be published.

Host/runner pairs: 51900/32904 (initial invalid QA config), 40300/88640,
37076/72560, and final 52664/106292. All are stopped before handoff. Automated
acceptance hosts stopped by their runner: latest 107752/25656; rc.5 71044/82104;
rc.2 88796/43600; 0.2.0 98712/82236. Their four uniquely owned homes were removed
by the existing runner; reusable prefixes and browser home remain. Browser
contexts and launch servers close in `finally`; exact profile paths are checked
absent during final cleanup. Early diagnostic browser launches closed in finally
but did not log individual browser PIDs; no complete historical PID claim.
Final inventory found no node.exe/msedge.exe command line containing the owned
task path. All 24 tracked browser starts have matching close records and all
24 exact profile directories are absent. No broad recursive cleanup was run.

Attacker should inspect the new diff from `8466e4a`, then the complete integration
diff from `342f638`, retaining ganpig's contribution. Prioritize stale/cancelled
search targets, root-title plus multi-child matching, archived target behavior,
callback identity during background streaming, and inherited subagent catalogs.
Run `npm test` and package checks from the supplied repo. Restart the owned
browser host with the owned Node and `../qa-host.mjs`, never a user DSH profile.
The retained browser fixture now includes extra UI-created versions, so the
early four-session matrix's OFF row-count constant needs a fresh fixture or an
updated expected count for reuse. `activity-probe.mjs` and `narrow-final.mjs`
remain reusable against the retained fixture. Writer handles feature caveats
and release documentation; parent controls all later review/publication steps.
