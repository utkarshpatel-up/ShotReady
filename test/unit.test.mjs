// The five unit tests. Run with: npm test
// They use simulated camera servers, so no camera is needed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShotReadyService } from '../src/core/service.mjs';
import { checkCamera, summarize, PROFILES, DEFAULT_STANDARDS, mandatoryChecks } from '../src/core/engine.mjs';
import { startSimulator, goodCamera } from '../src/sim/cameras.mjs';

const mac = (n) => `00:00:85:00:00:0${n}`;
const find = (rows, check) => rows.find((x) => x.check === check);
const rowsFor = (r, label) => r.labels.find((l) => l.label === label).results;
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return false;
};

let sim;
before(async () => {
  sim = await startSimulator([1, 2, 3].map((n) => ({ id: `C80-${n}`, info: goodCamera({ 's.hardware.address': mac(n) }) })));
});
after(() => sim.close());
beforeEach(() => {
  for (const [id, b] of Object.entries(sim.bodies)) {
    b.dropStreams();
    b.info = goodCamera({ 's.hardware.address': mac(Number(id.at(-1))) });
    b.frame = null; b.focus = null;
  }
});

function service() {
  const svc = new ShotReadyService(mkdtempSync(join(tmpdir(), 'shotready-')), { defaultConfig: sim.config({ pollSeconds: 3600 }), dupDelayMs: 1 });
  svc.cfg.pollSeconds = 3600;
  return svc;
}

// 1. The recorder must never get a colour picture.
test('gamma: flat Canon Log is green, every colour gamma is red', () => {
  const gammaOf = (gamma) => find(checkCamera(summarize(goodCamera({ 'c.1.gamma': gamma })), {}, PROFILES['4K25'], DEFAULT_STANDARDS), 'Gamma');
  for (const g of ['clog2_cgamut', 'clog3_cgamut', 'clog3_bt2020', 'clog3_bt709']) assert.equal(gammaOf(g).status, 'green', g);
  for (const g of ['pq_bt2020', 'hlg_bt2020', 'widedr_bt709', 'standard_bt709', 'canon709_bt709']) {
    assert.equal(gammaOf(g).status, 'red', g);
    assert.match(gammaOf(g).detail, /colour picture to the recorder/);
  }
});

// 2. The whole check, from cameras to verdict.
test('verdict: good cameras are READY, and the wrong profile makes them NOT READY', async () => {
  const svc = service();
  await svc.assignInOrder();
  await svc.setSwitcher('2me');
  const ready = await svc.check({ force: true });
  assert.equal(ready.reds, 0);
  assert.equal(rowsFor(ready, 'Cam-01').filter((x) => x.status === 'yellow').length, 0);
  const hd = await svc.setProfile('HD25');
  assert.equal(hd.verdict, 'not-ready');
  assert.match(find(rowsFor(hd, 'Cam-01'), 'SDI output').detail, /1080p25/);
});

// 3. The mandatory settings are judged from what the camera reports.
test('mandatory settings: the camera values decide pass or fail', () => {
  const std = { mandatory: { digitalIS: ['c.1.eis'], baseIso: ['c.1.me.baseiso'], teleConverter: ['c.1.zoom.mode'] } };
  const rows = (over) => { const info = goodCamera(over); return mandatoryChecks(info, summarize(info), std); };
  assert.equal(find(rows({ 'c.1.eis': 'on1' }), 'Digital IS').detail, 'ON (must be OFF)');
  assert.equal(find(rows({ 'c.1.zoom.mode': 'mag', 'c.1.zoom.mag': '250' }), 'Tele-converter').detail, 'ON at 2.5x (must be OFF)');
  assert.equal(find(rows({ 'c.1.me.iso': '6400' }), 'Base ISO range').status, 'red');
  assert.equal(find(rows({ 'c.1.me.iso': '800' }), 'Base ISO range').status, 'green');
  for (const gone of ['Sensor mode', 'Lens stabilization', 'Lens filter']) assert.equal(find(rows({}), gone), undefined, `${gone} is no longer checked`);
});

// 4. A setting changed on the camera reaches the screen straight away, with no new read.
test('live updates: a pushed change reaches the result without another request', async () => {
  const svc = service();
  await svc.assignInOrder();
  svc.startLive();
  try {
    assert.ok(await until(() => svc.liveStatus().connected === 3), 'all camera streams connect');
    const before = sim.bodies['C80-1'].requests;
    for (const iso of ['1000', '1250', '1600']) {
      const seen = new Promise((res) => { const on = (r) => { if (r.labels[0].summary.iso === iso) { svc.off('result', on); res(); } }; svc.on('result', on); });
      sim.bodies['C80-1'].update({ 'c.1.me.iso': iso });
      await Promise.race([seen, new Promise((_, no) => setTimeout(() => no(new Error(`ISO ${iso} never arrived`)), 1000))]);
    }
    assert.equal(sim.bodies['C80-1'].requests, before, 'no extra requests were needed');
  } finally { svc.stop(); }
});

// 5. The live view: frames and focus run only for a camera someone is watching.
test('live view: watching a camera starts frames and focus, and leaving stops them', async () => {
  const guide = (level) => ({ status: true, level, angle: level === 2 ? 0 : 30, dir: 'front', pos: { x: 5000, y: 5000, w: 1000, h: 1750 } });
  const cam = sim.bodies['C80-1'];
  cam.frame = () => Buffer.from([0xff, 0xd8, 0, 0xff, 0xd9]);
  cam.setFocus(guide(2));
  const svc = service();
  const focus = [];
  svc.on('focus', (e) => focus.push(e));
  try {
    svc.startLive();
    const { 'C80-1': base } = await svc.feedBase();
    assert.equal(svc.cams['C80-1'].mode.parallel, 0, 'nobody watching: no picture requests');
    assert.equal(cam.metaSubs.size, 0, 'nobody watching: no focus connection');

    let bytes = 0;
    const u = new URL(`${base}/C80-1.mjpeg`);
    const viewer = http.get({ host: u.hostname, port: u.port, path: u.pathname }, (res) => res.on('data', (c) => { bytes += c.length; }));
    assert.ok(await until(() => svc.cams['C80-1'].mode.parallel === 4), 'watched: the most overlapping requests');
    assert.ok(await until(() => bytes > 200), 'pictures reach the viewer');
    assert.ok(await until(() => focus.at(-1)?.focus?.focused === true), 'in focus is reported');
    cam.setFocus(guide(0));
    assert.ok(await until(() => focus.at(-1)?.focus?.focused === false), 'a change in focus is pushed');

    viewer.destroy();
    assert.ok(await until(() => svc.cams['C80-1'].mode.parallel === 0 && cam.metaSubs.size === 0), 'leaving stops pictures and focus');
  } finally { svc.stop(); }
});
