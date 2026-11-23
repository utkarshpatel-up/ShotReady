import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard, Menu, screen, nativeImage } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { checkForUpdate, applyUpdate, repoOf } from './updater.mjs';
import { Playout } from './playout.mjs';
import { Preprocessor } from './preprocess.mjs';
import { Streamer } from './stream.mjs';
import { createRequire } from 'node:module';
import { MobileServer, mobileView, newMobileKey, MOBILE_DEFAULT_PORT } from '../core/mobile.mjs';
import { ShotReadyService } from '../core/service.mjs';
import { AtemLink, FakeAtemLink } from '../core/atem.mjs';
import { PROFILES } from '../core/engine.mjs';
import { demoBodies, startSimulator, labelName } from '../sim/cameras.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const isDemo = process.argv.includes('--demo');
// Lets the end-to-end test run against a throwaway data folder.
const dataOverride = process.argv.find((a) => a.startsWith('--data-dir='))?.slice('--data-dir='.length);

let win, bar, svc, sim, playout, preprocessor, streamer, mobile;
let mobileError = null;
const qrcode = createRequire(import.meta.url)('qrcode-generator');

const encrypt = (s) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows could not protect the password, so it was not saved');
  return safeStorage.encryptString(s).toString('base64');
};
const decrypt = (s) => {
  try { return safeStorage.decryptString(Buffer.from(s, 'base64')); } catch { return ''; }
};

// ---------- software update ----------
const REPO = repoOf(JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')));
const updateCtx = () => ({
  repo: REPO, version: app.getVersion(), packaged: app.isPackaged, root: join(here, '../..'),
  installDir: dirname(process.execPath), tempDir: join(app.getPath('temp'), 'shotready-update'),
});

// Does the update, then ends this program so the new files can take over.
async function installUpdate() {
  const r = await applyUpdate(updateCtx());
  svc?.stop(); svc?.atem?.disconnect(); sim?.close();
  if (r.action === 'installer') {
    // The installer closes and replaces the running copy, then starts the new one.
    spawn(r.path, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (r.action === 'reinstall') {
    // New packages replace this program's own files, so they are installed after it has exited.
    const log = join(app.getPath('userData'), 'update.log');
    const line = `ping -n 4 127.0.0.1 >nul & npm ci --ignore-scripts >> "${log}" 2>&1 && node node_modules\\electron\\install.js >> "${log}" 2>&1 && npm start >> "${log}" 2>&1`;
    spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd: updateCtx().root, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  } else {
    app.relaunch();
  }
  setTimeout(() => app.exit(0), 200);
  return { ok: true };
}

function decodeJpeg(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error('Could not decode preview frame');
  const { width, height } = img.getSize();
  return { data: img.toBitmap(), width, height, bgra: true };
}

// Demo only: a dark-to-bright picture, different on each camera, with a bar that moves so the
// feed can be seen to be live.
function demoFrame(i, tick) {
  const width = 128, height = 72;
  const top = 90 + i * 18;
  const data = Buffer.alloc(width * height * 4, 255);
  const bar = (tick * 4) % width;
  for (let n = 0; n < width * height; n++) {
    const col = n % width;
    let y = 30 + Math.round((top - 30) * (col / (width - 1)));
    if (Math.abs(col - bar) < 5) y = 235;
    data[n * 4] = data[n * 4 + 1] = data[n * 4 + 2] = y;
  }
  return nativeImage.createFromBitmap(data, { width, height }).toJPEG(95);
}

// What each demo camera's focus guide says: some sharp, some soft, one in auto focus.
const DEMO_FOCUS = [
  { status: true, level: 2, angle: 0, dir: 'front', pos: { x: 5000, y: 5000, w: 1200, h: 2100 } },
  { status: true, level: 2, angle: 0, dir: 'front', pos: { x: 3600, y: 4600, w: 1000, h: 1750 } },
  { status: true, level: 0, angle: 38, dir: 'front', pos: { x: 6400, y: 5200, w: 1400, h: 2450 } },
  { status: true, level: 1, angle: 14, dir: 'behind', pos: { x: 5000, y: 4300, w: 1100, h: 1900 } },
  null,
  { status: true, level: 2, angle: 0, dir: 'front', pos: { x: 4200, y: 5600, w: 1300, h: 2300 } },
  { status: true, level: 2, angle: 0, dir: 'front', pos: { x: 5000, y: 5000, w: 1000, h: 1750 } },
  { status: true, level: 0, angle: 52, dir: 'behind', pos: { x: 5600, y: 5000, w: 1200, h: 2100 } },
];

// Who each demo camera's people detection has found: two people on C80-2 (AF frame Spot) and on
// C80-6 (AF frame Auto), so choosing a person by clicking can be tried.
const DEMO_PEOPLE = {
  1: [{ type: 'face', track: true, pos: { x: 3600, y: 4300, w: 900, h: 1400 } }, { type: 'face', track: false, pos: { x: 7000, y: 4500, w: 800, h: 1300 } }],
  5: [{ type: 'face', track: true, pos: { x: 1800, y: 4500, w: 900, h: 1400 } }, { type: 'face', track: false, pos: { x: 8200, y: 4400, w: 800, h: 1300 } }],
};

async function startService() {
  const base = dataOverride || app.getPath('userData');
  if (isDemo) {
    const dataDir = dataOverride || join(base, 'demo');
    let tick = 0;
    sim = await startSimulator(demoBodies().map((b, i) => ({ ...b, focus: DEMO_FOCUS[i], detect: DEMO_PEOPLE[i] || [], frame: () => demoFrame(i, tick++) })));
    for (const b of Object.values(sim.bodies)) b.frameDelayMs = 60;
    // Simulator ports change each launch, so a demo always starts from a clean config.
    const config = sim.config({ pollSeconds: 10 });
    config.locations.push({ label: 'Cam-09', atemInput: 9 }, { label: 'Cam-10', atemInput: 10 });
    const atem = new FakeAtemLink({
      modeName: 'P4KHDp25', modeLabel: '2160p25',
      inputs: { ...Object.fromEntries(config.locations.map((l) => [l.atemInput, l.label])), 3010: 'Media Player 1', 3020: 'Media Player 2' },
      mixEffects: [{ program: 1, preview: 2 }, { program: 5, preview: 3 }],
    });
    mkdirSync(dataDir, { recursive: true });
    rmSync(join(dataDir, 'shotready-state.json'), { force: true });
    writeFileSync(join(dataDir, 'cameras.json'), JSON.stringify(config, null, 2));
    svc = new ShotReadyService(dataDir, { atem, demo: true, decodeJpeg });
    const now = new Date().toISOString();
    const hours = [412, 386, 97, 540, 268, 153, 44, 301];
    config.bodies.forEach((b, i) => {
      const label = labelName(i);
      svc.state.assignments[label] = { body: b.id, since: now };
      svc.state.history.push({ label, body: b.id, from: now });
      svc.state.bodies[b.id] = { runtimeMs: hours[i] * 3.6e6, runtimeByLabel: { [label]: hours[i] * 3.6e6 }, runtimeSince: '2026-01-05T09:00:00.000Z' };
    });
    svc.saveState();
  } else {
    const seed = JSON.parse(readFileSync(join(here, '../../config/cameras.default.json'), 'utf8'));
    svc = new ShotReadyService(base, { defaultConfig: seed, atem: new AtemLink(), encrypt, decrypt, decodeJpeg });
    svc.startAtem();
  }
  const send = (name, payload) => {
    for (const w of [win, bar]) if (w && !w.isDestroyed()) w.webContents.send(`shotready:${name}`, payload);
  };
  svc.on('result', (r) => send('result', r));
  svc.on('log', (e) => send('log', e));
  svc.on('atem', (a) => send('atem', a));
  svc.on('wave', (w) => send('wave', w));
  svc.on('focus', (f) => send('focus', f));
  svc.on('feedstat', (f) => send('feedstat', f));
  // Video out: the output window on the HDMI display. Nothing opens until it is turned on. Clips can
  // be pre-processed in the background by a hidden window of their own.
  preprocessor = new Preprocessor({ page: join(here, '../renderer/preprocess.html'), preload: join(here, 'preload.cjs') });
  playout = new Playout({
    preprocessor, outDir: join(svc.dataDir, 'video-out'),
    page: join(here, '../renderer/playout.html'), preload: join(here, 'preload.cjs'),
    settings: () => svc.state.playout || {},
    save: (patch) => { svc.state.playout = { ...svc.state.playout, ...patch }; svc.saveStateSoon(); },
    profile: () => svc.profile,
    lut: () => svc.playoutLutData(),
    lutView: () => svc.playoutLutView(),
    // The Screen source can go through the inverse LUT, a monitoring LUT, or a LUT of its own.
    screenLuts: () => ({ video: svc.playoutLutView(), own: svc.screenLutView(), gammas: svc.lutsView().luts }),
    screenLutData: (choice) => (choice === 'own' ? svc.screenLutData()
      : choice.startsWith('gamma:') ? svc.lutData(choice.slice(6)) : svc.playoutLutData()),
    // A test machine has one display: the tests may use it as the output.
    allowPrimary: !!(dataOverride && process.env.SHOTREADY_TEST_PLAYOUT),
  });
  playout.on('status', (s) => send('playout', s));
  playout.on('note', (text) => svc.log('yellow', text));
  playout.on('info', (text) => svc.log('info', text));
  // Live stream: a video input on this computer, encoded in a hidden window of its own and sent to
  // YouTube, a Zoom webinar or any RTMP server. Nothing is opened or sent until Go live is pressed.
  streamer = new Streamer({
    page: join(here, '../renderer/stream.html'), preload: join(here, 'preload.cjs'),
    settings: () => svc.state.stream || {},
    save: (patch) => { svc.state.stream = { ...svc.state.stream, ...patch }; svc.saveStateSoon(); },
    encrypt, decrypt, lut: (gamma) => svc.lutData(gamma), version: app.getVersion(),
    testFile: () => join(svc.dataDir, 'stream-test.flv'),
    // A test hook, honoured only with a throwaway data folder: a test machine has no AAC encoder.
    audioCodec: (dataOverride && process.env.SHOTREADY_TEST_STREAM_AUDIO) || undefined,
  });
  streamer.on('status', (s) => send('stream', s));
  streamer.on('note', (text) => svc.log('yellow', text));
  streamer.on('info', (text) => svc.log('info', text));
  streamer.on('alarm', (text) => svc.log('red', text));
  // Phone view: a read-only page of the pictures and essentials for phones on the same network.
  // Off until turned on in Settings; its address carries a key that stays the same between runs.
  svc.state.mobile = { on: false, port: MOBILE_DEFAULT_PORT, ...svc.state.mobile };
  if (!svc.state.mobile.key) { svc.state.mobile.key = newMobileKey(); svc.saveStateSoon(); }
  mobile = new MobileServer({
    dir: join(here, '../renderer'),
    view: () => mobileView({ result: svc.lastResult, atem: svc.atemSummary(), focus: svc.focus, waves: svc.waves }),
    feedBase: () => svc.feedBase(),
    key: () => svc.state.mobile.key,
  });
  for (const ev of ['result', 'atem', 'focus', 'wave']) svc.on(ev, () => mobile.update());
  mobile.on('viewers', () => send('mobile', mobileStatus()));
  if (svc.state.mobile.on) startMobile().catch(() => {});
  svc.startLive();
  // Demo only: someone keeps adjusting C80-2's white balance, and C80-1 keeps drifting out of
  // focus and back, so live updates can be seen.
  if (isDemo) {
    let warm = false;
    setInterval(() => { warm = !warm; sim.bodies['C80-2'].update({ 'c.1.wb.kelvin': warm ? '5400' : '5600' }); }, 3000).unref();
    let soft = false;
    setInterval(() => {
      soft = !soft;
      sim.bodies['C80-1'].setFocus(soft ? { ...DEMO_FOCUS[0], level: 0, angle: 30 } : DEMO_FOCUS[0]);
    }, 4000).unref();
  }
}

// ---------- phone view ----------
async function startMobile() {
  mobileError = null;
  try {
    await mobile.start(svc.state.mobile.port);
    svc.log('info', `Phone view on: ${mobile.urls().map((u) => u.url).join('  ')}`);
  } catch (e) {
    mobileError = e.message;
    svc.log('red', `Phone view could not start: ${e.message}`);
    throw e;
  }
}

// What Settings shows: on or off, the addresses with a QR code each, and how many phones watch.
function mobileStatus() {
  const qr = (text) => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createDataURL(4, 2);
  };
  return {
    on: !!svc.state.mobile.on, running: mobile.running, port: svc.state.mobile.port, error: mobileError,
    urls: mobile.urls().map((u) => ({ ...u, qr: u.name === 'this computer' ? null : qr(u.url) })), viewers: mobile.viewers(),
  };
}

// The renderer can reach only what is listed here.
const api = {
  init: async () => ({
    feed: await svc.feedBase(),
    focus: svc.focus,
    cardOrder: svc.state.cardOrder || [],
    keyMode: svc.state.keyMode || 'mixer',
    profiles: PROFILES,
    profile: svc.profile,
    switcher: svc.state.switcher,
    barOpen: !!bar,
    demo: isDemo,
    version: app.getVersion(),
    bodies: svc.cfg.bodies.map((b) => ({ id: b.id, model: b.model })),
    autoRefresh: svc.state.autoRefresh,
    pollSeconds: svc.cfg.pollSeconds,
    atem: svc.atemSummary(),
    luts: svc.lutsView(),
    result: svc.lastResult,
    waves: svc.waves,
  }),
  check: (opts) => svc.check({ force: true, report: !!opts?.report }),
  setProfile: (k) => svc.setProfile(k),
  setSwitcher: (k) => svc.setSwitcher(k),
  confirm: (id, ids) => svc.confirm(id, ids),
  setCardOrder: (ids) => svc.setCardOrder(ids),
  setControl: (id, key, value) => svc.setControl(id, key, value),
  setRecord: (id, on) => svc.setRecord(id, on),
  stepIso: (dir, id) => svc.stepIso(dir > 0 ? 1 : -1, id),
  stepKelvin: (dir, id) => svc.stepKelvin(dir > 0 ? 1 : -1, id),
  cutMediaPlayer: (n, to) => svc.cutMediaPlayer(Number(n), to === 'program' ? 'program' : 'preview'),
  copyPreview: (from, to) => svc.copyPreview(from, to),
  saveSettingsList: async (id) => { const path = await svc.saveSettingsList(id); shell.showItemInFolder(path); return path; },
  copyApply: (from, to, keys) => svc.copyApply(from, to, Array.isArray(keys) ? keys.map(String) : []),
  menuKey: (key, id) => svc.menuKey(key, id),
  setKeyMode: (mode) => svc.setKeyMode(mode),
  applyFix: (id, check) => svc.applyFix(id, check),
  moveFocus: (id, dir) => svc.moveFocus(id, dir),
  setFocusFrame: (id, x, y, opts) => svc.setFocusFrame(id, x, y, { person: !!opts?.person, frame: typeof opts?.frame === 'string' ? opts.frame : undefined }),
  defaultsPreview: () => svc.defaultsPreview(),
  defaultsApply: () => svc.defaultsApply(),
  digitalIsAll: (on) => svc.digitalIsAll(!!on),
  wbPreview: (wb) => svc.wbPreview(wb),
  wbApply: (wb) => svc.wbApply(wb),
  setBar: (on) => setBar(on),
  showMain: () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); },
  assign: (label, body) => svc.assign(label, body),
  unassign: (label) => svc.unassign(label),
  assignInOrder: () => svc.assignInOrder(),
  diff: (label) => svc.diff(label),
  snapshot: (label) => svc.snapshot(label),
  acceptLens: (id) => svc.acceptLens(id),
  forgetMac: (id) => svc.forgetMac(id),
  bodies: () => svc.bodiesView(),
  sheet: () => svc.sheet(),
  workload: () => svc.workloadView(),
  setPicture: (id, on) => svc.setPicture(String(id), !!on),
  stepBaseIso: (dir, id) => svc.stepBaseIso(Number(dir) > 0 ? 1 : -1, id || null),
  setBaselineHours: (id, hours) => svc.setBaselineHours(id, hours),
  events: () => svc.events,
  settings: () => svc.settingsView(),
  saveSettings: (s) => svc.saveSettings(s),
  setAutoRefresh: (on) => svc.setAutoRefresh(on),
  atemInputs: () => svc.atemSummary().inputs || null,
  atemSearch: () => svc.searchAtem(),
  luts: () => svc.lutsView(),
  lutLoad: async (gamma) => {
    // The environment variable is a test hook, honoured only when a throwaway data folder is given.
    if (dataOverride && process.env.SHOTREADY_TEST_LUT) { const view = svc.loadLut(gamma, process.env.SHOTREADY_TEST_LUT); playout.command('lutChanged'); return view; }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: `LUT for ${gamma}`, properties: ['openFile'], filters: [{ name: '3D LUT', extensions: ['cube'] }],
    });
    if (canceled || !filePaths[0]) return null;
    const view = svc.loadLut(gamma, filePaths[0]);
    playout.command('lutChanged'); // the screen sent on video out may go through this LUT
    return view;
  },
  lutClear: (gamma) => { const view = svc.clearLut(gamma); playout.command('lutChanged'); return view; },
  lutRange: (gamma, input, output) => { const view = svc.setLutRange(gamma, input, output); playout.command('lutChanged'); return view; },
  lutData: (gamma) => svc.lutData(gamma),
  setLutOn: (id, on) => svc.setLutOn(id, on),
  playoutStatus: () => playout.status(),
  playout: (cmd, arg) => playout.command(String(cmd), arg),
  playoutOpen: async () => {
    // The environment variable is a test hook, honoured only when a throwaway data folder is given.
    let paths = dataOverride && process.env.SHOTREADY_TEST_VIDEO ? process.env.SHOTREADY_TEST_VIDEO.split('|') : null;
    if (!paths) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Videos to add to the queue', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (canceled || !filePaths.length) return null;
      paths = filePaths;
    }
    return playout.command('add', paths);
  },
  playoutFolder: () => { mkdirSync(join(svc.dataDir, 'video-out'), { recursive: true }); return shell.openPath(join(svc.dataDir, 'video-out')); },
  streamStatus: () => streamer.status(),
  stream: (cmd, arg) => {
    if (cmd === 'start') return streamer.start();
    if (cmd === 'stop') return streamer.stop();
    if (cmd === 'set') return streamer.set(arg || {});
    if (cmd === 'key') return streamer.setKey(String(arg?.dest), arg?.key);
    throw new Error('Unknown stream command');
  },
  streamShowTest: () => { shell.showItemInFolder(join(svc.dataDir, 'stream-test.flv')); return true; },
  // From the hidden stream window.
  streamReady: () => { streamer.pageReady(); return true; },
  streamReport: (msg) => { streamer.report(msg || {}); return true; },
  // From the hidden pre-processing window.
  ppReady: () => { preprocessor.pageReady(); return true; },
  ppRead: (id, offset, length) => preprocessor.read(String(id), Number(offset), Number(length)),
  ppWrite: (id, bytes, position) => preprocessor.write(String(id), bytes, position === null || position === undefined ? null : Number(position)),
  ppReport: (msg) => { preprocessor.report(msg || {}); return true; },
  playoutLutLoad: async () => {
    let path = dataOverride && process.env.SHOTREADY_TEST_PLAYOUT_LUT;
    if (!path) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Inverse LUT for video out', properties: ['openFile'], filters: [{ name: '3D LUT', extensions: ['cube'] }] });
      if (canceled || !filePaths[0]) return null;
      path = filePaths[0];
    }
    svc.loadPlayoutLut(path);
    return playout.command('lutChanged');
  },
  playoutLutClear: () => { svc.clearPlayoutLut(); return playout.command('lutChanged'); },
  playoutLutRange: (input, output) => { svc.setPlayoutLutRange(input, output); return playout.command('lutChanged'); },
  screenLutLoad: async () => {
    let path = dataOverride && process.env.SHOTREADY_TEST_SCREEN_LUT;
    if (!path) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'LUT for the screen sent on video out', properties: ['openFile'], filters: [{ name: '3D LUT', extensions: ['cube'] }] });
      if (canceled || !filePaths[0]) return null;
      path = filePaths[0];
    }
    svc.loadScreenLut(path);
    playout.command('screenLut', 'own');
    return playout.command('lutChanged');
  },
  screenLutClear: () => { svc.clearScreenLut(); return playout.command('lutChanged'); },
  screenLutRange: (input, output) => { svc.setScreenLutRange(input, output); return playout.command('lutChanged'); },
  mobileStatus: () => mobileStatus(),
  mobileSet: async (o) => {
    const port = Number(o?.port ?? svc.state.mobile.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The port must be a whole number from 1024 to 65535');
    svc.state.mobile = { ...svc.state.mobile, on: !!o?.on, port };
    svc.saveStateSoon();
    mobile.stop();
    if (svc.state.mobile.on) {
      try { await startMobile(); } catch (e) { svc.state.mobile.on = false; svc.saveStateSoon(); throw e; }
    } else { mobileError = null; svc.log('info', 'Phone view off'); }
    return mobileStatus();
  },
  // A new key: every phone with the old link is cut off and needs the new one.
  mobileNewKey: async () => {
    svc.state.mobile.key = newMobileKey();
    svc.saveStateSoon();
    if (mobile.running) { mobile.stop(); await startMobile(); }
    svc.log('info', 'Phone view: new link made; the old one no longer works');
    return mobileStatus();
  },
  // From the output window.
  playoutReady: () => { playout.restore(); return true; },
  playoutReport: (state) => { playout.report(state || {}); return true; },
  copySheet: () => { clipboard.writeText(svc.sheetCsv().replace(/,/g, '\t').replace(/"/g, '')); return true; },
  exportSheet: async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: 'ShotReady-label-sheet.csv', filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    writeFileSync(filePath, svc.sheetCsv());
    return filePath;
  },
  print: () => new Promise((res) => win.webContents.print({}, (ok) => res(ok))),
  openDataFolder: () => shell.openPath(svc.dataDir),
  openReports: () => shell.openPath(svc.reportsDir),
  // The environment variables are a test hook, honoured only when a throwaway data folder is given.
  updateCheck: () => (dataOverride && process.env.SHOTREADY_TEST_UPDATE ? JSON.parse(process.env.SHOTREADY_TEST_UPDATE) : checkForUpdate(updateCtx())),
  updateApply: async () => {
    if (dataOverride && process.env.SHOTREADY_TEST_APPLY) {
      await new Promise((r) => setTimeout(r, 600));
      if (process.env.SHOTREADY_TEST_APPLY === 'fail') throw new Error('git pull failed');
      return { ok: true };
    }
    return installUpdate();
  },
  openReleases: () => shell.openExternal(`https://github.com/${REPO}/releases/latest`),
};

ipcMain.handle('shotready:call', async (_e, method, args) => {
  if (!Object.hasOwn(api, method)) throw new Error(`Unknown call ${method}`);
  return api[method](...args);
});

// ---------- always-on-top bar ----------
const barFile = () => join(svc.dataDir, 'bar-position.json');
const BAR_HEIGHT = 84;
const BAR_LAYOUT = 2; // Raise when the bar needs more room, so an old saved height is not kept.

function barBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const fallback = { x: area.x, y: area.y + area.height - BAR_HEIGHT, width: area.width, height: BAR_HEIGHT };
  try {
    const b = JSON.parse(readFileSync(barFile(), 'utf8'));
    if (b.layout !== BAR_LAYOUT) { b.y -= BAR_HEIGHT - b.height; b.height = BAR_HEIGHT; }
    delete b.layout;
    // A saved position on a monitor that is no longer attached would lose the bar.
    const a = screen.getDisplayMatching(b).workArea;
    const visible = b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    return visible ? b : fallback;
  } catch {
    return fallback;
  }
}

function setBar(on) {
  svc.state.barOpen = !!on;
  svc.saveState();
  if (on && !bar) {
    bar = new BrowserWindow({
      ...barBounds(), minWidth: 480, minHeight: 56, frame: false, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
      maximizable: false, minimizable: false, show: false, backgroundColor: '#14161a', title: 'ShotReady bar',
      webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    // The highest level Windows offers, so it stays above full-screen apps such as RCCA.
    bar.setAlwaysOnTop(true, 'screen-saver');
    bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    bar.webContents.on('will-navigate', (e) => e.preventDefault());
    const remember = () => { try { writeFileSync(barFile(), JSON.stringify({ ...bar.getBounds(), layout: BAR_LAYOUT })); } catch { /* position only */ } };
    bar.on('moved', remember);
    bar.on('resized', remember);
    bar.once('ready-to-show', () => bar.showInactive());
    bar.on('closed', () => { bar = null; });
    bar.loadFile(join(here, '../renderer/bar.html'));
  } else if (!on && bar) {
    bar.close();
  }
  if (win && !win.isDestroyed()) win.webContents.send('shotready:bar', !!on);
  return !!on;
}

// Which graphics chip draws the pictures (and the LUTs), so it can be checked from the Log.
async function logGraphics() {
  try {
    const status = app.getGPUFeatureStatus();
    const info = await app.getGPUInfo('complete');
    const device = info?.gpuDevice?.find((d) => d.active) || info?.gpuDevice?.[0];
    const maker = { 0x8086: 'Intel', 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x1414: 'Microsoft (software)' }[device?.vendorId];
    const chip = info?.auxAttributes?.glRenderer || device?.deviceString || (maker ? `${maker} graphics` : 'no graphics chip found');
    const hardware = /^enabled/.test(status.webgl || '') && /^enabled/.test(status.gpu_compositing || '');
    svc.log(hardware ? 'info' : 'yellow', `Graphics: ${chip}. ${hardware ? 'Pictures and LUTs are drawn on it' : `Not hardware accelerated (WebGL ${status.webgl}), so a LUT may not be shown: pictures are then shown without it`}`);
  } catch (e) {
    svc.log('yellow', `Graphics: could not be read (${e.message})`);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1000, minHeight: 640, backgroundColor: '#14161a', title: 'ShotReady',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(join(here, '../renderer/index.html'));
  // The bar and video out are extra views of the main window: closing the main window ends the app.
  win.on('closed', () => { if (bar) bar.close(); playout?.stop(); preprocessor?.stop(); streamer?.close(); mobile?.stop(); });
}

if (!app.requestSingleInstanceLock() && !dataOverride) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      await startService();
    } catch (e) {
      dialog.showErrorBox('ShotReady could not start', `${e.message}\n\nIf you edited cameras.json by hand, check it for a typing mistake.`);
      app.quit();
      return;
    }
    createWindow();
    if (svc.state.barOpen !== false) setBar(true);
    logGraphics();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { mobile?.stop(); streamer?.close(); preprocessor?.stop(); playout?.stop(); svc?.stop(); svc?.atem?.disconnect(); sim?.close(); });
}
