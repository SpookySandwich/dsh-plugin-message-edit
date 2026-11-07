// Restart/presentation acceptance after verify-dsh-browser.mjs, same owned home.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchQA, settleTree } from './browser-qa-utils.mjs';

const qa = await launchQA('sidebar-restart');
const { page, out, origin } = qa;
const family = JSON.parse(await readFile(join(out, 'family.json'), 'utf8'));
const { root, child, sibling, other } = family;
const evidence = { source: process.env.DSH_QA_SHA, checks: [], errors: qa.errors, httpErrors: qa.httpErrors };
const resume = process.env.DSH_QA_RESUME;
let nested = family.nested, retry = { sessionId: family.retry };
if (resume) {
  const previous = JSON.parse(await readFile(join(out, 'restart.json'), 'utf8'));
  evidence.checks = previous.checks;
  nested ||= previous.checks.find(c => c.nested)?.nested;
  retry.sessionId ||= previous.checks.find(c => c.retry)?.retry;
  family.nested = nested; family.retry = retry.sessionId;
}
const row = id => page.locator(`[data-row-key="session:${id}"]`);
const rows = () => page.locator('[class*="_searchResultRow"]');
const active = () => page.evaluate(() => { const l = window.__qa.ctx.get('sessions').list.getSnapshot(); return l.ids.find(id => l.byId[id]?.retainedBy?.mainView > 0); });
async function check(name, details = {}) {
  evidence.checks.push({ name, ...details }); console.log(`PASS ${name}`);
  await writeFile(join(out, 'restart.json'), JSON.stringify(evidence, null, 2));
}
async function open(id) {
  await page.evaluate(id => window.__qa.ctx.get('uiWorkspace').openSession(id), id);
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, id);
  const chat = page.getByRole('tab', { name: 'Chat', exact: true });
  if (await chat.isVisible()) await chat.click();
  await page.getByRole('button', { name: 'Edit message', exact: true }).first().waitFor();
}
async function settings() {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  await page.getByRole('button', { name: 'Message Edit', exact: true }).click();
}
async function fold(value) {
  await settings(); await page.getByRole('checkbox', { name: 'Group versions into one sidebar entry' }).setChecked(value);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}
async function post(path, body) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
async function uiEdit(text, index) {
  await page.getByRole('button', { name: 'Edit message', exact: true }).nth(index).click(); await page.locator('textarea').fill(text);
  const response = page.waitForResponse(r => r.url().endsWith('/message-tree') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^(Send|Save)$/ }).click();
  const result = await (await response).json(); assert.ok(result.sessionId);
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, result.sessionId);
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.running === false, result.sessionId);
  return result.sessionId;
}
async function search(query, count) {
  const input = page.getByPlaceholder('Search session names');
  if (!await input.isVisible()) await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
  const before = await page.evaluate(() => window.__qa.done);
  await input.fill(query); await page.waitForFunction(n => window.__qa.done > n, before);
  await page.waitForFunction(n => document.querySelectorAll('[class*="_searchResultRow"]').length === n, count);
  return rows().allTextContents();
}
async function clear() { const input = page.getByPlaceholder('Search session names'); if (await input.isVisible()) { await input.fill(''); await input.press('Escape'); } }
async function filter(name) { await clear(); await page.getByRole('button', { name: 'View options', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click(); }
async function workspaceOp(operation, id) { await page.evaluate(({ operation, id }) => window.__qa.ctx.get('uiWorkspace')[operation](id), { operation, id }); }
try {
  await page.evaluate(() => { const qa = window.__qa, s = qa.ctx.get('sessions'), original = s.search.bind(s); qa.done = 0;
    s.search = async (...args) => { try { return await original(...args); } finally { qa.done++; } }; });
  if (!resume) {
  const before = await (await fetch(origin + '/qa/state')).json();
  assert.ok(before.sessions.find(s => s.header.id === child && s.header.isSeeded));
  assert.equal(before.sessions.find(s => s.header.id === other).live, false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-plugin-message-tree:prefs')).foldSidebar), true);
  await row(root).waitFor(); assert.equal(await row(child).count(), 0);
  await check('restart restores durable family and grouping preference; cold root not live');
  await open(child); await page.getByRole('tab', { name: 'Versions', exact: true }).click();
  const cards = await settleTree(page);
  await page.screenshot({ path: join(out, 'restart-versions-wide.png') });
  await check('settled Versions layout has no overlapping cards', { cardCount: cards.length });

  await open(other);
  const coldChild = await uiEdit('ColdRestartJuniper UI edit from saved conversation.', 0);
  await row(other).waitFor(); assert.equal(await row(coldChild).count(), 0);
  assert.equal(await row(other).getAttribute('aria-selected'), 'true');
  await check('normal cold-root UI edit groups without catalog loss', { coldChild });
  await open(child);
  await post('/qa/followup', { sessionId: child, text: 'Later second turn before a nested edit.' });
  await page.getByRole('button', { name: 'Edit message', exact: true }).nth(1).waitFor();
  nested = await uiEdit('NestedOnlyMaple edited second turn.', 1);
  family.nested = nested;
  const tree = await (await fetch(origin + '/message-tree?sessionId=' + nested)).json();
  assert.equal(tree.versions.find(v => v.sessionId === nested).targetTurn, 2);
  assert.equal(tree.versions.find(v => v.sessionId === nested).parentSessionId, child);
  await check('UI nested edit after restart retains turn-two lineage', { nested });
  await page.getByRole('tab', { name: 'Versions', exact: true }).click(); await settleTree(page);
  await page.locator(`.mtx-card[data-id="${root}#t1"]`).click();
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, root);
  await check('Versions card navigation selects original');

  await open(child); await settings(); await page.locator('.mtx-set select').selectOption('claude');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const retryResponse = page.waitForResponse(r => r.url().endsWith('/message-tree') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Retry this turn', exact: true }).first().click();
  retry = await (await retryResponse).json(); assert.ok(retry.sessionId); family.retry = retry.sessionId;
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, retry.sessionId);
  await row(root).waitFor(); assert.equal(await row(retry.sessionId).count(), 0);
  await check('Claude UI retry creates grouped persisted sibling', { retry: retry.sessionId });
  }
  await writeFile(join(out, 'family.json'), JSON.stringify(family, null, 2));

  const stages = ['pin', 'edges', 'subagent', 'copy', 'layout'];
  const runStage = name => !resume || stages.indexOf(name) >= stages.indexOf(resume);
  if (runStage('pin')) {
  // Root-owned native pin/menu behavior, even if a hidden child is pinned.
  await workspaceOp('unpinSession', root);
  await workspaceOp('pinSession', child);
  await row(root).hover(); await row(root).getByRole('button', { name: 'Session actions for Live: two images' }).click();
  await page.getByRole('menuitem', { name: 'Pin session', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: 'Pin session', exact: true }).click();
  await row(root).hover(); await row(root).getByRole('button', { name: 'Session actions for Live: two images' }).click();
  await page.getByRole('menuitem', { name: 'Unpin session', exact: true }).waitFor(); await page.keyboard.press('Escape');
  const pins = await page.evaluate(() => window.__qa.ctx.get('workspaces').list.getSnapshot().pinnedSessionIds);
  assert.ok(pins.includes(root) && pins.includes(child));
  await workspaceOp('unpinSession', root); await workspaceOp('unpinSession', child);
  await check('child pin leaves root menu unpinned; native root pin and unpin agree');

  // Archive combination checks, including the documented nonblocking presentation.
  await workspaceOp('archiveSession', child); await workspaceOp('archiveSession', retry.sessionId); await workspaceOp('archiveSession', nested);
  await open(other); await filter('All conversations (show archived)');
  const archivedRows = await search('ChildOnlyZephyr', 1);
  assert.equal(await rows().getByRole('button', { name: 'Unarchive session' }).count(), 0);
  const selected = await active(); await rows().click();
  await page.getByText('Archived sessions cannot be opened', { exact: false }).waitFor({ timeout: 5000 });
  assert.equal(await active(), selected);
  await check('known archived-only hit caveat observed: live root styling, notification, no navigation', { rows: archivedRows });
  await filter('Archived only'); await search('ChildOnlyZephyr', 0);
  await check('Archived only respects live-root visibility');
  await clear(); await workspaceOp('unarchiveSession', child); await workspaceOp('unarchiveSession', retry.sessionId); await workspaceOp('unarchiveSession', nested);
  await workspaceOp('archiveSession', root); await filter('Archived only');
  const rootRows = await search('Original first', 1);
  await check('archived root shows its own content in Archived only', { rows: rootRows });
  await clear(); await workspaceOp('unarchiveSession', root); await filter('Hide archived');
  }

  if (runStage('edges')) {
  await open(child);
  const fixtures = await post('/qa/sidebar', { action: 'edge-fixtures', sessionId: root });
  await page.evaluate(() => window.__qa.ctx.get('sessions').refresh());
  const workspaceRow = page.locator(`[data-row-key="workspace:${fixtures.workspaceId}"]`);
  if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click();
  await row('session-qa-orphan').waitFor(); await row('session-qa-independent').waitFor();
  assert.equal(await row('session-qa-moved').count(), 0); assert.equal(await row(root).count(), 1);
  await check('real host cross-workspace lineage keeps root once; orphan and equal-title independent root visible', fixtures);
  await workspaceOp('pinSession', 'session-qa-moved'); assert.equal(await row(root).count(), 1);
  await post('/qa/sidebar', { action: 'detach-root', sessionId: root });
  await page.waitForFunction(id => !window.__qa.ctx.get('workspaces').list.getSnapshot().items.some(w => w.sessionIds.includes(id)), root);
  await row(root).waitFor(); assert.equal(await row(root).count(), 1);
  await check('detached root stays visible once despite children in registered workspaces');
  await post('/qa/sidebar', { action: 'attach-root', sessionId: root }); await workspaceOp('unpinSession', 'session-qa-moved');
  }

  if (runStage('subagent')) {
  await open(child);
  const subagent = await post('/qa/sidebar', { action: 'subagent', sessionId: child });
  await row(root).getByText('1 subagent running', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await row(subagent.childId).count(), 0);
  await page.screenshot({ path: join(out, 'subagent-running.png') });
  await check('real spawned subagent under hidden version contributes running count without ordinary row', subagent);
  await page.waitForFunction(id => !window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.running, subagent.childId);
  const subStatus = await post('/qa/sidebar', { action: 'subagent-status', sessionId: child });
  assert.ok(!subStatus.some(s => s.error));
  await check('local subagent completes', { subStatus });
  }

  if (runStage('copy')) {
  // Official independent copy deliberately has no parentage.
  let copy = family.copy;
  if (!copy) {
  await open(sibling);
  const ids = await page.evaluate(() => window.__qa.ctx.get('sessions').list.getSnapshot().ids);
  await page.getByRole('button', { name: 'Branch into a new conversation', exact: true }).first().click();
  await page.waitForFunction(ids => window.__qa.ctx.get('sessions').list.getSnapshot().ids.some(id => !ids.includes(id)), ids);
  copy = await page.evaluate(ids => window.__qa.ctx.get('sessions').list.getSnapshot().ids.find(id => !ids.includes(id)), ids);
  family.copy = copy;
  await writeFile(join(out, 'family.json'), JSON.stringify(family, null, 2));
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, copy);
  } else await open(copy);
  const copyRow = await page.evaluate(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id], copy);
  assert.ok(!copyRow.parentId); await row(copy).waitFor();
  await check('native independent copy remains its own sidebar root', { copy });
  }

  await open(nested); await page.setViewportSize({ width: 400, height: 900 });
  await page.getByRole('button', { name: 'More conversation views', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Versions', exact: true }).click();
  await settleTree(page); await page.locator('.mtx-tool').first().click(); await settleTree(page);
  await page.screenshot({ path: join(out, 'versions-400.png') });
  await check('400px More-menu Versions navigation and settled layout');
  await page.setViewportSize({ width: 1360, height: 900 }); await settings();
  await page.setViewportSize({ width: 400, height: 900 });
  for (const lang of ['en', 'zh', 'ru']) {
    await page.evaluate(lang => window.__qa.ctx.get('locale').setLocale(lang), lang);
    await page.locator('.mtx-set input[type="checkbox"]').first().waitFor();
    const controls = await page.locator('.mtx-set input,.mtx-set select').evaluateAll(es => es.map(e => { const r=e.getBoundingClientRect(); return { x:r.x, right:r.right }; }));
    assert.ok(controls.length >= 4 && controls.every(r => r.x >= 0 && r.right <= 400));
    await page.screenshot({ path: join(out, `settings-${lang}-400.png`) });
    await check(`400px ${lang} settings controls fit`, { controls });
  }
  await page.evaluate(() => window.__qa.ctx.get('locale').setLocale('en'));
  await page.setViewportSize({ width: 1360, height: 900 }); await page.getByRole('button', { name: 'Close', exact: true }).click();
  await open(nested); await page.getByRole('tab', { name: 'Versions', exact: true }).click(); await settleTree(page);
  await page.screenshot({ path: join(out, 'final-versions-wide.png') });
  await writeFile(join(out, 'family.json'), JSON.stringify(family, null, 2));
  await qa.context.storageState({ path: join(out, 'browser-storage.json') });
  assert.deepEqual(qa.errors, []); assert.deepEqual(qa.httpErrors, []);
  await check('no page exceptions or HTTP errors');
} catch (error) {
  evidence.failure = String(error.stack || error);
  await page.screenshot({ path: join(out, 'restart-failure.png') });
  await writeFile(join(out, 'restart-failure.html'), await page.content()); throw error;
} finally {
  await writeFile(join(out, 'restart.json'), JSON.stringify(evidence, null, 2)); await qa.close();
}
