// Native completion/navigation checks in the launcher's isolated official host.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchQA } from './browser-qa-utils.mjs';

const name = process.env.DSH_QA_PHASE || 'status';
const qa = await launchQA(name);
const { page, out, origin } = qa;
const evidence = { source: process.env.DSH_QA_SHA, browser: qa.browser.version(), checks: [], errors: qa.errors, httpErrors: qa.httpErrors };
const root = 'session-qa-live', other = 'session-qa-cold';
const row = id => page.locator(`[data-row-key="session:${id}"]`);
const active = () => page.evaluate(() => {
  const l = window.__qa.ctx.get('sessions').list.getSnapshot();
  return l.ids.find(id => l.byId[id]?.retainedBy?.mainView > 0);
});
const mainIs = id => page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, id);
const status = id => page.evaluate(id => window.__qa.ctx.get('uiSession').sessionStatus.getSnapshot().get(id), id);
async function fixture(action, sessionId) {
  const response = await fetch(origin + '/qa/sidebar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, sessionId }) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
async function open(id) {
  await page.evaluate(id => window.__qa.ctx.get('uiWorkspace').openSession(id), id);
  await mainIs(id);
  const chat = page.getByRole('tab', { name: 'Chat', exact: true });
  if (await chat.isVisible()) await chat.click();
}
async function prefs(fold, remember) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  await page.getByRole('button', { name: 'Message Edit', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Group versions into one sidebar entry' }).setChecked(fold);
  await page.getByRole('checkbox', { name: 'Remember the version I was viewing' }).setChecked(remember);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}
async function edit(text) {
  await open(root);
  await page.getByRole('button', { name: 'Edit message', exact: true }).first().click();
  await page.locator('textarea').fill(text);
  const response = page.waitForResponse(r => r.url().endsWith('/message-tree') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^(Send|Save)$/ }).click();
  const result = await (await response).json(); assert.ok(result.sessionId);
  await mainIs(result.sessionId);
  await page.getByText('Local QA reply. Received 2 images.', { exact: true }).first().waitFor();
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.running === false, result.sessionId);
  return result.sessionId;
}
async function followup(id, label) {
  const response = await fetch(origin + '/qa/followup', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: id, text: `QA_STREAM_status_${label}` }) });
  assert.equal(response.status, 200, await response.text());
  await page.waitForFunction(id => window.__qa.ctx.get('uiSession').sessionStatus.getSnapshot().get(id)?.completionUnread === true, id);
}
async function check(name, details = {}) { evidence.checks.push({ name, ...details }); console.log(`PASS ${name}`); }
try {
  evidence.host = JSON.parse(await readFile(join(qa.home, 'process.json'), 'utf8')).version;
  let family;
  try { family = JSON.parse(await readFile(join(out, 'status-family.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await open(root); await prefs(false, false);
  if (!family) {
    family = { child: await edit('StatusChildQuartz keep both images.'), sibling: await edit('StatusSiblingCedar keep both images.') };
    await writeFile(join(out, 'status-family.json'), JSON.stringify(family, null, 2));
  }
  const { child, sibling } = family;
  evidence.family = { root, child, sibling, other };
  for (const [label, fold, remember] of [['native control', false, false], ['remember OFF', true, false], ['remember ON', true, true]]) {
    await prefs(fold, remember);
    for (const id of [root, child, sibling, other]) await open(id);
    await followup(child, label);
    const target = fold ? root : child;
    await row(target).getByText('Completed', { exact: true }).waitFor();
    await row(target).click();
    await page.waitForFunction(other => {
      const l = window.__qa.ctx.get('sessions').list.getSnapshot();
      return l.ids.some(id => id !== other && l.byId[id]?.retainedBy?.mainView > 0);
    }, other);
    const observed = { label, opened: await active(), childStatus: await status(child), rowCompleted: await row(target).getByText('Completed', { exact: true }).count() };
    evidence.lastObservation = observed;
    assert.equal(observed.opened, child, 'Completed family row must open the unread child');
    await page.waitForFunction(id => !window.__qa.ctx.get('uiSession').sessionStatus.getSnapshot().get(id)?.completionUnread, child);
    await row(target).getByText('Completed', { exact: true }).waitFor({ state: 'hidden' });
    await check(`completion leads to source and native read clears it: ${label}`, { ...observed, after: await status(child) });
  }
  for (const remember of [false, true]) {
    await prefs(true, remember);
    for (const id of [root, child, sibling, other]) await open(id);
    await followup(child, 'multiple-child'); await followup(sibling, 'multiple-sibling');
    await row(root).click();
    await page.waitForFunction(ids => ids.some(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0), [child, sibling]);
    const first = await active(), remaining = first === child ? sibling : child;
    await page.waitForFunction(id => !window.__qa.ctx.get('uiSession').sessionStatus.getSnapshot().get(id)?.completionUnread, first);
    assert.equal((await status(remaining)).completionUnread, true, 'opening one version must not mark its sibling read');
    await row(root).getByText('Completed', { exact: true }).waitFor();
    await row(root).click(); await mainIs(remaining);
    await row(root).getByText('Completed', { exact: true }).waitFor({ state: 'hidden' });
    await check(`multiple completions are visited individually remember=${remember}`, { first, remaining });
    await open(sibling); await open(other); await row(root).click(); await mainIs(remember ? sibling : root);
    await check(`no actionable status restores ordinary remember=${remember}`);
  }
  for (const remember of [false, true]) {
    await prefs(true, remember);
    for (const id of [root, child, sibling, other]) await open(id);
    await followup(sibling, 'unread-before-approval');
    await fixture('approval', child);
    await row(root).getByText('Waiting for approval', { exact: true }).waitFor();
    assert.equal((await status(child)).pendingInteraction.kind, 'approval');
    // A deliberate root-content hit still wins over the hidden approval.
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await page.getByPlaceholder('Search session names').fill('Original first');
    const hit = page.locator('[class*="_searchResultRow"]').filter({ has: page.locator('[class*="_searchResultTitle"]', { hasText: 'Live: two images' }) });
    await hit.getByText(/Original first turn/).waitFor();
    await hit.click(); await mainIs(root);
    assert.equal((await status(child)).pendingInteraction.kind, 'approval');
    await check(`explicit root-content hit precedes hidden pending approval remember=${remember}`);
    await row(root).click(); await mainIs(child);
    await page.getByText('Local sidebar QA: no operation will be executed.', { exact: true }).waitFor();
    assert.equal((await status(sibling)).completionUnread, true, 'approval navigation must leave sibling unread');
    await page.screenshot({ path: join(out, `${name}-approval-${remember}.png`) });
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await page.waitForFunction(id => {
      const state = window.__qa.ctx.get('uiSession').sessionStatus.getSnapshot().get(id);
      return !state?.pendingInteraction && !state?.running;
    }, child);
    const record = (await fixture('approval-status', child)).find(record => record.sessionId === child);
    assert.equal(record.outcome, 'rejected'); assert.equal(record.settled, true);
    await row(root).click(); await mainIs(sibling);
    await row(root).getByText('Completed', { exact: true }).waitFor({ state: 'hidden' });
    await check(`real pending approval opens before unread sibling and native rejection settles it remember=${remember}`, { record });
  }
  await prefs(true, true);
  for (const id of [root, child, sibling, other]) await open(id);
  await fixture('approval', root);
  await row(root).getByText('Waiting for approval', { exact: true }).waitFor();
  await row(root).click(); await mainIs(root);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.waitForFunction(id => !window.__qa.ctx.get('uiSession').sessionStatus.getSnapshot().get(id)?.running, root);
  assert.equal(await active(), root, 'bubble remember must not undo root approval navigation');
  await check('root approval remains on the root with a remembered sibling');
  assert.deepEqual(qa.errors, []); assert.deepEqual(qa.httpErrors, []);
  await page.screenshot({ path: join(out, `${name}.png`) });
  await check('no page exceptions or HTTP errors');
} catch (error) {
  evidence.failure = String(error.stack || error);
  await page.screenshot({ path: join(out, `${name}-failure.png`) });
  throw error;
} finally {
  try { await writeFile(join(out, `${name}.json`), JSON.stringify(evidence, null, 2)); }
  finally { await qa.close(); }
}
