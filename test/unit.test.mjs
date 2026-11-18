// The unit tests. Run with: npm test
// They use simulated camera servers, so no camera is needed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShotReadyService } from '../src/core/service.mjs';
import dgram from 'node:dgram';
import { checkCamera, summarize, PROFILES, DEFAULT_STANDARDS, mandatoryChecks, oneShotAf, continuousAf, copyPlan, digitalIsPlan, cameraControls, atemVideoFormat, resolutionControl, resolutionFor, essentials, powerOf } from '../src/core/engine.mjs';
import { findAtems, parseDns, atemsInAnswer, sweepTargets, mdnsQuery } from '../src/core/atem-discovery.mjs';
import { decodeJpeg } from '../src/core/jpeg.mjs';
import { parseCube, rangesFromName } from '../src/core/cube.mjs';
import { normalizeFocus } from '../src/core/focus.mjs';
import { readMp4, Mp4Writer, avcEntry, codecString } from '../src/core/mp4.mjs';
import { amfEncode, amfDecode, chunkMessage, ChunkReader, parseRtmpUrl, RtmpPublisher, MSG } from '../src/core/rtmp.mjs';
import { RtmpTestServer } from '../src/sim/rtmp-server.mjs';
import { lumaStats } from '../src/core/waveform.mjs';
import { AtemLink, FakeAtemLink } from '../src/core/atem.mjs';
import { AtemThread } from '../src/core/atem-thread.mjs';
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
    b.frame = null; b.focus = null; b.refuse = null; b.controls = [];
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
test('Digital IS for all cameras: the camera\'s own On mode, its own key, nothing when it has none', () => {
  assert.deepEqual(digitalIsPlan({}, { 'c.1.eis': 'off', 'c.1.eis.list': 'off,on1,on2' }, true), [{ key: 'c.1.eis', name: 'Digital IS', value: 'on1' }]);
  assert.deepEqual(digitalIsPlan({}, { 'c.1.eis': 'off', 'c.1.eis.list': 'off,on' }, true)[0].value, 'on');
  assert.deepEqual(digitalIsPlan({}, { 'c.1.eis': 'on2' }, false), [{ key: 'c.1.eis', name: 'Digital IS', value: 'off' }]);
  assert.deepEqual(digitalIsPlan({}, { 'c.1.is': 'off' }, true), [{ key: 'c.1.is', name: 'Digital IS', value: 'on1' }]);
  assert.deepEqual(digitalIsPlan({}, { 'c.1.gamma': 'clog2_cgamut' }, true), []);
});

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

// 6. 1-Shot AF is control.cgi?c.1.focus.action=one_shot, sent whenever the lens is on AF. Continuous AF
// is c.1.focus=auto AND c.1.focus.auto=continuous, so focus=auto alone must not block anything.
test('1-Shot AF: sent whenever the lens is on AF, judged on what the camera says at the press', async () => {
  assert.equal(continuousAf(goodCamera({ 'c.1.focus': 'auto', 'c.1.focus.auto': 'continuous' })), true);
  assert.equal(continuousAf(goodCamera({ 'c.1.focus': 'auto', 'c.1.focus.auto': 'one_shot' })), false);
  assert.equal(summarize(goodCamera({ 'c.1.focus': 'auto', 'c.1.focus.auto': 'one_shot' })).continuousAf, 'off');
  for (const over of [{ 'c.1.focus.action.list': 'one_shot,stop' }, { 'c.1.focus': 'auto', 'c.1.focus.auto': 'one_shot' }, { 'c.1.focus': 'auto', 'c.1.focus.auto': 'continuous' }]) {
    assert.deepEqual(oneShotAf(goodCamera(over)).params, { 'c.1.focus.action': 'one_shot' }, JSON.stringify(over));
  }
  assert.match(oneShotAf(goodCamera({ 'c.1.lens.focus': 'mf' })).why, /lens switch is on MF/);

  const cam = sim.bodies['C80-1'];
  cam.info = { ...cam.info, 'c.1.lens.focus': 'mf', 'c.1.focus': 'auto', 'c.1.focus.auto': 'one_shot' };
  const svc = service();
  await svc.check({ force: true });
  // The lens switch goes to AF on the camera before ShotReady's next read: the press still works.
  cam.info = { ...cam.info, 'c.1.lens.focus': 'af' };
  await svc.moveFocus('C80-1', 'one_shot');
  assert.deepEqual(cam.controls, [{ 'c.1.focus.action': 'one_shot' }]);
  cam.refuse = ['c.1.focus.action'];
  await assert.rejects(svc.moveFocus('C80-1', 'one_shot'), /the camera refused 1-Shot AF \(403/);
});

// 7. With the AF frame on Auto there is no box to place, so a click on the picture is a 1-Shot AF.
test('click on the picture: AF frame on Auto focuses instead of refusing', async () => {
  const cam = sim.bodies['C80-2'];
  cam.info = { ...cam.info, 'c.1.focus.frame.1': 'auto' };
  const svc = service();
  await svc.check({ force: true });
  const done = await svc.setFocusFrame('C80-2', 0.3, 0.6);
  assert.equal(done.autoFrame, true);
  assert.deepEqual(cam.controls, [{ 'c.1.focus.action': 'one_shot' }], 'no frame position sent, one 1-Shot AF');
  cam.info = { ...cam.info, 'c.1.focus.frame.1': 'spot' };
  await svc.check({ force: true });
  await svc.setFocusFrame('C80-2', 0.5, 0.5);
  assert.deepEqual(cam.controls.slice(1), [{ 'c.1.focus.frame.1.x': '5000', 'c.1.focus.frame.1.y': '5000' }, { 'c.1.focus.action': 'one_shot' }]);
  // With Continuous AF on, the camera follows the box itself: no 1-Shot AF on a click.
  cam.info = { ...cam.info, 'c.1.focus': 'auto', 'c.1.focus.auto': 'continuous' };
  await svc.check({ force: true });
  await svc.setFocusFrame('C80-2', 0.25, 0.25);
  assert.deepEqual(cam.controls.slice(3), [{ 'c.1.focus.frame.1.x': '2500', 'c.1.focus.frame.1.y': '2500' }]);
});

// 8. The ATEM is found on any network: by Bonjour, or by knocking on its control port.
test('ATEM search: Bonjour answers and control-port answers are both found', async () => {
  // A Bonjour answer with name compression, as an ATEM sends it, next to a HyperDeck that is not one.
  const name = (n) => Buffer.concat([...n.split('.').map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
  const rec = (n, type, data) => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(1, 2); h.writeUInt32BE(10, 4); h.writeUInt16BE(data.length, 8); return Buffer.concat([n, h, data]); };
  const svcName = name('_blackmagic._tcp.local');
  const head = Buffer.alloc(12); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(5, 6);
  const ptrAt = 12; // the service name sits right after the header, so later names can point at it
  const ref = (at) => Buffer.from([0xc0 | (at >> 8), at & 255]);
  const under = (label) => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label), ref(ptrAt)]);
  const inst = under('ATEM 2 ME Production');
  const deck = under('HyperDeck Studio');
  const txt = (pairs) => Buffer.concat(pairs.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])));
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x26, 0xb6]), name('atem-2me.local')]);
  const packet = Buffer.concat([head,
    rec(svcName, 12, inst), rec(ref(ptrAt), 12, deck),
    rec(inst, 16, txt(['class=AtemSwitcher', 'name=ATEM 2 M/E Constellation 4K'])), rec(inst, 33, srv),
    rec(name('atem-2me.local'), 1, Buffer.from([10, 0, 0, 40]))]);
  assert.deepEqual(atemsInAnswer(parseDns(packet), '10.0.0.99'), [{ ip: '10.0.0.40', name: 'ATEM 2 M/E Constellation 4K', via: 'Bonjour' }]);
  assert.equal(mdnsQuery().readUInt16BE(4), 1);

  // Every local network, the cameras' networks and Blackmagic's factory address, likeliest first.
  const t = sweepTargets([{ name: 'Wi-Fi', address: '10.0.0.5', prefix: 24 }, { name: 'Ethernet', address: '172.16.4.9', prefix: 16 }], { subnetsOf: ['192.168.8.10'], hosts: ['10.0.0.40'] });
  assert.deepEqual(t.slice(0, 2), ['10.0.0.40', '192.168.10.240']);
  assert.ok(t.includes('192.168.8.200') && t.includes('10.0.0.254') && t.includes('172.16.4.1') && !t.includes('172.16.5.1') && !t.includes('10.0.0.5'));

  // A switcher answering on its control port.
  const fake = dgram.createSocket('udp4');
  fake.on('message', (msg, r) => { if (msg.length === 20) fake.send(Buffer.from([0x10, 0x14, 0x7a, 0x01, 0, 0, 0, 0, 0, 0x3a, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]), r.port, r.address); });
  await new Promise((r) => fake.bind(9910, '127.0.0.1', r));
  try {
    const r = await findAtems({ hints: { hosts: ['127.0.0.1'] }, networks: [], waitMs: 300 });
    assert.deepEqual(r.found.map((f) => [f.ip, f.via]), [['127.0.0.1', 'control port']]);
  } finally { fake.close(); }
});

// 9. No switcher anywhere: the search says so, keeps going, and does not lock Assistant mode.
test('ATEM link: searches when no address is set, and reports none found', async () => {
  let searches = 0;
  const link = new AtemLink({ thread: null, find: async () => { searches++; return { networks: [], found: [] }; } });
  await link.start({ search: true });
  assert.ok(await until(() => link.status.notFound), 'not found is reported');
  assert.equal(searches, 1);
  assert.equal(link.status.configured, false, 'never found, so Assistant mode is not locked');
  link.searchNow();
  assert.ok(await until(() => searches === 2), 'Search now runs another search at once');
  await link.disconnect();
  await link.start({ search: false });
  assert.equal(link.status.enabled, false, 'no address and no search: no ATEM');
});

// 10. The switcher is not where Settings says: the search finds it, and finds it again when it moves.
test('ATEM link: a switcher found by search is connected, and followed to a new address', async () => {
  const { EventEmitter } = await import('node:events');
  let at = '10.0.0.40';
  const switchers = [];
  class Atem extends EventEmitter {
    state = { settings: { videoMode: 1 }, info: { productIdentifier: 'ATEM 2 M/E Constellation 4K' }, inputs: { 1: { longName: 'Cam-01' } }, video: { mixEffects: [{ programInput: 1, previewInput: 2 }] } };
    async connect(ip) { this.ip = ip; switchers.push(this); if (ip === at) setTimeout(() => this.emit('connected'), 5); }
    listVisibleInputs() { return []; }
    async disconnect() {}
    async destroy() {}
  }
  const lib = { Atem, Enums: { VideoMode: { 1: 'P4KHDp25' } } };
  const found = [];
  const link = new AtemLink({ thread: null, load: async () => lib, find: async () => ({ networks: [], found: [{ ip: at, name: '', via: 'control port', network: 'Wi-Fi' }] }), connectMs: 60, goneMs: 40, retryMs: [50] });
  await link.start({ ip: '10.0.0.9', search: true, onFound: (ip) => found.push(ip) });
  assert.ok(await until(() => link.status.connected), 'connected after the search');
  assert.equal(link.status.ip, '10.0.0.40');
  assert.equal(link.status.via, 'control port');
  assert.equal(link.data.name, 'ATEM 2 M/E Constellation 4K');
  assert.equal(link.data.modeLabel, '2160p25');
  assert.deepEqual(found, ['10.0.0.40']);
  assert.equal(switchers[0].ip, '10.0.0.9', 'the address in Settings was tried first');

  // Unplugged from the Ethernet, back on the Wi-Fi with a new address.
  at = '10.0.1.7';
  switchers.at(-1).emit('disconnected');
  assert.ok(await until(() => link.status.connected && link.status.ip === '10.0.1.7'), 'found again at its new address');
  assert.deepEqual(found, ['10.0.0.40', '10.0.1.7']);
  await link.disconnect();
});

// 11. The waveform is measured in each camera's own thread, with no decoder on the main thread, and
// reads the same as Electron's decoder. The picture and its readings were made with Electron.
test('waveform: measured inside the camera thread, matching Electron', async () => {
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAkAEADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAABgcACf/EACQQAAIBBAAGAwEAAAAAAAAAAAAFAgERMUIDBAaCg9EHEtKB/8QAGgEAAgMBAQAAAAAAAAAAAAAAAAIEBQcDCP/EACIRAAEEAAYDAQAAAAAAAAAAAAABAgMEBTEyQZHRBoGCg//aAAwDAQACEQMRAD8AlavFBer1CCvFBer1MiiPdt7cYKtRerxEIKtRerxEt4jO724wVZoMFeKA9VmgwV4oW8Rnd/cXK9Riq1ByvUYqtS3iM8vbnDtJ8mdSzpG7K/g4X5H6T5C6gn9LsL+Hh/kjKLEShotDqlSumUbeEILvIMYfquSr+j+yxJOuXc6xvzt/FD8j5L1e3nSN+bv44eiRosxKIixEdK8KZMThCO7F8SdqsvX7d2VdJ1KynWN+Zv2R9D9I852dI341+yPolqLMShosRHSKNMmpwRnX7b9Url+l7KakY8xP6X4l+2nofpOY4k6xvK/8Jui0KIizEdGtTJCO6aR2pyr7OEqLEShotDGGOJREWYlERYiYwAURFmJQ0WImMAFERaFERZiYwAf/2Q==', 'base64');
  const electron = { peak:  96,  avg:  57,  low:  5,  r:  99,  g:  97,  b:  93 };
  const close = (got) => Object.keys(electron).every((k) => Math.abs(got[k] - electron[k]) <= 1);
  const pic = decodeJpeg(jpeg);
  assert.ok(close(lumaStats(pic.data, pic.width, pic.height, { bgra: false })), 'the decoder reads like Electron');
  assert.throws(() => decodeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xc2, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0])), /progressive/);

  const cam = sim.bodies['C80-1'];
  cam.frame = jpeg;
  const svc = new ShotReadyService(mkdtempSync(join(tmpdir(), 'shotready-')), { defaultConfig: sim.config({ pollSeconds: 3600 }), dupDelayMs: 1, waveform: true });
  const waves = [];
  svc.on('wave', (e) => { if (e.body === 'C80-1' && e.wave) waves.push(e.wave); });
  try {
    svc.startLive();
    assert.ok(await until(() => waves.length > 0), 'a waveform reading arrives');
    assert.ok(close(waves[0]), JSON.stringify(waves[0]));
  } finally { svc.stop(); }
});

// 12. The ATEM link runs in its own thread, which passes on only what ShotReady uses, and only when it
// changes. A thread that cannot start leaves the link on the main thread, working as before.
test('ATEM link: its own thread, real changes only, and the main thread as a fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shotready-atem-'));
  const file = join(dir, 'fake-atem.mjs');
  writeFileSync(file, `import { EventEmitter } from 'node:events';
export const Enums = { VideoMode: { 1: 'P4KHDp25' } };
export class Atem extends EventEmitter {
  state = { settings: { videoMode: 1 }, info: { productIdentifier: 'ATEM Test' }, inputs: { 1: { longName: 'Cam-01' } }, video: { mixEffects: [{ programInput: 1, previewInput: 2 }] } };
  async connect(ip) {
    if (ip !== '10.9.9.9') return;
    setTimeout(() => {
      this.emit('connected');
      for (let i = 0; i < 20; i++) this.emit('stateChanged', this.state, ['audio']);
      this.state.video.mixEffects[0].programInput = 2;
      this.emit('stateChanged', this.state, ['video']);
    }, 5);
  }
  listVisibleInputs(mode) { const m = this.state.video.mixEffects[0]; return [mode === 'program' ? m.programInput : m.previewInput]; }
  async changeProgramInput(input, me) { this.state.video.mixEffects[me].programInput = input; this.emit('stateChanged', this.state, ['video']); }
  async disconnect() {}
  async destroy() {}
}
`);
  const lib = pathToFileURL(file).href;
  const host = new AtemThread({ lib });
  await host.ready;
  const s = host.session();
  let changes = 0;
  s.on('stateChanged', () => changes++);
  const up = new Promise((r) => s.once('connected', r));
  await s.connect('10.9.9.9');
  await up;
  assert.ok(await until(() => changes > 0));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(changes, 1, '21 updates from the switcher, 1 that changes what ShotReady uses');
  assert.deepEqual(s.snapshot().tally.program, [2]);
  host.stop();

  const find = async () => ({ networks: [], found: [] });
  const link = new AtemLink({ thread: () => new AtemThread({ lib }), find });
  await link.start({ ip: '10.9.9.9', search: true });
  assert.ok(await until(() => link.status.connected), 'connected through its own thread');
  assert.equal(link.status.thread, 'own');
  assert.equal(link.data.name, 'ATEM Test');
  // F1's cut goes through the ATEM's own thread and comes back as the new program.
  await link.changeProgram(3010, 0);
  assert.ok(await until(() => link.data.mixEffects[0].program === 3010), 'Media Player 1 is on program');
  await link.disconnect();
  await assert.rejects(link.changeProgram(3020, 0), /not connected/);

  const fallback = new AtemLink({ thread: () => new AtemThread({ lib: pathToFileURL(join(dir, 'missing.mjs')).href }), load: () => import(lib), find });
  await fallback.start({ ip: '10.9.9.9', search: true });
  assert.ok(await until(() => fallback.status.connected), 'connected on the main thread instead');
  assert.equal(fallback.status.thread, 'main');
  assert.match(fallback.status.threadError, /failed to load/);
  await fallback.disconnect();
});

// 13. Monitoring LUTs: a .cube file is checked before it reaches the graphics card, and is kept per gamma.
test('monitoring LUT: .cube files are checked, kept per gamma, and switched on per camera', () => {
  const cube = (n, lines = n ** 3) => ['# made for a test', 'TITLE "Test"', `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1', ...Array(lines).fill('0.5 0.25 1.0')].join('\n');
  const c = parseCube(cube(3));
  assert.equal(c.size, 3);
  assert.equal(c.title, 'Test');
  assert.equal(c.data.length, 81);
  assert.deepEqual([...c.data.slice(0, 3)], [0.5, 0.25, 1]);
  assert.throws(() => parseCube(cube(3, 26)), /needs 27 entries/);
  assert.throws(() => parseCube('LUT_1D_SIZE 1024\n0 0 0'), /1D LUT/);
  assert.throws(() => parseCube('hello'), /Not a 3D LUT/);
  assert.deepEqual(rangesFromName('CinemaGamut_CanonLog3-to-BT709_WideDR_65_FF_Ver.2.0.cube'), { input: 'full', output: 'full' });
  assert.deepEqual(rangesFromName('CanonLog2_to_709_LL.cube'), { input: 'legal', output: 'legal' });
  assert.deepEqual(rangesFromName('my look.cube'), { input: 'full', output: 'full' });

  const svc = service();
  const file = join(svc.dataDir, 'c3.cube');
  writeFileSync(file, cube(3));
  svc.loadLut('clog3_cgamut', file);
  assert.equal(svc.lutsView().luts.clog3_cgamut.name, 'c3.cube');
  assert.equal(svc.lutData('clog3_cgamut').size, 3);
  svc.setLutRange('clog3_cgamut', 'legal', 'full');
  assert.equal(svc.lutData('clog3_cgamut').input, 'legal');
  writeFileSync(file, 'not a LUT');
  assert.throws(() => svc.loadLut('clog3_cgamut', file), /Not a 3D LUT/);
  assert.equal(svc.lutsView().luts.clog3_cgamut.size, 3, 'a bad file leaves the loaded LUT alone');
  assert.deepEqual(svc.setLutOn('C80-1', true), { 'C80-1': true });
  svc.clearLut('clog3_cgamut');
  assert.equal(svc.lutsView().luts.clog3_cgamut, undefined);
  assert.equal(svc.lutData('clog3_cgamut'), null);
});

// 14. Clicking a person the camera detected focuses that person. On MF the focus guide still shows
// and a click only moves it.
test('people: a click picks the person, AF frame on Auto is offered a type, and MF keeps its focus guide', async () => {
  const meta = {
    fguide: [{ status: true, level: 1, angle: 12, dir: 'behind', pos: { x: 5000, y: 5000, w: 1000, h: 1750 } }],
    detect: [{ type: 'face', track: true, pos: { x: 3600, y: 4300, w: 900, h: 1400 } }, { type: 'face', track: false, pos: { x: 7000, y: 4500, w: 800, h: 1300 } }],
  };
  const f = normalizeFocus(meta);
  assert.equal(f.guide, true, 'the focus guide is read as before');
  assert.equal(f.focused, false);
  assert.deepEqual(f.box, { x: 0.45, y: 0.4125, w: 0.1, h: 0.175 });
  assert.deepEqual(f.people.map((p) => [p.track, p.box.x]), [[true, 0.315], [false, 0.66]]);
  assert.deepEqual(normalizeFocus({ fguide: meta.fguide }).people, [], 'no detection, no people');

  const cam = sim.bodies['C80-3'];
  cam.info = { ...cam.info, 'c.1.focus.frame.1': 'auto' };
  const svc = service();
  await svc.check({ force: true });
  assert.deepEqual(await svc.setFocusFrame('C80-3', 0.7, 0.45, { person: true }), { needFrame: true, offer: 'zone' });
  assert.deepEqual(cam.controls, [], 'nothing is sent: a 1-Shot AF would focus whoever the camera chose');
  const done = await svc.setFocusFrame('C80-3', 0.7, 0.45, { person: true, frame: 'zone' });
  assert.equal(done.focused, true);
  assert.deepEqual(cam.controls, [{ 'c.1.focus.frame.1': 'zone' }, { 'c.1.focus.frame.1.x': '6999', 'c.1.focus.frame.1.y': '4500' }, { 'c.1.focus.action': 'one_shot' }]);

  // Lens on MF: the click moves the focus guide onto the person, and does no AF.
  cam.controls = [];
  cam.info = { ...cam.info, 'c.1.lens.focus': 'mf', 'c.1.focus.frame.1': 'spot' };
  await svc.check({ force: true });
  const mf = await svc.setFocusFrame('C80-3', 0.315, 0.43, { person: true });
  assert.deepEqual([mf.placed, mf.focused], [true, false]);
  assert.deepEqual(cam.controls, [{ 'c.1.focus.frame.1.x': '3150', 'c.1.focus.frame.1.y': '4300' }]);
});

// 15. The keyboard and the switcher: F1 / F2 cut a media player to program from the Mixer seat only,
// A / D step Kelvin, and the laptop's video input never drives a camera's tally.
test('keys: F1 cut in Mixer mode only, A and D step Kelvin, the laptop input has no tally', async () => {
  const atem = new FakeAtemLink({ modeName: 'P4KHDp25', modeLabel: '2160p25', inputs: { 1: 'Cam-01', 2: 'Cam-02', 3: 'Cam-03', 3010: 'Media Player 1', 3020: 'Media Player 2' }, mixEffects: [{ program: 1, preview: 2 }] });
  const svc = new ShotReadyService(mkdtempSync(join(tmpdir(), 'shotready-')), { defaultConfig: sim.config({ pollSeconds: 3600 }), dupDelayMs: 1, atem });
  await svc.assignInOrder();
  assert.deepEqual(await svc.cutMediaPlayer(1), { input: 3010, name: 'Media Player 1' });
  assert.equal(atem.data.mixEffects[0].program, 3010);
  svc.setKeyMode('assistant');
  await assert.rejects(svc.cutMediaPlayer(2), /only in Mixer mode/);
  assert.equal(atem.data.mixEffects[0].program, 3010, 'nothing was changed');

  // Kelvin: one step up the camera's own list.
  const cam = sim.bodies['C80-1'];
  cam.controls = [];
  assert.deepEqual(await svc.stepKelvin(1, 'C80-1'), { body: 'C80-1', kelvin: '6500 K' });
  assert.deepEqual(cam.controls, [{ 'c.1.wb.kelvin': '6500' }]);
  cam.info = { ...cam.info, 'c.1.wb': 'auto' };
  await svc.check({ force: true });
  await assert.rejects(svc.stepKelvin(-1, 'C80-1'), /not on Kelvin/);

  // The laptop's input: a label that would default to it has no input, and a clash is refused.
  svc.cfg.laptopVideo = { atemInput: 2 };
  svc.cfg.locations[1] = { label: 'Cam-02' }; // no input set: Cam-02 would be input 2
  assert.equal(svc.atemInputOf(svc.findLocation('Cam-02')), 0);
  assert.equal(svc.atemInputOf(svc.findLocation('Cam-01')), 1);
  const settings = svc.settingsView();
  const locations = settings.locations.map((l, i) => ({ ...l, atemInput: i === 0 ? 7 : l.atemInput }));
  assert.throws(() => svc.saveSettings({ ...settings, locations, laptopVideo: { atemInput: 7 } }), /Cam-01 and the laptop video point at the same ATEM input \(7\)/);
  svc.stop();
});

// 16. Copying settings, ISO above Base ISO, saturation, and the settings list.
test('copy settings, ISO above Base ISO, saturation and the settings list', async () => {
  const plan = copyPlan(goodCamera({ 'c.1.me.iso': '1600', 'c.1.wb.kelvin': '4300', 'c.1.me.diaphragm': '400' }), goodCamera({ 'c.1.wb': 'auto' }));
  assert.deepEqual(plan.map((r) => r.name), ['White balance', 'Kelvin', 'ISO'], 'mode before value; iris is never copied');

  const from = sim.bodies['C80-2'], to = sim.bodies['C80-3'];
  from.info = { ...from.info, 'c.1.me.iso': '1600', 'c.1.nd.filter': '400' };
  to.controls = [];
  const svc = service();
  await svc.check({ force: true });
  const preview = await svc.copyPreview('C80-2', 'C80-3');
  assert.deepEqual(preview.rows.map((r) => [r.name, r.now, r.from]), [['ISO', '800', '1600'], ['ND', '2', '400']]);
  const done = await svc.copyApply('C80-2', 'C80-3', ['c.1.me.iso']);
  assert.deepEqual(done, { applied: ['ISO'], failed: [] });
  assert.deepEqual(to.controls, [{ 'c.1.me.iso': '1600' }], 'only what was ticked');

  const info = goodCamera({ 'c.1.me.iso': '6400' });
  assert.deepEqual([essentials(info, summarize(info), {}).isoOver, essentials(info, summarize(info), {}).baseIso], [true, 3200]);
  const sat = goodCamera({ 'c.1.colormatrix.saturation': '0', 'c.1.colormatrix.saturation.min': '-50', 'c.1.colormatrix.saturation.max': '50' });
  assert.equal(cameraControls(sat).find((c) => c.name === 'Saturation')?.key, 'c.1.colormatrix.saturation');
  assert.equal(cameraControls(goodCamera()).find((c) => c.name === 'Saturation'), undefined);

  const path = await svc.saveSettingsList('C80-1');
  assert.match(readFileSync(path, 'utf8'), /c\.1\.gamma=clog2_cgamut/);
});

// 17. Pre-processing's MP4 files: what is written reads back the same, the sound's description is kept
// as it was, and the codec strings WebCodecs needs come out right; a real clip is read too.
test('MP4: written and read back the same, sound kept, codec strings right', async () => {
  let file = new Uint8Array(0);
  const write = async (b, pos) => {
    if (pos === null) { const n = new Uint8Array(file.length + b.length); n.set(file); n.set(b, file.length); file = n; } else file.set(b, pos);
  };
  const w = new Mp4Writer(write);
  await w.start();
  const avcC = Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
  const v = w.addTrack({ kind: 'video', timescale: 25000, width: 640, height: 360, entry: avcEntry(640, 360, avcC), lastDuration: 1000 });
  const frames = Array.from({ length: 30 }, (_, i) => Uint8Array.from({ length: 100 + i }, (__, k) => (k * 7 + i) & 255));
  for (const [i, f] of frames.entries()) await w.addSample(v, f.slice(), { dts: i * 1000, key: i % 10 === 0 });
  const sound = Uint8Array.from([0, 0, 0, 16, 0x6d, 0x70, 0x34, 0x61, 1, 2, 3, 4, 5, 6, 7, 8]);
  const a = w.addTrack({ kind: 'audio', timescale: 48000, entry: sound, lastDuration: 1024 });
  for (let i = 0; i < 20; i++) await w.addSample(a, Uint8Array.of(i, i, i), { dts: i * 1024 });
  await w.finish();
  const r = await readMp4(async (o, l) => file.slice(o, o + l), file.length);
  assert.equal(r.video.codec, 'avc1.640028');
  assert.deepEqual([r.video.width, r.video.height, r.video.count, r.video.dts[29], r.video.durations[29]], [640, 360, 30, 29000, 1000]);
  assert.deepEqual([...Array(30).keys()].filter((i) => r.video.isKey(i)), [0, 10, 20]);
  assert.ok(frames.every((f, i) => Buffer.compare(Buffer.from(file.slice(r.video.offsets[i], r.video.offsets[i] + r.video.sizes[i])), Buffer.from(f)) === 0), 'every frame reads back');
  assert.deepEqual([...r.audio.entry], [...sound], 'the sound description is kept byte for byte');
  assert.equal(codecString('hvc1', Uint8Array.from([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120])), 'hvc1.1.6.L120.90');
  await assert.rejects(readMp4(async (o, l) => Uint8Array.from({ length: l }, () => 0), 100), /not an MP4/);

  const clip = readFileSync('test/fixtures/bars.mp4');
  const c = await readMp4(async (o, l) => clip.subarray(o, o + l), clip.length);
  assert.deepEqual([c.video.codec.slice(0, 5), c.video.count, c.audio.entryType], ['avc1.', 50, 'Opus']);
});

test('power: a C50 on USB-C is outside power, only a battery source is battery, and changes are logged', () => {
  const p = (over) => powerOf({ 's.power.volt': '', 's.power.percent': '', ...over });
  assert.deepEqual([p({ 's.power.source': 'dc', 's.power.volt': '195' }).text, p({ 's.power.source': 'dc' }).battery], ['DC 19.5 V', false]);
  // A C50 has no DC input: whatever it calls USB-C power is not the battery.
  for (const source of ['usb', 'usbpd', 'usb_pd', 'pd', 'USB']) assert.equal(p({ 's.power.source': source }).battery, false, source);
  assert.equal(p({ 's.power.source': 'usbpd', 's.power.volt': '200', 's.power.percent': '80' }).text, 'USB-C 20 V  ·  battery 80%');
  assert.equal(p({ 's.power.source': 'usb', 's.power.volt': '9999' }).text, 'USB-C', 'a voltage that makes no sense is left out');
  assert.deepEqual(p({ 's.power.source': 'battery', 's.power.percent': '62' }), { battery: true, source: 'battery', percent: '62', text: 'Battery 62%' });
  assert.equal(p({ 's.power.source': 'something' }).text, 'SOMETHING', 'an unknown source is shown as reported, not as battery');
  assert.equal(p({}), null);

  // Low battery is only a warning while running on it: on USB-C it is charging.
  const battery = (source) => checkCamera(summarize(goodCamera({ 's.power.source': source, 's.power.percent': '20' })), {}, PROFILES['4K25'], DEFAULT_STANDARDS).find((r) => r.check === 'Battery');
  assert.equal(battery('usbpd'), undefined);
  assert.equal(battery('battery').status, 'yellow');

  const logs = [];
  const svc = { powerSeen: {}, log: (level, text) => logs.push([level, text]) };
  const note = (source) => ShotReadyService.prototype.notePower.call(svc, 'C50-1', p({ 's.power.source': source }));
  note('dc'); note('dc');
  assert.equal(logs.length, 0, 'plain DC on first sight is not logged');
  note('battery'); note('usbpd');
  svc.powerSeen = {}; note('usbpd');
  assert.deepEqual(logs, [
    ['red', 'C50-1: now on its battery: Battery (the camera reports battery)'],
    ['green', 'C50-1: back on outside power: USB-C (the camera reports usbpd)'],
    ['info', 'C50-1: power USB-C (the camera reports usbpd)'],
  ]);
});

test('RTMP: commands, chunks, addresses, and a stream that arrives whole', async () => {
  assert.deepEqual(amfDecode(amfEncode('connect', 1, { app: 'live2', n: 2.5, ok: true, none: null }, null)), ['connect', 1, { app: 'live2', n: 2.5, ok: true, none: null }, null]);
  // Chunks: a long message cut up, a long timestamp, and two messages arriving a byte at a time.
  const big = Buffer.alloc(10000, 7);
  const wire = Buffer.concat([
    chunkMessage({ csid: 6, type: MSG.VIDEO, streamId: 1, timestamp: 0x1234567, payload: big }, 4096),
    chunkMessage({ csid: 4, type: MSG.AUDIO, streamId: 1, timestamp: 40, payload: Buffer.from([1, 2, 3]) }, 4096),
  ]);
  const r = new ChunkReader();
  r.chunkSize = 4096;
  const got = [];
  for (const byte of wire) got.push(...r.push(Buffer.from([byte])));
  assert.deepEqual(got.map((m) => [m.type, m.timestamp, m.payload.length]), [[MSG.VIDEO, 0x1234567, 10000], [MSG.AUDIO, 40, 3]]);
  assert.ok(got[0].payload.equals(big));

  assert.deepEqual(parseRtmpUrl('rtmps://a.rtmps.youtube.com/live2', ' abcd-1234 '), { secure: true, host: 'a.rtmps.youtube.com', port: 443, app: 'live2', key: 'abcd-1234', tcUrl: 'rtmps://a.rtmps.youtube.com/live2' });
  assert.equal(parseRtmpUrl('rtmp://server:1936/app/inst/KEY').key, 'KEY', 'a key left at the end of the address is used');
  assert.equal(parseRtmpUrl('rtmp://server:1936/app/inst/KEY').app, 'app/inst');
  assert.throws(() => parseRtmpUrl('https://youtube.com', 'k'), /rtmp:\/\/server\/app/);

  // A stream to the test server: the setup, the pictures and the sound all arrive, in order.
  const server = new RtmpTestServer({ key: 'right' });
  await server.listen();
  await assert.rejects(new RtmpPublisher({ url: server.url, key: 'wrong' }).connect(), /stream key was not accepted/);
  const p = await new RtmpPublisher({ url: server.url, key: 'right' }).connect();
  p.metadata({ width: 1280, height: 720, framerate: 25 });
  p.videoConfig(new Uint8Array([1, 0x64, 0, 0x1f, 0xff]));
  p.audioConfig(new Uint8Array([0x11, 0x90]));
  for (let i = 0; i < 50; i++) {
    p.video(i * 40, Buffer.alloc(3000 + i, i), i % 25 === 0);
    p.audio(i * 40, Buffer.alloc(200, i));
  }
  await new Promise((res) => setTimeout(res, 300));
  const st = server.stats;
  assert.deepEqual([st.publishing, st.app, st.key, st.meta?.width, st.frames, st.keyFrames, st.audioFrames, st.lastMs, st.backwards], [true, 'live', 'right', 1280, 50, 2, 50, 1960, 0]);
  assert.deepEqual([...st.audioConfig], [0x11, 0x90]);
  // A connection that drops is reported, so the stream can connect again.
  const closed = new Promise((res) => p.once('close', res));
  server.sock.destroy();
  assert.match(await closed, /closed/);
  await assert.rejects(new RtmpPublisher({ url: 'rtmp://127.0.0.1:9/live', key: 'k', connectMs: 3000 }).connect(), /refused|reached/);
  await server.close();
});

test('SDI output: the cameras must match the ATEM\'s own video mode, and a settable resolution is offered', async () => {
  assert.equal(atemVideoFormat('P1080p25'), '1920x1080:25000:P');
  assert.equal(atemVideoFormat('P4KHDp25'), '3840x2160:25000:P');
  assert.equal(atemVideoFormat('P1080p5994'), '1920x1080:59940:P');
  assert.equal(atemVideoFormat('N1080i50'), '1920x1080:50000:I');
  assert.equal(atemVideoFormat('weird'), null);

  // Constellation at 1080p25: 1080p25 cameras pass, a 2160p25 one is red for the ATEM's format.
  const atem = new FakeAtemLink({ modeName: 'P1080p25', modeLabel: '1080p25', inputs: { 1: 'Cam-01' }, mixEffects: [{ program: 5, preview: 6 }] });
  const svc = new ShotReadyService(mkdtempSync(join(tmpdir(), 'shotready-')), { defaultConfig: sim.config({ pollSeconds: 3600 }), dupDelayMs: 1, atem });
  await svc.assignInOrder();
  await svc.setSwitcher('constellation');
  let r = await svc.setProfile('HD25');
  assert.match(find(rowsFor(r, 'Cam-01'), 'SDI output').detail, /^3840x2160 25p but the ATEM \(1080p25\) needs 1920x1080 25p$/);
  for (const b of Object.values(sim.bodies)) b.info = { ...b.info, 'f.output1.videoinfo': '1920x1080:25000:P' };
  r = await svc.check({ force: true });
  assert.equal(find(rowsFor(r, 'Cam-01'), 'SDI output').status, 'green');
  for (const b of Object.values(sim.bodies)) b.info = { ...b.info, 'f.output1.videoinfo': '3840x2160:25000:P' };
  await svc.check({ force: true });

  // A camera with no resolution setting gets SDI output listed in the default settings, to set by
  // hand; one with a resolution setting gets it sent with the rest.
  assert.equal(resolutionControl(sim.bodies['C80-1'].info), null);
  let plan = svc.defaultsPreview().targets.find((t) => t.body === 'C80-1');
  assert.equal(plan.changes.find((c) => c.name === 'SDI output').supported, false);
  const info = { 'c.1.rec.resolution': '3840x2160', 'c.1.rec.resolution.list': '3840x2160,1920x1080', 'f.rec.media1.videoinfo.list': '3840x2160,1920x1080' };
  assert.equal(resolutionControl(info).key, 'c.1.rec.resolution', 'never a media slot');
  assert.equal(resolutionFor(resolutionControl(info), '1920x1080:25000:P'), '1920x1080');
  assert.equal(resolutionFor({ list: ['4k_uhd', 'fhd'] }, '3840x2160:25000:P'), '4k_uhd');
  assert.deepEqual(cameraControls(info).find((c) => c.name === 'Resolution').options.map((o) => o.value), ['3840x2160', '1920x1080']);
  sim.bodies['C80-1'].info = { ...sim.bodies['C80-1'].info, ...info };
  await svc.check({ force: true });
  plan = svc.defaultsPreview().targets.find((t) => t.body === 'C80-1');
  assert.deepEqual(plan.steps.find((c) => c.name === 'SDI output'), { ...plan.steps.find((c) => c.name === 'SDI output'), key: 'c.1.rec.resolution', value: '1920x1080', supported: true });
  assert.equal(plan.manual.length, 0);
});
