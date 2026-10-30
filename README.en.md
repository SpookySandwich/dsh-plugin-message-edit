# dsh-plugin-message-edit

English | [简体中文](README.md)

[![npm](https://img.shields.io/npm/v/dsh-plugin-message-edit?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-plugin-message-edit)
[![CI](https://github.com/SpookySandwich/dsh-plugin-message-edit/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/SpookySandwich/dsh-plugin-message-edit/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.5-4b8dff)](https://github.com/deepseek-ai/deepseek-harness)
[![stars](https://img.shields.io/github/stars/SpookySandwich/dsh-plugin-message-edit?style=flat&label=stars)](https://github.com/SpookySandwich/dsh-plugin-message-edit/stargazers)

Edit a message you already sent and the conversation **rewinds and branches** from that point, the way ChatGPT, Claude and DeepSeek all do it. The old version is not overwritten — a `‹ 2/4 ›` counter appears under the bubble, and a Versions tab draws the whole tree.

![demo](https://raw.githubusercontent.com/SpookySandwich/dsh-plugin-message-edit/master/assets/demo.gif)

## Version Tree Visualization

No matter how deeply conversations diverge or how many times prompts are edited, the **Versions** tab projects a clear, turn-level branching hierarchy with real-time active path highlights and instant navigation:

![Version Tree](https://raw.githubusercontent.com/SpookySandwich/dsh-plugin-message-edit/master/assets/tree-demo.png)

## What it does

- **Edit and branch.** Revise a past prompt and send: a new branch regenerates from the full context *before* that turn. This is a true rewind, not a fork that continues from the end.
- **Version counter.** When a message has alternatives, `‹ n/m ›` appears beneath it. The arrows move between them instantaneously.
- **Version tree.** A **Versions** tab lays the branches out as a graph you can pan, zoom and drag. The current path is highlighted; click any node to jump to that conversation.
- **Zero-flicker instant switching.** Family-aware SWR client caching enables 0ms version switching and graph navigation without indicator flicker or loading delays.
- **In-memory host caching.** Parsed turns and version metadata are cached in host memory, eliminating redundant disk I/O and JSON parsing for deep branching trees.
- **Automatic cancellation.** Branching immediately cancels any still-streaming obsolete sibling turns across the conversation family to save tokens and compute.
- **Retry.** Re-run a turn without editing it (Claude layout).
- **Copy.** Put the message text on the clipboard.
- **Durable.** Every branch is a real persisted session, and version links are stored as durable events so the tree survives restarts. New branches automatically group into the parent session's workspace.

## Interface style

The three interfaces this imitates differ in **where the controls sit and which ones exist**, so the preset changes exactly that — never the colours, which stay native to DSH. Pick one under **Settings → Message Tree**; the panel previews it live.

| Preset | Controls under the bubble | Shown | Editor buttons |
| --- | --- | --- | --- |
| **ChatGPT** | edit, copy | on hover | `Cancel` / `Send` **inside** the box |
| **DeepSeek** | edit, copy | always — like DSH itself | `Cancel` / `Send` **inside** the box |
| **Claude** | **retry**, edit, copy | on hover | `Cancel` / `Save` **below** the box |

Only Claude offers retry on a user message, matching the real interface. There is no share button, because DSH has none.

## Install

```bash
dsh plugin --profile web add dsh-plugin-message-edit
```

Restart DSH afterwards — the host half loads with the server. The interface follows DSH's display language (English / 中文 / Русский). Russian is available in the language selector; untranslated host UI falls back to English.

## How it works

DSH sessions are append-only event logs with no in-session branching, so a rewind has to be built:

- The host half serves `/message-tree`. Editing a message creates a **new session seeded with every event before the target turn**, writes a durable `message-tree/version` marker naming what changed, and submits the edited prompt.
- Those markers are read back to reconstruct the tree, the `‹ n/m ›` ring, and which branch you are currently on.
- The marker is written with the envelope's `ignorable` flag. Plugin event types live outside the harness vocabulary, and without that flag the reader refuses to interpret the whole log — the session simply fails to open.
- Only the plain `user` message node is shadowed, at priority `-1`. Reasoning, tool calls and steering rows keep the host renderer.

The host-side branching logic derives from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT © Moeblack), reworked for ChatGPT-style rewind semantics, sibling fan-out, and the interface presets above.

The names are similar, so to be explicit: this is a separate plugin. Its route, cordis id and durable event type keep a distinct `message-tree` spelling precisely so both can be installed side by side without colliding.

## Documentation

For technical details and developer guides, see:
- [Architecture Overview](docs/ARCHITECTURE.md): Host/client architecture, Cordis lifecycle injection, durable event storage, and HTTP API.
- [Tree Data Model & Algorithms](docs/TREE_DATA_MODEL.md): Turn-level message tree projection, sibling fan-out, ghost recovery, and active path calculation.
- [Development & Testing Guide](docs/DEVELOPMENT.md): Build pipeline, automated test suite, and local installation instructions.

## Compatibility

Version `1.5.0` (current source): Support official DSH `0.2.1-rc.5` while retaining `0.2.0-rc.2` and `0.2.1-rc.2` compatibility. Declared host compatibility ranges (`peerDependencies` and `engines.dsh`) explicitly include `0.2.1-rc.5` (`>=0.2.0-rc.2 <0.3.0-0 || 0.2.1-rc.2 || 0.2.1-rc.5`). Verified on official `0.2.0-rc.2`, `0.2.1-rc.2`, and `0.2.1-rc.5` runtimes for fresh and restart acceptance, user message edits with retained images, version navigation, retry branching, and 400px More-menu navigation.

Version `1.4.1`: Override `@deepseek-ai/dsh-mcp-client` to `@modelcontextprotocol/client` `2.3.0` (with `@modelcontextprotocol/core` `2.3.0`) in this repository's checkout lockfile to cover [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) (`CVE-2026-104850`, fixed in `2.2.0`) and [GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) (`CVE-2026-111769`, custom-header/body cross-origin redirect disclosure, fixed in `2.3.0`; Node HTTP transports in `2.3.0` follow same-origin redirects only and require the final URL for cross-origin MCP endpoints). This hardens development/test checkouts of this repository only; npm ignores dependency `overrides` and does not ship `package-lock.json`, so installing the plugin does not modify an existing user's DSH host.

Version `1.4.0`: Add a Russian (`ru` / `Русский`) client locale covering all 37 UI and image strings and register `Русский` in the DSH host language selector (with English fallback for untranslated host UI; if no explicit DSH language preference is stored and browser language preferences list Russian before Chinese, auto-detection selects Russian and falls back untranslated host UI to English; a preloaded `ru` language pack is respected, whereas a separate `ru` pack loaded after this plugin would collide on duplicate registration).

Version `1.3.1`: Render user message images through the host `conversation.chat.user.content` factory (preserving the native gallery and lightbox) when the legacy `renderMessageImages` callback is absent, with an async `loadImage` / `loadImage.peek` thumbnail fallback.

Version `1.3.0`: Admit official dsh `0.2.1-rc.2` in declared compatibility ranges and verify live/persisted edits and retries on official `0.2.0-rc.2` and `0.2.1-rc.2` runtimes.

Version `1.2.1`: Fix DSH 0.2 client activation and route edits, retries, and version switching through `uiWorkspace.openSession`.

Version `1.2.0`: Unarchive a version through `workspaceRegistry.unarchiveSession` on official dsh `0.2.0-rc.2`.

Version `1.1.0`: Fix seeded edit/retry creation, clear inherited pending input before publication, identify version markers by session ownership, preserve reasoning effort, and read persisted branches through disposable session observations.

The declared host range is `>=0.2.0-rc.2 <0.3.0-0 || 0.2.1-rc.2 || 0.2.1-rc.5`; official dsh `0.2.0-rc.2`, `0.2.1-rc.2`, and `0.2.1-rc.5` satisfy it. Keep the previous plugin release on older DSH. [Validation record](.github/reviews/dsh-0.2.1-rc.5.md).

Install published versions from [npm](https://www.npmjs.com/package/dsh-plugin-message-edit). To test the current source, run `npm ci` and `npm pack`, then `dsh plugin --profile desktop add ./dsh-plugin-message-edit-1.5.0.tgz`. See the [release procedure](.github/RELEASING.md) for publication checks.

Version `1.1.0` has been verified in an isolated DSH `0.1.5-rc.2` Web environment:
plugin loading, images, edit/retry, nested branches, and restored sessions. Model
responses use a local test adapter; remote model services were not exercised.

The compatibility layer retains the older `events` / `seedLength` interfaces,
covered by automated tests. This release targets official dsh `0.2.1-rc.5`.
Restart DSH after updating the plugin.

Coexists with [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream) and [dsh-plugin-rollout-scout](https://github.com/SpookySandwich/dsh-plugin-rollout-scout).

## License

MIT © SpookySandwich. Portions of the host half derive from dsh-message-edit (MIT © Moeblack).
