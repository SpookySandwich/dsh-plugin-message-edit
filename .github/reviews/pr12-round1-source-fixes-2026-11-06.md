# PR 12 Round 1 source corrections — 2026-11-06

> **Current status (2026-11-07): FINAL ACCEPTANCE PASS (`v1.6.0`).**
> This document is preserved as a historical record from an earlier stage of PR #12 validation.
> All earlier `PAUSED`, `BLOCKED`, or intermediate findings noted below were resolved and verified passing in
> [`pr12-round2-actionable-status-2026-11-07.md`](pr12-round2-actionable-status-2026-11-07.md) and [`pr12-current-runtime-2026-11-07.md`](pr12-current-runtime-2026-11-07.md).

Historical evidence for `764f42a`: its root-content navigation rule and test
expectation were incorrect. [Round 2 correction](pr12-round2-root-content-2026-11-06.md)
supersedes that rule; all displayed nonempty snippets select their source version.

**Source implementation: DONE. Official UI acceptance for these changes:
BLOCKED / PAUSED. No release-readiness or browser PASS claim.**

Parent: `37a091ad-502c-43d6-bc7b-82d926144743`. Implementer:
`59a507df-22d9-4c3a-9d92-d85ace86555b`. Attacker:
`35552da5-e2d1-47c1-a7dd-d3105c3ed2c2`.

Starting HEAD: `5a07e63b1953e13c1b995495904eb92f1d4a8d4d`.
Integration base remains `342f638ec3c906673b05442836e71f03792a9d55`;
ganpig's original `af6ba8df9aa3e8ac05a321b87c2ba85f863e69c6` remains in ancestry.
Changes stay in the supplied checkout/branch, with no publication, version,
README compatibility, changelog, dependency, or lockfile changes.

## Validation boundary

The parent reported that Attacker's browser calls were explicitly rejected:
"The user doesn't want to proceed with this tool use...STOP what you are doing
and wait for the user to tell you how to proceed." No specific reason was given.
The parent subsequently authorized only source fixes and local unit/regression,
build, package, and release-helper checks. No browser, seed, browserattack,
substitute UI, or official-host acceptance command was launched in this round.
No tools were used to ask the user for permission; clarification stays with the
parent. Prior browser evidence describes the earlier source, not these changes.

## Reproduction and fixes — SOURCE / LOCAL TESTS

The first ten new local regression cases ran against the unchanged `5a07e63`
bundle: nine failed, while the cancellation/grouping-off control passed.
The previous 22 sidebar cases also passed. Failures reproduced all three
source findings before product edits:

1. **Shared title with default FTS disabled:** provider rejection fell back to
   hidden local title hits. An arbitrary child became the navigation target even
   when the original matched, overriding rememberPath on/off. The projection now
   distinguishes ordinary root matches from explicit hidden-version intent.
   Native root title, ID, and workspace-label/cwd matches keep ordinary
   navigation unless a hidden version supplies displayed content. A hidden-only
   match still navigates to that version. Root content hits and empty snippets
   retain ordinary navigation; a nonempty hidden snippet selects its version.
2. **Pending/empty target map:** `targets.get(id) || id` converted the absence of
   an explicit target into an explicit root selection and overwrote the saved
   path. The open callback now consumes the request but falls through to the
   ordinary rememberPath rule when no target exists. It does not write the path
   in that case. Workspace/ID matches, pending and completed requests, on/off
   preferences, cancellation, and late completion are covered.
3. **Archived hit precedence:** remote and local hidden hits were grouped before
   checking archive visibility. A first archived child could supply the snippet
   and block an openable family. The projection now filters the real member and
   original according to the native archive mode before family deduplication.
   In Show archived, an openable matching member or local root takes precedence
   over archived-only hits. An archived-only match is hidden in default mode; if
   shown explicitly, clicking it retains the archived notification and cannot
   silently open an unrelated root. Only archived follows original-owned family
   visibility and filters member hits too. Root archive still blocks opening
   the root row. The remembered-version archive guard remains intact.

Archive membership and archive-filter changes intentionally replace the search
callback so native search removes newly hidden snippets. Equal membership,
including reordered archive IDs, leaves it stable. Catalog/status streaming
updates still do not replace it. Pending results read current catalog/workspace
snapshots, and each request retains its independent target map.

The original archived-target regression now archives the target *after* search
resolution; it continues to verify the click-time race guard. Searching an
already archived hit in default mode is instead covered by the new exclusion
regressions. Two additional cases cover root/empty snippets and archive changes
while a request is pending. Final sidebar total: 34 passing cases, including
12 new cases (several iterate preference/filter/input combinations).

## Official contract reviewed — SOURCE ONLY

Read the retained official upstream source at
`dsh-v0.2.2-rc.1`, SHA `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`:

- `packages/api/session-controller/src/types.ts`: `SessionSearchRequest` contains
  only `query`; no archive-filter request field.
- `packages/api/session-controller/src/list.ts`: the host queries current user
  and assistant message content under its authorization/result bounds. It does
  not apply the sidebar archive mode.
- `packages/client/ui-workspace/src/client/contract/slots.ts`: injected
  `searchSessions(query, signal)` returns bounded items and `hasMore`.
- `rows/WorkspaceBrowser.tsx`: archive mode comes from
  `useStore(s => s.archivedFilter ?? 'default')`; search effect cleanup aborts
  the request when its query/callback changes. Native search blocks archived
  root rows before clearing the query and opening them.
- `tree.ts`: `sessionVisible` implements default/show/only. `deriveSearchResults`
  filters both local and remote results by that mode, merges by exact ID, and
  derives local labels from the first owning workspace or cwd basename.
- `packages/util/workspace-path/src/index.ts`: cwd labels use the final nonempty
  segment with either slash separator; separator-only paths fall back to the
  original path at the workspace tree call site.

No upstream source, native search implementation, or global settings were changed.
Root-owned archive, independent-copy, and unread semantics remain as previously
approved. Subagent catalog deduplication is unchanged and its regression passes.

## Final local checks

Run from the supplied checkout with owned Node **24.22.2** first on PATH, and
TEMP/TMP set to the owned task root:

```powershell
npm test                               # 93/93; zero failed/skipped
npm run check:release-tools             # 4/4
node --test scripts/npm-publish.test.mjs # 10/10; unit tests, no publication
npm run check:package                   # 13 expected files; real npm pack
git diff --check                       # pass
```

The npm test lifecycle rebuilt and verified the generated client. Existing
default-semver and lock/manifest tests continue to admit 0.2.0-rc.2,
0.2.1-rc.2, 0.2.1-rc.5, and 0.2.2-rc.1 without admitting untested prereleases.
No dependency installation or declaration changes were needed. These are local
tests and build/package checks, not new official-runtime, browser, Native
Desktop, remote-provider, Linux, or hosted-CI acceptance.

## Handoff and QA ownership

No QA host/browser processes or profiles were created in this continuation.
Owned runtimes from the earlier round remain available. Attacker scratch,
junctions, and process ownership were not modified. The parent's report says
Attacker hosts 97928/2900 and their runners were stopped; that statement is not
a new independent process verification by this implementer.

Review this continuation against `5a07e63` and the full feature against
`342f638`. The source/local checks are concrete and ready for review. The parent
must resolve the browser refusal before any further browser work. After that
permission is established, revalidate default FTS-off shared titles, workspace
and ID local matches while search is pending, archive modes/precedence and
archived-only hits, then check remembered navigation, multi-child deduplication,
streaming callback stability, and restart persistence in the official host.
The earlier browser evidence cannot close these acceptance gaps.
