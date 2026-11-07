# PR #12 — grouped actionable status, round 2

**Current status: FINAL PASS (`v1.6.0` release acceptance).** Both implementation validation and independent verification passed on `59fe62844686947fb15409da3d825f9106c1d9c0` (production fix `586e7e7206c42ab6d71953d80ac2025ae024a33c`). Earlier `PAUSED`/`BLOCKED` notes in prior `pr12-*.md` reports are historical only.

Implementation source: `586e7e7206c42ab6d71953d80ac2025ae024a33c`.
Baseline: `88ba4a146445a2293184d9067645a76b908b10bc`.
Assigned branch: `maint-20261107-message-edit-2605505a`.
Contributor `af6ba8df9aa3e8ac05a321b87c2ba85f863e69c6` remains an ancestor.

This addresses the independent round-1 blocking finding: a grouped row could
display a hidden version's Completed/approval status while opening the root or
a remembered sibling. The previous runtime report did not cover that mismatch;
its PASS does not supersede the independent failure. This report records the
reproduction and the bounded correction on top of that baseline.

## Behavior and tradeoff

Ordinary grouped-row navigation now chooses:

1. An eligible pending approval, plan review, or question.
2. An eligible unread completion.
3. The existing remembered version or original, according to the setting.

Within each status priority, the original is preferred, then the host's catalog
order. Multiple unread versions are visited individually: the host clears only
the version actually opened, and another click can reach the next unread one.
A pending interaction continues to take priority until it settles. There is no
family-wide read acknowledgement and no deletion of native status metadata.

The same candidate map supplies projected pending/completion flags and click
targets. Candidates exclude archived, missing, blank, and subagent sessions;
ordinary hidden versions must come from the catalog. ById-only subagents retain
their native activity projection and are not treated as conversation versions.
An archived root still obeys the host's root-owned navigation restriction.
Old click handlers read the latest rendered catalog/archive/status selection.
Known pending kinds match the official host's visible status contract; unknown
kinds do not silently acquire navigation priority.

Explicit search-hit destinations remain first, including original-content
snippets and unique hidden-title hits. Status navigation records its chosen
destination so the bubble's remembered-path effect cannot undo an intentional
root selection. When there is no actionable status, ordinary no-content title
navigation still honors remember ON/OFF. Grouping remains OFF by default, and
the root retains its actual identity, workspace, pin and archive semantics.

The chosen tradeoff is that an actionable grouped indicator temporarily takes
precedence over the remember setting. Root-only flags would preserve that
setting unconditionally but conceal a hidden version's request for attention.
Keeping the indicator and directing the click to its source makes that hidden
work reachable without adding a new UI or changing per-session acknowledgements.

## Reproduction and regression evidence

- Before changing production source, the new unit regression failed: the row
  projected `completionUnread: true`, but opening it produced `root` instead of
  `child`. The baseline official `0.2.2-rc.1` browser run independently passed
  the grouping-OFF control, then failed grouping-ON/remember-OFF with the same
  wrong destination and the child's unread flag still set. The script stopped
  at that failure; this implementer's baseline run does not claim a second
  remember-ON failure (that case was in the independent review).
- Seven added behavior tests cover pending priority for all three visible
  kinds, both remember settings, multiple flags, root restore, native metadata
  preservation, exclusions, stale handlers, and explicit search precedence.
  Existing ordinary-title/remember, archive and search regressions also pass.
- A negative control copied the generated bundle and test file into owned
  scratch and removed only the actionable-navigation block. All three selected
  completion/pending/multiple-status regressions failed. No repository source
  was changed for this control.

## Validation

The completed results and exact command output are in
[the evidence directory](assets/pr12-round2-actionable-status-2026-11-07/).

| Check | Result |
| --- | --- |
| `npm test` | 102/102 passed, including 43 sidebar tests |
| Release and publication helper unit tests | 14/14 passed (4 + 10); no publication |
| `npm run check:package` | 13 expected files verified |
| New/changed helper syntax, generated bundle, diff checks | Passed |
| Latest official host status/approval browser | 13/13 checkpoints passed |
| Official `0.2.1-rc.5` status/approval browser | 13/13 checkpoints passed |
| Latest official host main search/browser matrix | 20/20 checkpoints passed |
| Official `0.2.1-rc.5` main search/browser matrix | 18/18 checkpoints passed |
| Latest official host restart/native operations/layout matrix | 20/20 checkpoints passed in one invocation |
| Latest default-disabled full-text search and real plugin disposal | 10/10 checkpoints passed |
| Official `0.2.2-rc.1`, `0.2.1-rc.5`, `0.2.1-rc.2`, `0.2.0-rc.2` API acceptance | All four passed fresh and restart |

Both status matrices exercised native grouping OFF, grouped completion with
remember OFF and ON, multiple unread versions without bulk acknowledgement,
ordinary navigation after flags clear, explicit original-content search while
a hidden approval waits, pending-before-unread navigation, and root approval
with a remembered sibling. All completed browser phases report zero page
exceptions and HTTP error responses.

Real 60-chunk streaming search remained stable: latest-host OFF/ON observed
377/373 samples and 11 catalog updates each; older rc.5 OFF/ON observed 393/391
samples and 18 catalog updates each. Every run recorded zero missing-hit
samples and zero extra searches. Latest restart checks retained native
workspace/pin/archive behavior, orphan and independent-copy separation,
hidden-version subagent counts, cold/nested edits, retry, and 400px layouts.
API acceptance covered live/cold sources, both images, unchanged original
histories, sibling retry, nested versions and persisted seeded-child retry.

**Actual pending approval was exercised on both hosts.** The owned local model
fixture calls the real host approval service inside an open model turn. The
host supplies the real pending-interaction state, audit pair, card and Reject
button. Browser checks navigate to that card and reject it through the native
UI, verify `outcome: rejected`, and then reach the still-unread sibling. The
fixture performs no tool or file operation. This establishes native approval
routing/settlement, not remote model behavior or arbitrary privileged tools.
Plan-review and question priority are covered at unit-contract level only.

Status matrices were rerun against the committed source SHA above. The older
main search matrix ran on the identical working source immediately before that
commit; its JSON retains the truthful working-tree source label. No source
changes intervened. The evidence-only follow-up commit does not change the
validated implementation.

## Minor finding: older native session-ID search

The browser helper now reads the actual launcher's host version and checks the
native ungrouped root-ID contract. Official `0.2.2-rc.1` matches the original's
ID; retained older hosts search titles/workspace labels instead. The older
matrix asserts zero native root-ID results and omits the two latest-only
ordinary-ID navigation scenarios. Existing hidden-version ID fallback remains
unchanged; no additional capability was introduced into older native search.

## Reproduce the status matrix

Use the existing isolated browser launcher with an owned
`message-edit-dsh-qa-*` home and an installed official runtime. Node `24.22.2`
and Edge `156.0.4314.58` were used here, with `playwright-core@1.65.0` from the
owned latest-runtime prefix. The browser verifier can use that prefix for
Playwright while the launcher uses `runtime-rc5/node_modules` for its DSH host.

```powershell
# From the assigned repo; set the owned Node prefix first on PATH.
# Host shell: DSH_QA_MODULES selects the host runtime; DSH_QA_HOME is disposable.
node scripts/run-dsh-browser-host.mjs *> ../round2-owned-host.log
# Wait for ready; in the verifier shell set HOME/OUTPUT/HOST_LOG to that host.
$env:DSH_QA_MODULES = (Resolve-Path ../runtime/node_modules).Path
$env:DSH_QA_SHA = (git rev-parse HEAD)
$env:DSH_QA_PHASE = 'status-final'
node scripts/verify-dsh-status.mjs
```

The status helper creates two edited versions on its first invocation and
records them in `status-family.json`. It can reuse them for subsequent status
runs. Use a separate fresh home for the main search matrix: status QA prompts
contain session IDs and would otherwise create real content hits for the
title-only ID scenario. Browser storage and raw host logs stay in scratch.

## Boundaries and resource ownership

This run changes production sidebar status/navigation, focused tests and local
QA fixtures/helpers. Version, package metadata, README compatibility/changelog,
release documentation and publication remain outside this change. The two
previously accepted search caveats still apply: archived-only hidden matches
can show root styling/no Unarchive action before a native restriction notice;
ambiguous hidden-only titles need not choose the remembered version.

No native Desktop, Linux, remote-provider, hosted-CI or maximum-size dataset
claim is made. The original contributor ancestry and prior retained fixes are
preserved. Attacker scratch was read only for the sanitized probe script and
was not modified; no private attacker auth logs were copied.

All new resources are under `<task-root>`, the assigned repo's parent. Owned
homes are `message-edit-dsh-qa-round2-022`, `message-edit-dsh-qa-round2-rc5`, and
`message-edit-dsh-qa-round2-matrix`; evidence is in the corresponding
`round2-*-evidence` directories. The process inventory records exact host,
runner and browser PIDs, owned paths, and final cleanup verification. Shared
official runtime prefixes were retained for parent review.

Cleanup verified all **29** recorded host/runner/browser PIDs absent and ports
**55001, 55002, 55003** free. Final host **29488** and runner **60228** are stopped;
all eight API host lifecycles and their four homes were cleaned by their runner. The
first immediate cleanup scan raced launcher exit; a subsequent scan after the
shell completion notification confirmed no remaining process. Raw auth logs,
browser storage and owned QA homes remain only in scratch. Forced host stops
can produce launcher-shell exit code 1; all verifier results above passed.

## Final current acceptance summary (independent verification PASS)

Independent verification on exact revision `59fe62844686947fb15409da3d825f9106c1d9c0` (production source `586e7e7206c42ab6d71953d80ac2025ae024a33c`) confirmed **VERDICT: PASS**:

- **Clean export suite (Node `24.22.2`):** `102/102` automated tests, `4/4` release-tool tests, `10/10` publish-helper unit tests, and `13`-file `npm run check:package` verification all passed.
- **Independent real-browser status and approval probes (Microsoft Edge `156`, official Web host on both latest `0.2.2-rc.1` and older `0.2.1-rc.5`):**
  - **Original B1 mismatch fixed (`rememberPath` ON and OFF):** Clicking a grouped row with a hidden child unread completion opens that child and clears the `Completed` label; ordinary remembered-version or root fallback returns once actionable flags are cleared.
  - **S1 (unversioned native approval):** An unversioned session with pending approval retains its native label; clicking opens it and `Allow once` settles to `allowed-once`.
  - **S2 (archived hidden unread exclusion and restore):** Archiving a hidden unread version removes its unread flag from the grouped row; clicking falls back to the root while preserving the child's unread state; unarchiving restores the projected flag and clicking the row opens the child and clears it.
  - **S3 (explicit search precedence over pending approval):** An explicit child-content search hit opens the matching child even while the root has a pending approval; the next ordinary click on the grouped row opens the root approval and `Reject` settles it.
  - **S4 (grouping OFF control):** With grouping disabled, pending approval stays on its own native session row.
  - **S5 (sibling pending reachability and root invariants):** Pending approval on a sibling version is reachable via the grouped row while root identity, title, workspace membership, active selection highlight, and family deduplication remain intact.
  - **Zero errors:** `0` page exceptions and `0` HTTP error responses across all probes.
- **Independent latest-host (`0.2.2-rc.1`) main search and streaming stability:** Fresh `20/20` main search/browser checkpoints passed; 60-chunk background streaming search recorded `383` samples (grouping OFF) and `373` samples (grouping ON) with `0` missing-hit samples and `0` extra searches.
- **Combined multi-round coverage:**
  - Round 1 independently validated `19/19` main search, `20/20` restart/native operations/layout, `10/10` default FTS-off + real plugin disposal, fresh and restart API acceptance on all 4 official hosts (`0.2.2-rc.1`, `0.2.1-rc.5`, `0.2.1-rc.2`, `0.2.0-rc.2`), and `17/17` older `0.2.1-rc.5` main checks.
  - Round 2 independent verification focused on the updated status/search/streaming paths without repeating unaffected restart/API phases, while the implementation pass reran the updated source across all 4 official hosts fresh/restart API acceptance, latest `20/20` main, `20/20` restart, `10/10` FTS-off + disposal, `0.2.1-rc.5` `18/18` main, `13/13` actual status/approval checks on each of `0.2.2-rc.1` and `0.2.1-rc.5`, the 3-regression negative control (all 3 selected regressions failed with the actionable-navigation block removed), and full `102/102` tests.
- **Scope and boundaries:** `plan-review` and `question` pending priorities are verified at unit and source-contract level, while actual `approval` interaction was verified end-to-end in the real browser on both `0.2.2-rc.1` and `0.2.1-rc.5`. No Native Desktop, Linux, remote model provider, or maximum-size dataset claims are made locally; hosted Linux/Windows CI runs on the final release commit.
