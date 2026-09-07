// dsh-plugin-message-tree — host half.
//
// Owns the /message-tree HTTP route. POST builds a version branch: a new
// session seeded with every event BEFORE the edited turn (true rewind, unlike
// the client-side session fork which cuts after a turn), a durable
// `message-tree/version` marker naming what changed, and the edited prompt
// queued for a fresh answer. GET projects the whole version tree for the
// client's ‹ › rings and tree view.
//
// The branch-transaction shape is derived from dsh-message-edit
// (MIT © Moeblack) — simplified to ChatGPT semantics: user-message edits and
// turn retries only, always truncating downstream.

import { attachParentId, ancestorChainFromLog, collectFamily } from './tree-logic.js';
import { sessionEventCount, sessionRecord, branchSeedOptions } from './session-record.js';

// The package is named dsh-plugin-message-edit, but the route, the cordis id
// and the durable event type below deliberately keep the `message-tree`
// spelling. Moeblack's dsh-message-edit already owns `/message-edit`, the
// cordis id `message-edit` and the event type `message-edit/version`; reusing
// those would collide whenever both plugins are installed. Keeping ours
// distinct also preserves the version links already written into existing
// session logs, which name this type verbatim.
/** Same-origin endpoint owned by this plugin's host half. */
const MESSAGE_TREE_PATH = '/message-tree';
/** Durable version-marker schema. */
const MESSAGE_TREE_SCHEMA = 1;

const name = 'message-tree';
const inject = [
  'sessions',
  'agents',
  'sessionPersistence',
  'sessionQuery',
  'webServer',
  // Used three ways: to flag archived versions in the tree payload (the app
  // cannot navigate to an archived session, so the client unarchives before
  // opening), to unarchive on demand, and to attach a new version to the same
  // sidebar workspace group as its parent. Plain string: cordis uses array
  // inject entries as service names directly.
  'workspaceRegistry',
];

/* ------------------------------------------------------------ log reading -- */

/** Fold complete turn brackets; an open tail is deliberately absent. */
function closedTurns(events) {
  const result = [];
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, startSeq: event.seq };
      continue;
    }
    if (current === undefined) continue;
    if (event.type === 'user/message' && current.user === undefined && event.data.source.kind === 'user') {
      current.user = event;
      continue;
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      result.push({ ...current, endSeq: event.seq });
      current = undefined;
    }
  }
  return result;
}

function userText(message) {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

function cloneUser(message, content = structuredClone(message.content)) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'user' }),
  });
}

function replaceTextBlock(content, blockIndex, text) {
  const block = content[blockIndex];
  if (block?.type !== 'text') throw new Error('所选内容块不是可编辑文本。');
  return content.map((candidate, index) => index === blockIndex ? { ...candidate, text } : structuredClone(candidate));
}

/* ---------------------------------------------------------------- planning -- */

function pairVersionEffect(sourceSessionId, effect) {
  return {
    schemaVersion: MESSAGE_TREE_SCHEMA,
    effect: { ...effect, id: crypto.randomUUID() },
    inverse: { kind: 'restore-version', sessionId: sourceSessionId },
  };
}

/** Edit a user message: rewind to before its turn, queue the edited prompt. */
function editPlan(operation, turns) {
  const turn = turns.find((candidate) => operation.eventSeq > candidate.startSeq && operation.eventSeq < candidate.endSeq);
  if (turn === undefined) throw new Error('所选消息不属于已落定回合。');
  if (turn.user === undefined || turn.user.seq !== operation.eventSeq) throw new Error('所选消息不是用户消息。');
  const before = turn.user.data.content[operation.blockIndex];
  if (before?.type !== 'text') throw new Error('所选用户消息块不是文本。');
  const edited = cloneUser(turn.user.data, replaceTextBlock(turn.user.data.content, operation.blockIndex, operation.text));
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(operation.sessionId, {
      operation: 'edit',
      targetTurn: turn.turn,
      targetEventSeq: turn.user.seq,
      before: before.text,
      after: operation.text,
    }),
    queuedUsers: [edited],
  };
}

/** Regenerate a turn: rewind to before it, queue the original prompt again. */
function retryPlan(sessionId, turnNumber, turns) {
  const turn = turns.find((candidate) => candidate.turn === turnNumber);
  if (turn?.user === undefined) throw new Error('所选回合没有可重放的用户输入。');
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(sessionId, {
      operation: 'retry',
      targetTurn: turn.turn,
      targetEventSeq: turn.user.seq,
      before: userText(turn.user.data),
    }),
    queuedUsers: [cloneUser(turn.user.data)],
  };
}

function planOperation(operation, events) {
  const turns = closedTurns(events);
  switch (operation.action) {
    case 'edit': return editPlan(operation, turns);
    case 'retry': return retryPlan(operation.sessionId, operation.turn, turns);
  }
}

/* -------------------------------------------------------- branch creation -- */

function agentOptions(events, fallback) {
  const config = events.findLast((event) => event.type === 'request/header')?.data.header.config;
  const provider = config?.provider ?? fallback?.provider;
  const model = config?.model ?? fallback?.model;
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    throw new Error('无法从会话历史解析模型路由。');
  }
  const maxTokens = config?.maxTokens ?? fallback?.maxTokens;
  return { provider, model, ...maxTokens === undefined ? {} : { maxTokens } };
}

async function withSourceAgent(ctx, sessionId, operation) {
  let handle;
  let agent = ctx.agents.get(sessionId);
  if (agent === undefined) {
    const snapshot = sessionRecord(await ctx.sessionQuery.readSession(sessionId));
    handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptions(snapshot.events),
    });
    agent = handle.agent;
  }
  try {
    return await agent.runMaintenance(async () => operation(agent));
  } finally {
    await handle?.dispose();
  }
}

function inheritedSeed(source, boundary) {
  if (boundary === -1) return [];
  const boundaryEvent = source.events[boundary];
  if (boundary < 0 || boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
    throw new Error('分支边界不是连续会话事件。');
  }
  return source.events.slice(0, boundary + 1);
}

function versionSeed(source, plan) {
  const events = inheritedSeed(source, plan.boundary);
  const inheritedLength = events.length;
  events.push({
    type: 'message-tree/version',
    seq: events.length,
    time: Date.now(),
    data: plan.version,
    // Plugin event types live outside the harness vocabulary; without this
    // marker the read path refuses to interpret the whole session log.
    ignorable: true,
  });
  return { events, inheritedLength };
}

function sessionPreset(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset;
  }
  return session.header.agentPreset;
}

async function loadSessionRecord(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId);
  return sessionRecord(live ?? await ctx.sessionQuery.readSession(sessionId));
}

function sessionRecordId(session) {
  return session.header?.id ?? session.id;
}

function sessionTargetTurn(session) {
  return ownVersionEvent(session)?.effect.targetTurn;
}

/**
 * Repeated edits of the same message must hang off the original, not off
 * the previous edit. Walk the parent chain and stop at the first session
 * that is not itself a version of `targetTurn`.
 */
async function resolveAttachSession(ctx, sourceSession, targetTurn) {
  const nodes = new Map();
  let session = sourceSession;
  const seen = new Set();
  while (session) {
    const id = sessionRecordId(session);
    if (id === undefined || seen.has(id)) break;
    seen.add(id);
    nodes.set(id, {
      targetTurn: sessionTargetTurn(session),
      parentSessionId: session.header.parentSession,
      session,
    });
    const parentId = session.header.parentSession;
    if (parentId === undefined || nodes.has(parentId)) break;
    session = await loadSessionRecord(ctx, parentId);
  }
  const byId = new Map([...nodes].map(([id, node]) => [id, {
    targetTurn: node.targetTurn,
    parentSessionId: node.parentSessionId,
  }]));
  const attachId = attachParentId(byId, sessionRecordId(sourceSession), targetTurn);
  return nodes.get(attachId)?.session ?? sourceSession;
}

async function createVersionAgent(ctx, source, childId, plan, options) {
  const seed = versionSeed(source, plan);
  const presets = ctx.get('agentPresets');
  const presetId = sessionPreset(source);
  let agentPreset;
  let setup;
  if (presets !== undefined && presetId !== undefined) {
    const resolved = (await presets.resolve(presetId)).id;
    agentPreset = resolved;
    setup = async (agentCtx) => { await presets.mount(agentCtx, resolved); };
  }
  const seedOptions = branchSeedOptions(source, seed.inheritedLength);
  const child = await ctx.agents.create({
    sessionId: childId,
    seed: seed.events,
    ...seedOptions,
    meta: {
      ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
      parentSession: source.id ?? source.header.id,
      ...seedOptions.meta,
      // NOTE: deliberately NOT `origin: 'subagent'`, and deliberately not
      // hidden from the sidebar at all.
      //
      // Two hiding approaches are known-bad:
      //
      //  - `origin: 'subagent'` keeps versions out of the sidebar (the
      //    workspace list filters on `origin !== 'subagent'`), but the API
      //    proxy fences the same field: `hasApiRemoteSubagentOwner` treats
      //    such a session as owned by subagent routing and refuses both
      //    `session.cancel` and model selection with
      //      agent-busy: session "..." is owned by subagent routing
      //    so every edited or retried message became impossible to stop.
      //    The schema accepts no third `origin` value to hide behind.
      //
      //  - Archiving the child (`workspaceRegistry.archiveSession`) hides it
      //    without fencing it, but the app cannot NAVIGATE to an archived
      //    session: opening one bounces to the workspace picker, so edit,
      //    retry and version switching all dead-ended on the home screen.
      //
      // Versions therefore appear in the sidebar as ordinary sessions. That
      // is cosmetic; stopping, model switching and navigation all work.
      ...agentPreset === undefined ? {} : { agentPreset },
    },
    agentOptions: options,
    ...setup === undefined ? {} : { setup },
  });
  try {
    await ctx.sessions.flush(child.agent.session);
    return child;
  } catch (error) {
    await child.dispose();
    throw error;
  }
}

async function recoverOperation(inverses) {
  const failures = [];
  for (const inverse of inverses.reverse()) {
    try {
      await inverse();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, '版本操作恢复失败。');
}

/**
 * Stop a still-running turn on `sessionId` so an edit can fork away from it.
 *
 * Two reasons this is needed. Editing forks from the source session but does
 * not stop it, so the superseded turn keeps streaming and keeps spending
 * tokens. And `runMaintenance` throws outright unless the agent is idle, which
 * is why editing was blocked while a turn was live at all.
 *
 * Cancelling the parent is also what stops its subagents: a subagent session is
 * fenced from the ordinary cancel path ("owned by subagent routing"), but the
 * subtree is owned by the parent's fiber and unwinds with it.
 *
 * `cancel` only signals the abort; `whenIdle` waits for the phase to actually
 * settle, without which the `runMaintenance` that follows can still throw.
 */
async function stopRunningTurn(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId);
  if (agent === undefined) return false;
  try {
    agent.cancel({ kind: 'user' });
    await agent.whenIdle();
    return true;
  } catch (error) {
    // An agent that was already finishing is not an error for our purposes:
    // the goal is only that it is no longer running.
    return false;
  }
}

/** Archived session ids, as a Set; empty when the registry cannot say. */
function archivedSessionIdSet(ctx) {
  try {
    const ids = ctx.get('workspaceRegistry')?.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids : []);
  } catch (error) {
    return new Set();
  }
}

/**
 * Unarchive one session so the app can navigate to it.
 *
 * The app cannot open an archived session — it bounces to the workspace
 * picker — and archiving versions to declutter the sidebar is a natural thing
 * to do, so paging the ring onto one must unarchive it first. This dsh build
 * has no unarchive API anywhere (the registry's archiveSession only adds), so
 * this mirrors archiveSession's own state discipline: same operation queue,
 * same durable state write. The API proxy watches this state and broadcasts
 * host/archived-sessions-changed, so the sidebar updates live.
 */
async function activateVersion(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined) throw new Error('workspaceRegistry 不可用，无法取消归档。');
  if (!registry.archivedSessionIds.includes(sessionId)) return { unarchived: false };
  if (typeof registry.enqueueOperation !== 'function'
    || typeof registry.requireState !== 'function'
    || typeof registry.setState !== 'function') {
    throw new Error('此 dsh 版本未提供取消归档的途径。');
  }
  await registry.enqueueOperation(async () => {
    const state = registry.requireState();
    if (!state.archivedSessionIds.includes(sessionId)) return;
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    });
  });
  return { unarchived: true };
}

/**
 * Keep a version in the same sidebar workspace group as its tree parent.
 * Versions inherit the parent's cwd but were never attached to its workspace,
 * so they showed up as stray ungrouped rows. Failure is cosmetic — the
 * version works either way — so it never fails the edit.
 */
async function attachToParentWorkspace(ctx, parentId, childId) {
  try {
    const registry = ctx.get('workspaceRegistry');
    const workspace = registry?.list().find((w) => w.sessionIds.includes(parentId));
    if (workspace !== undefined) await workspace.attachSession(childId);
  } catch (error) {}
}

/** All message-tree/version events of one session's full log, in seq order. */
async function versionMarkers(ctx, sessionId) {
  const { events } = await loadSessionRecord(ctx, sessionId);
  return events.filter((event) => event.type === 'message-tree/version');
}

/**
 * Assemble one conversation family, bridging sessions the user has deleted.
 *
 * dsh's traceSession stops at the first missing parent, so deleting one
 * version used to fragment the family: siblings of a deleted original lost
 * their ‹k/N› counters entirely, and everything below a deleted chain link
 * vanished from the Versions tree. But every version's seed inherits its
 * ancestors' `message-tree/version` markers, so a deleted ancestor's identity,
 * parent and target turn all survive in its descendants' logs. This walks
 * surviving headers where possible and recovers the rest from those markers,
 * emitting ghost entries for the deleted sessions so the tree stays whole.
 *
 * Families never span working directories (a version inherits its source's
 * cwd), so orphan logs outside the target's cwd are never read.
 *
 * @returns { rootId, flat: [{ entry, depth }], recordsById } where each entry
 *   is { id, parentId?, createdAt, ghost, marker? }.
 */
async function assembleFamily(ctx, sessionId) {
  const records = await ctx.sessionQuery.listSessions();
  const recordsById = new Map(records.map((record) => [record.header.id, record]));
  const target = recordsById.get(sessionId);
  if (target === undefined) throw new Error(`session "${sessionId}" not found`);

  const ghostInfo = new Map();
  const absorbChain = (chain) => {
    for (let i = 0; i < chain.length; i++) {
      const link = chain[i];
      if (recordsById.has(link.sessionId)) continue;
      const info = ghostInfo.get(link.sessionId) ?? {};
      if (link.marker !== undefined) info.marker = link.marker;
      if (i + 1 < chain.length) info.parentId = chain[i + 1].sessionId;
      ghostInfo.set(link.sessionId, info);
    }
  };

  // The target's root: surviving headers first, the log bridge at a hole.
  let rootId;
  {
    const seen = new Set();
    let cursor = target.header;
    while (cursor.parentSession !== undefined && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent = recordsById.get(cursor.parentSession);
      if (parent === undefined) break;
      cursor = parent.header;
    }
    rootId = cursor.id;
    if (cursor.parentSession !== undefined) {
      const chain = ancestorChainFromLog(cursor.parentSession, await versionMarkers(ctx, cursor.id));
      absorbChain(chain);
      if (chain.length > 0) rootId = chain[chain.length - 1].sessionId;
    }
  }

  // Other orphans in the same cwd may belong to this family through their own
  // holes; each orphan's log names its full ancestry, connecting it or ruling
  // it out. Orphans are rare (they only exist where something was deleted),
  // so the full-log reads here are few.
  for (const record of records) {
    const parentId = record.header.parentSession;
    if (parentId === undefined || recordsById.has(parentId)) continue;
    if (record.header.cwd !== target.header.cwd) continue;
    if (record.header.id === sessionId) continue;
    try {
      absorbChain(ancestorChainFromLog(parentId, await versionMarkers(ctx, record.header.id)));
    } catch (error) {
      // An unreadable orphan stays an island; the family is still assembled.
    }
  }

  const entries = [];
  for (const record of records) {
    if (record.header.cwd !== target.header.cwd && record.header.id !== sessionId) continue;
    entries.push({
      id: record.header.id,
      ...record.header.parentSession === undefined ? {} : { parentId: record.header.parentSession },
      createdAt: record.header.createdAt,
      ghost: false,
    });
  }
  for (const [id, info] of ghostInfo) {
    entries.push({
      id,
      ...info.parentId === undefined ? {} : { parentId: info.parentId },
      createdAt: info.marker?.time ?? 0,
      ghost: true,
      ...info.marker === undefined ? {} : { marker: info.marker },
    });
  }
  return { rootId, flat: collectFamily(rootId, entries), recordsById };
}

/**
 * Every surviving session in this conversation's version family — the root
 * and all descendants, bridged across deleted members, ghosts excluded.
 */
async function familySessionIds(ctx, sessionId) {
  const { flat } = await assembleFamily(ctx, sessionId);
  const ids = new Set([sessionId]);
  for (const { entry } of flat) {
    if (!entry.ghost) ids.add(entry.id);
  }
  return [...ids];
}

/**
 * Stop every still-running turn in this conversation's family before branching.
 *
 * Editing must stop the reply it supersedes — that is what every chat UI does,
 * and leaving it running silently spends tokens on an answer nobody will read.
 * It is not enough to cancel only the session being edited: versions are
 * separate sessions, so a sibling branch started earlier can still be
 * streaming while you edit a different one. Those are exactly the runs that are
 * hard to notice and hard to stop by hand.
 *
 * Falls back to the source session alone if the family cannot be traced, so a
 * lookup failure still stops the obvious one rather than nothing.
 */
async function stopFamilyTurns(ctx, sessionId) {
  let ids;
  try {
    ids = await familySessionIds(ctx, sessionId);
  } catch (error) {
    ids = [sessionId];
  }
  let stopped = 0;
  for (const id of ids) {
    if (await stopRunningTurn(ctx, id)) stopped += 1;
  }
  return stopped;
}

async function runOperation(ctx, operation) {
  const sourceId = sessionIdOf(operation.sessionId);
  if (operation.stopPrevious === true) await stopFamilyTurns(ctx, sourceId);
  return withSourceAgent(ctx, sourceId, async (source) => {
    const childId = sessionIdOf(`session-${crypto.randomUUID()}`);
    const inverses = [];
    try {
      const record = sessionRecord(source.session);
      const events = record.events;
      const plan = planOperation(operation, events);
      const options = agentOptions(events, source.options);
      const attach = await resolveAttachSession(ctx, record, plan.version.effect.targetTurn);
      if (sessionRecordId(attach) !== record.id) {
        const turn = closedTurns(attach.events).find((candidate) => candidate.turn === plan.version.effect.targetTurn);
        if (turn === undefined) throw new Error('无法在父会话上定位同一回合。');
        plan.boundary = turn.startSeq - 1;
        plan.version.inverse.sessionId = sessionRecordId(attach);
      }
      const child = await createVersionAgent(ctx, attach, childId, plan, options);
      inverses.push(() => child.dispose());
      for (const message of plan.queuedUsers) child.agent.followup(message);
      inverses.length = 0;
      await attachToParentWorkspace(ctx, sessionRecordId(attach), childId);
      return { sessionId: childId, queuedTurns: plan.queuedUsers.length };
    } catch (error) {
      try {
        await recoverOperation(inverses);
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], '版本操作及其恢复均失败。');
      }
      throw error;
    }
  });
}

/* ------------------------------------------------------- tree projection -- */

function ownVersionEvent({ header, events, inheritedEventCount: inherited }) {
  const ownEvents = events.filter((event) => event.type === 'message-tree/version' && event.seq >= inherited);
  if (ownEvents.length === 0) return undefined;
  const event = ownEvents[0];
  const version = event.data;
  const parent = header.parentSession;
  if (version.schemaVersion !== MESSAGE_TREE_SCHEMA) throw new Error(`会话 ${header.id} 使用不支持的版本效果结构。`);
  if (version.inverse.kind !== 'restore-version' || parent === undefined || version.inverse.sessionId !== parent) {
    throw new Error(`会话 ${header.id} 的版本效果与逆不匹配。`);
  }
  return { effect: version.effect, time: event.time };
}

const TREE_READ_CONCURRENCY = 4;
async function mapConcurrent(items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };
  const workers = Math.min(TREE_READ_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

/** Extract all user turns from a session's event stream. */
function extractTurns(events) {
  if (!Array.isArray(events)) return [];
  const result = [];
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, startSeq: event.seq, time: event.time };
      continue;
    }
    if (current === undefined) continue;
    if (event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') {
      current.user = event;
      current.text = userText(event.data);
      current.time = event.time ?? current.time;
      continue;
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      result.push({ turn: current.turn, text: current.text ?? '', time: current.time ?? event.time });
      current = undefined;
    }
  }
  if (current && current.user) {
    result.push({ turn: current.turn, text: current.text ?? '', time: current.time ?? Date.now() });
  }
  return result;
}

const SESSION_CACHE_MAX = 500;
const sessionParsedCaches = new WeakMap();

async function sessionParsedData(ctx, record) {
  if (!record || !record.header) return { turns: [], effect: undefined, time: undefined };
  const id = record.header.id;
  let sessionParsedCache = sessionParsedCaches.get(ctx);
  if (!sessionParsedCache) sessionParsedCaches.set(ctx, sessionParsedCache = new Map());
  const live = ctx.sessions.get(id);
  // Header creation timestamps never change when a cold log grows. Read a
  // cold snapshot before caching by length; live logs expose a cheap count.
  const snapshot = live === undefined ? await loadSessionRecord(ctx, id) : undefined;
  const key = live === undefined ? snapshot.events.length : sessionEventCount(live);
  const cached = sessionParsedCache.get(id);
  if (cached !== undefined && cached.key === key && cached.live?.deref() === live) {
    return cached;
  }

  const source = snapshot ?? sessionRecord(live);
  const events = source.events;
  const turns = extractTurns(events);
  let effect;
  let time;
  try {
    const version = ownVersionEvent(source);
    effect = version?.effect;
    time = version?.time;
  } catch (error) {
    effect = undefined;
  }

  // Cache identity without keeping a disposed session's entire log alive.
  const entry = { key, live: live === undefined ? undefined : new WeakRef(live), turns, effect, time };
  if (sessionParsedCache.size >= SESSION_CACHE_MAX) {
    const firstKey = sessionParsedCache.keys().next().value;
    sessionParsedCache.delete(firstKey);
  }
  sessionParsedCache.set(id, entry);
  return entry;
}

async function tree(ctx, sessionId) {
  const { flat, recordsById } = await assembleFamily(ctx, sessionId);
  const archived = archivedSessionIdSet(ctx);
  const parsedLogs = await mapConcurrent(flat, async ({ entry }) => {
    if (entry.ghost) return null;
    const record = recordsById.get(entry.id);
    return record === undefined ? null : sessionParsedData(ctx, record);
  });
  const parentOf = new Map(flat.map(({ entry }) => [entry.id, entry.parentId]));
  const currentPath = new Set();
  let pathId = sessionId;
  while (pathId !== undefined && !currentPath.has(pathId)) {
    currentPath.add(pathId);
    pathId = parentOf.get(pathId);
  }
  const versions = flat.map(({ entry, depth }, index) => {
    let effect;
    let time;
    let turns = [];
    if (entry.ghost) {
      effect = entry.marker?.data?.effect;
      time = entry.marker?.time;
    } else {
      const parsed = parsedLogs[index];
      turns = parsed?.turns ?? [];
      effect = parsed?.effect;
      time = parsed?.time;
    }
    const record = entry.ghost ? undefined : recordsById.get(entry.id);
    return {
      sessionId: entry.id,
      ...entry.parentId === undefined ? {} : { parentSessionId: entry.parentId },
      createdAt: time ?? record?.header.createdAt ?? entry.createdAt,
      depth,
      current: entry.id === sessionId,
      onCurrentPath: currentPath.has(entry.id),
      ...entry.ghost ? { deleted: true } : {},
      ...archived.has(entry.id) ? { archived: true } : {},
      ...effect === undefined ? {} : {
        operation: effect.operation,
        targetTurn: effect.targetTurn,
        targetEventSeq: effect.targetEventSeq,
        ...effect.before === undefined ? {} : { before: effect.before },
        ...effect.after === undefined ? {} : { after: effect.after },
      },
      turns,
    };
  });
  return { sessionId, versions };
}

/* --------------------------------------------------------- HTTP plumbing -- */

function objectValue(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('请求体必须是 JSON 对象。');
  return value;
}

function sessionIdOf(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('sessionId 必须是非空字符串。');
  return value;
}

function integerOf(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} 必须是非负安全整数。`);
  return value;
}

function decodeOperation(value) {
  const record = objectValue(value);
  const sessionId = sessionIdOf(record['sessionId']);
  switch (record['action']) {
    case 'edit':
      if (typeof record['text'] !== 'string' || record['text'].trim().length === 0) throw new TypeError('text 必须是非空字符串。');
      return {
        action: 'edit',
        sessionId,
        eventSeq: integerOf(record['eventSeq'], 'eventSeq'),
        blockIndex: integerOf(record['blockIndex'], 'blockIndex'),
        text: record['text'],
        stopPrevious: record['stopPrevious'] === true,
      };
    case 'retry':
      return {
        action: 'retry',
        sessionId,
        turn: integerOf(record['turn'], 'turn'),
        stopPrevious: record['stopPrevious'] === true,
      };
    default:
      throw new TypeError('action 必须是 edit 或 retry。');
  }
}

function requestJson(request) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    request.on('data', (chunk) => {
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    });
    request.on('end', () => {
      try {
        text += decoder.decode();
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function respondJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function handleRoute(ctx, request, response) {
  try {
    if (request.method === 'GET') {
      const url = new URL(request.url ?? MESSAGE_TREE_PATH, 'http://message-tree.local');
      respondJson(response, 200, await tree(ctx, sessionIdOf(url.searchParams.get('sessionId'))));
      return;
    }
    if (request.method === 'POST') {
      const body = await requestJson(request);
      // activate = make an archived version navigable again. Kept apart from
      // decodeOperation: it creates nothing, it only clears the archive flag.
      if (body !== null && typeof body === 'object' && body.action === 'activate') {
        respondJson(response, 200, await activateVersion(ctx, sessionIdOf(body.sessionId)));
        return;
      }
      respondJson(response, 200, await runOperation(ctx, decodeOperation(body)));
      return;
    }
    response.writeHead(405);
    response.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respondJson(response, error instanceof TypeError ? 400 : 409, { error: message });
  }
}

function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MESSAGE_TREE_PATH,
    handler: (request, response) => handleRoute(ctx, request, response),
  }), 'message-tree: HTTP route');
}

export { MESSAGE_TREE_PATH, MESSAGE_TREE_SCHEMA, apply, inject, name };
