// Official default (content index disabled), after restarting the owned home.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchQA, settleTree } from './browser-qa-utils.mjs';
const qa = await launchQA('sidebar-fts-off');
const { page, out, origin } = qa;
const family = JSON.parse(await readFile(join(out, 'family.json'), 'utf8'));
const { root, child, sibling, nested, retry } = family;
const evidence = { source: process.env.DSH_QA_SHA, checks: [], errors: qa.errors, httpErrors: qa.httpErrors };
async function check(name, details = {}) { evidence.checks.push({ name, ...details }); console.log(`PASS ${name}`); }
const active = () => page.evaluate(() => { const l=window.__qa.ctx.get('sessions').list.getSnapshot();return l.ids.find(id=>l.byId[id]?.retainedBy?.mainView>0); });
async function open(id) { await page.evaluate(id=>window.__qa.ctx.get('uiWorkspace').openSession(id),id); await page.waitForFunction(id=>window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView>0,id); }
async function preferences(fold, remember) {
  await page.getByRole('button',{name:'Account menu'}).click(); await page.getByRole('menuitem',{name:/Settings/}).click();
  await page.getByRole('button',{name:'Message Edit',exact:true}).click();
  await page.getByRole('checkbox',{name:'Group versions into one sidebar entry'}).setChecked(fold);
  await page.getByRole('checkbox',{name:'Remember the version I was viewing'}).setChecked(remember);
  await page.getByRole('button',{name:'Close',exact:true}).click();
}
async function rename(id,title) { const result=await page.evaluate(({id,title})=>window.__qa.ctx.get('sessions').manager.rename(id,title),{id,title});assert.ok(result.ok,JSON.stringify(result)); }
const rows=()=>page.locator('[class*="_searchResultRow"]');
async function search(query) {
  const input=page.getByPlaceholder('Search session names');if(!await input.isVisible())await page.getByRole('button',{name:'Search sessions',exact:true}).click();
  const n=await page.evaluate(()=>window.__qa.done);await input.fill(query);await page.waitForFunction(n=>window.__qa.done>n,n);
  // Wait for the host's pending search state to settle as well as its RPC.
  await page.waitForFunction(()=>!document.querySelector('[class*="_searchLoading"]'));
}
async function clear() { const input=page.getByPlaceholder('Search session names');if(await input.isVisible()){await input.fill('');await input.press('Escape');} }
try {
  const preflight=await page.evaluate(async()=>{const result=await window.__qa.ctx.get('sessions').search('Original first',new AbortController().signal);
    return result.ok ? result : {ok:false,error:{name:result.error.name,message:result.error.message,code:result.error.code}};});
  assert.equal(preflight.ok,false);assert.match(JSON.stringify(preflight),/SESSION_QUERY_SEARCH_DISABLED|search.disabled|search is disabled/i);
  await check('official default content search is disabled',{preflight});
  await page.evaluate(()=>{const qa=window.__qa,s=qa.ctx.get('sessions'),f=s.search.bind(s);qa.done=0;s.search=async(...args)=>{try{return await f(...args);}finally{qa.done++;}};});
  const state=await(await fetch(origin+'/qa/state')).json();
  for(const id of [child,nested,retry])assert.ok(state.sessions.find(s=>s.header.id===id)?.events.some(e=>e.type==='message-tree/version'&&e.data.sessionId===id));
  const tree=await(await fetch(origin+'/message-tree?sessionId='+nested)).json();
  assert.equal(tree.versions.find(v=>v.sessionId===nested).parentSessionId,child);
  assert.equal(tree.versions.find(v=>v.sessionId===nested).targetTurn,2);
  await check('second restart restores nested edits and retry version markers');
  await rename(child,'Live: two images');await rename(sibling,'Live: two images');
  for(const remember of [false,true]) {
    await preferences(true,remember);await open(sibling);await search('Live: two images');
    const match=rows().filter({has:page.getByText('Live: two images',{exact:true})}).filter({hasText:'Message Edit acceptance'});
    await match.waitFor();assert.equal(await match.count(),1);
    const text=await match.innerText();await match.click();
    const expected=remember?sibling:root;await page.waitForFunction(id=>window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView>0,expected);
    assert.equal(await active(),expected);await check(`shared-title FTS-off navigation remember=${remember}`,{row:text});
  }
  await rename(child,'HiddenOnlyWillow');await open(sibling);await search('HiddenOnlyWillow');
  await rows().waitFor();assert.equal(await rows().count(),1);await rows().click();
  await page.waitForFunction(id=>window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView>0,child);
  await check('unique hidden-title fallback opens child without full-text search');
  await rename(child,'AmbiguousOnlyBirch');await rename(sibling,'AmbiguousOnlyBirch');
  for(const remembered of [child,sibling]) {
  await open(remembered);await search('AmbiguousOnlyBirch');
  await rows().waitFor();assert.equal(await rows().count(),1);await rows().click();
  await page.waitForFunction(ids=>ids.some(id=>window.__qa.ctx.get('sessions').list.getSnapshot().byId[id]?.retainedBy?.mainView>0),[child,sibling]);
  const chosen=await active();assert.ok([child,sibling].includes(chosen));
  await check('ambiguous hidden-title behavior observed',{remembered,chosen,rememberedSelected:chosen===remembered});
  }
  await rename(child,'HiddenOnlyLarch');await rename(sibling,'Live: two images');
  await preferences(false,false);await search('ChildOnlyZephyr');
  await page.waitForFunction(()=>document.querySelectorAll('[class*="_searchResultRow"]').length===0);
  await check('grouping OFF default host has no content-only search results');await clear();
  await preferences(true,true);await open(nested);
  const chat=page.getByRole('tab',{name:'Chat',exact:true});if(await chat.isVisible())await chat.click();
  await page.getByRole('tab',{name:'Versions',exact:true}).click();await settleTree(page);
  await page.screenshot({path:join(out,'fts-off-restart-tree.png')});
  // Actual plugin unload must restore the original native entry and styles.
  const unload=await page.evaluate(async()=>{const ctx=window.__qa.ctx,entry=ctx.get('slots').entriesOfSlot('sidebar.workspaces').find(e=>e.component);
    const children=entry.children,store=entry.store,before=entry.component.name;
    const pluginStyles=[...document.querySelectorAll('style')].filter(e=>e.textContent.includes('.mtx-card'));
    if(!pluginStyles.length)throw new Error('Expected mounted plugin CSS before disposal');
    await ctx.fiber.dispose();
    return{before,after:entry.component.name,childrenPreserved:entry.children===children,storePreserved:entry.store===store,styleRemoved:pluginStyles.every(e=>!e.isConnected)};});
  assert.equal(unload.before,'GroupedSidebar');assert.equal(unload.after,'WorkspaceBrowser');assert.ok(unload.childrenPreserved&&unload.storePreserved&&unload.styleRemoved);
  await check('real plugin disposal restores native sidebar registration',unload);
  assert.deepEqual(qa.errors,[]);assert.deepEqual(qa.httpErrors,[]);await check('no page exceptions or HTTP errors');
}catch(error){evidence.failure=String(error.stack||error);await page.screenshot({path:join(out,'fts-off-failure.png')});throw error;}
finally{await writeFile(join(out,'fts-off.json'),JSON.stringify(evidence,null,2));await qa.close();}
