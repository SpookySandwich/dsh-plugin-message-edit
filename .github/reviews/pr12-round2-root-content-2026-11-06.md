# PR 12 Round 2 root-content correction — 2026-11-06

> **Current status (2026-11-07): FINAL ACCEPTANCE PASS (`v1.6.0`).**
> This document is preserved as a historical record from an earlier stage of PR #12 validation.
> All earlier `PAUSED`, `BLOCKED`, or intermediate findings noted below were resolved and verified passing in
> [`pr12-round2-actionable-status-2026-11-07.md`](pr12-round2-actionable-status-2026-11-07.md) and [`pr12-current-runtime-2026-11-07.md`](pr12-current-runtime-2026-11-07.md).

**Source fix and local checks: DONE. Overall official UI acceptance: BLOCKED /
PAUSED. Source review Round 3 remains pending; this is not a mature-release or
browser PASS claim.**

Parent `37a091ad-502c-43d6-bc7b-82d926144743`; implementer
`59a507df-22d9-4c3a-9d92-d85ace86555b`.
Starting HEAD: `764f42af2cfc71c5af68633f84ae5d9a0ff5c236`.
Integration base: `342f638ec3c906673b05442836e71f03792a9d55`.
Original contributor: `af6ba8df9aa3e8ac05a321b87c2ba85f863e69c6`, preserved in
ancestry. Grouping remains OFF by default and uses recorded lineage only.

## Blocker reproduction and correction — LOCAL TESTS

Read `attacker/export/test/attack-round2.test.mjs` for independent A1/A7 evidence.
That file and all Attacker scratch were left untouched; the independent suite
was not executed in this round. Equivalent regressions were added to the
repository's existing local sidebar harness.

Before changing product source, the new root-content case failed against the
rebuilt `764f42a` bundle: a root row displaying `OriginalOnly wording before the
edit` opened remembered `nested`, with expected `root`. The new multi-hit case
also failed when a root snippet opened remembered `child`. The title-only /
empty-snippet control passed. These are local callback/projection observations,
not browser reproductions.

The previous implementation required a hidden member even when a nonempty
snippet was displayed. That condition and the prior test expectation were
wrong. The target rule is now:

```js
if (item.snippet || (item.sessionId !== sessionId && !ordinary))
  targets.set(sessionId, item.sessionId);
```

The native snippet type is an optional string: a nonempty value selects its
actual source, including the root; missing or empty-string snippets do not
create content intent. A hidden-only match still selects its matching version.
An ordinary shared-title match without a displayed snippet preserves the
rememberPath rule. Explicit root navigation records the root path, preventing
the bubble-level remembered-version restore from undoing the selection.

Root regression coverage iterates rememberPath ON/OFF and root-title matching /
not matching the query. The corrected ordinary-navigation test covers missing
and empty snippets from both root and hidden members, with both preferences.
The prior three corrections (shared-title FTS-off behavior, pending/empty maps,
archive visibility and precedence) remain covered and passing.

## Snippet precedence and M9 — LOCAL MUTATION CHECK

The new multi-hit regression provides an earlier hit with no snippet (missing
or empty string), a later nonempty snippet from either root or hidden `nested`,
another family member with content, and an independent conversation. It asserts
one family row, the first nonempty snippet, navigation to that snippet's source,
the separate conversation row, and preserved `hasMore`, with remember ON/OFF.

After the target fix passed the focused tests, temporarily replacing
`candidates.find(item => item.snippet) || candidates[0]` with `candidates[0]`
made this regression fail: the family snippet was undefined instead of
`first displayed content from nested`. This catches M9's first-hit precedence
failure. The mutation was restored before the final build and full checks.
Only this focused mutation was run here; no claim of a new full mutation sweep.

## Final local checks

Owned Node 24.22.2, supplied isolated checkout, TEMP/TMP in the owned task root:

```powershell
npm test                               # 95/95; zero failed/skipped
npm run check:release-tools             # 4/4
node --test scripts/npm-publish.test.mjs # 10/10; unit tests only
npm run check:package                   # 13 expected runtime files
git diff --check                       # pass
```

The full suite includes 36 sidebar cases. Build lifecycle regenerated and
verified the client after restoring M9. Package verification ran npm pack;
publication-helper checks are local tests and did not publish anything. Existing
compatibility/lock tests for all four supported prereleases remain passing.
No version, README compatibility, changelog, manifest, lockfile, or dependency
changes. No source-host publication or child delegation.

## Unresolved minor behavior and validation limits

- **Ambiguous hidden-only titles:** when the root has been renamed and several
  hidden versions match a title without snippets, the first eligible match can
  win over a remembered matching version. This pre-existing behavior is left
  unresolved as the parent permitted; A2 is not claimed fixed or passing.
- **Show archived presentation:** an archived-only hidden hit grouped under a
  live root can appear with the root's live styling and no Unarchive control.
  Native search clears its query before the plugin's archived notification.
  Root-owned archive semantics are unchanged. This remains a source-derived
  presentation risk, not a newly observed or validated browser outcome.
- **Browser/host QA remains paused:** the parent's explicit restriction follows
  the earlier rejected tool-use request. No browser, host, seed, browserattack,
  or substitute UI commands ran. No new official-runtime, Native Desktop,
  remote-provider, Linux, or hosted-CI validation is claimed. Earlier browser
  evidence cannot validate this correction or close the main acceptance blocker.

No QA hosts, browser profiles, or persistent processes were created in this
round. All local check commands completed. Attacker scratch/process ownership
was not modified; retained runtimes stay available for parent-owned cleanup.

Review this continuation against `764f42a`, then the complete feature against
`342f638`. Round 3 should prioritize A1 and A7/M9 plus the earlier archive,
ordinary-navigation, cancellation, and stable-callback regressions. Only after
the parent resolves the browser refusal may official-host acceptance resume,
including the root-only content / remembered edited-version case.
