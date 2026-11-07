// Helpers for repeatable official Web acceptance with an owned Edge process.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { readFile, appendFile, mkdir, writeFile } from 'node:fs/promises';

export async function launchQA(name) {
  assert.ok(process.env.DSH_QA_MODULES && process.env.DSH_QA_HOME && process.env.DSH_QA_OUTPUT);
  const home = resolve(process.env.DSH_QA_HOME);
  assert.match(home, /[\\/]message-edit-dsh-qa-[^\\/]+$/);
  const out = resolve(process.env.DSH_QA_OUTPUT);
  await mkdir(out, { recursive: true });
  const require = createRequire(join(resolve(process.env.DSH_QA_MODULES), 'package.json'));
  const { chromium } = require('playwright-core');
  const logBytes = await readFile(process.env.DSH_QA_HOST_LOG);
  const log = logBytes.toString(logBytes[0] === 0xff && logBytes[1] === 0xfe ? 'utf16le' : 'utf8');
  // Keep the ephemeral local auth token inside owned scratch, never reports.
  const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?[^\s\x1b]+/)?.[0]
    || log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(url, 'Wait for official host startup before running browser QA');
  const server = await chromium.launchServer({ executablePath: process.env.DSH_QA_EDGE ||
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const pid = server.process().pid;
  let browser, context, page;
  const errors = [], httpErrors = [];
  const close = async () => {
    try { await browser?.close(); }
    finally {
      await server.close();
      await appendFile(join(out, 'processes.jsonl'), JSON.stringify({ name, pid, stopped: new Date().toISOString() }) + '\n');
    }
  };
  try {
  await appendFile(join(out, 'processes.jsonl'), JSON.stringify({ name, pid, started: new Date().toISOString() }) + '\n');
  browser = await chromium.connect(server.wsEndpoint());
  context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'en-US',
    ...(process.env.DSH_QA_STORAGE ? { storageState: process.env.DSH_QA_STORAGE } : {}) });
  // Observe the actual plugin context without replacing host stores/renderers.
  await context.addInitScript(() => {
    let loader;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      get: () => loader,
      set(value) {
        loader = value;
        const wrap = load => function (definition) {
          if (definition.id === 'dsh-plugin-message-edit') {
            const factory = definition.factory;
            definition = { ...definition, factory: (...args) => {
              const plugin = factory(...args);
              const apply = plugin.apply;
              return { ...plugin, apply(ctx, ...rest) {
                window.__qa = { ctx };
                return apply(ctx, ...rest);
              } };
            } };
          }
          return load.call(this, definition);
        };
        let wrapped = wrap(value.load);
        Object.defineProperty(value, 'load', { configurable: true, get: () => wrapped,
          set: load => { wrapped = wrap(load); } });
      },
    });
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('response', response => { if (response.status() >= 400) httpErrors.push({ url: new URL(response.url()).pathname, status: response.status() }); });
    await page.goto(url);
    await page.waitForFunction(() => window.__qa?.ctx?.get('sessions')?.list, undefined, { timeout: 30000 });
    await page.waitForFunction(() => window.__qa.ctx.get('sessions').list.getSnapshot().byId['session-qa-live']);
    const notice = page.getByRole('button', { name: 'Continue', exact: true });
    if (await notice.isVisible()) await notice.click();
    return { page, browser, context, out, home, origin: new URL(url).origin, errors, httpErrors, close };
  } catch (error) {
    try { if (page) await writeFile(join(out, `${name}-startup.json`), JSON.stringify({ errors, httpErrors,
      text: await page.locator('body').innerText(), scripts: await page.locator('script[src]').evaluateAll(es => es.map(e => e.src)),
      loader: await page.evaluate(() => ({ type: typeof window.__ModuleLoader__, keys: Object.keys(window.__qa || {}) })) }, null, 2)); }
    finally { await close(); }
    throw error;
  }
}

export async function settleTree(page) {
  await page.locator('.mtx-card').first().waitFor();
  await page.evaluate(() => new Promise((resolve, reject) => {
    let last = '', stable = 0;
    const deadline = performance.now() + 10000;
    const frame = () => {
      if (performance.now() > deadline) { reject(new Error('Versions tree did not settle within 10 seconds')); return; }
      const now = [...document.querySelectorAll('.mtx-card')].map(e => e.style.transform).join('|');
      stable = now === last ? stable + 1 : 0;
      last = now;
      if (stable >= 8) resolve(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  const cards = await page.locator('.mtx-card').evaluateAll(es => es.map(e => {
    const r = e.getBoundingClientRect(); return { id: e.dataset.id, x: r.x, y: r.y, w: r.width, h: r.height };
  }));
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
      `Settled tree cards overlap: ${a.id}, ${b.id}`);
  }
  return cards;
}
