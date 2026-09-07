// Optional real-DSH acceptance fixture. Mount ONLY in a disposable DSH_HOME;
// DSH_QA_MODULES names an installed official DSH node_modules directory.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

assert.ok(process.env.DSH_QA_MODULES, 'Set DSH_QA_MODULES to the official runtime node_modules');
assert.match(process.env.DSH_HOME ?? '', /message-edit-dsh-qa-/, 'Use a disposable QA home');
const require = createRequire(join(process.env.DSH_QA_MODULES, 'package.json'));
const { LlmAdapter, createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const { default: sharp } = await import(pathToFileURL(require.resolve('sharp')));

class LocalReply extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: 'Local acceptance model', inputModalities: ['text', 'image'] };
  }
  async listModels(provider) { return [await this.resolveModel(provider, 'qa-model')]; }
  async *stream(options) {
    const last = options.messages.findLast(message => message.source.kind === 'user');
    const imageCount = last?.content.filter(block => block.type === 'image').length ?? 0;
    yield { type: 'text-delta', index: 0, text: `Local QA reply. Received ${imageCount} images.` };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export const inject = ['sessions', 'agents', 'agentLoop', 'llm', 'sessionPersistence', 'sessionQuery',
  'sessionTitle', 'attachments', 'workspaceRegistry', 'webServer'];

export async function apply(ctx) {
  ctx.llm.registerAdapter(['qa-local'], new LocalReply());
  const cwd = join(process.env.DSH_HOME, 'fixture-workspace');
  await mkdir(cwd, { recursive: true });
  const workspace = await ctx.workspaceRegistry.create(cwd, 'Message Edit acceptance');
  const existing = new Set((await ctx.sessionQuery.listSessions()).map(record => record.header.id));
  const refs = [];
  for (const [name, color] of [['red.png', '#ef4444'], ['blue.png', '#2563eb']]) {
    const data = await sharp({ create: { width: 360, height: 180, channels: 3, background: color } }).png().toBuffer();
    refs.push(await ctx.attachments.saveImage({ data, mediaType: 'image/png', name }));
  }
  for (const [id, title, cold] of [
    ['session-qa-live', 'Live: two images', false],
    ['session-qa-cold', 'Cold: two images', true],
  ]) {
    if (existing.has(id)) {
      if (!cold) {
        const resumed = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'qa-local', model: 'qa-model' } });
        ctx.effect(() => () => resumed.dispose());
      }
      continue;
    }
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions: { provider: 'qa-local', model: 'qa-model' } });
    ctx.effect(() => () => handle.dispose());
    const { agent } = handle;
    ctx.sessionTitle.rename(agent.session, title);
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: 'Original first turn; keep both images.' }, ...refs.map(attachment => ({ type: 'image', attachment })),
    ] }));
    await agent.whenIdle();
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Original later turn.' }] }));
    await agent.whenIdle();
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 2);
    await ctx.sessions.flush(agent.session);
    await workspace.attachSession(id);
    if (cold) await handle.dispose();
  }
  ctx.webServer.register({ kind: 'exact', path: '/qa/state', handler: async (_req, res) => {
    const sessions = await Promise.all((await ctx.sessionQuery.listSessions()).map(async ({ header }) => {
      await ctx.agents.get(header.id)?.whenIdle();
      const live = ctx.sessions.get(header.id);
      if (live) await ctx.sessions.flush(live);
      const snapshot = await ctx.sessionQuery.readSession(header.id);
      return { ...snapshot, header: snapshot.session ?? snapshot.header, live: !!live };
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
  } });
  ctx.webServer.register({ kind: 'exact', path: '/qa/followup', handler: async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { sessionId, text } = JSON.parse(body);
    const agent = ctx.agents.get(sessionId);
    assert.equal(agent?.session.header.cwd, cwd, 'Only this disposable fixture workspace may be changed');
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  } });
  console.log('QA fixtures ready: real live/cold DSH agents with an offline model.');
}
