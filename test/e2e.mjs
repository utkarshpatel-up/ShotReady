// Smoke test: drives the real Electron app in demo mode and takes screenshots.
// Usage: npm run test:e2e [-- screenshotDir]
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { readMp4 } from '../src/core/mp4.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const shots = process.argv[2] || mkdtempSync(join(tmpdir(), 'shotready-shots-'));
mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'shotready-e2e-'));
const electronPath = createRequire(import.meta.url)('electron');
const ok = (name) => console.log(`ok - ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A test LUT that turns every pixel red, so the picture shows at a glance whether it is applied.
const redLut = join(data, 'red-test.cube');
writeFileSync(redLut, ['LUT_3D_SIZE 2', ...Array(8).fill('1.0 0.0 0.0')].join('\n'));
// Chromium's software GPU stands in for a graphics card, so the LUT view runs on a test machine too.
const app = await electron.launch({
  executablePath: electronPath, args: ['.', '--demo', `--data-dir=${data}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  env: { ...process.env, SHOTREADY_TEST_LUT: redLut, SHOTREADY_TEST_PLAYOUT: '1', SHOTREADY_TEST_VIDEO: `${resolve('test/fixtures/bars.webm')}|${resolve('test/fixtures/bars.mp4')}`, SHOTREADY_TEST_PLAYOUT_LUT: redLut, SHOTREADY_TEST_SCREEN_LUT: redLut, SHOTREADY_TEST_STREAM_AUDIO: 'opus' },
});
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
  await win.waitForSelector('#atem-status', { timeout: 20000 });
  await win.waitForFunction(() => document.querySelector('#check').textContent === 'Run check');
  assert.equal(await win.locator('.card').count(), 8);
  assert.equal(await win.locator('#atem-status').textContent(), 'CONNECTED');
  assert.match(await win.locator('.atem-status').textContent(), /ATEM 2 M\/E Constellation 4K · simulated · 2160p25/);
  assert.match(await win.locator('#checks-sum').textContent(), /Camera checks.*\d+ red.*Connection \(C80-7\)/);
  ok('dashboard: one card per camera, ATEM CONNECTED top left, camera checks beside it with their reasons');

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
  await win.waitForFunction(() => /\d+% avg \d+%/.test(document.querySelector('[data-wfm="C80-2"]')?.textContent || ''), null, { timeout: 8000 });
  const log = await win.evaluate(() => window.shotready.call('events'));
  assert.ok(!log.some((e) => /measured on the main thread/.test(e.text)), 'no camera fell back to the main thread');
  assert.ok(log.some((e) => /Threads: the main thread, 8 camera threads/.test(e.text)));
  ok(`waveform measured in the camera threads: C80-2 ${await card('C80-2').locator('[data-wfm]').textContent()}`);
  await win.screenshot({ path: join(shots, '1-dashboard.png') });

  // 2. Focus box: green when in focus, red when not, none in auto focus.
  assert.match(await box('C80-2').getAttribute('class'), /\bok\b/);
  assert.match(await box('C80-3').getAttribute('class'), /\bbad\b/);
  assert.match(await box('C80-4').getAttribute('class'), /\bbad\b/);
  assert.match(await box('C80-5').getAttribute('class'), /\bgone\b/);
  assert.match(await card('C80-2').locator('.fchip').textContent(), /IN FOCUS/);
  assert.match(await card('C80-3').locator('.fchip').textContent(), /OUT OF FOCUS · front focus/);
  assert.match(await card('C80-4').locator('.fchip').textContent(), /back focus/);
  assert.match(await card('C80-4').locator('.facts').textContent(), /FocusMF/, 'C80-4 has its lens on MF');
  assert.equal(await card('C80-5').locator('.iso-over').textContent(), '6400', 'ISO above the Base ISO is red');
  assert.equal(await card('C80-1').locator('.iso-over').count(), 0);
  assert.equal(await box('C80-4').isVisible(), true, 'a camera on MF still shows where its focus is');
  assert.match(await card('C80-5').locator('.fchip').textContent(), /Focus not detected/);
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
  assert.doesNotMatch(await panel('C80-2').textContent(), /Hardware|Compare|Save as reference/);
  ok('checks tab: every check is there, and the removed checks are gone');

  // 4. Pictures keep running on other tabs, so they are there the moment the Dashboard returns.
  await sleep(1500);
  await tab('Dashboard');
  await win.waitForSelector('.card img');
  assert.equal(await win.locator('.card:not(.offline) img').evaluateAll((l) => l.every((i) => i.naturalWidth > 0)), true, 'no wait after switching tabs');
  assert.match(await card('C80-2').locator('.ffps').textContent(), /\d+ fps/);
  ok('pictures keep running while another tab is open');

  // Cards can be moved, and stay moved.
  const head = await card('C80-3').locator('.name').boundingBox();
  const target = await card('C80-1').locator('.name').boundingBox();
  await win.mouse.move(head.x + 5, head.y + 5);
  await win.mouse.down();
  await win.mouse.move(target.x + 20, target.y + 5, { steps: 8 });
  await win.mouse.up();
  await sleep(300);
  const names = () => win.locator('.card .name').allTextContents();
  assert.equal((await names())[0], 'C80-3', 'dragged to the front');
  await sleep(3500); // a screen update rebuilds the cards
  assert.equal((await names())[0], 'C80-3', 'the new order survives a screen update');
  ok('camera cards can be dragged and stay where they are put');

  // A press low on the page leaves the page where it is, through the rebuilds that follow.
  await win.setViewportSize({ width: 1200, height: 700 });
  await sleep(300);
  const view = () => win.evaluate(() => document.getElementById('view').scrollTop);
  await win.evaluate(() => { const v = document.getElementById('view'); v.scrollTop = v.scrollHeight; });
  const low = await view();
  assert.ok(low > 300, `the page scrolls (${low})`);
  const last = await win.locator('.card').last().getAttribute('data-body');
  await card(last).locator('.one-shot-btn').click();
  await sleep(3500); // C80-2's white balance changes every 3 s, which rebuilds the cards
  assert.equal(await view(), low, '1-Shot AF does not move the page');
  await card(last).locator('.adjust-btn').click();
  await sleep(500);
  assert.ok(Math.abs((await view()) - low) < 5, 'Adjust does not jump to the top either');
  await card(last).locator('.adjust-btn').click();
  await win.setViewportSize({ width: 1500, height: 940 });
  ok('pressing a button on a card low on the page keeps the page where it is');

  // AF frame on Auto: said on the picture, and a click focuses (the camera picks the subject).
  await win.evaluate(() => { document.getElementById('view').scrollTop = 0; });
  assert.equal(await card('C80-6').locator('.fframe').isVisible(), true);
  assert.equal(await card('C80-1').locator('.fframe').isVisible(), false);
  await card('C80-6').locator('.feed').click();
  await win.waitForFunction(() => /1-Shot AF done.*AF frame is on Auto/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  await win.evaluate(() => { document.getElementById('toast').hidden = true; });
  await card('C80-6').locator('.feed').click();
  await sleep(800);
  assert.equal(await win.locator('#toast').isHidden(), true, 'the explanation is not repeated on every click');
  ok('AF frame on Auto: shown on the picture, a click does 1-Shot AF, and the notice is not repeated');

  // People: the camera's detected people are drawn, the one under the cursor is the one a click picks,
  // and the AF frame goes onto that person.
  await win.evaluate(() => { document.getElementById('view').scrollTop = 0; });
  await win.waitForFunction(() => document.querySelectorAll('.card[data-body="C80-2"] .fperson').length === 2, null, { timeout: 5000 });
  const feed2 = card('C80-2').locator('.feed');
  const size = await feed2.boundingBox();
  await feed2.hover({ position: { x: size.width * 0.68, y: size.height * 0.5 } });
  await win.waitForFunction(() => document.querySelectorAll('.card[data-body="C80-2"] .fperson')[1]?.classList.contains('hover'), null, { timeout: 3000 });
  assert.equal(await card('C80-2').locator('.fperson.hover').count(), 1);
  await card('C80-2').screenshot({ path: join(shots, '7-people.png') });
  await feed2.click({ position: { x: size.width * 0.68, y: size.height * 0.5 } });
  const centre = () => box('C80-2').evaluate((b) => [parseFloat(b.style.left) + parseFloat(b.style.width) / 2, parseFloat(b.style.top) + parseFloat(b.style.height) / 2]);
  await win.waitForFunction(() => { const b = document.querySelector('.card[data-body="C80-2"] .fbox'); return Math.abs(parseFloat(b.style.left) + parseFloat(b.style.width) / 2 - 70) < 1; }, null, { timeout: 5000 });
  const [cx, cy] = await centre();
  assert.ok(Math.abs(cy - 45) < 1, `the AF frame is on the person's face, not the click (${cx}, ${cy})`);
  await win.waitForFunction(() => document.querySelectorAll('.card[data-body="C80-2"] .fperson')[1]?.classList.contains('track'), null, { timeout: 3000 });
  ok('people: the person under the cursor is highlighted, and a click puts the AF frame on that person');

  // AF frame on Auto: a click on a person offers a type that can be placed, and one button does it.
  const feed6 = card('C80-6').locator('.feed');
  const size6 = await feed6.boundingBox();
  await feed6.click({ position: { x: size6.width * 0.82, y: size6.height * 0.46 } });
  await win.waitForSelector('#toast .toast-act', { timeout: 5000 });
  assert.match(await win.locator('#toast').textContent(), /AF frame is on Auto, so People Priority picks the person itself/);
  assert.equal(await win.locator('#toast .toast-act').textContent(), 'Use Zone AF frame');
  await win.locator('#toast .toast-act').click();
  await win.waitForFunction(() => /AF frame set to Zone and on the person you clicked/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  await win.waitForFunction(() => document.querySelector('.card[data-body="C80-6"] .fframe').hidden, null, { timeout: 8000 });
  await win.waitForFunction(() => { const b = document.querySelector('.card[data-body="C80-6"] .fbox'); return Math.abs(parseFloat(b.style.left) + parseFloat(b.style.width) / 2 - 82) < 1; }, null, { timeout: 5000 });
  ok('people with the AF frame on Auto: one button sets Zone and focuses the person clicked');

  // Adjust one camera from its card.
  await card('C80-1').locator('.adjust-btn').click();
  await win.waitForSelector('.card[data-body="C80-1"] .adjust select');
  assert.deepEqual(await card('C80-1').locator('.adjust label').evaluateAll((l) => l.map((x) => x.firstChild.textContent)), ['Shutter', 'White balance', 'Kelvin', 'Tint', 'Base ISO', 'ISO', 'ND', 'Iris', 'AF frame', 'OSD']);
  await card('C80-1').locator('select[aria-label="ISO on C80-1"]').selectOption('1600');
  await win.waitForFunction(() => /1600/.test(document.querySelector('.card[data-body="C80-1"] .facts').textContent), null, { timeout: 8000 });
  await card('C80-1').locator('select[aria-label="Shutter on C80-1"]').selectOption('60');
  await win.waitForFunction(() => document.querySelector('.card[data-body="C80-1"] .facts').textContent.includes('1/60'), null, { timeout: 8000 });
  await win.screenshot({ path: join(shots, '5-adjust.png') });
  await card('C80-1').locator('.adjust-btn').click();
  await win.waitForFunction(() => !document.querySelector('.card[data-body="C80-1"] .adjust'), null, { timeout: 5000 });
  ok('Adjust changes shutter and ISO on a camera and closes again');

  // Digital IS for every camera, from one camera's Adjust panel. C80-6 starts with it on.
  await card('C80-2').locator('.adjust-btn').click();
  await win.waitForSelector('.card[data-body="C80-2"] .dis-row');
  await card('C80-2').locator('.dis-row button', { hasText: 'Off' }).click();
  await win.waitForFunction(() => /Digital IS OFF: .*C80-6/.test(document.getElementById('toast').textContent), null, { timeout: 10000 });
  await win.waitForFunction(() => /\(C80-2: OFF\)/.test(document.querySelector('.card[data-body="C80-2"] .dis-row')?.textContent || ''), null, { timeout: 10000 });
  await card('C80-2').locator('.dis-row button', { hasText: 'On' }).click();
  await win.waitForFunction(() => /Digital IS ON: .*C80-2/.test(document.getElementById('toast').textContent), null, { timeout: 10000 });
  await win.waitForFunction(() => /\(C80-2: ON\)/.test(document.querySelector('.card[data-body="C80-2"] .dis-row')?.textContent || ''), null, { timeout: 10000 });
  await card('C80-2').locator('.dis-row button', { hasText: 'Off' }).click();
  await win.waitForFunction(() => /Digital IS OFF/.test(document.getElementById('toast').textContent), null, { timeout: 10000 });
  await card('C80-2').locator('.adjust-btn').click();
  ok('Adjust: Digital IS turns on and off on every camera at once');

  // Record: one click starts, one click stops. Nothing asks first.
  const rec = card('C80-3').locator('.rec-btn');
  await rec.click();
  await win.waitForFunction(() => /Recording/.test([...document.querySelectorAll('.card')].find((c) => /C80-3/.test(c.textContent))?.querySelector('.rec-btn')?.textContent || ''), null, { timeout: 10000 });
  await rec.click();
  await win.waitForFunction(() => /REC/.test([...document.querySelectorAll('.card')].find((c) => /C80-3/.test(c.textContent))?.querySelector('.rec-btn')?.textContent || ''), null, { timeout: 10000 });
  assert.equal(await win.locator('.rec-btn.armed').count(), 0);
  ok('record: one click starts and one click stops, with no question');

  // Copy settings: C80-1 takes C80-2's picture settings back (its ISO and shutter were changed above).
  await card('C80-1').locator('.adjust-btn').click();
  await card('C80-1').locator('.copy-row select').selectOption('C80-2');
  await card('C80-1').locator('.copy-row button').click();
  await win.waitForSelector('.dialog .copy-list');
  const copyNames = await win.locator('.dialog .copy-list tbody td:nth-child(2)').allTextContents();
  assert.ok(copyNames.includes('ISO') && copyNames.includes('Shutter'), copyNames.join());
  assert.ok(!copyNames.includes('diaphragm'), 'iris is not copied');
  await win.locator('.dialog button', { hasText: /^Copy \d+ setting/ }).click();
  await win.waitForFunction(() => /Copied to C80-1/.test(document.querySelector('.dialog')?.textContent || ''), null, { timeout: 10000 });
  await win.locator('.dialog button', { hasText: 'Close' }).click();
  await win.waitForFunction(() => { const t = document.querySelector('.card[data-body="C80-1"] .facts').textContent; return /ISO800/.test(t) && t.includes('1/50'); }, null, { timeout: 8000 });
  await card('C80-1').locator('.adjust-btn').click();
  ok('copy settings: shows what will change, then copies it from one camera to another');

  // Keys: D steps Kelvin on the camera on preview, F1 cuts Media Player 1 to program.
  await win.locator('#tabs button', { hasText: 'Dashboard' }).focus();
  await win.keyboard.press('d');
  await win.waitForFunction(() => /^C80-2: \d+ K$/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  assert.equal(await card('C80-1').locator('.badge.pgm').count(), 1);
  // F1 alone: Media Player 1 on preview, program untouched. Shift+F1: cut to program.
  await win.keyboard.press('F1');
  await win.waitForFunction(() => /Media Player 1 on preview/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  await win.waitForFunction(() => !document.querySelector('.card[data-body="C80-2"] .badge.pvw'), null, { timeout: 5000 });
  assert.equal(await card('C80-1').locator('.badge.pgm').count(), 1, 'program is untouched by F1');
  await win.keyboard.press('Shift+F1');
  await win.waitForFunction(() => /Media Player 1 cut to program/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  await win.waitForFunction(() => !document.querySelector('.card[data-body="C80-1"] .badge.pgm'), null, { timeout: 5000 });
  ok('keys: D steps Kelvin on the camera on preview, F1 puts Media Player 1 on preview, Shift+F1 cuts it to program');

  // The card: Base ISO where ND was, and SDI red when it is not the ATEM's format (C80-6 sends 1080p).
  assert.match(await card('C80-2').locator('.facts').textContent(), /ISO\s*\d+\s*·\s*Base \d+/);
  assert.equal(await card('C80-6').locator('.facts .sdi-bad').textContent(), '1920×1080 25p');
  assert.match(await card('C80-6').locator('.facts .sdi-bad').getAttribute('title'), /the ATEM \(2160p25\) needs 3840x2160 25p/);
  assert.equal(await card('C80-2').locator('.facts .sdi-bad').count(), 0);
  ok('card: Base ISO beside ISO, and SDI red when it does not match the ATEM');

  // The electronic level under the picture: a green dot on an axis within 0.5° of level.
  await win.waitForFunction(() => /Roll \+0\.2°\s*·\s*Tilt −1\.4°/.test(document.querySelector('.card[data-body="C80-1"] [data-level]')?.textContent || ''), null, { timeout: 8000 });
  assert.equal(await card('C80-1').locator('[data-level] .lvl-ok').count(), 1, 'roll level: one dot');
  assert.match(await card('C80-2').locator('[data-level]').textContent(), /Roll \+2\.6°\s*·\s*Tilt \+0\.3°/);
  assert.equal(await card('C80-2').locator('[data-level] .lvl').first().locator('.lvl-ok').count(), 0, 'roll 2.6° has no dot');
  assert.equal((await card('C80-3').locator('[data-level]').textContent()).trim(), '—');
  // Iris under the picture, without opening Adjust (C80-2 has an F2 lens set to F2).
  assert.match(await card('C80-2').locator('.facts').textContent(), /Iris\s*F2(?![.\d])/);
  ok('card: the electronic level, with a green dot when level, and the iris');

  // A camera on program and preview at once: the label dropdown keeps its width, the tags stack.
  await win.evaluate(() => { document.querySelector('.card[data-body="C80-5"] .tally-tags').innerHTML = '<span class="badge pgm">PROGRAM M/E 2</span><span class="badge pvw">PREVIEW</span>'; });
  const sel = await card('C80-5').locator('.card-head select').boundingBox();
  assert.ok(sel.width >= 112, `the dropdown keeps its width (${sel.width})`);
  ok('card header: program and preview tags together do not squash the label dropdown');

  // Number pad, Assistant mode: 2 selects Cam-02's camera; 5 (Cam-05, on program on M/E 2) is refused.
  await win.locator('#keymode button', { hasText: 'Assistant' }).click();
  await win.locator('#tabs button', { hasText: 'Dashboard' }).focus();
  await win.keyboard.press('Numpad2');
  await win.waitForSelector('.card.selected[data-body="C80-2"]', { timeout: 5000 });
  await win.keyboard.press('Numpad5');
  await win.waitForFunction(() => /Cam-05 \(C80-5\) is live and cannot be selected/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  assert.equal(await win.locator('.card.selected').getAttribute('data-body'), 'C80-2', 'the live camera was not selected');
  await win.keyboard.press('s');
  await win.waitForFunction(() => /^C80-2: ISO \d+/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  await win.keyboard.press('w');
  await win.locator('#keymode button', { hasText: 'Mixer' }).click();
  ok('number pad: selects a label\'s camera in Assistant mode, never one on program');

  // Laptop video: its switcher input cannot be a camera's.
  await tab('Settings');
  const laptop = win.locator('input[aria-label="Laptop video ATEM input"]');
  await laptop.fill('2');
  await win.locator('#save-settings').click();
  await win.waitForFunction(() => /Cam-02 and the laptop video point at the same ATEM input \(2\)/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  await laptop.fill('12');
  await win.locator('#save-settings').click();
  await win.waitForFunction(() => document.getElementById('toast').textContent === 'Settings saved', null, { timeout: 10000 });
  ok('laptop video: its own switcher input, refused when a camera label already uses it');

  // Video out: a clip through the inverse LUT, on the output display.
  await tab('Video out');
  await win.waitForFunction(() => /Output display:/.test(document.getElementById('view').textContent), null, { timeout: 5000 });
  assert.match(await win.locator('#view').textContent(), /ATEM input 12 \(Laptop video/);
  const section = (title) => win.locator('.section', { has: win.locator('h2', { hasText: new RegExp(`^${title}$`) }) });
  await win.locator('button', { hasText: 'Add videos…' }).click();
  await win.waitForFunction(() => document.querySelectorAll('.vo-queue tr').length === 2, null, { timeout: 5000 });
  assert.match(await section('Player').textContent(), /bars\.webm/, 'the first clip added is in the player');
  assert.match(await win.locator('#view').textContent(), /None loaded: the video goes out as it is, in colour/);
  await section('Player').locator('label', { hasText: 'Loop' }).locator('input').check();
  // No LUT yet: a warning, and the video goes out all the same.
  await win.locator('button', { hasText: '▶ Play' }).click();
  await win.waitForFunction(() => /Playing without a LUT/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  const out = await pageOf('playout.html');
  await win.waitForFunction(() => /PLAYING/.test(document.querySelector('.vo-live')?.textContent || ''), null, { timeout: 10000 });
  await sleep(600);
  const shotColour = (png) => app.evaluate(({ nativeImage }, b64) => {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    const { width, height } = img.getSize();
    const px = img.toBitmap();
    let r = 0, g = 0, n = 0;
    for (let y = Math.floor(height * 0.3); y < height * 0.7; y += 8) for (let x = Math.floor(width * 0.2); x < width * 0.8; x += 8) { const i = (y * width + x) * 4; g += px[i + 1]; r += px[i + 2]; n++; }
    return { r: r / n, g: g / n };
  }, png.toString('base64'));
  const asIs = await shotColour(await out.screenshot());
  assert.ok(asIs.g > 60, `without a LUT the clip still goes out, as it is (${JSON.stringify(asIs)})`);
  await win.locator('button', { hasText: 'Load .cube…' }).click();
  await win.waitForFunction(() => /red-test\.cube \(2-point\)/.test(document.getElementById('view').textContent), null, { timeout: 5000 });
  await sleep(600);
  const playing = await shotColour(await out.screenshot());
  assert.ok(playing.r > 200 && playing.g < 40, `with the LUT loaded the clip goes out through it (${JSON.stringify(playing)})`);
  await out.screenshot({ path: join(shots, '8-video-out.png') });
  await win.locator('button', { hasText: 'Stop (black)' }).click();
  await sleep(500);
  const stopped = await shotColour(await out.screenshot());
  assert.ok(stopped.r < 10 && stopped.g < 10, `black after Stop (${JSON.stringify(stopped)})`);
  await section('Player').locator('label', { hasText: 'Loop' }).locator('input').uncheck();
  ok('video out: plays without a LUT (with a warning), then through the LUT on the output display, black on Stop');

  // Pre-processing: a copy of the MP4 with the LUT in every frame, the sound kept, played instead.
  const mp4row = win.locator('.vo-queue tr', { hasText: 'bars.mp4' });
  await mp4row.locator('button', { hasText: 'Pre-process' }).click();
  await win.waitForFunction(() => /Pre-processed ✓/.test(document.querySelector('.vo-queue')?.textContent || ''), null, { timeout: 60000 });
  const made = readdirSync(join(data, 'video-out')).filter((f) => f.endsWith('.mp4'));
  assert.equal(made.length, 1);
  const copy = readFileSync(join(data, 'video-out', made[0]));
  const parsed = await readMp4(async (o, l) => copy.subarray(o, o + l), copy.length);
  assert.ok(/^avc1\./.test(parsed.video.codec) && parsed.video.count === 50, `the copy has every frame (${parsed.video.codec}, ${parsed.video.count})`);
  assert.equal(parsed.audio?.entryType, 'Opus', 'the copy keeps the sound');
  await mp4row.locator('button', { hasText: 'Put in the player' }).click();
  await win.waitForFunction(() => /playing the pre-processed copy/.test(document.getElementById('view').textContent), null, { timeout: 5000 });
  await win.screenshot({ path: join(shots, '9-video-out-tab.png') });
  ok('pre-processing: the MP4 is copied with the LUT in every frame and its sound, and the copy is what plays');

  // The queue: the next clip plays by itself at the end of one, and a clip can be removed.
  await win.locator('label', { hasText: 'Next clip plays automatically' }).locator('input').check();
  await win.locator('.vo-queue tr', { hasText: 'bars.webm' }).locator('button', { hasText: 'Put in the player' }).click();
  await win.waitForFunction(() => /bars\.webm/.test(document.querySelector('.vo-queue tr.cued')?.textContent || ''), null, { timeout: 5000 });
  await win.locator('button', { hasText: '▶ Play' }).click();
  await win.waitForFunction(() => /bars\.mp4/.test(document.querySelector('.vo-queue tr.cued')?.textContent || '') && /PLAYING/.test(document.querySelector('.vo-live')?.textContent || ''), null, { timeout: 15000 });
  await win.locator('.vo-queue tr', { hasText: 'bars.webm' }).locator('button[title="Remove from the queue"]').click();
  await win.waitForFunction(() => document.querySelectorAll('.vo-queue tr').length === 1, null, { timeout: 5000 });
  await win.locator('button', { hasText: 'Output on' }).click();
  for (let i = 0; i < 50 && app.windows().some((w) => w.url().endsWith('playout.html')); i++) await sleep(100);
  assert.equal(app.windows().some((w) => w.url().endsWith('playout.html')), false, 'the output window closes when the output is turned off');

  // The Screen source: with one display, it covers that display with its own picture through the LUT.
  await win.locator('select[aria-label="What goes out"]').selectOption('screen');
  await win.waitForFunction(() => /shows itself through the LUT/.test(document.getElementById('view').textContent), null, { timeout: 5000 });
  assert.match(await section('Screen').textContent(), /The inverse LUT, as for clips \(red-test\.cube\)/);
  await win.locator('button', { hasText: 'Output off' }).click();
  const screenOut = await pageOf('playout.html');
  await win.waitForFunction(() => /SENDING THE SCREEN/.test(document.querySelector('.vo-live')?.textContent || ''), null, { timeout: 10000 });
  await sleep(800);
  const sent = await shotColour(await screenOut.screenshot());
  assert.ok(sent.r > 200 && sent.g < 40, `the screen goes out through the LUT (${JSON.stringify(sent)})`);
  await screenOut.screenshot({ path: join(shots, '9b-video-out-screen.png') });
  await win.locator('select[aria-label="Screen LUT"]').selectOption('own');
  await win.waitForFunction(() => /That LUT is not loaded/.test(document.getElementById('view').textContent), null, { timeout: 5000 });
  await section('Screen').locator('button', { hasText: 'Load .cube…' }).click();
  await win.waitForFunction(() => /red-test\.cube \(2-point\)/.test([...document.querySelectorAll('.section')].find((x) => x.querySelector('h2')?.textContent === 'Screen')?.textContent || ''), null, { timeout: 5000 });
  await win.screenshot({ path: join(shots, '9c-video-out-screen-tab.png') });
  // Play sends the clip in the player instead.
  await win.locator('button', { hasText: '▶ Play' }).click();
  await win.waitForFunction(() => document.querySelector('select[aria-label="What goes out"]')?.value === 'clips' && /PLAYING/.test(document.querySelector('.vo-live')?.textContent || ''), null, { timeout: 10000 });
  await win.locator('button', { hasText: 'Output on' }).click();
  for (let i = 0; i < 50 && app.windows().some((w) => w.url().endsWith('playout.html')); i++) await sleep(100);
  assert.equal(app.windows().some((w) => w.url().endsWith('playout.html')), false);
  ok('video out, screen: one display shows itself through the picked LUT, its own LUT loads, Play goes back to clips');
  await tab('Dashboard');
  ok('queue: the next clip plays by itself at the end of one, clips can be removed, and the output closes when off');

  // Live stream: the test destination on this computer, from a simulated video device. The test
  // machine has no AAC encoder, so the sound is encoded as Opus here (a test hook).
  await win.locator('#tabs button', { hasText: 'Stream' }).click();
  await win.waitForSelector('.st-go');
  await win.waitForFunction(() => document.querySelector('.st-preview')?.videoWidth > 0, null, { timeout: 10000 });
  await win.locator('.seg button', { hasText: 'YouTube' }).click();
  await win.locator('.st-go').click();
  await win.waitForFunction(() => /Enter the stream key/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  await win.locator('.seg button', { hasText: 'Test on this computer' }).click();
  await win.locator('.st-go').click();
  await win.waitForFunction(() => /LIVE/.test(document.querySelector('#tabs').textContent) && /Arriving: [1-9]/.test(document.getElementById('view').textContent), null, { timeout: 20000 });
  await win.waitForTimeout(3000);
  await win.screenshot({ path: join(shots, '10-stream.png') });
  await win.locator('.st-go').click();
  await win.waitForFunction(() => /The test received: \d+ pictures/.test(document.getElementById('view').textContent), null, { timeout: 10000 });
  const received = await win.evaluate(() => window.shotready.call('streamStatus'));
  assert.ok(received.state === 'off' && received.test.frames >= 40 && received.test.keyFrames >= 2 && received.test.sound && received.test.audioFrames > 50 && received.test.width === 1920, JSON.stringify(received.test));
  assert.ok(!/LIVE/.test(await win.locator('#tabs').textContent()));
  ok(`stream: refused without a key, then ${received.test.frames} pictures and ${received.test.audioFrames} blocks of sound sent to the test server, from its own threads, and stopped with one click`);

  // Set all cameras.
  await tab('Checks');
  await win.locator('#wb-btn').click();
  await win.locator('.dialog input[aria-label="White balance in Kelvin"]').fill('5600');
  await win.waitForFunction(() => /Kelvin 4300/.test(document.querySelector('.dialog').textContent), null, { timeout: 8000 });
  assert.match(await win.locator('.dialog').textContent(), /Kelvin 4300 → 5600/);
  assert.match(await win.locator('.dialog').textContent(), /Not reachable.*C80-7/);
  await win.screenshot({ path: join(shots, '4-match.png') });
  await win.locator('.dialog button', { hasText: /^Send WB/ }).click();
  await win.waitForFunction(() => /Done\./.test(document.querySelector('.dialog').textContent), null, { timeout: 10000 });
  await win.locator('.dialog button', { hasText: 'Close' }).click();
  await tab('Dashboard');
  await win.waitForFunction(() => document.querySelector('.card[data-body="C80-5"] .facts').textContent.includes('5600 K'), null, { timeout: 10000 });
  ok('Send WB shows what will change and applies it');

  // Monitoring LUT: off until it is turned on, drawn on the graphics card, only on that camera.
  const colour = async (body) => {
    const png = await card(body).locator('.feed').screenshot();
    return app.evaluate(({ nativeImage }, b64) => {
      const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
      const { width, height } = img.getSize();
      const px = img.toBitmap();
      let r = 0, g = 0, n = 0;
      for (let y = Math.floor(height * 0.3); y < height * 0.7; y += 4) for (let x = Math.floor(width * 0.1); x < width * 0.9; x += 4) { const i = (y * width + x) * 4; g += px[i + 1]; r += px[i + 2]; n++; }
      return { r: r / n, g: g / n };
    }, png.toString('base64'));
  };
  assert.equal(await card('C80-2').locator('.lut-btn').isDisabled(), true, 'no LUT loaded yet');
  await tab('Settings');
  await win.locator('table.luts tr', { hasText: 'clog2_cgamut' }).locator('button', { hasText: 'Load' }).click();
  await win.waitForFunction(() => /red-test\.cube \(2-point\)/.test(document.querySelector('table.luts')?.textContent || ''), null, { timeout: 5000 });
  await tab('Dashboard');
  await win.waitForSelector('.card[data-body="C80-2"] .lut-btn:not([disabled])');
  assert.equal(await win.locator('canvas.flut').count(), 0, 'loading a LUT changes no picture by itself');
  // A camera that loses its last viewer has its focus connection closed, which shows as no focus.
  await win.evaluate(() => { window.focusDrops = 0; window.shotready.on('focus', (e) => { if (e.body === 'C80-2' && !e.focus) window.focusDrops++; }); });
  await card('C80-2').locator('.lut-btn').click();
  await win.waitForFunction(() => /^LUT · \d+ fps/.test(document.querySelector('.card[data-body="C80-2"] .ffps')?.textContent || ''), null, { timeout: 8000 });
  await sleep(500);
  const red = await colour('C80-2'), plain = await colour('C80-1');
  assert.ok(red.r > 200 && red.g < 40, `C80-2 is drawn through the LUT (${JSON.stringify(red)})`);
  assert.ok(Math.abs(plain.r - plain.g) < 20, `C80-1 keeps its plain picture (${JSON.stringify(plain)})`);
  await win.screenshot({ path: join(shots, '6-lut.png') });
  await card('C80-2').locator('.lut-btn').click();
  await win.waitForFunction(() => !document.querySelector('.card[data-body="C80-2"] canvas.flut') && document.querySelector('.card[data-body="C80-2"] img').naturalWidth > 0, null, { timeout: 5000 });
  assert.equal(await win.evaluate(() => window.focusDrops), 0, 'switching the LUT on and off never dropped the camera\'s focus connection');
  ok('monitoring LUT: loaded per gamma, drawn on the graphics card for one camera, and off again');

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
