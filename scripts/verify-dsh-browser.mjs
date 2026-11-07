// Real official DSH Web UI acceptance. Uses only the launcher's disposable home.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchQA, settleTree } from './browser-qa-utils.mjs';

const qa = await launchQA('sidebar-current');
const { page, out, origin } = qa;
const host = JSON.parse(await readFile(join(qa.home, 'process.json'), 'utf8')).version;
const nativeIdSearch = host === '0.2.2-rc.1';
const evidence = { source: process.env.DSH_QA_SHA, host, browser: qa.browser.version(), checks: [], errors: qa.errors, httpErrors: qa.httpErrors };
const rows = () => page.locator('[class*="_searchResultRow"]');
const row = id => page.locator(`[data-row-key="session:${id}"]`);
const active = () => page.evaluate(() => {
  const list = window.__qa.ctx.get('sessions').list.getSnapshot();
  return list.ids.find(id => list.byId[id]?.retainedBy?.mainView > 0);
});
async function checkpoint(name, details = {}) {
  evidence.checks.push({ name, ...details });
  console.log(`PASS ${name}`);
  await writeFile(join(out, 'current.json'), JSON.stringify(evidence, null, 2));
}
async function open(id) {
  await page.evaluate(id => window.__qa.ctx.get('uiWorkspace').openSession(id), id);
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, id);
  const chat = page.getByRole('tab', { name: 'Chat', exact: true });
  if (await chat.isVisible()) await chat.click();
  await page.getByRole('button', { name: 'Edit message', exact: true }).first().waitFor();
}
async function prefs(foldSidebar, rememberPath) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  await page.getByRole('button', { name: 'Message Edit', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Group versions into one sidebar entry' }).setChecked(foldSidebar);
  await page.getByRole('checkbox', { name: 'Remember the version I was viewing' }).setChecked(rememberPath);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('dsh-plugin-message-tree:prefs'));
    return [p.foldSidebar, p.rememberPath];
  }), [foldSidebar, rememberPath]);
}
async function edit(text, index = 0) {
  await page.getByRole('button', { name: 'Edit message', exact: true }).nth(index).click();
  await page.locator('textarea').fill(text);
  const response = page.waitForResponse(r => r.url().endsWith('/message-tree') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^(Send|Save)$/ }).click();
  const result = await (await response).json();
  assert.ok(result.sessionId, JSON.stringify(result));
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, result.sessionId);
  await page.getByText('Local QA reply. Received 2 images.', { exact: true }).first().waitFor();
  await page.waitForFunction(() => !window.__qa.ctx.get('sessions').list.getSnapshot().ids.some(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id].running));
  return result.sessionId;
}
async function search(query, count) {
  const input = page.getByPlaceholder('Search session names');
  if (!await input.isVisible()) await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
  const previous = await page.evaluate(() => window.__qa.searchDone);
  await input.fill(query);
  await page.waitForFunction(n => window.__qa.searchDone > n, previous);
  await page.waitForFunction(count => document.querySelectorAll('[class*="_searchResultRow"]').length === count, count);
  return rows().allTextContents();
}
async function clearSearch() {
  const input = page.getByPlaceholder('Search session names');
  if (await input.isVisible()) { await input.fill(''); await input.press('Escape'); }
}
async function hit(query, title, target, count = 1) {
  const texts = await search(query, count);
  const match = rows().filter({ has: page.locator('[class*="_searchResultTitle"]', { hasText: title }) });
  assert.equal(await match.count(), 1, JSON.stringify(texts));
  await match.click();
  await page.waitForFunction(id => window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, target);
  assert.equal(await active(), target);
  return texts;
}
try {
  await page.evaluate(() => {
    const qa = window.__qa, sessions = qa.ctx.get('sessions');
    const search = sessions.search.bind(sessions);
    qa.searchCalls = 0; qa.searchDone = 0; qa.catalogChanges = 0;
    sessions.list.subscribe(() => qa.catalogChanges++);
    sessions.search = async (...args) => { qa.searchCalls++; try { return await search(...args); } finally { qa.searchDone++; } };
  });
  const root = 'session-qa-live', other = 'session-qa-cold';
  const preflight = await page.evaluate(() => window.__qa.ctx.get('sessions').search('Original first', new AbortController().signal));
  assert.ok(JSON.stringify(preflight).includes('session-qa-live'), `Official full-text search must be enabled: ${JSON.stringify(preflight)}`);
  await checkpoint('official full-text search enabled', { preflight });
  await open(root);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-plugin-message-tree:prefs') || '{}').foldSidebar || false), false);
  await checkpoint('grouping defaults OFF');
  await search('session-qa-live', nativeIdSearch ? 1 : 0);
  await clearSearch();
  await checkpoint('native root-ID search contract', { supported: nativeIdSearch, host });
  await prefs(true, false);
  const child = await edit('ChildOnlyZephyr Live edited prompt; keep both images.');
  await page.waitForFunction(() => document.querySelectorAll('[data-row-key="session:session-qa-live"]').length === 1);
  assert.equal(await row(child).count(), 0);
  assert.equal(await row(root).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('img[alt="red.png"]').count(), 1);
  assert.equal(await page.locator('img[alt="blue.png"]').count(), 1);
  await checkpoint('UI edit with two images immediately groups and selects original', { child });
  await open(root);
  const sibling = await edit('SiblingOnlyCedar a separate remembered version.');
  evidence.family = { root, child, sibling, other };
  await checkpoint('second UI edit preserves family', { sibling });

  for (const remember of [false, true]) {
    await prefs(true, remember);
    await open(sibling);
    let texts = await hit('Original first', 'Live: two images', root, 2);
    await checkpoint(`root-content opens root remember=${remember}`, { rows: texts });
    await open(sibling);
    texts = await hit('ChildOnlyZephyr', 'Live: two images', child);
    await checkpoint(`child-content opens child remember=${remember}`, { rows: texts });
    await open(sibling);
    texts = await hit('Live', 'Live: two images', child);
    await checkpoint(`local root title plus child content deduplicates remember=${remember}`, { rows: texts });
    if (nativeIdSearch) {
      await open(sibling);
      texts = await hit('session-qa-live', 'Live: two images', remember ? sibling : root);
      await checkpoint(`root ID title-only ordinary navigation remember=${remember}`, { rows: texts });
    }
  }
  await prefs(false, false);
  assert.equal(await row(child).count(), 1);
  await hit('ChildOnlyZephyr', 'Live: two images', child);
  await checkpoint('grouping OFF preserves direct content navigation');

  // Native host title-only match among hidden members.
  await page.evaluate(async id => {
    const sessions = window.__qa.ctx.get('sessions');
    const result = await sessions.manager.rename(id, 'HiddenOnlyLarch');
    if (result.error) throw new Error(JSON.stringify(result));
  }, child);
  await prefs(true, true);
  await open(sibling);
  await hit('HiddenOnlyLarch', 'Live: two images', child);
  await checkpoint('hidden unique title opens its version');

  // Remembered hidden archive is excluded; default content search must omit it.
  await page.evaluate(id => window.__qa.ctx.get('uiWorkspace').archiveSession(id), child);
  await open(other);
  await row(root).click();
  await page.waitForFunction(() => window.__qa.ctx.get('sessions').list.getSnapshot().byId['session-qa-live']?.retainedBy?.mainView > 0);
  const archivedRows = await search('ChildOnlyZephyr', 0);
  await checkpoint('archived remembered child stays archived and default search hides it', { rows: archivedRows });
  await clearSearch();
  await page.evaluate(id => window.__qa.ctx.get('uiWorkspace').unarchiveSession(id), child);

  // Stable search through real 60-chunk background activity.
  for (const fold of [false, true]) {
    await prefs(fold, true);
    await open(other);
    await search('ChildOnlyZephyr', 1);
    await page.evaluate(() => {
      const qa = window.__qa;
      qa.measure = { calls: qa.searchCalls, changes: qa.catalogChanges, samples: 0, missing: 0 };
      qa.timer = setInterval(() => { qa.measure.samples++; if (document.querySelectorAll('[class*="_searchResultRow"]').length !== 1) qa.measure.missing++; }, 10);
    });
    const response = await fetch(`${origin}/qa/followup`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: root, text: `QA_STREAM_${fold} real background activity` }) });
    assert.equal(response.status, 200);
    const result = await page.evaluate(() => { const qa = window.__qa; clearInterval(qa.timer); return { samples: qa.measure.samples,
      missing: qa.measure.missing, extraSearches: qa.searchCalls - qa.measure.calls, catalogChanges: qa.catalogChanges - qa.measure.changes }; });
    assert.ok(result.samples > 100); assert.equal(result.missing, 0); assert.equal(result.extraSearches, 0); assert.ok(result.catalogChanges > 0);
    await checkpoint(`no search flicker grouping=${fold}`, result);
    await clearSearch();
  }
  await prefs(true, true);
  await open(child);
  await page.getByRole('tab', { name: 'Versions', exact: true }).click();
  await settleTree(page);
  await page.screenshot({ path: join(out, 'current-versions-wide.png') });
  await checkpoint('Versions tree renders grouped family');
  await writeFile(join(out, 'family.json'), JSON.stringify(evidence.family, null, 2));
  await qa.context.storageState({ path: join(out, 'browser-storage.json') });
  assert.deepEqual(qa.errors, []);
  assert.deepEqual(qa.httpErrors, []);
  await checkpoint('no page exceptions or HTTP errors');
} catch (error) {
  evidence.failure = String(error.stack || error);
  await page.screenshot({ path: join(out, 'current-failure.png') });
  await writeFile(join(out, 'current-failure.html'), await page.content());
  throw error;
} finally {
  await writeFile(join(out, 'current.json'), JSON.stringify(evidence, null, 2));
  await qa.close();
}
