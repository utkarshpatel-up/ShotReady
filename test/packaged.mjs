// Launches the BUILT app in live mode: proves the bundled ATEM library and native module
// load from the package, the password is encrypted, and an absent ATEM does no harm.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const exe = resolve('dist/win-unpacked/ShotReady.exe');
const data = mkdtempSync(join(tmpdir(), 'shotready-pkg-'));
const app = await electron.launch({ executablePath: exe, args: [`--data-dir=${data}`] });
// The bar opens too, so pick the main window by its page rather than by which came first.
let win;
for (let i = 0; i < 300 && !win; i++) {
  win = app.windows().find((w) => w.url().endsWith('index.html'));
  if (!win) await new Promise((r) => setTimeout(r, 100));
}
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
try {
  await win.waitForSelector('#verdict', { timeout: 60000 });
  assert.equal(await win.locator('#demo').isHidden(), true);
  assert.equal(await win.locator('.card').count(), 8);
  console.log('ok - starts in live mode with the 8 labels from cameras.json');
  console.log('     verdict:', await win.locator('#verdict').textContent());

  await win.locator('.setup button').click();
  await win.waitForFunction(() => document.querySelectorAll('.card select')[0]?.value === 'Cam-01', null, { timeout: 60000 });
  const sel = await win.locator('.card select').evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(sel, ['Cam-01', 'Cam-02', 'Cam-03', 'Cam-04', 'Cam-05', 'Cam-06', 'Cam-07', 'Cam-08']);
  console.log('ok - Assign in order puts each body on its label');

  await win.locator('#tabs button', { hasText: 'Settings' }).click();
  await win.waitForSelector('#save-settings');
  const conn = win.locator('.section', { hasText: 'Connections' });
  await conn.locator('label', { hasText: 'ATEM IP' }).locator('input').fill('127.0.0.1');
  await conn.locator('label', { hasText: 'user name' }).locator('input').fill('admin');
  await conn.locator('label', { hasText: 'password' }).locator('input').fill('pkg-test-secret');
  await win.locator('#save-settings').click();
  await win.waitForSelector('.toast:not(.bad)', { timeout: 60000 });
  const cfg = readFileSync(join(data, 'cameras.json'), 'utf8');
  assert.ok(!cfg.includes('pkg-test-secret'));
  assert.ok(JSON.parse(cfg).auth.passEnc);
  console.log('ok - password saved encrypted, not in plain text');

  await win.locator('#tabs button', { hasText: 'Dashboard' }).click();
  await win.waitForFunction(() => /ATEM/.test(document.querySelector('.atem-status')?.textContent || ''), null, { timeout: 60000 });
  // The library loads lazily: give it time, then read the status from a fresh check.
  await new Promise((r) => setTimeout(r, 5000));
  await win.locator('#check').click();
  await win.waitForFunction(() => document.querySelector('#check').textContent === 'Run check', null, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 500));
  const s = win.locator('.atem-status').first();
  const g = `${await s.textContent()} ${await s.getAttribute('title')}`;
  assert.ok(!/failed to load/.test(g), g);
  console.log('ok - real ATEM library loaded in the running app; absent ATEM shows:', g);
  assert.ok(app.windows().some((w) => w.url().endsWith('bar.html')));
  console.log('ok - always-on-top bar opens from the built app');
  assert.deepEqual(errors, []);
  await win.screenshot({ path: process.argv[2] || join(data, 'live.png') });
} finally {
  await app.close();
}
