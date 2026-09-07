# PR #1 acceptance record

Reviewed on 2026-09-07. Scope: restoring images in user-message bubbles.

- Contributor PR: https://github.com/SpookySandwich/dsh-plugin-message-edit/pull/1
- Reviewed contributor commit: `4e3ccfc50d016750e632d86c5b828aeb4a5d2a31`
- Tests and CI commit: `4cb0fc31afb6ca3279ea34b6fc8998052dc4c35c`
- Successful CI run: https://github.com/SpookySandwich/dsh-plugin-message-edit/actions/runs/34085150511

## Decision

The image-rendering change passes its scoped acceptance checks. No blocking
defect was found in the contributor's change. This is not a declaration that
the complete plugin is compatible with newer DSH releases or ready to publish.
PR #1 remains open; this review did not merge it or publish an npm release.

## Evidence

- All 8 new client-image tests pass, together with the existing 36 tree
  assertions. Tests load the generated client bundle, use real React and jsdom,
  and provide doubles for host services and the image gallery.
- Replacing the generated client with the pre-PR implementation makes the
  multiple-image, image-only, and cancel-edit image-restoration cases fail
  (3 failures, 5 passes), confirming that the tests detect the reported bug.
- A clean temporary copy without dependencies or a generated client passes
  `npm ci`, `npm test`, and `npm run check:package` on Windows / Node 22.19.
- GitHub Actions passes all three jobs: Linux / Node 22, Linux / Node 24,
  and Windows / Node 22, including real npm packaging checks.

## Actual DSH browser verification

The installed official DSH 0.1.2-rc.1 runtime was started with a separate
temporary `DSH_HOME`, its own workspace, two synthetic sessions, and locally
generated red/blue PNG attachments. No user's existing conversations or API
credentials were used, and no model request was required for these checks.

With the unchanged package manifest, the plugin appears Enabled/Running in
the plugin list but its settings entry is absent. This reproduces the client
loading problem reported in Issue #2.

To isolate PR #1, **only the temporary installed copy** was given the four
client injection declarations proposed in Issue #2 (locale, UI slots,
UI conversation, and modules). The review branch's manifest still has its
original empty injection list. With that test-only prerequisite:

- Text plus two images shows both real thumbnails in order.
- Clicking the red thumbnail opens DSH's original-image viewer and displays
  the full image; closing it returns to the message.
- Entering edit mode shows the original text and the two-image retention
  notice; cancelling restores both thumbnails.
- An image-only message displays its image. Its text-edit action remains
  disabled, consistent with the existing behavior.
- The Versions tab is visible.

Full edit submission and branch creation are **not accepted by this record**.
The synthetic session has no model-route history, so attempting submission
stops with the expected prerequisite error “无法从会话历史解析模型路由。”.
The server-side `.events` incompatibility described in Issue #2 therefore
still needs a representative session and separate integration coverage.

The browser tab and isolated DSH server were closed after verification.

## Release follow-up

- Handle Issue #2 as a separate compatibility change, including visible
  diagnostics and end-to-end edit/branch checks on the chosen DSH versions.
- Update both README languages when compatibility is verified. Their DSH
  badge currently says `0.1.0-rc.7`; it must describe tested compatibility,
  rather than merely copying the newest upstream version.
- The npm version badge is dynamic and follows the published npm version.
- CI is on `review/pr-1-images-ci`; the default branch has not yet received
  the workflow. Required merge checks are a separate repository setting.
