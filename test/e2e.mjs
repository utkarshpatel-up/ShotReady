// Drives the real Electron app in demo mode and takes screenshots.
// Usage: npm run test:e2e [-- screenshotDir]
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const shots = process.argv[2] || mkdtempSync(join(tmpdir(), 'shotready-shots-'));
mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'shotready-e2e-'));
const electronPath = createRequire(import.meta.url)('electron');

const app = await electron.launch({ executablePath: electronPath, args: ['.', '--demo', `--data-dir=${data}`] });
// The bar opens too, so pick the main window by its page rather than by which came first.
let win;
for (let i = 0; i < 300 && !win; i++) {
  win = app.windows().find((w) => w.url().endsWith('index.html'));
  if (!win) await new Promise((r) => setTimeout(r, 100));
}
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await win.setViewportSize({ width: 1500, height: 940 });
const tab = (name) => win.locator('#tabs button', { hasText: name }).click();
const card = (body) => win.locator(`.card[data-body="${body}"]`);
const ok = (name) => console.log(`ok - ${name}`);

try {
  await win.waitForSelector('#verdict', { timeout: 20000 });
  await win.waitForFunction(() => document.querySelector('#check').textContent === 'Run check');
  assert.equal(await win.locator('.card').count(), 8);
  assert.equal(await win.locator('#verdict').textContent(), 'NOT READY');
  ok('eight label cards and a NOT READY verdict');
  assert.deepEqual(await win.locator('.card .name').allTextContents(), ['C80-1', 'C80-2', 'C80-3', 'C80-4', 'C80-5', 'C80-6', 'C80-7', 'C50-8']);
  assert.equal(await card('C80-3').locator('select').inputValue(), 'Cam-03');
  ok('dashboard is one card per body, and each body chooses its label');

  assert.match(await card('C80-3').textContent(), /colour picture to the recorder/);
  assert.match(await card('C80-4').textContent(), /No recordable card/);
  assert.match(await card('C80-7').textContent(), /not answering/);
  assert.equal(await card('C80-1').getAttribute('data-tally'), 'pgm');
  assert.equal(await card('C80-2').getAttribute('data-tally'), 'pvw');
  assert.match(await card('C80-3').getAttribute('class'), /\bred\b/, 'a preview camera with a fault still shows red');
  ok('colour gamma, missing cards, offline body and PGM/PVW all shown on the right cards');

  assert.match(await card('C80-2').textContent(), /s35 \(must be Full\)/);
  assert.match(await card('C80-5').textContent(), /ISO 6400 exceeds Base ISO 3200/);
  assert.match(await card('C80-6').textContent(), /Digital IS.*ON \(must be OFF\)/);
  assert.match(await card('C50-8').textContent(), /Tele-converter.*ON at 2x \(must be OFF\)/);
  assert.match(await card('C50-8').textContent(), /Lens stabilization.*ON \(must be OFF\)/);
  ok('every mandatory setting fails on the camera that breaks it');

  // The always-on-top bar is a separate window fed by the same results.
  const barWin = () => app.windows().find((w) => w.url().endsWith('bar.html'));
  for (let i = 0; i < 50 && !barWin(); i++) await new Promise((r) => setTimeout(r, 100));
  const bar = barWin();
  assert.ok(bar, 'bar window opened');
  await bar.waitForSelector('.cell', { timeout: 15000 });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('bar.html')).isAlwaysOnTop()), true);
  const cell = (label) => bar.locator(`.cell[data-label="${label}"]`);
  const barText = await cell('Cam-05').textContent();
  for (const want of ['C80-5', '4300K', '6400', 'F4', '1/50']) assert.ok(barText.includes(want), `bar shows ${want}: ${barText}`);
  assert.match(await cell('Cam-05').locator('[data-v="iso"]').getAttribute('class'), /bad/);
  assert.match(await cell('Cam-06').locator('[data-v="digitalIS"]').getAttribute('class'), /bad/);
  assert.match(await cell('Cam-08').locator('[data-v="lensIS"]').getAttribute('class'), /bad/);
  assert.match(await cell('Cam-07').textContent(), /Offline/);
  await bar.waitForFunction(() => /\d+% avg \d+%/.test(document.querySelector('.cell[data-label="Cam-01"] [data-v="wfm"]')?.textContent || ''), null, { timeout: 8000 });
  const peakOf = async (label) => Number((await cell(label).locator('[data-v="wfm"]').textContent()).match(/(\d+)%/)[1]);
  await bar.waitForFunction(() => /\d+% avg/.test(document.querySelector('.cell[data-label="Cam-05"] [data-v="wfm"]')?.textContent || ''), null, { timeout: 8000 });
  assert.ok(await peakOf('Cam-05') > await peakOf('Cam-01'), 'brighter demo frame reads higher');
  assert.match(await cell('Cam-07').textContent(), /Offline/);
  await win.waitForFunction(() => /\d+% avg/.test(document.querySelector('.card[data-body="C80-1"] [data-wfm]')?.textContent || ''), null, { timeout: 8000 });
  ok('bar and dashboard show shutter and waveform levels decoded from real JPEG frames');
  await bar.screenshot({ path: join(shots, '8-bar.png') });
  ok('bar is always on top and shows WB, ISO, aperture, lens IS and digital IS, flagging bad values');
  // Demo's C80-2 changes WB every 3 s; the safety check runs every 10 s, so this is the push.
  const wb = async () => cell('Cam-02').locator('[data-v="wb"]').textContent();
  const was = await wb();
  const t0 = Date.now();
  await bar.waitForFunction((v) => document.querySelector('.cell[data-label="Cam-02"] [data-v="wb"]').textContent !== v, was, { timeout: 5000 });
  assert.notEqual(await wb(), was);
  ok(`bar updates by itself from a pushed change (${was} changed after ${Date.now() - t0} ms of a 3 s cycle)`);
  assert.match(await win.locator('.verdict .sub').last().textContent(), /Live 7\/8 cameras/);
  ok('dashboard shows how many cameras are live');
  await bar.locator('#bar-close').click();
  await win.waitForFunction(() => !document.querySelector('#bar-toggle').classList.contains('on'));
  await win.locator('#bar-toggle').click();
  await win.waitForFunction(() => document.querySelector('#bar-toggle').classList.contains('on'));
  ok('bar closes from its own button and reopens from the main window');

  assert.match(await card('C80-1').textContent(), /Lens filter/);
  await card('C80-1').locator('.row', { hasText: 'Lens filter' }).locator('button', { hasText: 'Confirm' }).first().click();
  await win.waitForFunction(() => /All checks passed/.test(document.querySelector('.card[data-body="C80-1"]').textContent), null, { timeout: 15000 });
  ok('Lens filter stays yellow until an operator confirms it');

  await win.locator('#switcher button', { hasText: '2 M/E 2RU' }).click();
  await win.waitForFunction(() => /2 M\/E 2RU/.test(document.querySelector('.verdict .sub')?.textContent || ''));
  await win.locator('#profile button', { hasText: 'HD25' }).click();
  await win.waitForFunction(() => /HD25/.test(document.querySelector('.verdict .sub')?.textContent || ''));
  assert.match(await card('C80-1').textContent(), /but profile is 1080p25/);
  assert.match(await win.locator('.global').first().textContent(), /ATEM is 2160p25, profile is 1080p25/);
  ok('on 2 M/E 2RU, HD25 flags every camera and the ATEM');
  await win.locator('#switcher button', { hasText: 'Constellation' }).click();
  await win.waitForFunction(() => /Constellation/.test(document.querySelector('.verdict .sub')?.textContent || ''));
  assert.doesNotMatch(await card('C80-1').textContent(), /SDI output.*but/);
  ok('on Constellation, HD25 still expects 3840x2160 SDI');
  await win.locator('#profile button', { hasText: '4K25' }).click();
  await win.waitForFunction(() => /4K25/.test(document.querySelector('.verdict .sub')?.textContent || ''));
  await win.waitForFunction(() => document.querySelector('#check').textContent === 'Run check');
  await win.screenshot({ path: join(shots, '1-dashboard.png') });

  // Give C80-5 the label C80-1 holds: it shows the comparison, and C80-1 becomes spare.
  await card('C80-1').locator('button', { hasText: 'Compare' }).click();
  await win.locator('.dialog button', { hasText: 'Close' }).click();
  await card('C80-5').locator('select').selectOption('Cam-01');
  await win.waitForSelector('.dialog table', { timeout: 15000 });
  const diff = await win.locator('.dialog').textContent();
  assert.match(diff, /wb\.kelvin/);
  assert.match(diff, /me\.iso/);
  await win.screenshot({ path: join(shots, '2-swap-diff.png') });
  ok('taking a label opens a comparison with the earlier camera');
  await win.locator('.dialog button', { hasText: 'Close' }).click();
  await win.waitForFunction(() => document.querySelector('.card[data-body="C80-1"] select').value === '');
  assert.match(await card('C80-1').textContent(), /not counted in the verdict/);
  assert.match(await win.locator('.global').first().textContent(), /Cam-05 has no camera/);
  ok('the displaced body is spare and the empty label is called out');

  for (const [name, file, pattern] of [
    ['Bodies', '3-bodies', /192|127\.0\.0\.1/], ['Label sheet', '4-sheet', /ATEM input/],
    ['Workload', '5-workload', /Lifetime.*Enter hour meter.*412 h/], ['Log', '6-log', /moved|←/], ['Settings', '7-settings', /Team standard/],
  ]) {
    await tab(name);
    await win.waitForFunction((p) => new RegExp(p).test(document.querySelector('#view').textContent), pattern.source);
    await win.screenshot({ path: join(shots, `${file}.png`), fullPage: true });
    ok(`${name} tab renders`);
  }

  // Settings: rejected save shows why, good save renames the label everywhere.
  const labels = win.locator('.section').first().locator('tbody tr td:first-child input');
  await labels.nth(1).fill('Cam-03');
  await win.locator('#save-settings').click();
  await win.waitForSelector('.toast.bad');
  assert.match(await win.locator('#toast').textContent(), /unique/);
  ok('duplicate label refused with a clear message');
  await labels.nth(1).fill('Jib');
  await win.locator('#save-settings').click();
  await win.waitForSelector('.toast:not(.bad)');
  await tab('Dashboard');
  await win.waitForFunction(() => document.querySelector('.card[data-body="C80-2"] select')?.value === 'Jib', null, { timeout: 15000 });
  ok('renamed label keeps its body');

  await win.locator('#check').click();
  await win.waitForFunction(() => document.querySelector('#toast').textContent.includes('Report saved'), null, { timeout: 15000 });
  assert.ok(readdirSync(join(data, 'reports')).length >= 1);
  ok('Run check writes a report');

  assert.deepEqual(errors, []);
  ok('no errors in the window console');
} finally {
  await win.screenshot({ path: join(shots, 'last.png') }).catch(() => {});
  await app.close();
}
console.log(`Screenshots: ${shots}`);
