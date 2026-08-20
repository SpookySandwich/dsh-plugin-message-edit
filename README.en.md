# dsh-plugin-message-tree

English | [中文](./README.md)

ChatGPT-style message editing for DeepSeek Harness: hover any prompt you sent, click the pencil, revise, and send — the conversation truly rewinds and branches from that point instead of merely continuing.

- **Edit in place**: hover your message → pencil → revise → Send. The new branch regenerates from the full context before that turn, with your edited prompt.
- **Version switching**: when a message has multiple versions, a `‹ 2/3 ›` control appears under the bubble to flip between them.
- **Versions view**: a new "Versions" tab above the conversation draws the whole branch tree — the current path is highlighted, and clicking any node jumps to it.
- **Durable**: every branch is a real session; version links are written as persistent events and survive restarts. Branches stay off the left session list — 21 edits still look like one conversation. Switch versions with `‹ ›` or the Versions tab.

## Install

Search for `dsh-plugin-message-tree` in the DeepSeek Harness plugin market, or install manually:

```
dsh plugin add dsh-plugin-message-tree
```

Restart DSH after installing (the host half loads with the server).

## How it works

DSH sessions are append-only event logs with no in-session branching. This plugin's host half serves a `/message-tree` endpoint: editing a message creates a new session seeded with every event before the target turn, writes a durable version-marker event, and submits the edited prompt as a fresh message. The client reads those markers back into a full version tree.

The host-side branching logic is partially derived from [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (MIT, © Moeblack), with a redesigned ChatGPT-style interface and version-ring navigation on top.

## Compatibility

- Only the `user` message bubble is shadowed (at priority `-1`); reasoning, tool calls, steering rows, and everything else keep the host renderer. Coexists with plugins like [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream).
- The UI follows DSH's display language (English/Chinese).

## License

MIT © SpookySandwich. Portions of the host half derive from dsh-message-edit (MIT © Moeblack).
