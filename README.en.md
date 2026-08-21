# dsh-plugin-message-edit

English | [简体中文](README.md)

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.7-4b8dff)](https://github.com/deepseek-ai/deepseek-harness)
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

Restart DSH afterwards — the host half loads with the server. The interface follows DSH's display language (English / 中文).

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

Coexists with [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream) and [dsh-plugin-rollout-scout](https://github.com/SpookySandwich/dsh-plugin-rollout-scout).

## License

MIT © SpookySandwich. Portions of the host half derive from dsh-message-edit (MIT © Moeblack).

