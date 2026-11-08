// Smoke test: drives the real Electron app in demo mode and takes screenshots.
// Usage: npm run test:e2e [-- screenshotDir]
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const shots = process.argv[2] || mkdtempSync(join(tmpdir(), 'shotready-shots-'));
mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'shotready-e2e-'));
const electronPath = createRequire(import.meta.url)('electron');
const ok = (name) => console.log(`ok - ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({ executablePath: electronPath, args: ['.', '--demo', `--data-dir=${data}`] });
const pageOf = async (name) => {
  for (let i = 0; i < 300; i++) {
    const w = app.windows().find((x) => x.url().endsWith(name));
    if (w) return w;
    await sleep(100);
  }
  throw new Error(`no ${name}`);
};
const win = await pageOf('index.html');
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await win.setViewportSize({ width: 1500, height: 940 });
const tab = (name) => win.locator('#tabs button', { hasText: name }).click();
const card = (body) => win.locator(`.card[data-body="${body}"]`);
const box = (body) => card(body).locator('.fbox');
const loaded = (body) => card(body).locator('img').evaluate((i) => i.naturalWidth > 0);

try {
  await win.waitForSelector('#verdict', { timeout: 20000 });
  await win.waitForFunction(() => document.querySelector('#check').textContent === 'Run check');
  assert.equal(await win.locator('.card').count(), 8);
  assert.equal(await win.locator('#verdict').textContent(), 'NOT READY');
  ok('dashboard: one card per camera, verdict shown');

  // 1. Live pictures on the cards, and they keep running while the screen rebuilds.
  await win.waitForFunction(() => [...document.querySelectorAll('.card:not(.offline) img')].every((i) => i.naturalWidth > 0), null, { timeout: 10000 });
  assert.equal(await win.locator('.card:not(.offline) img').count(), 7);
  assert.equal(await win.locator('.card.offline .fnone').first().isVisible(), true, 'the offline camera says No video');
  await win.waitForFunction(() => /\d+ fps/.test(document.querySelector('.card[data-body="C80-2"] .ffps')?.textContent || ''), null, { timeout: 5000 });
  await sleep(2500); // the first reading covers only part of a second
  const fps = Number((await card('C80-2').locator('.ffps').textContent()).match(/(\d+) fps/)[1]);
  assert.ok(fps >= 5, `frame rate ${fps}`);
  await win.evaluate(() => { document.querySelector('.card[data-body="C80-2"] img').dataset.mark = 'same'; });
  await sleep(3500); // C80-2's white balance changes every 3 s, which rebuilds the cards
  assert.equal(await card('C80-2').locator('img').getAttribute('data-mark'), 'same', 'the picture element survives the rebuild');
  assert.equal(await loaded('C80-2'), true);
  assert.match(await card('C80-2').locator('.ffps').textContent(), /\d+ fps/, 'frames still arriving');
  ok(`live pictures on 7 cameras at ${fps} fps, and they survive screen updates`);
  await win.screenshot({ path: join(shots, '1-dashboard.png') });

  // 2. Focus box: green when in focus, red when not, none in auto focus.
  assert.match(await box('C80-2').getAttribute('class'), /\bok\b/);
  assert.match(await box('C80-3').getAttribute('class'), /\bbad\b/);
  assert.match(await box('C80-4').getAttribute('class'), /\bbad\b/);
  assert.match(await box('C80-5').getAttribute('class'), /\bgone\b/);
  assert.match(await card('C80-2').locator('.fchip').textContent(), /IN FOCUS/);
  assert.match(await card('C80-3').locator('.fchip').textContent(), /OUT OF FOCUS · front focus/);
  assert.match(await card('C80-4').locator('.fchip').textContent(), /back focus/);
  assert.match(await card('C80-5').locator('.fchip').textContent(), /no focus data/);
  const was = await box('C80-1').getAttribute('class');
  await win.waitForFunction((w) => document.querySelector('.card[data-body="C80-1"] .fbox').className !== w, was, { timeout: 6000 });
  ok('focus box: green in focus, red out of focus, none in auto focus, and it changes live');

  // 3. The checks are on the second tab.
  assert.equal(await win.locator('.card .rows').count(), 0, 'no check rows left on the dashboard');
  assert.equal((await win.locator('#tabs button').allTextContents()).slice(0, 2).join(), 'Dashboard,Checks');
  await tab('Checks');
  await win.waitForSelector('.panel[data-body="C80-3"]');
  const panel = (body) => win.locator(`.panel[data-body="${body}"]`);
  assert.match(await panel('C80-3').textContent(), /colour picture to the recorder/);
  assert.match(await panel('C80-6').textContent(), /Digital IS.*ON \(must be OFF\)/);
  assert.match(await panel('C50-8').textContent(), /Tele-converter.*ON at 2x \(must be OFF\)/);
  assert.match(await panel('C80-7').textContent(), /not answering/);
  for (const gone of ['Firmware', 'Sensor mode', 'Lens filter', 'Lens stabilization']) assert.doesNotMatch(await panel('C80-6').textContent(), new RegExp(gone), `${gone} is gone`);
  await win.screenshot({ path: join(shots, '2-checks.png') });
  ok('checks tab: every check is there, and the removed checks are gone');

  // 4. Pictures are only fetched while the dashboard is showing.
  assert.equal(await win.locator('.card img').count(), 0, 'cards are not on screen');
  await win.waitForFunction(() => Object.keys(window).length > 0); // page still alive
  await tab('Dashboard');
  await win.waitForFunction(() => [...document.querySelectorAll('.card:not(.offline) img')].every((i) => i.naturalWidth > 0), null, { timeout: 10000 });
  ok('leaving the dashboard stops the pictures and coming back restarts them');

  // 5. The always-on-top bar still works.
  const bar = await pageOf('bar.html');
  await bar.waitForSelector('.cell [data-v="wb"]', { timeout: 15000 });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('bar.html')).isAlwaysOnTop()), true);
  await bar.screenshot({ path: join(shots, '3-bar.png') });
  ok('bar: open and always on top');

  assert.deepEqual(errors, []);
  ok('no errors in the window console');
} finally {
  await win.screenshot({ path: join(shots, 'last.png') }).catch(() => {});
  await app.close();
}
console.log(`Screenshots: ${shots}`);
