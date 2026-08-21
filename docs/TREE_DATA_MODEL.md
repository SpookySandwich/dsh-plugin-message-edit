# Tree Data Model & Algorithms

This document details how conversation versions and turns are represented, branched, and visualized in `dsh-plugin-message-edit`.

---

## 1. Dual-Level Representation

There are two distinct levels of data representation in the system:

1. **Storage Level (Session DAG)**:
   - DSH enforces session-level isolation. Each branch is a distinct DSH session record with `parentSession` and `seedLength`.
   - The host maintains durable `message-tree/version` markers detailing which turn was edited/retried and what changed.

2. **Presentation Level (Turn-Level Branching Tree)**:
   - A user thinks of conversation branching at the **message/turn** level, not the session container level.
   - `buildTurnTree` projects the session versions into individual turn nodes.

```
Session DAG (Storage):
Session A (Original)  ──[edit turn 1]──>  Session B (Fork)

Turn Tree (Visualization):
               [Root Conversation]
                 /             \
        [A: Turn 1 (1/2)]    [B: Turn 1 (2/2) - Edited]
               |                    |
        [A: Turn 2]          [B: Turn 2]
```

---

## 2. Core Algorithms

### 2.1 Turn Tree Construction (`buildTurnTree`)
*Location: [`lib/tree-logic.js`](file:///D:/dsh-plugin-message-edit/lib/tree-logic.js#L173), [`plugin.client.js`](file:///D:/dsh-plugin-message-edit/plugin.client.js#L415)*

Transforms `versions` into an array of turn nodes:
1. **Root Conversation Node (`${rootSessionId}#root`)**: Represents the origin anchor of the conversation.
2. **Root Session Turns**:
   - Turn 1 hangs off `${rootSessionId}#root`.
   - Turn $k$ ($k > 1$) hangs off `${rootSessionId}#t${k-1}`.
3. **Forked Session Turns**:
   - For a session branched at `targetTurn = T`:
     - If $T = 1$: Turn 1 hangs off `${rootSessionId}#root` (sibling of the original Turn 1).
     - If $T > 1$: Turn $T$ hangs off `${parentSessionId}#t${T-1}` (sibling of parent's Turn $T$).
     - Subsequent turns $T+1, T+2, \dots$ hang off the previous turn in the same session (`${sessionId}#t${k-1}`).
4. **Safety Fallback**: Any node whose computed `parentId` does not exist in the graph is automatically attached to `${rootSessionId}#root`, preventing disconnected subtrees.

### 2.2 Sibling Fan-Out (`attachParentId`)
*Location: [`lib/tree-logic.js`](file:///D:/dsh-plugin-message-edit/lib/tree-logic.js#L9)*

When a user edits Turn 1 repeatedly (e.g. Turn 1 $\rightarrow$ Edit 1 $\rightarrow$ Edit 2 while viewing Edit 1):
- Without fan-out, edits form a chain: $A \rightarrow B \rightarrow C$.
- `attachParentId` traverses up versions of the same turn and stops at the first session that is *not* an edit of that turn ($A$).
- Result: Both Edit 1 and Edit 2 hang off $A$ as sibling branches.

### 2.3 Ghost Ancestor Recovery (`ancestorChainFromLog` & `collectFamily`)
*Location: [`lib/tree-logic.js`](file:///D:/dsh-plugin-message-edit/lib/tree-logic.js#L110-L171)*

If an intermediate session in a family is deleted by the user in DSH:
- The deleted session's own event log is gone.
- However, its descendant sessions inherited its prefix log (including the `message-tree/version` marker describing the deleted parent).
- `ancestorChainFromLog` inspects the surviving descendant's seed events to reconstruct deleted ancestors as **ghost nodes** (`deleted: true`).
- `collectFamily` ensures the family graph remains fully connected even when intermediate nodes are deleted.

### 2.4 Active Path Calculation
*Location: [`lib/tree-logic.js`](file:///D:/dsh-plugin-message-edit/lib/tree-logic.js#L318-L339)*

To highlight only the active branch path without highlighting superseded sibling branches:
1. Locate the latest turn node in `currentSessionId`.
2. Walk upwards following `parentId` pointers until reaching `${rootSessionId}#root`.
3. Mark only nodes on this walk with `onCurrentPath = true`.

### 2.5 Bubble Version Ring (`ringFor`)
*Location: [`lib/tree-logic.js`](file:///D:/dsh-plugin-message-edit/lib/tree-logic.js#L30-L68)*

Calculates the `‹ n/m ›` counter under a message at `turn` while viewing `sessionId`:
- Walks parent links to find the common fork point for that turn.
- Filters out deleted/ghost sessions (renumbering over surviving versions).
- Returns `{ alternatives, index }`. If fewer than 2 alternatives exist, returns `null` (counter is hidden).

---

## 3. Graph Layout & Springs

*Location: [`plugin.client.js`](file:///D:/dsh-plugin-message-edit/plugin.client.js#L567-L612)*

- **Tidy Tree Layout (`layoutTurnTree`)**:
  - Leaf nodes take successive horizontal slots (`cursor * SLOT_X`, where `SLOT_X = 206px`).
  - Parent nodes center horizontally over their children (`(min_x + max_x) / 2`).
  - Depths scale vertically (`depth * SLOT_Y`, where `SLOT_Y = 132px`).
- **Spring Physics (`springs.current`)**:
  - Cards smoothly animate to their target coordinates using critically-damped spring equations ($k = 190, c = 24$).
  - New cards spawn at their parent's coordinates and spring outward.
  - Edges are rendered as cubic SVG bezier curves connecting parent card bottoms to child card tops.
