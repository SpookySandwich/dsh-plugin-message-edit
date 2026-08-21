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
Runs the build check and executes `test/tree.test.mjs`.

To add new tests, edit [`test/tree.test.mjs`](file:///D:/dsh-plugin-message-edit/test/tree.test.mjs).

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
