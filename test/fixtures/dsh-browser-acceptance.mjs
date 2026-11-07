// Additional real-host scenarios, exclusively for the isolated browser runner.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { apply as baseApply, inject as baseInject } from './dsh-acceptance.mjs';

assert.match(process.env.DSH_HOME ?? '', /[\\/]message-edit-dsh-qa-[^\\/]+$/);
const home = resolve(process.env.DSH_HOME);
const require = createRequire(join(process.env.DSH_QA_MODULES, 'package.json'));
const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
export const inject = [...baseInject, 'subagents', 'approval'];
export async function apply(ctx) {
  const activations = new Map();
  const approvals = new Map();
  const owned = id => {
    const agent = ctx.agents.get(id);
    assert.ok(agent && resolve(agent.session.header.cwd).startsWith(home + sep), 'Only this owned QA home');
    return agent;
  };
  await baseApply(ctx, { beforeReply: async (message, signal) => {
    const text = message?.content.find(block => block.type === 'text')?.text || '';
    if (!text.startsWith('QA_APPROVAL_')) return;
    const id = text.slice('QA_APPROVAL_'.length);
    const agent = owned(id);
    const record = { sessionId: id, settled: false };
    approvals.set(id, record);
    // Ask inside a real model turn so the host owns the durable audit pair and
    // its native approval UI. This fixture performs no tool or file operation.
    record.outcome = await ctx.approval.request({ agent, toolName: 'qa-local-approval',
      reason: 'Local sidebar QA: no operation will be executed.', signal });
    record.settled = true;
  } });
  ctx.webServer.register({ kind: 'exact', path: '/qa/sidebar', handler: async (req, res) => {
    try {
      assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress));
      assert.equal(req.method, 'POST');
      if (req.headers.origin) assert.equal(new URL(req.headers.origin).host, req.headers.host);
      let body = '';
      for await (const chunk of req) { body += chunk; assert.ok(body.length < 4096); }
      const { action, sessionId } = JSON.parse(body);
      const parent = owned(sessionId);
      let result;
      if (action === 'edge-fixtures') {
        const cwd = join(home, 'other-workspace');
        await mkdir(cwd, { recursive: true });
        const workspace = await ctx.workspaceRegistry.create(cwd, 'QA other workspace');
        const existing = new Set((await ctx.sessionQuery.listSessions()).map(s => s.header.id));
        for (const [id, title, parentSession] of [
          ['session-qa-moved', 'Moved recorded version', sessionId],
          ['session-qa-orphan', 'Orphan recorded version', 'session-qa-absent-parent'],
          ['session-qa-independent', 'Live: two images', undefined],
        ]) {
          if (existing.has(id)) continue;
          const handle = await ctx.agents.create({ sessionId: id, meta: { cwd, ...(parentSession ? { parentSession } : {}) },
            agentOptions: { provider: 'qa-local', model: 'qa-model' } });
          ctx.effect(() => () => handle.dispose());
          ctx.sessionTitle.rename(handle.agent.session, title);
          handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `${title} fixture content.` }] }));
          await handle.agent.whenIdle(); await ctx.sessions.flush(handle.agent.session); await workspace.attachSession(id);
        }
        result = { workspaceId: workspace.id };
      } else if (action === 'detach-root' || action === 'attach-root') {
        const workspace = ctx.workspaceRegistry.list().find(w => w.path === parent.session.header.cwd);
        assert.ok(workspace);
        await workspace[action === 'detach-root' ? 'detachSession' : 'attachSession'](sessionId);
        result = { workspaceId: workspace.id };
      } else if (action === 'subagent') {
        const activation = await ctx.subagents.startActivation({ provider: 'spawn', label: 'QA hidden-child subagent',
          request: { parent, prompt: [{ type: 'text', text: 'QA_STREAM_subagent fixture' }],
            agentOptions: { provider: 'qa-local', model: 'qa-model' } },
          signal: new AbortController().signal, delivery: 'caller' });
        const record = { childId: activation.childId, settled: false };
        activations.set(activation.childId, record);
        activation.result.then(result => { record.settled = true; record.result = result; }, error => { record.error = String(error); });
        ctx.effect(() => () => activation.dispose());
        result = { childId: activation.childId };
      } else if (action === 'approval') {
        parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `QA_APPROVAL_${sessionId}` }] }));
        result = { sessionId };
      } else if (action === 'approval-status') result = [...approvals.values()];
      else if (action === 'subagent-status') result = [...activations.values()];
      else throw new Error('Unsupported QA action');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) }));
    }
  } });
}
