# Architecture Overview

`dsh-plugin-message-edit` provides ChatGPT/Claude-style conversation branching and message editing for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

Because DSH session event logs are append-only without native in-session branching, this plugin splits responsibilities across a **Node.js Host Service** and a **Browser/Web Client**.

---

## 1. System Components

```
┌─────────────────────────────────────────────────────────────┐
│                      DSH Desktop / Web                      │
│                                                             │
│  ┌──────────────────────┐         ┌──────────────────────┐  │
│  │     Client Half      │  HTTP   │      Host Half       │  │
│  │  (plugin.client.js)  │<───────>│    (lib/index.js)    │  │
│  └──────────┬───────────┘         └──────────┬───────────┘  │
│             │                                │              │
│    Shadow User Message              Cordis Services:        │
│    Versions Tab (Graph)             - sessions              │
│    Settings UI                      - agents                │
│                                     - webServer             │
│                                     - sessionPersistence    │
└─────────────────────────────────────────────────────────────┘
```

### 1.1 Host Half (`lib/index.js`)
- Runs in the Node.js backend process via Cordis lifecycle injection.
- Normalizes DSH sessions through `lib/session-record.js`: current live sessions
  expose `snapshotEvents()`, query snapshots carry their header in `session`,
  and older records expose `events` / `header`. Invalid logs fail explicitly.
- DSH 0.1.5 branches use `meta.isSeeded` plus `inheritedEventCount`, which must
  equal the complete constructor seed length. New markers carry their owning
  `sessionId`; old markers without that field use the legacy inherited cut.
  Cold logs use `observeSession(..., { projectionMode: 'none' })` and release
  the observation lease; this restores seeded sessions through the correct API.
- Registers the `/message-tree` HTTP route on `ctx.webServer`.
- Owns branch creation transactions (`POST /message-tree`):
  1. Truncates parent events up to the target turn.
  2. Adds an ignorable `message-tree/version` marker to the constructor seed.
  3. Creates the agent and clears both inherited inbox queues in its setup,
     before publication can schedule the rewound original input.
  4. Flushes the branch and submits the edited prompt exactly once.
- Admits an edited message's attachment set before any of that: `POST /message-tree`
  may carry an ordered `attachments` array. Durable references pass through, a
  staged file receipt resolves against the source Agent
  (`ctx.fileUploads.resolve`), and a newly added image arrives in the composer's
  own wire form and goes through `ctx.attachments.admitPromptContent`. An omitted
  array keeps the original attachments, which is what an older client sends.
  Attachment blocks are rebuilt immediately before the edited text block.
- Owns graph queries (`GET /message-tree?sessionId=...`):
  - Traverses the session family DAG.
  - Recovers deleted/ghost ancestors from surviving descendants' event logs.
  - Extracts turn event boundaries for turn-level rendering.
- Resolves one stored file attachment to its host path (`GET /message-tree/attachment`), passing the session log's own reference through the attachment store, which validates the digest and the display name and refuses anything it did not write.

### 1.2 Client Half (`plugin.client.js`)
- Runs in the browser / renderer process.
- Injects a shadowed `user` message renderer at priority `-1` to add the edit/copy/retry toolbar and `‹ n/m ›` version ring without modifying agent responses, tool calls, or reasoning blocks.
- Because the shadowed row *replaces* the host's bubble, it also owns content rendering: an attachment row above the bubble mirrors the host's `contentParts` layout — image runs go through the host's `conversation.message.images` slot, each `file` block becomes a card built from the platform-seeded `@deepseek-ai/dsh-client-ui-primitives` atoms, and any block type it does not recognize falls back to the host's `JsonBlock` instead of disappearing.
- Its edit box owns the message's attachment set in its own chips (file cards reusing the transcript metrics, 64px image thumbnails, a remove button each, a paperclip and a scoped drop target for additions). The host's own draft rail cannot be rendered from here: `conversation.input.attachments` is declared by the composer's entry, and the slots registry lets exactly one entry declare a child slot, so a second declaration throws. Existing images resolve their URL through the `loadImage` prop the host passes down; picked files upload in the background through the client `fileUpload` service; submit sends the resulting ordered set.
- Transcript file cards are buttons: clicking one asks the host half to resolve the durable reference to its stored host path (`GET /message-tree/attachment`), then hands the sidebar the same `dsh-resource://file/session/<id>/<path>` address the harness builds for its own file cards (`sessionFileAddress`). The right sidebar's document preview — text, code, PDF, images — reads that path through the composed filesystem, which is not confined to the workspace, so an attachment outside the session cwd opens normally.
- Adds the **Versions** tab (`VIEW_ORDER: 16`) providing an interactive pan/zoom graph with spring physics.
- Adds settings options in **Settings → Message Edit** with live layout switching (ChatGPT, DeepSeek, Claude styles).

---

## 2. Durable Storage Model

DSH sessions are immutable append-only logs. When branching:

1. **Seed Inheritance**: Copy the parent prefix before the edited turn, then add the plugin marker. The full constructor seed is inherited on DSH 0.1.5; the kernel adds its own `session/end-seed` afterwards.
2. **Durable Marker**: The seed carries a custom event with explicit child ownership:
   ```json
   {
     "type": "message-tree/version",
     "data": {
       "schemaVersion": 1,
       "sessionId": "child-session-id",
       "effect": {
         "operation": "edit",
         "targetTurn": 1,
         "targetEventSeq": 5,
         "before": "Original message text",
         "after": "Edited message text"
       },
       "inverse": {
         "kind": "restore-version",
         "sessionId": "parent-session-id"
       }
     }
   }
   ```
3. **`ignorable` Flag**: Custom plugin event types fall outside DSH's core schema. The event envelope must set `ignorable: true`; otherwise, DSH's built-in event reader will reject the entire session log.

---

## 3. HTTP API

### `GET /message-tree?sessionId={id}`
Returns the entire conversation family surrounding the requested session.

**Response Schema:**
```json
{
  "sessionId": "current-session-id",
  "versions": [
    {
      "sessionId": "session-a",
      "createdAt": 1724334000000,
      "depth": 0,
      "current": false,
      "onCurrentPath": true,
      "turns": [
        { "turn": 1, "text": "Hello", "time": 1724334001000 },
        { "turn": 2, "text": "Tell me more", "time": 1724334005000 }
      ]
    },
    {
      "sessionId": "session-b",
      "parentSessionId": "session-a",
      "createdAt": 1724334020000,
      "depth": 1,
      "current": true,
      "onCurrentPath": true,
      "operation": "edit",
      "targetTurn": 1,
      "before": "Hello",
      "after": "Hello world",
      "turns": [
        { "turn": 1, "text": "Hello world", "time": 1724334021000 },
        { "turn": 2, "text": "What is next?", "time": 1724334025000 }
      ]
    }
  ]
}
```

### `POST /message-tree`
Performs branch creation or reactivation.

- **`edit`**: Rewinds to before the specified user turn, creates a new branched session, appends a durable `message-tree/version` marker, and submits the replacement prompt.
- **`retry`**: Rewinds to before the target turn, creates a child session, and replays the original user prompt.
- **`activate`**: Unarchives an archived version session via the host registry queue so the client can navigate to it.

---

## 4. Performance & In-Memory Caching

1. **Host-Side Parsed Session Cache (`sessionParsedCache`)**:
   - Parses turn boundaries (`extractTurns`) and version headers once per immutable event sequence.
   - Bounded to 500 entries per plugin context. Live keys use session identity
     and event count; unchanged modern logs do not need a new snapshot.
   - Cold logs are read before comparing their event count. Creation timestamps
     cannot invalidate append-only history and must not be used as revisions.

2. **Client-Side Family SWR Store (`treeStore`)**:
   - Maps every non-deleted branch in a tree to the shared family structure upon fetch.
   - Switching between sibling branches (`‹ n/m ›` or Versions view) is 100% synchronous (0ms lag, zero indicator flicker).
   - Uses monotonic request timestamps to prevent race-condition overwrites from out-of-order responses.
   - Optimistically seeds newly created edit/retry branches before navigation.

---

## 5. Security and Error Resilience

- **Ignorable Event Envelope**: `ignorable: true` ensures foreign event markers do not crash the core DSH log parser.
- **Fail-Safe Mutation Recovery**: Transaction reversals (`child.dispose()`) on failures prevent dangling session artifacts.
- **Memory Bounded Stores**: LRU bounds (500 sessions) prevent unbounded memory growth in long-running processes.

## 6. Naming & Namespaces

- **NPM Package**: `dsh-plugin-message-edit`
- **Cordis Service Name**: `message-tree`
- **HTTP Path**: `/message-tree`
- **Durable Event Type**: `message-tree/version`

> The package uses `dsh-plugin-message-edit` for discovery, but retains `message-tree` in routes, cordis IDs, and event types to prevent collisions with prior third-party plugins (such as `dsh-message-edit`) and ensure seamless side-by-side operation.
