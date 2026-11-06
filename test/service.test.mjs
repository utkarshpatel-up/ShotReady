import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShotReadyService } from '../src/core/service.mjs';
import { FakeAtemLink, readAtemState } from '../src/core/atem.mjs';
import { MultipartParser } from '../src/core/stream.mjs';
import { lumaStats } from '../src/core/waveform.mjs';
import { parseInfo, checkCamera, summarize, PROFILES, DEFAULT_STANDARDS, matchCameras, validateOnBody, mandatoryChecks, essentials, diffAgainstRef } from '../src/core/engine.mjs';
import { startSimulator, goodCamera, toInfoText } from '../src/sim/cameras.mjs';

const mac = (n) => `00:00:85:00:00:0${n}`;
let sim, dir, svc;

before(async () => {
  sim = await startSimulator([
    { id: 'C80-1', info: goodCamera({ 's.hardware.address': mac(1) }) },
    { id: 'C80-2', info: goodCamera({ 's.hardware.address': mac(2) }) },
    { id: 'C50-8', info: goodCamera({ 's.hardware': 'EOS C50', 's.firmware': '1.0.0', 's.hardware.address': mac(8), 'c.1.gamma.list': 'canon709_bt709' }) },
  ]);
});
after(() => sim.close());

function freshService(opts = {}) {
  dir = mkdtempSync(join(tmpdir(), 'shotready-'));
  return new ShotReadyService(dir, { defaultConfig: sim.config(), dupDelayMs: 1, ...opts });
}
beforeEach(() => {
  for (const [id, b] of Object.entries(sim.bodies)) {
    b.dropStreams(); b.noStream = false;
    b.offline = false; b.flip = null; b.requireAuth = null; b.requests = 0; b.methods = [];
    b.info = goodCamera({ 's.hardware.address': mac(id === 'C50-8' ? 8 : Number(id.at(-1))), ...(id === 'C50-8' ? { 's.hardware': 'EOS C50', 's.firmware': '1.0.0', 'c.1.gamma.list': 'canon709_bt709' } : {}) });
  }
  svc = freshService();
});

const CAM = (n) => `Cam-0${n}`;
const rowsFor = (r, label) => r.labels.find((l) => l.label === label).results;
const find = (rows, check) => rows.find((x) => x.check === check);

test('parseInfo handles := and = and CRLF', () => {
  assert.deepEqual(parseInfo('a.b:=1\r\nc=2\r\n\r\nnoise\n'), { 'a.b': '1', c: '2' });
});

test('a colour camera with no cards gets exactly those findings, and timecode is not checked', () => {
  const s = summarize(goodCamera({
    'c.1.gamma': 'canon709_bt709', 'f.rec.media1.status': 'unrecordable', 'f.rec.media2.status': 'unrecordable',
    'f.rec.media1.remainingtime': '0', 'f.rec.media2.remainingtime': '0', 'f.timecode.frame': 'df',
  }));
  const r = checkCamera(s, {}, PROFILES['4K25'], DEFAULT_STANDARDS);
  assert.equal(find(r, 'Gamma').status, 'red');
  assert.equal(find(r, 'Recording media').status, 'red');
  assert.equal(find(r, 'Timecode'), undefined);
  assert.equal(find(r, 'SDI output').status, 'green');
  assert.equal(find(r, 'Tally').status, 'green');
  assert.equal(find(r, 'Hardware').status, 'green');
});

test('flat Canon Log passes with View Assist on or off; every colour gamma on the C80 is red', () => {
  const gammaOf = (over, std = DEFAULT_STANDARDS) => find(checkCamera(summarize(goodCamera(over)), {}, PROFILES['4K25'], std), 'Gamma');
  for (const g of ['clog2_cgamut', 'clog3_cgamut', 'clog3_bt2020', 'clog3_bt709']) {
    for (const v of ['on', 'off']) assert.equal(gammaOf({ 'c.1.gamma': g, 'monitoring.output1.viewassist': v }).status, 'green', g);
  }
  for (const g of ['pq_bt2020', 'hlg_bt2020', 'widedr_bt709', 'standard_bt709', 'canon709_bt709']) {
    const row = gammaOf({ 'c.1.gamma': g });
    assert.equal(row.status, 'red', g);
    assert.match(row.detail, /colour picture to the recorder/);
  }
  const narrowed = { ...DEFAULT_STANDARDS, allowedGamma: ['clog2_cgamut'] };
  assert.match(gammaOf({ 'c.1.gamma': 'clog3_cgamut' }, narrowed).detail, /not in the allowed gamma list/);
});

test('a saved config with the first default gamma list moves to flat; an edited list is kept', () => {
  const start = (allowedGamma) => {
    const d = mkdtempSync(join(tmpdir(), 'shotready-'));
    writeFileSync(join(d, 'cameras.json'), JSON.stringify(sim.config({ standards: { allowedGamma } })));
    return { s: new ShotReadyService(d, { dupDelayMs: 1 }), d };
  };
  const { s: moved, d } = start(['standard_bt709', 'canon709_bt709', 'widedr_bt709']);
  assert.ok(moved.std.allowedGamma.includes('clog2_cgamut'));
  assert.ok(!moved.std.allowedGamma.includes('canon709_bt709'));
  assert.match(readFileSync(join(d, 'cameras.json'), 'utf8'), /clog2_cgamut/);
  assert.deepEqual(start(['clog3_cgamut']).s.std.allowedGamma, ['clog3_cgamut']);
});

test('all bodies good on the right profile is READY; switching profile is NOT READY', async () => {
  await svc.assignInOrder();
  await svc.setSwitcher('2me');
  await svc.confirm('C80-1', ['lensFilter']);
  const r = await svc.check({ force: true });
  assert.equal(r.reds, 0);
  assert.equal(rowsFor(r, CAM(1)).filter((x) => x.status === 'yellow').length, 0);
  const hd = await svc.setProfile('HD25');
  assert.equal(hd.verdict, 'not-ready');
  assert.match(find(rowsFor(hd, CAM(1)), 'SDI output').detail, /1080p25/);
});

test('empty label is a warning and an unassigned body is a spare', async () => {
  await svc.assign(CAM(1), 'C80-1');
  const r = await svc.check({ force: true });
  assert.equal(find(rowsFor(r, CAM(2)), 'No body').status, 'yellow');
  assert.deepEqual(r.spares.map((s) => s.body), ['C80-2', 'C50-8']);
});

test('nothing assigned at all is NOT READY, not a warning', async () => {
  const r = await svc.check({ force: true });
  assert.equal(r.verdict, 'not-ready');
  assert.equal(r.global.find((g) => g.check === 'No cameras').status, 'red');
});

test('offline body on a label is red and does not throw; coming back is logged', async () => {
  await svc.assign(CAM(1), 'C80-1');
  sim.bodies['C80-1'].offline = true;
  const r = await svc.check({ force: true });
  assert.equal(find(rowsFor(r, CAM(1)), 'Connection').status, 'red');
  assert.equal(r.verdict, 'not-ready');
  sim.bodies['C80-1'].offline = false;
  await svc.check({ force: true });
  assert.ok(svc.events.some((e) => /C80-1 back online/.test(e.text)));
});

test('a different MAC on a known IP is flagged as wrong body', async () => {
  await svc.assign(CAM(1), 'C80-1');
  await svc.check({ force: true });
  sim.bodies['C80-1'].info = goodCamera({ 's.hardware.address': 'AA:BB:CC:00:00:99' });
  const r = await svc.check({ force: true });
  assert.equal(find(rowsFor(r, CAM(1)), 'Wrong body on IP').status, 'red');
  const fixed = await svc.forgetMac('C80-1');
  assert.equal(find(rowsFor(fixed, CAM(1)), 'Wrong body on IP'), undefined);
});

test('duplicate IP is detected from a flipping MAC and no MAC is learned', async () => {
  sim.bodies['C80-1'].flip = goodCamera({ 's.hardware.address': 'AA:BB:CC:00:00:77' });
  await svc.assign(CAM(1), 'C80-1');
  const r = await svc.check({ force: true });
  assert.equal(find(rowsFor(r, CAM(1)), 'Duplicate IP').status, 'red');
  assert.equal(svc.state.bodies['C80-1'].mac, undefined);
});

test('model mismatch against the registry is red', async () => {
  await svc.assign(CAM(1), 'C80-1');
  sim.bodies['C80-1'].info = goodCamera({ 's.hardware': 'EOS C50', 's.hardware.address': mac(1) });
  const r = await svc.check({ force: true });
  assert.equal(find(rowsFor(r, CAM(1)), 'Model').status, 'red');
});

test('moving a body empties its old label and closes workload history', async () => {
  await svc.assign(CAM(1), 'C80-1');
  const res = await svc.assign(CAM(2), 'C80-1');
  assert.equal(res.movedFrom, CAM(1));
  assert.equal(svc.state.assignments[CAM(1)], undefined);
  assert.equal(svc.state.history.filter((h) => !h.to).length, 1);
  assert.deepEqual(svc.state.history.filter((h) => h.body === 'C80-1').map((h) => h.label), [CAM(1), CAM(2)]);
});

test('double assignment in a hand-edited state is red', async () => {
  await svc.assign(CAM(1), 'C80-1');
  svc.state.assignments[CAM(2)] = { body: 'C80-1', since: new Date().toISOString() };
  const r = await svc.check({ force: true });
  assert.equal(find(rowsFor(r, CAM(2)), 'Double assignment').status, 'red');
});

test('swapping a body onto a label shows the diff against the earlier camera', async () => {
  await svc.assign(CAM(1), 'C80-1');
  await svc.check({ force: true });
  assert.equal(svc.state.labelRef[CAM(1)].fromBody, 'C80-1');
  sim.bodies['C50-8'].info = { ...sim.bodies['C50-8'].info, 'c.1.me.iso': '1600', 'c.1.gamma': 'canon709_bt709' };
  sim.bodies['C80-1'].info = { ...sim.bodies['C80-1'].info };
  const res = await svc.assign(CAM(1), 'C50-8');
  assert.equal(res.previous, 'C80-1');
  const iso = res.diff.rows.find((r) => r.key === 'c.1.me.iso');
  assert.equal(iso.earlier, '800');
  assert.equal(iso.current, '1600');
  assert.equal(iso.copyable, true);
  const r = await svc.check({ force: true });
  assert.equal(find(rowsFor(r, CAM(1)), 'vs earlier camera').status, 'yellow');
});

test('a reference saved with timecode in it no longer reports a timecode difference', () => {
  const rows = diffAgainstRef({ settings: { 'f.timecode.frame': 'ndf', 'c.1.me.iso': '800' } }, { 'f.timecode.frame': 'df', 'c.1.me.iso': '800' });
  assert.deepEqual(rows, []);
});

test('diff marks a value the new body does not support as not copyable', () => {
  assert.equal(validateOnBody('c.1.gamma', 'clog2', { 'c.1.gamma.list': 'canon709_bt709' }), false);
  assert.equal(validateOnBody('c.1.wb.kelvin', '99999', { 'c.1.wb.kelvin.min': '2000', 'c.1.wb.kelvin.max': '15000' }), false);
});

test('a body with reds does not become the label reference; snapshot still can', async () => {
  sim.bodies['C80-1'].info = goodCamera({ 's.hardware.address': mac(1), 'c.1.colorbar': 'on' });
  await svc.assign(CAM(1), 'C80-1');
  await svc.check({ force: true });
  assert.equal(svc.state.labelRef[CAM(1)], undefined);
  const [snap] = await svc.snapshot(CAM(1));
  assert.equal(snap.body, 'C80-1');
  assert.ok(svc.state.labelRef[CAM(1)].settings['c.1.gamma']);
  assert.equal(svc.state.labelRef[CAM(1)].settings['c.1.lens.name'], undefined, 'lens belongs to the body');
});

test('lens change stays flagged across refreshes until accepted, and logs once', async () => {
  await svc.assign(CAM(1), 'C80-1');
  await svc.check({ force: true });
  sim.bodies['C80-1'].info = { ...sim.bodies['C80-1'].info, 'c.1.lens.name': 'RF24-70mm F2 L IS USM' };
  await svc.check({ force: true });
  const r2 = await svc.check({ force: true });
  assert.equal(find(rowsFor(r2, CAM(1)), 'Lens changed').status, 'yellow');
  assert.equal(svc.events.filter((e) => /lens changed/.test(e.text)).length, 1);
  const r3 = await svc.acceptLens('C80-1');
  assert.equal(find(rowsFor(r3, CAM(1)), 'Lens changed'), undefined);
});

test('camera matching ignores Kelvin on cameras not in Kelvin mode', () => {
  const a = { label: 'A', summary: summarize(goodCamera({ 'c.1.wb.kelvin': '5600' })) };
  const b = { label: 'B', summary: summarize(goodCamera({ 'c.1.wb': 'daylight', 'c.1.wb.kelvin': '3200' })) };
  const rows = matchCameras([a, b], ['wbMode', 'wbKelvin']);
  assert.deepEqual(rows.map((r) => r.key), ['wbMode']);
});

test('basic login: wrong credentials report clearly, right ones work, password is stored encrypted and hidden', async () => {
  sim.bodies['C80-1'].requireAuth = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
  const enc = (s) => `enc:${Buffer.from(s).toString('hex')}`;
  const dec = (s) => Buffer.from(s.slice(4), 'hex').toString();
  svc = freshService({ encrypt: enc, decrypt: dec });
  await svc.assign(CAM(1), 'C80-1');
  let r = await svc.check({ force: true });
  assert.match(find(rowsFor(r, CAM(1)), 'Connection').detail, /login rejected/);
  const s = svc.settingsView();
  r = await svc.saveSettings({ ...s, auth: { user: 'admin', pass: 'secret' } });
  assert.equal(rowsFor(r, CAM(1)).find((x) => x.check === 'Connection'), undefined);
  const onDisk = readFileSync(join(dir, 'cameras.json'), 'utf8');
  assert.ok(!onDisk.includes('secret'));
  assert.equal(JSON.stringify(svc.settingsView()).includes('secret'), false);
  // Blank password on a later save keeps the saved one.
  r = await svc.saveSettings({ ...svc.settingsView(), auth: { user: 'admin', pass: '' } });
  assert.equal(rowsFor(r, CAM(1)).find((x) => x.check === 'Connection'), undefined);
});

test('renaming labels keeps assignment, reference and workload, including a swap of two names', async () => {
  await svc.assign(CAM(1), 'C80-1');
  await svc.assign(CAM(2), 'C80-2');
  await svc.check({ force: true });
  const s = svc.settingsView();
  s.locations[0].label = CAM(2);
  s.locations[1].label = CAM(1);
  s.locations[2].label = 'JIB';
  await svc.saveSettings(s);
  assert.equal(svc.state.assignments[CAM(2)].body, 'C80-1');
  assert.equal(svc.state.assignments[CAM(1)].body, 'C80-2');
  assert.equal(svc.state.labelRef[CAM(2)].fromBody, 'C80-1');
  assert.ok(svc.state.history.some((h) => h.label === CAM(2) && h.body === 'C80-1'));
});

test('settings reject duplicate labels, duplicate IPs and bad addresses without changing anything', async () => {
  const before = readFileSync(join(dir, 'cameras.json'), 'utf8');
  const s = () => JSON.parse(JSON.stringify(svc.settingsView()));
  let bad = s(); bad.locations[1].label = bad.locations[0].label;
  assert.throws(() => svc.saveSettings(bad), /unique/);
  bad = s(); bad.bodies[1].ip = bad.bodies[0].ip;
  assert.throws(() => svc.saveSettings(bad), /same IP/);
  bad = s(); bad.bodies[0].ip = 'http://evil/x';
  assert.throws(() => svc.saveSettings(bad), /invalid IP/);
  assert.equal(readFileSync(join(dir, 'cameras.json'), 'utf8'), before);
});

test('state survives a restart; a damaged state file is set aside instead of crashing', async () => {
  await svc.assign(CAM(1), 'C80-1');
  const again = new ShotReadyService(dir, { dupDelayMs: 1 });
  assert.equal(again.state.assignments[CAM(1)].body, 'C80-1');
  writeFileSync(join(dir, 'shotready-state.json'), '{ not json');
  const third = new ShotReadyService(dir, { dupDelayMs: 1 });
  assert.deepEqual(third.state.assignments, {});
  assert.ok(readdirSync(dir).some((f) => f.includes('.damaged-')));
  assert.ok(third.events.some((e) => e.level === 'red' && /damaged/.test(e.text)));
});

test('reads v0.2 prototype state files as they are', async () => {
  writeFileSync(join(dir, 'shotready-state.json'), JSON.stringify({
    assignments: { [CAM(1)]: { body: 'C80-1', since: '2026-11-06T10:00:00.000Z' } },
    bodies: {}, labelRef: {}, history: [{ label: CAM(1), body: 'C80-1', from: '2026-11-06T10:00:00.000Z' }],
  }));
  const s2 = new ShotReadyService(dir, { dupDelayMs: 1 });
  const r = await s2.check({ force: true });
  assert.equal(r.labels[0].body, 'C80-1');
  assert.equal(s2.profile, '4K25');
});

test('a manual check writes a JSON report', async () => {
  await svc.assign(CAM(1), 'C80-1');
  const r = await svc.check({ force: true, report: true });
  assert.ok(existsSync(r.reportPath));
  assert.equal(JSON.parse(readFileSync(r.reportPath, 'utf8')).profile, '4K25');
});

test('overlapping checks share one run and a report request is not lost', async () => {
  await svc.assign(CAM(1), 'C80-1');
  const [a, b] = await Promise.all([svc.check(), svc.check({ report: true })]);
  assert.ok(a && b);
  assert.ok(readdirSync(join(dir, 'reports')).length >= 1);
});

test('nothing but GET ever reaches a camera', async () => {
  await svc.assignInOrder();
  await svc.check({ force: true });
  await svc.snapshot();
  await svc.assign(CAM(1), 'C50-8');
  await svc.diff(CAM(1));
  for (const b of Object.values(sim.bodies)) assert.ok(b.methods.every((m) => m === 'GET'));
  assert.ok(Object.values(sim.bodies).some((b) => b.methods.length));
});

test('sheet and CSV reflect assignments and quote awkward text', async () => {
  const s = svc.settingsView(); s.locations[0].label = 'Jib, "wide"';
  await svc.saveSettings(s);
  await svc.assign('Jib, "wide"', 'C80-1');
  assert.equal(svc.sheet()[0].body, 'C80-1');
  assert.match(svc.sheetCsv(), /"Jib, ""wide""",/);
});

test('ATEM: format mismatch is red, label mismatch is yellow, program and preview map to labels', async () => {
  const atem = new FakeAtemLink({ modeName: 'P1080p25', modeLabel: '1080p25', inputs: { 1: CAM(1), 2: 'Wrong Name' }, mixEffects: [{ program: 1, preview: 2 }, { program: 2, preview: 1 }] });
  svc = freshService({ atem });
  await svc.assign(CAM(1), 'C80-1');
  await svc.assign(CAM(2), 'C80-2');
  let r = await svc.check({ force: true });
  assert.equal(r.global.find((g) => g.check === 'ATEM format').status, 'red');
  assert.deepEqual(r.labels[0].tally.program, [1]);
  assert.deepEqual(r.labels[0].tally.preview, [2]);
  assert.equal(find(rowsFor(r, CAM(2)), 'ATEM label').status, 'yellow');
  r = await svc.setProfile('HD25');
  assert.equal(r.global.find((g) => g.check === 'ATEM format').status, 'green');
  atem.set({ ...atem.data, mixEffects: [{ program: 2, preview: 1 }] });
  assert.deepEqual(svc.lastResult.labels[1].tally.program, [1]);
});

test('ATEM down is a warning, and labels still get checked', async () => {
  const atem = new FakeAtemLink(null);
  atem.status = { configured: true, connected: false, error: 'timeout', ip: '192.168.8.240' };
  svc = freshService({ atem });
  await svc.assign(CAM(1), 'C80-1');
  const r = await svc.check({ force: true });
  assert.equal(r.global[0].status, 'yellow');
  assert.ok(find(rowsFor(r, CAM(1)), 'Gamma'));
});

test('readAtemState maps the library state shape', () => {
  const VideoMode = { 10: 'P1080p25', 16: 'P4KHDp25' };
  const d = readAtemState({ settings: { videoMode: 16 }, inputs: { 1: { longName: CAM(1) } }, video: { mixEffects: [{ programInput: 1, previewInput: 2 }, undefined] } }, VideoMode);
  assert.equal(d.modeName, 'P4KHDp25');
  assert.equal(d.modeLabel, '2160p25');
  assert.deepEqual(d.mixEffects, [{ program: 1, preview: 2 }]);
  assert.equal(d.inputs[1], CAM(1));
});

const SIM = { mandatory: { sensor: ['sim.sensor'], digitalIS: ['c.1.eis'], baseIso: ['c.1.me.baseiso'], teleConverter: ['c.1.zoom.mode'], lensIS: ['sim.lensis'] } };
const man = (over, std = SIM, confirmed) => {
  const info = goodCamera(over);
  return mandatoryChecks(info, summarize(info), std, confirmed);
};

test('Constellation requires 3840x2160 SDI whatever the profile; 2 M/E 2RU follows the profile', async () => {
  await svc.assign(CAM(1), 'C80-1');
  let r = await svc.setProfile('HD25');
  assert.equal(find(rowsFor(r, CAM(1)), 'SDI output').status, 'green');
  sim.bodies['C80-1'].info = { ...sim.bodies['C80-1'].info, 'f.output1.videoinfo': '1920x1080:25000:P' };
  r = await svc.check({ force: true });
  assert.match(find(rowsFor(r, CAM(1)), 'SDI output').detail, /Constellation needs 3840x2160/);
  r = await svc.setSwitcher('2me');
  assert.equal(find(rowsFor(r, CAM(1)), 'SDI output').status, 'green');
});

test('mandatory settings: reported values pass or fail on what the camera says', () => {
  assert.equal(find(man({}), 'Sensor mode').status, 'green');
  assert.equal(find(man({ 'sim.sensor': 's35' }), 'Sensor mode').status, 'red');
  assert.equal(find(man({ 'c.1.eis': 'on' }), 'Digital IS').status, 'red');
  const tele = find(man({ 'c.1.zoom.mode': 'mag', 'c.1.zoom.mag': '250' }), 'Tele-converter');
  assert.equal(tele.status, 'red');
  assert.match(tele.detail, /ON at 2\.5x \(must be OFF\)/);
  assert.equal(find(man({ 'c.1.zoom.mode': 'off', 'c.1.zoom.mag': '150' }), 'Tele-converter').status, 'green', 'a remembered level is not On');
  const shipped = goodCamera({ 'c.1.zoom.mode': 'mag' });
  assert.equal(find(mandatoryChecks(shipped, summarize(shipped), DEFAULT_STANDARDS), 'Tele-converter').status, 'red', 'the shipped defaults read it');
  assert.equal(find(man({ 'c.1.zoom.mode': 'dzoom' }), 'Tele-converter').status, 'red');
  assert.equal(find(man({ 'sim.lensis': 'on' }), 'Lens stabilization').status, 'red');
});

test('Base ISO: ISO above the range is red, at or below it passes', () => {
  assert.equal(find(man({ 'c.1.me.iso': '6400' }), 'Base ISO range').status, 'red');
  assert.equal(find(man({ 'c.1.me.iso': '3200' }), 'Base ISO range').status, 'green');
  assert.equal(find(man({ 'c.1.me.iso': '800', 'c.1.me.baseiso': 'Iso3200 12db' }), 'Base ISO range').status, 'green');
});

test('a setting the camera does not report never passes on its own, and Auto Base ISO cannot be compared', () => {
  const rows = man({ 'c.1.me.baseiso': 'auto' }, { mandatory: { sensor: [], digitalIS: [], baseIso: ['c.1.me.baseiso'], teleConverter: [], lensIS: [] } });
  for (const c of ['Sensor mode', 'Digital IS', 'Tele-converter', 'Lens stabilization', 'Base ISO range', 'Lens filter']) {
    assert.equal(find(rows, c).status, 'yellow', c);
    assert.equal(find(rows, c).action, 'confirm', c);
  }
});

test('operator confirmation holds for the same lens on the same day only', () => {
  const lens = goodCamera()['c.1.lens.name'];
  const now = new Date().toISOString();
  assert.equal(find(man({}, SIM, { lensFilter: { at: now, lens } }), 'Lens filter').status, 'green');
  assert.equal(find(man({}, SIM, { lensFilter: { at: now, lens: 'other lens' } }), 'Lens filter').status, 'yellow');
  assert.equal(find(man({}, SIM, { lensFilter: { at: '2020-01-01T10:00:00.000Z', lens } }), 'Lens filter').status, 'yellow');
});

test('a reported value overrules an older confirmation', () => {
  const lens = goodCamera()['c.1.lens.name'];
  const rows = man({ 'sim.sensor': 's35' }, SIM, { sensor: { at: new Date().toISOString(), lens } });
  assert.equal(find(rows, 'Sensor mode').status, 'red');
});

test('confirmations survive later reads', async () => {
  await svc.assign(CAM(1), 'C80-1');
  await svc.confirm('C80-1', ['lensFilter']);
  const r = await svc.check({ force: true });
  assert.equal(find(rowsFor(r, CAM(1)), 'Lens filter').status, 'green');
  assert.ok(svc.state.bodies['C80-1'].confirmed.lensFilter);
});

test('bar essentials: values, F-number, ISO over range, and null when not reported', () => {
  const info = goodCamera({ 'c.1.me.iso': '6400', 'c.1.me.diaphragm': '280', 'sim.lensis': 'on' });
  const e = essentials(info, summarize(info), SIM);
  assert.deepEqual(e, { wb: '5600K', iso: '6400', isoOver: true, shutter: '1/50', shutterBad: false, aperture: 'F2.8', lensIS: 'ON', digitalIS: 'OFF' });
  for (const mode of ['on', 'on1', 'on2']) {
    const cam = goodCamera({ 'c.1.eis': mode });
    assert.equal(essentials(cam, summarize(cam), SIM).digitalIS, 'ON', mode);
    const row = find(man({ 'c.1.eis': mode }), 'Digital IS');
    assert.equal(row.status, 'red', mode);
    assert.equal(row.detail, 'ON (must be OFF)', mode);
  }
  assert.equal(find(man({}), 'Digital IS').detail, 'OFF');
  const slow = goodCamera({ 'c.1.me.shutter': '100' });
  assert.equal(essentials(slow, summarize(slow), SIM).shutterBad, true);
  const angle = goodCamera({ 'c.1.me.shutter.mode': 'angle' });
  assert.equal(essentials(angle, summarize(angle), SIM).shutter, 'angle');
  const plain = goodCamera();
  delete plain['c.1.me.diaphragm'];
  const none = essentials(plain, summarize(plain), { mandatory: { lensIS: [], digitalIS: [] } });
  assert.equal(none.aperture, null);
  assert.equal(none.lensIS, null);
  assert.equal(none.digitalIS, null);
});

test('the check result carries bar values for each assigned body', async () => {
  await svc.assign(CAM(1), 'C80-1');
  const r = await svc.check({ force: true });
  assert.equal(r.labels[0].essentials.wb, '5600K');
  sim.bodies['C80-1'].offline = true;
  const off = await svc.check({ force: true });
  assert.equal(off.labels[0].essentials, null);
});

test('total runtime adds up across reads and restarts, by label, and skips long gaps', async () => {
  await svc.assign(CAM(1), 'C80-1');
  const k = svc.state.bodies['C80-1'];
  k.runtimeMs = 3600000;
  k.lastSeen = new Date(Date.now() - 30000).toISOString();
  await svc.check({ force: true });
  const after = svc.state.bodies['C80-1'];
  assert.ok(after.runtimeMs >= 3630000 && after.runtimeMs < 3640000, String(after.runtimeMs));
  assert.ok(after.runtimeByLabel[CAM(1)] >= 30000);

  after.lastSeen = new Date(Date.now() - 6 * 3600000).toISOString();
  const before = after.runtimeMs;
  await svc.check({ force: true });
  assert.ok(svc.state.bodies['C80-1'].runtimeMs - before < 5000, 'six hours switched off is not runtime');

  const again = new ShotReadyService(dir, { dupDelayMs: 1 });
  assert.ok(again.workloadView().find((w) => w.body === 'C80-1').runtimeMs >= 3630000);
  assert.ok(again.workloadView().find((w) => w.body === 'C80-1').since);
});

test('a spare shows its checks but they do not count towards the verdict', async () => {
  sim.bodies['C80-2'].info = { ...sim.bodies['C80-2'].info, 'c.1.colorbar': 'on' };
  await svc.assign(CAM(1), 'C80-1');
  const r = await svc.check({ force: true });
  const spare = r.spares.find((s) => s.body === 'C80-2');
  assert.ok(spare.checks.some((c) => c.check === 'Color bars' && c.status === 'red'));
  assert.equal(r.reds, 0);
});

test('giving a body a label another body holds makes the other one spare', async () => {
  await svc.assign(CAM(1), 'C80-1');
  const res = await svc.assign(CAM(1), 'C80-2');
  assert.equal(res.previous, 'C80-1');
  assert.ok(svc.lastResult.spares.some((s) => s.body === 'C80-1'));
});

test('old placeholder labels move to Cam-01 style and keep their body', () => {
  const d = mkdtempSync(join(tmpdir(), 'shotready-'));
  const cfg = sim.config({ locations: Array.from({ length: 8 }, (_, i) => ({ label: `CAM ${i + 1}` })) });
  writeFileSync(join(d, 'cameras.json'), JSON.stringify(cfg));
  writeFileSync(join(d, 'shotready-state.json'), JSON.stringify({ assignments: { 'CAM 2': { body: 'C80-1', since: '2026-11-06T10:00:00.000Z' } }, bodies: {}, labelRef: {}, history: [{ label: 'CAM 2', body: 'C80-1', from: '2026-11-06T10:00:00.000Z' }] }));
  const s2 = new ShotReadyService(d, { dupDelayMs: 1 });
  assert.equal(s2.cfg.locations[1].label, 'Cam-02');
  assert.equal(s2.state.assignments['Cam-02'].body, 'C80-1');
  assert.equal(s2.state.history[0].label, 'Cam-02');
  assert.match(readFileSync(join(d, 'cameras.json'), 'utf8'), /Cam-08/);
});

const part = (t) => `--boundary\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(t)}\r\n\r\n${t}\r\n`;

test('multipart parser survives chunks split anywhere, including inside a character', () => {
  const wire = Buffer.from(part('a:=1\nname:=Café\n') + part('b:=2\n') + '--boundary--');
  for (let cut = 1; cut < wire.length; cut++) {
    const parser = new MultipartParser('boundary');
    const got = [...parser.push(wire.subarray(0, cut)), ...parser.push(wire.subarray(cut))];
    assert.deepEqual(got, ['a:=1\nname:=Café\n', 'b:=2\n'], `cut at ${cut}`);
  }
});

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 2)); }
  return false;
};
const liveUp = (s, n) => until(() => s.liveStatus().connected === n);

test('a pushed change reaches the result without any new read, and is measured', async () => {
  svc.cfg.pollSeconds = 3600;
  await svc.assignInOrder();
  svc.startLive();
  try {
    assert.ok(await liveUp(svc, 3), 'all streams connect');
    const before = sim.bodies['C80-1'].requests;
    const times = [];
    for (let i = 0; i < 20; i++) {
      const iso = String(1000 + i);
      const start = performance.now();
      const seen = new Promise((res) => {
        const on = (r) => { if (r.labels[0].summary.iso === iso) { svc.off('result', on); res(); } };
        svc.on('result', on);
      });
      sim.bodies['C80-1'].update({ 'c.1.me.iso': iso });
      await seen;
      times.push(performance.now() - start);
      await new Promise((r) => setTimeout(r, 25));
    }
    times.sort((a, b) => a - b);
    console.log(`push to result, local simulator: median ${times[10].toFixed(1)} ms, worst ${times[19].toFixed(1)} ms`);
    assert.ok(times[19] < 100, `worst ${times[19]}`);
    assert.equal(sim.bodies['C80-1'].requests, before, 'no extra requests were needed');
  } finally { svc.stop(); }
});

test('a pushed bad setting flips the verdict at once and bursts stay coalesced', async () => {
  svc.cfg.pollSeconds = 3600;
  await svc.assign(CAM(1), 'C80-1');
  svc.startLive();
  try {
    assert.ok(await liveUp(svc, 3));
    await until(() => svc.lastResult.live.connected === 3 || true);
    sim.bodies['C80-1'].update({ 'c.1.colorbar': 'on' });
    assert.ok(await until(() => find(rowsFor(svc.lastResult, CAM(1)), 'Color bars')?.status === 'red', 500));
    assert.equal(svc.lastResult.verdict, 'not-ready');
    let results = 0;
    const on = () => { results++; };
    svc.on('result', on);
    for (let i = 0; i < 200; i++) sim.bodies['C80-1'].update({ 'c.1.nd.filter': String(i) });
    assert.ok(await until(() => svc.lastResult.labels[0].summary.nd === '199', 2000));
    svc.off('result', on);
    assert.ok(results < 100, `200 changes made ${results} results`);
  } finally { svc.stop(); }
});

test('a dropped stream finds an offline camera straight away and reconnects when it returns', async () => {
  svc.cfg.pollSeconds = 3600;
  await svc.assign(CAM(1), 'C80-1');
  svc.startLive();
  try {
    assert.ok(await liveUp(svc, 3));
    const b = sim.bodies['C80-1'];
    b.offline = true;
    b.dropStreams();
    assert.ok(await until(() => find(rowsFor(svc.lastResult, CAM(1)), 'Connection'), 2000), 'seen offline');
    b.offline = false;
    assert.ok(await until(() => svc.liveStatus().connected === 3, 6000), 'reconnected');
    b.update({ 'c.1.me.iso': '1234' });
    assert.ok(await until(() => svc.lastResult.labels[0].summary?.iso === '1234', 500));
  } finally { svc.stop(); }
});

test('a camera that refuses the stream still gets checked, and it is logged once', async () => {
  sim.bodies['C80-1'].noStream = true;
  await svc.assign(CAM(1), 'C80-1');
  svc.startLive();
  try {
    assert.ok(await until(() => svc.events.some((e) => /C80-1: no live updates/.test(e.text))));
    const r = await svc.check({ force: true });
    assert.ok(find(rowsFor(r, CAM(1)), 'Gamma'), 'still checked by normal read');
  } finally { svc.stop(); }
});

test('turning Live off closes the streams', async () => {
  svc.startLive();
  assert.ok(await liveUp(svc, 3));
  svc.setAutoRefresh(false);
  assert.equal(svc.liveStatus().total, 0);
  assert.ok(await until(() => Object.values(sim.bodies).every((b) => b.subs.size === 0)));
  svc.stop();
});

test('runtime counts camera uptime, including time before ShotReady first saw it, and survives a power cycle', async () => {
  await svc.assign(CAM(1), 'C80-1');
  const b = sim.bodies['C80-1'];
  const clock = Date.now() / 1000;
  const at = (up, boot = clock) => { b.info = { ...b.info, timestamp: String(up), realtime: String(boot + up) }; };
  delete svc.state.bodies['C80-1'];
  at(600);
  await svc.check({ force: true });
  assert.equal(svc.state.bodies['C80-1'].runtimeMs, 600000, 'ten minutes on before ShotReady opened');
  at(660);
  await svc.check({ force: true });
  assert.equal(svc.state.bodies['C80-1'].runtimeMs, 660000);
  await svc.check({ force: true });
  assert.equal(svc.state.bodies['C80-1'].runtimeMs, 660000, 'same uptime adds nothing');
  at(30, clock + 5000);
  await svc.check({ force: true });
  assert.equal(svc.state.bodies['C80-1'].runtimeMs, 690000, 'restarted camera keeps the earlier total');
});

test('lifetime: an entered hour meter starts the count fresh and persists; bad input is refused', async () => {
  svc.state.bodies['C80-1'] = { runtimeMs: 7200000, runtimeByLabel: { x: 7200000 } };
  svc.setBaselineHours('C80-1', 1234.5);
  const w = svc.workloadView().find((x) => x.body === 'C80-1');
  assert.equal(w.baselineHours, 1234.5);
  assert.equal(w.runtimeMs, 0);
  assert.throws(() => svc.setBaselineHours('C80-1', -1), /positive/);
  assert.throws(() => svc.setBaselineHours('nope', 1), /Unknown body/);
  const again = new ShotReadyService(dir, { dupDelayMs: 1 });
  assert.equal(again.workloadView().find((x) => x.body === 'C80-1').baselineHours, 1234.5);
});

test('real C80 values: Base ISO format, blank aperture without a lens, F-number with one', () => {
  const real = goodCamera({ 'c.1.me.baseiso': 'iso800_12db', 'c.1.me.iso': '250', 'c.1.me.diaphragm': '', 'c.1.me.fno': '', 'c.1.ae.fno': '', 'c.1.ae.diaphragm': '' });
  const s = summarize(real);
  const std = { mandatory: { baseIso: ['c.1.me.baseiso'] } };
  assert.equal(find(mandatoryChecks(real, s, std), 'Base ISO range').status, 'green');
  assert.equal(essentials(real, s, std).aperture, null);
  assert.equal(essentials({ ...real, 'c.1.me.fno': '2.8' }, s, std).aperture, 'F2.8');
  const over = { ...real, 'c.1.me.iso': '1600' };
  assert.equal(find(mandatoryChecks(over, summarize(over), std), 'Base ISO range').status, 'red');
});

const flat = (w, h, y) => Buffer.alloc(w * h * 4, y);

test('waveform levels: video scale, percentiles ignore specks, and channel order is honoured', () => {
  assert.deepEqual(lumaStats(flat(40, 40, 16), 40, 40), { peak: 0, avg: 0, low: 0 });
  assert.deepEqual(lumaStats(flat(40, 40, 235), 40, 40), { peak: 100, avg: 100, low: 100 });
  assert.deepEqual(lumaStats(flat(40, 40, 0), 40, 40), { peak: 0, avg: 0, low: 0 });
  assert.equal(lumaStats(flat(40, 40, 255), 40, 40).peak, 109);

  const speck = flat(100, 100, 126);
  speck[0] = speck[1] = speck[2] = 255;
  assert.equal(lumaStats(speck, 100, 100).peak, 50, 'one hot pixel does not set the peak');

  const half = flat(100, 100, 16);
  for (let i = 0; i < half.length; i += 4) if (((i / 4) % 100) >= 50) half[i] = half[i + 1] = half[i + 2] = 235;
  const w = lumaStats(half, 100, 100);
  assert.equal(w.peak, 100);
  assert.equal(w.low, 0);
  assert.equal(w.avg, 50);

  const red = flat(10, 10, 0);
  for (let i = 0; i < red.length; i += 4) red[i + 2] = 255;
  assert.ok(lumaStats(red, 10, 10, { bgra: true }).avg > lumaStats(red, 10, 10, { bgra: false }).avg, 'red weighs more than blue');
});

test('waveform runs per camera, only reads frames, and clears when a camera goes away', async () => {
  const decodeJpeg = (buf) => ({ data: flat(20, 20, buf[0]), width: 20, height: 20, bgra: true });
  svc = freshService({ decodeJpeg });
  svc.cfg.waveformMs = 5;
  svc.cfg.pollSeconds = 3600;
  const b = sim.bodies['C80-1'];
  b.frame = Buffer.from([126]);
  await svc.assign(CAM(1), 'C80-1');
  const seen = [];
  svc.on('wave', (w) => seen.push(w));
  svc.startLive();
  try {
    assert.ok(await until(() => svc.waves['C80-1']?.peak === 50));
    assert.deepEqual(seen.find((w) => w.body === 'C80-1').wave, { peak: 50, avg: 50, low: 50 });
    b.frame = Buffer.from([235]);
    assert.ok(await until(() => svc.waves['C80-1']?.peak === 100));
    b.frame = null;
    assert.ok(await until(() => !svc.waves['C80-1']), 'no frame clears the reading');
    assert.ok(b.methods.every((m) => m === 'GET'));
    assert.equal(svc.waves['C80-2'], undefined, 'a camera with no frame shows none');
  } finally { svc.stop(); b.frame = null; }
});

test('turning Live off stops reading frames', async () => {
  // Counted at the decoder: services from earlier tests may still run their safety check against this simulator.
  let frames = 0;
  const decodeJpeg = (buf) => { frames++; return { data: flat(4, 4, buf[0]), width: 4, height: 4, bgra: true }; };
  svc = freshService({ decodeJpeg });
  svc.cfg.waveformMs = 5;
  const b = sim.bodies['C80-1'];
  b.frame = Buffer.from([100]);
  await svc.check({ force: true });
  svc.startLive();
  assert.ok(await until(() => svc.waves['C80-1']));
  svc.setAutoRefresh(false);
  await new Promise((r) => setTimeout(r, 30));
  const n = frames;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(frames, n, 'no more frames after Live is off');
  svc.stop();
  b.frame = null;
});

test('simulator info text round-trips through parseInfo', () => {
  const i = goodCamera();
  assert.deepEqual(parseInfo(toInfoText(i)), i);
});
