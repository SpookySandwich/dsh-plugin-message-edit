# Development & Testing Guide

This guide covers building, testing, packaging, and installing `dsh-plugin-message-edit`.

---

## 1. Repository Structure

```
dsh-plugin-message-edit/
├── lib/
│   ├── index.js          # Host-side Cordis plugin (routes, session log processing)
│   ├── tree-logic.js     # Pure tree algorithms (shared with client and tests)
│   └── client.js         # Generated client bundle (wrapped from plugin.client.js)
├── plugin.client.js      # Source client-side UI and React components
├── scripts/
│   └── build-client.mjs  # Build script wrapping plugin.client.js into lib/client.js
├── test/
│   └── tree.test.mjs     # Automated test suite (36+ unit tests)
├── cordis.patch.yml      # Service dependencies and injection metadata
├── docs/                 # Technical architecture and data model documentation
└── package.json
```

---

## 2. Build Pipeline

The client component [`plugin.client.js`](file:///D:/dsh-plugin-message-edit/plugin.client.js) is written in browser-compatible JavaScript. Before distribution or testing, it is wrapped with a Cordis module preamble into [`lib/client.js`](file:///D:/dsh-plugin-message-edit/lib/client.js).

### Build Client
```bash
npm run build
```
Executes `node scripts/build-client.mjs` to regenerate `lib/client.js`.

### Check Build Integrity
```bash
node scripts/build-client.mjs --check
```
Exits with code 1 if `lib/client.js` is out of date relative to `plugin.client.js`.

---

## 3. Testing

The project includes an automated test suite verifying tree construction, sibling fan-out, ghost recovery, active path calculation, and ring index calculation.

```bash
npm test
```
Automatically builds the client first, checks that it matches the source, then
runs the Node test runner. Install development dependencies with `npm ci` on a
fresh checkout before running tests (Node 22.19+ or Node 24).

- `test/tree.test.mjs`: 36 assertions covering branch and version-tree behavior.
- `test/client-images.test.mjs`: loads the generated client through its module
  loader, mounts its registered user-message component using React and jsdom,
  and checks image delegation, multiple/image-only messages, old-host fallback,
  text-only messages, and entering/cancelling an edit. Host services and the image
  gallery are test doubles; these are not full DSH integration tests.
- `test/client-registration.test.mjs`: checks module dependencies and visible
  failures when services or registrations are unavailable.
- `test/session-record.test.mjs` and `test/host-compatibility.test.mjs`: cover
  legacy/current session shapes, live/resumed edit requests, retained images,
  retry ancestry, nested version markers, and cache invalidation.

GitHub Actions runs these checks for pull requests and branch pushes, on
Linux (Node 22 and 24) and Windows (Node 22). It also runs:

```bash
npm run check:package
```

This creates a real npm archive in a temporary directory, verifies that runtime
entry points are present and development-only directories are absent, checks
the host entry's syntax, and removes the temporary archive. `npm pack` and
`npm publish` now build the client automatically through `prepack`, preventing
an old or missing generated client from being shipped.

The workflow needs to be pushed to GitHub to run there. Making its checks
mandatory before merging is a separate repository ruleset/branch-protection
setting; adding the workflow alone does not block the Merge button.

Before accepting an image-rendering change, also check it in a running DSH:
send text with one/multiple images and an image-only message, open an image in
the native viewer, enter/cancel an edit, then verify the original attachments
survive an edit submission. CI's gallery double cannot verify native image
loading, lightbox behavior, or compatibility with DSH's module injection.

To add new tests, edit [`test/tree.test.mjs`](file:///D:/dsh-plugin-message-edit/test/tree.test.mjs).

### Optional real DSH acceptance

`test/fixtures/dsh-acceptance.mjs` is an offline model adapter and live/cold
session fixture for an installed official DSH `0.1.2-rc.1` runtime. Mount it
only in a new temporary home whose name contains `message-edit-dsh-qa-`.
Set `DSH_HOME` to that home and `DSH_QA_MODULES` to the official runtime's
`node_modules` directory. Use a separate Web profile with the base/Web bundles,
a built copy of this plugin, and a loader entry for the fixture. Never point
this fixture at an existing user's DSH home.

Once the isolated server prints its URL, run:

```bash
node scripts/verify-dsh-acceptance.mjs http://127.0.0.1:61587
```

The verifier exercises real HTTP edit/retry operations, local model execution,
image retention, unchanged source messages, and nested branch markers. Restart
the same isolated server and repeat to exercise persisted branches. The fixture
adds `/qa/state` and `/qa/followup` endpoints solely for this disposable test.
Browser acceptance additionally checks the settings entry, version switcher,
thumbnails, and native original-image viewer. No remote API key is needed.

---

## 4. Local Installation into DSH Desktop

### Step 1: Build and Package
```bash
npm run build
npm pack
```
This produces a tarball: `dsh-plugin-message-edit-0.1.0.tgz`.

### Step 2: Install into DSH Profile
To install into the DSH Desktop profile:
```bash
dsh plugin --profile desktop add file:/path/to/dsh-plugin-message-edit-0.1.0.tgz
```
Or sync files directly into `~/.dsh/profiles/desktop/node_modules/dsh-plugin-message-edit/`.

### Step 3: Restart DSH Desktop
Restart DSH Desktop to reload the host-side plugin in the server process and mount the updated client interface.
