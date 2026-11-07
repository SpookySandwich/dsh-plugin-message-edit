# PR 12 search continuation evidence — 2026-11-06

> **Current status (2026-11-07): FINAL ACCEPTANCE PASS (`v1.6.0`).**
> This document is preserved as a historical record from an earlier stage of PR #12 validation.
> All earlier `PAUSED`, `BLOCKED`, or intermediate findings noted below were resolved and verified passing in
> [`pr12-round2-actionable-status-2026-11-07.md`](pr12-round2-actionable-status-2026-11-07.md) and [`pr12-current-runtime-2026-11-07.md`](pr12-current-runtime-2026-11-07.md).

Status: **BLOCKED** on search-hit navigation versus family deduplication. Only
the validated search callback fix is active. Base: `13cd6b49fe8ae6b381ff96f4f18f64d9c02bac5e`.
No publication or version change. The contributor ancestry remains intact.

## Final active code

`GroupedSidebar.searchSessions` retains its identity across catalog/status
updates and reads the latest catalog for search results and local fallback.
The behavioral regression replaces the catalog with a new hidden-version title,
verifies callback identity and fresh query results, and verifies provider changes.
Existing abort/error/snippet/hasMore tests continue to pass.

- Owned Node 24.22.2: `npm test` **74/74 passed**, zero failed/skipped.
- `npm run check:package`: **13 files**, all runtime entries present.
- `git diff --check`: passed.
- Official npm DSH 0.2.2-rc.1, headless Edge 156.0.4314.50, local deterministic
  60-chunk reply, retained isolated Web home restarted for this continuation:

| Grouping | Samples | Missing-hit samples | Extra searches | Catalog notifications |
| --- | ---: | ---: | ---: | ---: |
| OFF | 248 | 0 | 0 | 19 |
| ON | 253 | 0 | 0 | 19 |

Both final browser runs had zero page errors and zero HTTP errors. The original
Attacker baseline for grouping ON had two extra searches and 14/252 missing-hit
samples. An intermediate final-code attempt ran concurrently with npm's build;
the search input cleared during that attempt, so it was discarded and rerun
after the build finished. No Desktop, remote model, Linux or hosted-CI claim.

## Remaining bug and rejected candidate

1. Enable grouping and create an original plus two recorded edit versions.
2. Give one version unique searchable content; open its sibling so rememberPath
   selects that sibling, or disable rememberPath.
3. Search for the unique content. Current source rewrites the hit's session ID
   to the root; clicking it can open the root/remembered sibling without the hit.

The adjacent candidate patch keeps the actual hit ID and preserves hidden
records in projected `byId`. Its content-only click checks passed with
rememberPath on/off, but it introduced this separate reproducible failure:

1. In the official host, use an original titled `Cold: two images`, a hidden
   recorded version containing `Direct cold API diagnostic.`, and the separate
   native independent copy titled `Cold: two images (1)`.
2. Enable grouping and search `Cold`.
3. Candidate result: three rows — the independent copy, the original title
   match, and the hidden version content hit. Expected: two families.

Observed row text, with local workspace paths removed:

```text
Cold: two images (1) | Normal cold lifecycle UI edit after restart.
Cold: two images
Cold: two images | Direct cold API diagnostic.
```

Official `deriveSearchResults` merges local title/workspace/ID matches from
`list.ids` with remote content hits by exact session ID. Remote family
deduplication alone cannot combine the root's local match with a retained child
target. The candidate was reverted; it must not ship. The preserved patch is
against `13cd6b4` and includes the now-committed callback fix too. It is evidence
for further work, not an apply-on-current-HEAD patch.

The native independent copy remains separate by approved scope because it has
no recorded parentage. That scope decision does not excuse this search bug.

## Ownership and cleanup

Owned QA host PID 11640 and runner PID 62848 stopped at 00:56:44 UTC. Browser
contexts closed; exact-task-path node.exe/msedge.exe inventory was empty after
cleanup. Retained scratch artifacts may be removed by the parent; the patch and
this sanitized record preserve the necessary reproduction evidence. No raw
authentication URLs, browser storage, credentials or local user paths are included.
