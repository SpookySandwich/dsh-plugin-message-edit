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

import { attachParentId } from './tree-logic.js';

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
  'workspaceRegistry',
  'webServer',
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
    const snapshot = await ctx.sessionQuery.readSession(sessionId);
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
  if (live !== undefined) return live;
  return ctx.sessionQuery.readSession(sessionId);
}

function sessionRecordId(session) {
  return session.header?.id ?? session.id;
}

function sessionTargetTurn(session) {
  try {
    return ownVersionEvent(session.header, session.events)?.effect.targetTurn;
  } catch (error) {
    return undefined;
  }
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
  const child = await ctx.agents.create({
    sessionId: childId,
    seed: seed.events,
    meta: {
      ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
      parentSession: source.id ?? source.header.id,
      seedLength: seed.inheritedLength,
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

function sourceWorkspace(ctx, sessionId) {
  return ctx.workspaceRegistry.list().find((workspace) => workspace.sessionIds.includes(sessionId));
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

async function runOperation(ctx, operation) {
  const sourceId = sessionIdOf(operation.sessionId);
  return withSourceAgent(ctx, sourceId, async (source) => {
    const childId = sessionIdOf(`session-${crypto.randomUUID()}`);
    const inverses = [];
    try {
      const events = source.session.events;
      const plan = planOperation(operation, events);
      const options = agentOptions(events, source.options);
      const attach = await resolveAttachSession(ctx, source.session, plan.version.effect.targetTurn);
      if (sessionRecordId(attach) !== sessionRecordId(source.session)) {
        const turn = closedTurns(attach.events).find((candidate) => candidate.turn === plan.version.effect.targetTurn);
        if (turn === undefined) throw new Error('无法在父会话上定位同一回合。');
        plan.boundary = turn.startSeq - 1;
        plan.version.inverse.sessionId = sessionRecordId(attach);
      }
      const child = await createVersionAgent(ctx, attach, childId, plan, options);
      inverses.push(() => child.dispose());
      const workspace = sourceWorkspace(ctx, sourceId);
      if (workspace !== undefined) {
        await workspace.attachSession(childId);
        inverses.push(() => workspace.detachSession(childId));
      }
      for (const message of plan.queuedUsers) child.agent.followup(message);
      inverses.length = 0;
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

function ownVersionEvent(header, events) {
  const inherited = header.seedLength ?? 0;
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

function flattenLineage(root, descendants) {
  const result = [{ record: root, depth: 0 }];
  const visit = (nodes, depth) => {
    const ordered = [...nodes].sort((left, right) =>
      left.session.header.createdAt - right.session.header.createdAt
      || String(left.session.header.id).localeCompare(String(right.session.header.id)));
    for (const node of ordered) {
      result.push({ record: node.session, depth });
      visit(node.descendants, depth + 1);
    }
  };
  visit(descendants, 1);
  return result;
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

/** Own-version scan window: the tail beyond the durable seed boundary. */
async function versionLog(ctx, record) {
  const inherited = record.header.seedLength ?? 0;
  const live = ctx.sessions.get(record.header.id);
  if (live !== undefined) return live.events.slice(inherited);
  const persistence = ctx.get('sessionPersistence');
  if (persistence !== undefined) return (await persistence.readFrom(record.header.id, inherited)).events;
  return (await ctx.sessionQuery.readSession(record.header.id)).events.slice(inherited);
}

async function tree(ctx, sessionId) {
  const targetTrace = await ctx.sessionQuery.traceSession(sessionId);
  const rootId = targetTrace.complete
    ? targetTrace.root.header.id
    : targetTrace.ancestors.at(-1)?.header.id ?? sessionId;
  const rootTrace = rootId === sessionId ? targetTrace : await ctx.sessionQuery.traceSession(rootId);
  const lineage = flattenLineage(rootTrace.target, rootTrace.descendants);
  const logs = await mapConcurrent(lineage, async ({ record }) => {
    if (record.header.parentSession === undefined) return [];
    return versionLog(ctx, record);
  });
  const recordsById = new Map(lineage.map(({ record }) => [record.header.id, record]));
  const currentPath = new Set();
  let pathId = sessionId;
  while (pathId !== undefined && !currentPath.has(pathId)) {
    currentPath.add(pathId);
    pathId = recordsById.get(pathId)?.header.parentSession;
  }
  const versions = lineage.map(({ record, depth }, index) => {
    let version;
    try {
      version = ownVersionEvent(record.header, logs[index] ?? []);
    } catch (error) {
      version = undefined;
    }
    return {
      sessionId: record.header.id,
      ...record.header.parentSession === undefined ? {} : { parentSessionId: record.header.parentSession },
      createdAt: version?.time ?? record.header.createdAt,
      depth,
      current: record.header.id === sessionId,
      onCurrentPath: currentPath.has(record.header.id),
      ...version === undefined ? {} : {
        operation: version.effect.operation,
        targetTurn: version.effect.targetTurn,
        targetEventSeq: version.effect.targetEventSeq,
        ...version.effect.before === undefined ? {} : { before: version.effect.before },
        ...version.effect.after === undefined ? {} : { after: version.effect.after },
      },
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
      };
    case 'retry':
      return { action: 'retry', sessionId, turn: integerOf(record['turn'], 'turn') };
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
      respondJson(response, 200, await runOperation(ctx, decodeOperation(await requestJson(request))));
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
