// ShotReady application service: config + state files, reading bodies, running
// checks, label assignment, references, workload, event log. No Electron imports.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROFILES, DEFAULT_STANDARDS, OLD_DEFAULT_GAMMA, parseInfo, summarize, checkCamera, extractCopySettings, diffAgainstRef,
  bodyIdentity, matchCameras, verdictOf, mandatoryChecks, essentials, shortLens, defaultsPlan, wbPlan, validateOnBody, cameraControls, recordState, focusDrive, focusFrame, checkFixes, fmtVideo,
} from './engine.mjs';
import { httpGet } from './http.mjs';
import { CameraStream } from './stream.mjs';
import { lumaStats } from './waveform.mjs';
import { FocusStream, normalizeFocus } from './focus.mjs';
import { CameraThread } from './camera-thread.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const LOG_KEEP = 500;
const SWITCHERS = {
  constellation: { name: 'Constellation', sdi: '3840x2160:25000:P' },
  '2me': { name: '2 M/E 2RU' },
};
const DEFAULT_LABELS = Array.from({ length: 8 }, (_, i) => `CAM ${i + 1}`);

function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

const NET_ERRORS = {
  ECONNREFUSED: 'connection refused', ECONNRESET: 'connection dropped', UND_ERR_SOCKET: 'connection dropped',
  EHOSTUNREACH: 'no route to camera', ENETUNREACH: 'not on the camera network', ENOTFOUND: 'address not found',
  ETIMEDOUT: 'no response', UND_ERR_CONNECT_TIMEOUT: 'no response',
};
function friendlyError(e) {
  if (e.name === 'TimeoutError') return 'no response';
  return NET_ERRORS[e.cause?.code] || e.cause?.code || e.message;
}

// How much camera on-time this read adds. The camera reports its uptime (timestamp) and clock
// (realtime), so on-time before ShotReady was opened still counts. A camera that does not report
// them falls back to the gap since it was last seen.
function runtimeStep(info, known, now, maxGap) {
  const up = Number(info.timestamp), clock = Number(info.realtime);
  if (up > 0 && clock > 0) {
    const bootAt = clock - up;
    const sameBoot = known.bootAt !== undefined && up >= known.bootUp && Math.abs(bootAt - known.bootAt) < 60;
    const counted = Math.round((sameBoot ? up - known.bootUp : up) * 1000);
    return { counted, boot: { bootAt: sameBoot ? known.bootAt : bootAt, bootUp: up } };
  }
  const gap = known.lastSeen ? now - Date.parse(known.lastSeen) : Infinity;
  return { counted: gap >= 0 && gap <= maxGap ? gap : 0, boot: {} };
}

export class ShotReadyService extends EventEmitter {
  /**
   * @param dataDir   folder for cameras.json, shotready-state.json, events.log, reports/
   * @param opts.defaultConfig  config object seeded on first run
   * @param opts.atem           AtemLink or FakeAtemLink
   * @param opts.encrypt/decrypt  password protection (Electron safeStorage in the app)
   * @param opts.dupDelayMs     pause between duplicate-IP re-reads
   */
  constructor(dataDir, opts = {}) {
    super();
    this.dataDir = dataDir;
    this.opts = opts;
    this.atem = opts.atem || null;
    this.dupDelayMs = opts.dupDelayMs ?? 400;
    this.configPath = join(dataDir, 'cameras.json');
    this.statePath = join(dataDir, 'shotready-state.json');
    this.logPath = join(dataDir, 'events.log');
    this.reportsDir = join(dataDir, 'reports');
    mkdirSync(this.reportsDir, { recursive: true });
    this.profile = '4K25';
    this.lastResult = null;
    this.reads = {};
    this.lensAlerted = {};
    this.running = null;
    this.streams = {};
    this.streamRefused = {};
    this.waves = {};
    // Live view: pictures and focus for the cameras someone is watching.
    this.cams = {};           // one video thread per camera
    this.lampSent = {};       // what each camera's tally lamp was last set to
    this.lampWant = {};
    this.lampBusy = {};
    this.lampFailed = {};
    this.focusStreams = {};
    this.focus = {};
    this.viewers = {};
    this.waveAt = {};
    this.dupAt = {};
    this.frameCounts = {};
    this.timer = null;
    this.load();
    this.log('info', `ShotReady started${opts.demo ? ' in demo mode' : ''}`);
    if (this.atem) {
      this.atemKey = this.atemStateKey();
      this.atem.on('change', () => this.onAtemChange());
    }
  }

  // ---------- files ----------
  load() {
    if (!existsSync(this.configPath)) writeJsonAtomic(this.configPath, this.opts.defaultConfig || { bodies: [], locations: [] });
    const raw = JSON.parse(readFileSync(this.configPath, 'utf8'));
    this.cfg = { infoPath: '/-wvhttp-01-/info.cgi', auth: { user: '', pass: '' }, atem: { ip: '' }, pollSeconds: 5, waveformMs: 1000, standards: {}, bodies: [], locations: [], ...raw };
    // Saved configs still holding the first default list move to the flat standard. A list
    // someone edited is theirs and stays.
    if (this.cfg.standards.allowedGamma?.join() === OLD_DEFAULT_GAMMA.join()) {
      this.cfg.standards.allowedGamma = [...DEFAULT_STANDARDS.allowedGamma];
      this.saveConfig();
    }
    this.std = { ...DEFAULT_STANDARDS, ...this.cfg.standards };

    this.state = { assignments: {}, bodies: {}, labelRef: {}, history: [], profile: '4K25', switcher: 'constellation', autoRefresh: true, barOpen: true };
    if (existsSync(this.statePath)) {
      try {
        this.state = { ...this.state, ...JSON.parse(readFileSync(this.statePath, 'utf8')) };
      } catch {
        // A damaged state file must not stop the app on show day. Keep it for inspection.
        renameSync(this.statePath, `${this.statePath}.damaged-${Date.now()}`);
        this.startupWarning = 'State file was damaged and was set aside. Assignments need re-entering.';
      }
    }
    this.profile = PROFILES[this.state.profile] ? this.state.profile : '4K25';
    if (!SWITCHERS[this.state.switcher]) this.state.switcher = 'constellation';
    // Installs that still have the original placeholder names move to Cam-01 ... Cam-08.
    const CAM8 = Array.from({ length: 8 }, (_, i) => `Cam-0${i + 1}`).join();
    if (this.cfg.locations.map((l) => l.label).join() === DEFAULT_LABELS.join()) {
      const next = DEFAULT_LABELS.map((_, i) => `Cam-0${i + 1}`);
      this.renameLabels(DEFAULT_LABELS, next);
      this.cfg.locations.forEach((l, i) => { l.label = next[i]; });
      this.saveConfig();
      this.saveState();
    }
    // Installs with the standard eight labels gain Cam-09 and Cam-10.
    if (this.cfg.locations.map((l) => l.label).join() === CAM8) {
      this.cfg.locations.push({ label: 'Cam-09' }, { label: 'Cam-10' });
      this.saveConfig();
    }
    this.events = [];
    if (existsSync(this.logPath)) {
      this.events = readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean).slice(-LOG_KEEP).flatMap((l) => {
        try { return [JSON.parse(l)]; } catch { return []; }
      });
    }
    if (this.startupWarning) this.log('red', this.startupWarning);
  }
  saveState() { writeJsonAtomic(this.statePath, this.state); }
  saveConfig() { writeJsonAtomic(this.configPath, this.cfg); }

  log(level, text) {
    const e = { time: new Date().toISOString(), level, text };
    this.events.push(e);
    if (this.events.length > LOG_KEEP) this.events.shift();
    try { appendFileSync(this.logPath, JSON.stringify(e) + '\n'); } catch { /* logging never breaks a check */ }
    this.emit('log', e);
  }

  authForRequests() {
    const a = this.cfg.auth || {};
    if (!a.user) return null;
    const pass = a.passEnc && this.opts.decrypt ? this.opts.decrypt(a.passEnc) : (a.pass || '');
    return { user: a.user, pass };
  }

  // ---------- reading ----------
  async fetchInfo(body, auth) {
    const res = await httpGet(`http://${body.ip}${this.cfg.infoPath}`, auth);
    if (res.status === 401) throw new Error('login rejected, check Settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseInfo(await res.text());
  }

  // Reads a body three times: a MAC that flips between reads means two cameras share the IP.
  async readBody(body, { dupCheck = true } = {}) {
    const auth = this.authForRequests();
    try {
      const info = await this.fetchInfo(body, auth);
      let dupMacs = null;
      if (dupCheck) {
        const macs = new Set([info['s.hardware.address']]);
        for (let i = 0; i < 2; i++) {
          await sleep(this.dupDelayMs);
          try { macs.add((await this.fetchInfo(body, auth))['s.hardware.address']); } catch { /* a dropped re-read is not a duplicate */ }
        }
        macs.delete(undefined);
        if (macs.size > 1) dupMacs = [...macs];
      }
      return { body, info, summary: summarize(info), dupMacs };
    } catch (e) {
      return { body, error: friendlyError(e) };
    }
  }

  findBody(id) { return this.cfg.bodies.find((b) => b.id === id); }
  findLocation(label) { return this.cfg.locations.find((l) => l.label === label); }
  labelOfBody(id) { return Object.entries(this.state.assignments).find(([, a]) => a.body === id)?.[0]; }

  // Learns MAC on first sight and the first lens. A later lens change stays flagged until
  // accepted, otherwise auto-refresh would clear the warning seconds after it appeared.
  rememberBody(rb, now = Date.now()) {
    if (rb.error) return;
    const k = this.state.bodies[rb.body.id] || {};
    const { counted, boot } = runtimeStep(rb.info, k, now, Math.max(this.cfg.pollSeconds * 3, 120) * 1000);
    const where = this.labelOfBody(rb.body.id) || 'Spare';
    const byLabel = { ...k.runtimeByLabel };
    if (counted) byLabel[where] = (byLabel[where] || 0) + counted;
    if (k.lastLens && k.lastLens !== rb.summary.lens && this.lensAlerted[rb.body.id] !== rb.summary.lens) {
      this.lensAlerted[rb.body.id] = rb.summary.lens;
      this.log('yellow', `${rb.body.id}: lens changed ${shortLens(k.lastLens)} → ${shortLens(rb.summary.lens)}`);
    }
    this.state.bodies[rb.body.id] = {
      ...k,
      runtimeMs: (k.runtimeMs || 0) + counted,
      runtimeByLabel: byLabel,
      runtimeSince: k.runtimeSince || new Date(now).toISOString(),
      ...boot,
      mac: k.mac || (rb.dupMacs ? undefined : rb.summary.mac),
      model: rb.summary.model,
      firmware: rb.summary.firmware,
      lastLens: k.lastLens || rb.summary.lens,
      lastSeen: new Date(now).toISOString(),
    };
  }

  // ---------- the check ----------
  // A background refresh shares any run in progress. An explicit check, or one that follows
  // a change, waits its turn so it reports what is true now.
  async check(opts = {}) {
    if (this.running) {
      if (!opts.force && !opts.report) return this.running;
      await this.running.catch(() => {});
      return this.check(opts);
    }
    this.running = this.#check(opts).finally(() => { this.running = null; });
    return this.running;
  }

  async #check({ report = false } = {}) {
    // The triple read that catches two cameras sharing an IP is only needed now and then. Doing
    // it every few seconds triples the status traffic, which a weak link cannot spare.
    const now = Date.now();
    const reads = await Promise.all(this.cfg.bodies.map((b) => {
      const due = now - (this.dupAt[b.id] || 0) > 60000;
      if (due) this.dupAt[b.id] = now;
      return this.readBody(b, { dupCheck: due });
    }));
    this.reads = Object.fromEntries(reads.map((r) => [r.body.id, r]));
    // If a lamp was changed by something else, set it again.
    for (const r of reads) {
      const sent = this.lampSent[r.body.id];
      if (!sent || !r.info) continue;
      const ok = sent === 'off' ? r.info['f.tally'] === 'off' : r.info['f.tally'] === 'on' && r.info['f.tally.mode'] === sent;
      if (!ok) delete this.lampSent[r.body.id];
    }
    return this.#evaluate({ report });
  }

  // Judges what is currently known about every body. Makes no network calls, so a pushed
  // change reaches the screen without waiting for any camera.
  #evaluate({ report = false, pushed = false } = {}) {
    const profile = PROFILES[this.profile];
    const sw = SWITCHERS[this.state.switcher];
    const checkProfile = sw.sdi ? { ...profile, sdi: sw.sdi, sdiWhy: sw.name } : profile;
    const byId = this.reads;
    const reads = this.cfg.bodies.map((b) => byId[b.id]).filter(Boolean);
    this.trackOnlineChanges(reads);

    let reds = 0, yellows = 0;
    const count = (rs) => rs.forEach((r) => { if (r.status === 'red') reds++; if (r.status === 'yellow') yellows++; });

    const seen = {};
    for (const [label, a] of Object.entries(this.state.assignments)) (seen[a.body] ||= []).push(label);

    const atem = this.atemSummary();
    const global = [];
    if (atem.configured && !atem.connected) global.push({ status: 'yellow', check: 'ATEM', detail: `Not connected${atem.error ? ` (${atem.error})` : ''}. Format and labels are not being checked against it.` });
    if (atem.connected && atem.modeName && atem.modeName !== profile.atemMode) global.push({ status: 'red', check: 'ATEM format', detail: `ATEM is ${atem.modeLabel}, profile is ${profile.label}` });
    if (atem.connected && atem.modeName === profile.atemMode) global.push({ status: 'green', check: 'ATEM format', detail: `ATEM is ${atem.modeLabel}` });
    // Empty labels alone are only a warning (a smaller show), but no cameras at all is never ready.
    if (!Object.keys(this.state.assignments).length) global.push({ status: 'red', check: 'No cameras', detail: 'No body is assigned to any label' });
    count(global);

    // While the ATEM drives the lamps, a lamp being off just means the camera is not on air.
    const std = this.tallyDriven(atem) ? { ...this.std, requireTally: false } : this.std;
    const labels = [];
    for (const loc of this.cfg.locations) {
      const id = this.state.assignments[loc.label]?.body;
      const tally = this.atemTally(loc, atem);
      if (!id || !byId[id]) {
        // There can be more labels than cameras, so an empty label is not a problem.
        labels.push({ label: loc.label, body: null, results: [], tally });
        continue;
      }
      const rb = byId[id];
      const known = this.state.bodies[id] || {};
      const results = [...bodyIdentity(rb, known)];
      if (seen[id].length > 1) results.push({ status: 'red', check: 'Double assignment', detail: `${id} is also on ${seen[id].filter((l) => l !== loc.label).join(', ')}` });
      if (atem.connected && loc.atemInput) {
        const name = atem.inputs?.[loc.atemInput];
        if (name !== undefined && name !== loc.label) results.push({ status: 'yellow', check: 'ATEM label', detail: `Input ${loc.atemInput} is named "${name}" on the ATEM` });
      }
      let diffCount = 0;
      const ref = this.state.labelRef[loc.label];
      if (!rb.error) {
        results.push(...checkCamera(rb.summary, loc, checkProfile, std));
        results.push(...mandatoryChecks(rb.info, rb.summary, this.std, known.confirmed));
        if (ref) diffCount = diffAgainstRef(ref, rb.info).length;
        if (ref && ref.fromBody !== id && diffCount) results.push({ status: 'yellow', check: 'vs earlier camera', detail: `${diffCount} setting(s) differ from ${ref.fromBody}`, action: 'diff' });
      }
      count(results);
      labels.push({
        label: loc.label, body: id, ip: rb.body.ip, online: !rb.error, summary: rb.summary || null, results, tally,
        ref: ref ? { fromBody: ref.fromBody, time: ref.time } : null, diffCount,
        essentials: rb.error ? null : essentials(rb.info, rb.summary, this.std),
        controls: rb.error ? null : cameraControls(rb.info),
        record: rb.error ? null : recordState(rb.info),
        focusDrive: rb.error ? null : focusDrive(rb.info),
        focusFrame: rb.error ? null : focusFrame(rb.info),
      });
    }

    const spares = [];
    for (const rb of reads) {
      if (this.labelOfBody(rb.body.id)) continue;
      const results = bodyIdentity(rb, this.state.bodies[rb.body.id]).filter((r) => r.check !== 'Connection');
      count(results);
      // Shown on the card so a spare can be readied, but not counted until it is on a label.
      const known = this.state.bodies[rb.body.id] || {};
      const checks = rb.error ? [] : [...checkCamera(rb.summary, {}, checkProfile, std), ...mandatoryChecks(rb.info, rb.summary, this.std, known.confirmed)];
      spares.push({ body: rb.body.id, ip: rb.body.ip, online: !rb.error, summary: rb.summary || null, results, checks, spare: true, controls: rb.error ? null : cameraControls(rb.info), record: rb.error ? null : recordState(rb.info), focusDrive: rb.error ? null : focusDrive(rb.info), focusFrame: rb.error ? null : focusFrame(rb.info) });
    }

    for (const c of [...labels, ...spares]) {
      const info = byId[c.body]?.info;
      if (!info || !c.online) continue;
      const fixes = checkFixes(info, this.std);
      for (const r of [...c.results, ...(c.checks || [])]) if (fixes[r.check]) r.fix = fixes[r.check].label;
    }

    const live = labels.filter((l) => l.online).map((l) => ({ label: l.label, summary: l.summary }));
    const matching = live.length > 1 ? matchCameras(live, this.std.consistencyKeys) : [];
    yellows += matching.length;

    reads.forEach((rb) => this.rememberBody(rb));
    // "First good check" sets a label's reference: a body with reds is no reference.
    for (const l of labels) {
      if (!l.online || this.state.labelRef[l.label] || l.results.some((r) => r.status === 'red')) continue;
      this.state.labelRef[l.label] = { fromBody: l.body, time: new Date().toISOString(), settings: extractCopySettings(byId[l.body].info) };
      l.ref = { fromBody: l.body, time: this.state.labelRef[l.label].time };
      this.log('info', `${l.label}: reference saved from ${l.body}`);
    }
    // Pushed changes can come in bursts, so those writes to disk are batched.
    if (pushed) this.saveStateSoon(); else this.saveState();

    const result = {
      time: new Date().toISOString(), profile: this.profile, profileLabel: profile.label,
      switcher: this.state.switcher, switcherName: sw.name,
      live: this.liveStatus(),
      verdict: verdictOf(reds, yellows), reds, yellows, global, labels, spares, matching,
    };
    if (this.lastResult?.verdict !== result.verdict) {
      const words = { ready: 'READY TO MIX', warnings: 'READY WITH WARNINGS', 'not-ready': 'NOT READY' };
      this.log(result.verdict === 'ready' ? 'green' : result.verdict === 'warnings' ? 'yellow' : 'red', `${words[result.verdict]} on ${this.profile}: ${reds} red, ${yellows} yellow`);
    }
    if (report) result.reportPath = this.writeReport(result);
    this.lastResult = result;
    this.emit('result', result);
    this.syncTally();
    return result;
  }

  // ---------- live updates ----------
  // Each camera pushes changes over one stream. The regular check keeps running as a safety net:
  // it catches a network that dies silently, and any setting the camera does not push.
  startLive() {
    this.liveEnabled = true;
    this.startCameras();
    this.startStreams();
    this.startTimer();
  }

  // A full read waits for every camera, and an unreachable one holds it up for seconds. These
  // settings are read on their own, camera by camera, so a change shows within about a second.
  startFastReads() {
    clearInterval(this.fastTimer);
    this.fastTimer = setInterval(() => this.#fastRead(), 1000);
    this.fastTimer.unref?.();
  }

  #fastRead() {
    const m = { ...DEFAULT_STANDARDS.mandatory, ...this.std.mandatory };
    const auth = this.authForRequests();
    for (const body of this.cfg.bodies) {
      const info = this.reads[body.id]?.info;
      const items = [...(m.digitalIS || []), ...(m.teleConverter || [])].filter((k) => info && k in info);
      if (!items.length || this.fastBusy[body.id]) continue;
      this.fastBusy[body.id] = true;
      const query = new URLSearchParams(items.map((k) => ['item', k]));
      httpGet(`http://${body.ip}${this.cfg.infoPath}?${query}`, auth, 900)
        .then(async (res) => {
          if (!res.ok) { await res.arrayBuffer(); return; }
          const got = parseInfo(await res.text());
          delete got.timestamp;
          delete got.realtime;
          if (this.reads[body.id]?.info) this.onPushed(body, got);
        })
        .catch(() => {}) // The full read reports a camera that has gone away.
        .finally(() => { this.fastBusy[body.id] = false; });
    }
  }

  startStreams() {
    this.startFastReads();
    this.stopStreams();
    if (!this.liveEnabled || !this.state.autoRefresh) return;
    for (const body of this.cfg.bodies) {
      this.streams[body.id] = new CameraStream(`http://${body.ip}${this.cfg.infoPath}`, () => this.authForRequests(), {
        up: () => { this.scheduleEvaluate(); },
        update: (items) => this.onPushed(body, items),
        down: (reason, { refused, wasConnected }) => {
          if (refused && this.streamRefused[body.id] !== reason) {
            this.streamRefused[body.id] = reason;
            this.log('yellow', `${body.id}: no live updates (${reason}). Using the regular check for this camera.`);
          }
          // A dropped stream may be a camera that just went away: find out now.
          if (wasConnected) this.check({ force: true }).catch(() => {});
        },
      });
    }
    this.startFrames();
  }

  stopStreams() {
    for (const st of Object.values(this.streams)) st.stop();
    this.streams = {};
    this.stopFrames();
  }

  // ---------- live view ----------
  // Every camera has a frame reader. It runs slowly in the background (just enough for the
  // waveform) and fast while a card is on screen, which the feed server tells us about.
  startCameras() {
    if (Object.keys(this.cams).length) return;
    for (const body of this.cfg.bodies) {
      this.cams[body.id] = new CameraThread(body.id, { url: this.frameUrl(body), auth: this.authForRequests() }, {
        viewers: (n) => this.onViewers(body.id, n),
        state: (state) => { if (state === 'down') this.setWave(body.id, null); },
        wave: (jpeg) => this.measureWave(body.id, jpeg),
        stats: (frames) => { if (this.viewers[body.id] > 0) this.emit('feedstat', { body: body.id, fps: frames }); },
        failed: (message) => this.log('red', `${body.id}: video thread stopped (${message})`),
      });
    }
    this.feedReady = Promise.all(Object.values(this.cams).map((c) => c.ready));
    this.feedReady.catch((e) => this.log('red', `Live view could not start: ${e.message}`));
  }

  frameUrl(body) { return `http://${body.ip}${this.cfg.infoPath.replace(/info\.cgi$/, 'image.cgi')}`; }

  startFrames() {
    for (const body of this.cfg.bodies) this.cams[body.id]?.setSource(this.frameUrl(body), this.authForRequests());
    this.framesOn = true;
    this.applyViewing();
  }

  stopFrames() {
    this.framesOn = false;
    for (const cam of Object.values(this.cams)) cam.setMode({ parallel: 0, intervalMs: 0, waveGap: 0 });
    for (const id of Object.keys(this.focusStreams)) this.stopFocus(id);
  }

  onViewers(id, n) {
    this.viewers[id] = n;
    this.applyViewing();
  }

  // The more cameras are watched, the fewer overlapping requests each one gets, so 8 live
  // pictures do not swamp the network or the cameras. liveViewParallel (1 to 4) overrides it.
  applyViewing() {
    if (!this.framesOn) return;
    const watched = Object.keys(this.viewers).filter((id) => this.viewers[id] > 0);
    const fixed = Number(this.cfg.liveViewParallel);
    // 8 overlapping requests to share between the watched cameras, at most 4 each (more than 4
    // made the C80 return errors): 1 or 2 cameras get 4, 3 or 4 get 2, 5 or more get 1.
    const parallel = fixed >= 1 && fixed <= 4 ? fixed : Math.max(1, Math.min(4, Math.floor(8 / Math.max(1, watched.length))));
    const measure = this.opts.decodeJpeg && this.cfg.waveformMs > 0;
    const idle = measure ? { parallel: 1, intervalMs: this.cfg.waveformMs, waveGap: this.cfg.waveformMs } : { parallel: 0, intervalMs: 0, waveGap: 0 };
    // Waveform from the same frames: quicker while someone is watching.
    const live = { parallel, intervalMs: 0, waveGap: measure ? 250 : 0 };
    for (const [id, cam] of Object.entries(this.cams)) cam.setMode(this.viewers[id] > 0 ? live : idle);
    for (const body of this.cfg.bodies) {
      const want = this.viewers[body.id] > 0;
      if (want && !this.focusStreams[body.id]) this.startFocus(body);
      else if (!want && this.focusStreams[body.id]) this.stopFocus(body.id);
    }
  }

  measureWave(id, jpeg) {
    try {
      const { data, width, height, bgra } = this.opts.decodeJpeg(jpeg);
      this.setWave(id, lumaStats(data, width, height, { bgra }));
    } catch { /* one bad frame is skipped */ }
  }

  setWave(id, wave) {
    if (JSON.stringify(this.waves[id] || null) === JSON.stringify(wave)) return;
    if (wave) this.waves[id] = wave; else delete this.waves[id];
    this.emit('wave', { body: id, wave });
  }

  startFocus(body) {
    const path = this.cfg.infoPath.replace(/info\.cgi$/, 'meta.cgi');
    this.focusStreams[body.id] = new FocusStream(`http://${body.ip}${path}`, () => this.authForRequests(), {
      onMeta: (meta) => this.setFocus(body.id, normalizeFocus(meta)),
      onDown: () => this.setFocus(body.id, null),
    });
  }

  stopFocus(id) {
    this.focusStreams[id]?.stop();
    delete this.focusStreams[id];
    this.setFocus(id, null);
  }

  setFocus(id, focus) {
    if (JSON.stringify(this.focus[id] || null) === JSON.stringify(focus)) return;
    if (focus) this.focus[id] = focus; else delete this.focus[id];
    this.emit('focus', { body: id, focus });
  }

  // The local address of each camera's picture stream.
  async feedBase() {
    await this.feedReady;
    return Object.fromEntries(Object.entries(this.cams).map(([id, cam]) => [id, cam.base]));
  }

  // ---------- writing to cameras ----------
  async control(body, params) {
    // The camera reports its display settings as m.something, but takes them on menu.cgi without
    // the m. (read from a real C80: control.cgi refuses them with 406).
    const entries = Object.entries(params);
    const menu = entries.every(([k]) => k.startsWith('m.'));
    const path = this.cfg.infoPath.replace(/info\.cgi$/, menu ? 'menu.cgi' : 'control.cgi');
    const query = new URLSearchParams(menu ? entries.map(([k, v]) => [k.slice(2), v]) : params);
    const res = await httpGet(`http://${body.ip}${path}?${query}`, this.authForRequests());
    const status = res.headers.get('livescope-status');
    await res.arrayBuffer();
    if (res.status === 401) throw new Error('login rejected');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (status && status !== '0') throw new Error(status);
  }

  // ---------- tally from the ATEM to the camera lamps ----------
  tallyDriven(atem) { return this.cfg.tallyFromAtem !== false && !!atem.connected; }

  syncTally() {
    if (!this.liveEnabled || this.cfg.tallyFromAtem === false) return;
    const atem = this.atemSummary();
    const me = atem.mixEffects?.[0];
    const tally = atem.tally || (me ? { program: [me.program], preview: [me.preview] } : null);
    const wanted = {};
    if (atem.connected && tally) {
      this.cfg.locations.forEach((loc, i) => {
        const id = this.state.assignments[loc.label]?.body;
        if (!id) return;
        const input = Number(loc.atemInput) || i + 1;
        wanted[id] = tally.program.includes(input) ? 'program' : tally.preview.includes(input) ? 'preview' : 'off';
      });
    }
    // Any lamp ShotReady lit but no longer controls goes out, so nothing stays red by mistake.
    for (const id of Object.keys(this.lampSent)) wanted[id] ||= 'off';
    for (const [id, want] of Object.entries(wanted)) {
      const body = this.findBody(id);
      if (body && this.reads[id]?.info) this.setLamp(body, want);
    }
  }

  // One request at a time per camera, always ending on the newest state.
  async setLamp(body, want) {
    const id = body.id;
    this.lampWant[id] = want;
    if (this.lampBusy[id]) return;
    this.lampBusy[id] = true;
    try {
      while (this.lampSent[id] !== this.lampWant[id]) {
        const next = this.lampWant[id];
        await this.control(body, next === 'off' ? { 'f.tally': 'off' } : { 'f.tally': 'on', 'f.tally.mode': next });
        this.lampSent[id] = next;
        this.lampFailed[id] = false;
      }
    } catch (e) {
      if (!this.lampFailed[id]) this.log('yellow', `${id}: tally not set (${e.message})`);
      this.lampFailed[id] = true;
    } finally {
      this.lampBusy[id] = false;
    }
  }

  fastBusy = {};
  isoSent = {};
  isoChain = Promise.resolve();
  focusTimers = {};
  focusChain = {};

  // The camera on preview on the lowest M/E. Only labelled cameras have a tally.
  previewCamera() {
    const on = (this.lastResult?.labels || []).filter((l) => l.online && l.tally?.preview?.length);
    on.sort((a, b) => Math.min(...a.tally.preview) - Math.min(...b.tally.preview));
    return on[0] || null;
  }

  // On air on any M/E, or visible in the program output through a key.
  isLive(id) {
    const label = this.labelOfBody(id);
    const atem = this.atemSummary();
    if (!label || !atem.connected) return false;
    const input = Number(this.findLocation(label)?.atemInput) || this.cfg.locations.findIndex((l) => l.label === label) + 1;
    return !!(atem.tally?.program?.includes(input) || atem.mixEffects?.some((m) => m.program === input));
  }

  // Assistant mode never touches a live camera. With the ATEM lost nobody can say which one is
  // live, so everything waits for it to come back. Without an ATEM set up, no camera is on air.
  #assistantLock(id) {
    if (this.state.keyMode !== 'assistant') return null;
    const atem = this.atemSummary();
    if (atem.configured && !atem.connected) return 'the ATEM is not connected, so ShotReady cannot tell which cameras are live';
    return this.isLive(id) ? `${id} is live` : null;
  }

  #guardLive(id) {
    const why = this.#assistantLock(id);
    if (why) throw new Error(`Assistant mode: ${why}. Nothing was changed.`);
  }

  setKeyMode(mode) {
    if (mode !== 'mixer' && mode !== 'assistant') throw new Error('Unknown mode');
    this.state.keyMode = mode;
    this.saveState();
    return mode;
  }

  // One ISO step. Run one at a time so quick taps each move a full step.
  stepIso(dir, selected) {
    const run = this.isoChain.catch(() => {}).then(() => this.#stepIso(dir, selected));
    this.isoChain = run;
    return run;
  }

  // Mixer: only ever the camera on preview. Assistant: the camera that person has selected.
  #isoTarget(selected) {
    if (this.state.keyMode === 'assistant') {
      if (!selected) throw new Error('Click a camera to select it first');
      this.#guardLive(selected);
      return selected;
    }
    const cam = this.previewCamera();
    if (!cam) throw new Error('No camera on preview');
    if (cam.tally.program.length) throw new Error(`${cam.body} is on program too, so its ISO was not changed`);
    return cam.body;
  }

  async #stepIso(dir, selected) {
    const id = this.#isoTarget(selected);
    const body = this.findBody(id);
    const info = this.reads[id]?.info;
    if (!body || !info) throw new Error(`${id} is not online`);
    const control = cameraControls(info).find((c) => c.key === 'c.1.me.iso');
    if (!control) throw new Error(`${id}: ISO cannot be stepped while it is on auto or in gain mode`);
    // The camera's report can lag a quick tap, so step from the value just sent.
    const sent = this.isoSent[id];
    const from = sent && Date.now() - sent.at < 1500 ? sent.value : control.value;
    const i = control.options.findIndex((o) => o.value === from);
    if (i < 0) throw new Error(`${id}: ISO ${from} is not in the camera's list`);
    const next = control.options[i + dir];
    if (!next) throw new Error(`${id} is already at its ${dir > 0 ? 'highest' : 'lowest'} ISO`);
    await this.control(body, { [control.key]: next.value });
    this.isoSent[id] = { value: next.value, at: Date.now() };
    this.log('info', `${id}: ISO set to ${next.text} from the keyboard`);
    clearTimeout(this.isoRefresh);
    this.isoRefresh = setTimeout(() => this.check({ force: true }).catch(() => {}), 400);
    await sleep(50);
    return { body: id, iso: next.text };
  }

  // Push focus closer or further while held. If the stop never arrives the camera is stopped anyway.
  moveFocus(bodyId, dir) {
    if (!['near', 'far', 'one_shot', 'stop'].includes(dir)) throw new Error('Unknown focus direction');
    const body = this.findBody(bodyId);
    const info = this.reads[bodyId]?.info;
    if (!body || !info) throw new Error(`${bodyId} is not online`);
    // A stop always goes through, even if the camera went live while focus was moving.
    if (dir !== 'stop') {
      this.#guardLive(bodyId);
      const drive = focusDrive(info);
      if (!drive?.ok) throw new Error(drive?.why || `${bodyId} cannot move focus`);
    }
    clearTimeout(this.focusTimers[bodyId]);
    if (dir === 'near' || dir === 'far') this.focusTimers[bodyId] = setTimeout(() => this.moveFocus(bodyId, 'stop').catch(() => {}), 4000);
    const run = (this.focusChain[bodyId] || Promise.resolve()).catch(() => {}).then(() => this.control(body, { 'c.1.focus.action': dir }));
    this.focusChain[bodyId] = run;
    return run.then(() => {
      if (dir === 'one_shot') this.log('info', `${bodyId}: 1-shot focus`);
      return true;
    });
  }

  // Put the AF frame where the picture was clicked. x and y are fractions of the picture.
  async setFocusFrame(bodyId, x, y) {
    const body = this.findBody(bodyId);
    const info = this.reads[bodyId]?.info;
    if (!body || !info) throw new Error(`${bodyId} is not online`);
    this.#guardLive(bodyId);
    const frame = focusFrame(info);
    if (!frame?.ok) throw new Error(frame?.why || `${bodyId} cannot move its AF frame`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Unknown position');
    // With Continuous AF on, moving the frame pulls focus straight away.
    const onAir = this.lastResult?.labels.find((l) => l.body === bodyId)?.tally?.program?.length;
    if (onAir && info['c.1.focus'] === 'auto') throw new Error(`${bodyId} is on program with Continuous AF on, so the box was not moved`);
    const place = (n) => String(Math.round(Math.max(0, Math.min(1, n)) * 9999));
    await this.control(body, { 'c.1.focus.frame.1.x': place(x), 'c.1.focus.frame.1.y': place(y) });
    // Focusing on air would show on the program feed, so that stays a deliberate press of 1-Shot AF.
    if (onAir) return { onAir: true };
    if (focusDrive(info)?.ok) {
      await sleep(100);
      await this.moveFocus(bodyId, 'one_shot');
    }
    return { onAir: false };
  }

  // The repair offered on a failed check. Worked out again here from what the camera reports now.
  async applyFix(bodyId, check) {
    const body = this.findBody(bodyId);
    const info = this.reads[bodyId]?.info;
    if (!body || !info) throw new Error(`${bodyId} is not online`);
    this.#guardLive(bodyId);
    const fix = checkFixes(info, this.std)[check];
    if (!fix) throw new Error(`${check} no longer needs fixing on ${bodyId}`);
    for (const [key, value] of fix.params) {
      await this.control(body, { [key]: value });
      await sleep(50);
    }
    this.log('info', `${bodyId}: ${check} fixed (${fix.label})`);
    this.check({ force: true }).catch(() => {});
    return true;
  }

  // Start or stop recording. The card shows what the camera reports, not what was asked for.
  async setRecord(bodyId, on) {
    const body = this.findBody(bodyId);
    const info = this.reads[bodyId]?.info;
    if (!body || !info) throw new Error(`${bodyId} is not online`);
    this.#guardLive(bodyId);
    const state = recordState(info);
    if (!state) throw new Error(`${bodyId} cannot be told to record`);
    if (state.on === on) return true;
    if (on && !state.ready) throw new Error(`${bodyId} has no SD Card it can record to`);
    await this.control(body, { 'f.rec': on ? 'on' : 'off' });
    this.log('info', `${bodyId}: record ${on ? 'start' : 'stop'} sent`);
    this.check({ force: true }).catch(() => {});
    return true;
  }

  // One setting on one camera. Only a setting and value the camera itself offers can be sent.
  async setControl(bodyId, key, value) {
    const body = this.findBody(bodyId);
    const info = this.reads[bodyId]?.info;
    if (!body || !info) throw new Error(`${bodyId} is not online`);
    this.#guardLive(bodyId);
    const control = cameraControls(info).find((c) => c.key === key);
    if (!control) throw new Error('That setting cannot be changed right now');
    const option = control.options.find((o) => o.value === value);
    if (!option) throw new Error(`${bodyId} does not offer that value`);
    // The display may go out on SDI, which feeds the switcher, so this applies in Mixer mode as well.
    if (key === 'm.onscreen' && value === 'on' && this.isLive(bodyId)) throw new Error(`${bodyId} is live: the on-screen display would show on air`);
    await this.control(body, { [key]: value });
    this.log('info', `${bodyId}: ${control.name} set to ${option.text}`);
    // The camera pushes the change as well; this covers a camera whose stream is down.
    this.check({ force: true }).catch(() => {});
    return true;
  }

  // ---------- default settings and white balance on every camera ----------
  // What each reachable camera would get. steps is everything that is sent; changes is the part
  // that differs from what the camera has now, which is what the operator is shown.
  #bulkTargets(stepsFor, manualFor = () => []) {
    const targets = [], offline = [], locked = [];
    for (const body of this.cfg.bodies) {
      const info = this.reads[body.id]?.info;
      if (!info) { offline.push(body.id); continue; }
      if (this.#assistantLock(body.id)) { locked.push(body.id); continue; }
      const steps = stepsFor(info).map((p) => ({
        ...p,
        from: p.onOff && p.key in info ? 'ON' : info[p.key] ?? '—',
        display: p.onOff ? 'OFF' : p.value,
        supported: validateOnBody(p.key, p.value, info),
      }));
      const manual = manualFor(info);
      targets.push({ body: body.id, label: this.labelOfBody(body.id), steps, manual, changes: [...manual, ...steps.filter((p) => info[p.key] !== p.value)] });
    }
    return { targets, offline, locked };
  }

  // Every step goes out, even one the camera already has, so pressing Send always does what it says.
  async #bulkSend(targets, what) {
    const results = await Promise.all(targets.map(async (t) => {
      const body = this.findBody(t.body);
      const applied = [], failed = t.manual.map((m) => ({ name: m.name, reason: m.why }));
      for (const c of t.steps) {
        if (!c.supported) { failed.push({ name: c.name, reason: 'not supported on this camera' }); continue; }
        try {
          await this.control(body, { [c.key]: c.value });
          applied.push(c.name);
        } catch (e) { failed.push({ name: c.name, reason: e.message }); }
        await sleep(50); // Canon recommends a gap between separate control requests
      }
      return { body: t.body, applied, failed };
    }));
    this.log('info', `${what} sent to ${results.filter((r) => r.applied.length).length} camera(s)`);
    for (const r of results) if (r.failed.length) this.log('yellow', `${r.body}: ${r.failed.map((f) => `${f.name} not set`).join(', ')}`);
    await this.check({ force: true });
    return results;
  }

  #defaultTargets() {
    const sdi = SWITCHERS[this.state.switcher].sdi || PROFILES[this.profile].output;
    const manualFor = (info) => (info['f.output1.videoinfo'] === sdi ? [] : [{
      name: 'SDI output', value: fmtVideo(sdi), from: fmtVideo(info['f.output1.videoinfo']), supported: false, why: 'set this on the camera',
    }]);
    return this.#bulkTargets((info) => defaultsPlan(this.std, info), manualFor);
  }

  defaultsPreview() {
    const value = (key) => defaultsPlan(this.std).find((p) => p.key === key).value;
    const sdi = SWITCHERS[this.state.switcher].sdi || PROFILES[this.profile].output;
    return { ...this.#defaultTargets(), defaults: { sdi: fmtVideo(sdi), gamma: value('c.1.gamma'), shutter: `1/${value('c.1.me.shutter')}` } };
  }

  defaultsApply() {
    return this.#bulkSend(this.#defaultTargets().targets, 'Default settings');
  }

  #wbTargets(wb) {
    const typed = wb?.kelvin ? { kelvin: String(Number(wb.kelvin)), tint: String(Number(wb.tint || 0)) } : null;
    return this.#bulkTargets(() => (typed ? wbPlan(typed) : []));
  }

  wbPreview(wb) { return this.#wbTargets(wb); }

  wbApply(wb) {
    if (!wb?.kelvin) throw new Error('Type a Kelvin value first');
    return this.#bulkSend(this.#wbTargets(wb).targets, 'White balance');
  }

  setCardOrder(ids) {
    this.state.cardOrder = ids.filter((id) => this.findBody(id));
    this.saveStateSoon();
  }

  liveStatus() {
    const all = Object.values(this.streams);
    return { enabled: all.length > 0, connected: all.filter((x) => x.connected).length, total: all.length };
  }

  onPushed(body, items) {
    const prev = this.reads[body.id];
    const base = prev?.info || {};
    const changed = !prev?.info || Object.entries(items).some(([k, v]) => base[k] !== v);
    if (!changed) return;
    const info = { ...base, ...items };
    this.reads[body.id] = { body, info, summary: summarize(info), dupMacs: prev?.dupMacs || null };
    this.scheduleEvaluate();
  }

  // Immediate for a single change. In a burst, at most once per screen frame.
  scheduleEvaluate() {
    if (this.evalTimer || !this.lastResult) return;
    const run = () => {
      this.evalTimer = null;
      this.lastEval = Date.now();
      try { this.#evaluate({ pushed: true }); } catch (e) { this.log('red', `Check failed: ${e.message}`); }
    };
    const wait = 16 - (Date.now() - (this.lastEval || 0));
    // Run at once where possible: a Windows timer can add about 16 ms by itself.
    if (wait <= 0) { run(); return; }
    this.evalTimer = setTimeout(run, wait);
    this.evalTimer.unref?.();
  }

  saveStateSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveState(); }, 1000);
    this.saveTimer.unref?.();
  }

  trackOnlineChanges(reads) {
    this.onlineWas ||= {};
    for (const rb of reads) {
      const on = !rb.error;
      const was = this.onlineWas[rb.body.id];
      if (was !== undefined && was !== on) this.log(on ? 'green' : 'red', `${rb.body.id} ${on ? 'back online' : `went offline (${rb.error})`}`);
      this.onlineWas[rb.body.id] = on;
    }
  }

  writeReport(result) {
    const stamp = result.time.replace(/[:.]/g, '-').slice(0, 19);
    const path = join(this.reportsDir, `shotready-report-${result.profile}-${stamp}.json`);
    writeJsonAtomic(path, result);
    return path;
  }

  // ---------- ATEM ----------
  atemSummary() {
    if (!this.atem) return { configured: false, connected: false };
    return { ...this.atem.status, ...(this.atem.data || {}) };
  }
  atemTally(loc, atem) {
    if (!atem.connected || !loc.atemInput || !atem.mixEffects) return null;
    const on = (k) => atem.mixEffects.flatMap((m, i) => (m[k] === Number(loc.atemInput) ? [i + 1] : []));
    return { program: on('program'), preview: on('preview'), input: Number(loc.atemInput) };
  }
  atemStateKey() {
    const a = this.atemSummary();
    return `${a.connected}|${a.modeName}`;
  }
  onAtemChange() {
    this.syncTally();
    const a = this.atemSummary();
    const key = this.atemStateKey();
    if (key !== this.atemKey) {
      this.atemKey = key;
      if (a.configured) this.log(a.connected ? 'green' : 'yellow', a.connected ? `ATEM connected: ${a.modeLabel || 'reading'}` : 'ATEM not connected');
      if (this.lastResult) this.check({ force: true }).catch(() => {});
    } else if (this.lastResult) {
      // Cut on the switcher: update program/preview without re-reading cameras.
      for (const l of this.lastResult.labels) l.tally = this.atemTally(this.findLocation(l.label) || {}, a);
      this.emit('result', this.lastResult);
    }
    this.emit('atem', a);
  }

  // ---------- commands ----------
  setProfile(key) {
    if (!PROFILES[key]) throw new Error(`Unknown profile ${key}`);
    if (this.profile !== key) this.log('info', `Profile set to ${key} (${PROFILES[key].label})`);
    this.profile = key;
    this.state.profile = key;
    this.saveState();
    return this.check({ force: true });
  }

  setSwitcher(key) {
    if (!SWITCHERS[key]) throw new Error(`Unknown switcher ${key}`);
    if (this.state.switcher !== key) this.log('info', `Switcher set to ${SWITCHERS[key].name}`);
    this.state.switcher = key;
    this.saveState();
    return this.check({ force: true });
  }

  // Operator's own confirmation of settings the camera cannot report. Holds for this lens, today.
  confirm(bodyId, ids) {
    const rb = this.reads[bodyId];
    const k = this.state.bodies[bodyId];
    if (!k || !rb?.summary) throw new Error(`${bodyId} is not online`);
    k.confirmed ||= {};
    const at = new Date().toISOString();
    for (const id of ids) k.confirmed[id] = { at, lens: rb.summary.lens };
    this.saveState();
    this.log('info', `${bodyId}: operator confirmed ${ids.join(', ')}`);
    return this.check({ force: true });
  }

  async assign(label, bodyId) {
    if (!this.findLocation(label)) throw new Error(`Unknown label "${label}"`);
    const body = this.findBody(bodyId);
    if (!body) throw new Error(`Unknown body "${bodyId}"`);
    const now = new Date().toISOString();
    this.state.history.filter((h) => !h.to && (h.label === label || h.body === bodyId)).forEach((h) => { h.to = now; });
    const oldLabel = this.labelOfBody(bodyId);
    if (oldLabel && oldLabel !== label) delete this.state.assignments[oldLabel];
    const previous = this.state.assignments[label]?.body;
    this.state.assignments[label] = { body: bodyId, since: now };
    this.state.history.push({ label, body: bodyId, from: now });
    this.saveState();
    this.log('info', `${label} ← ${bodyId}${previous && previous !== bodyId ? ` (was ${previous})` : ''}${oldLabel && oldLabel !== label ? `; ${oldLabel} is now empty` : ''}`);
    await this.check({ force: true });
    const ref = this.state.labelRef[label];
    const showDiff = !!ref && ref.fromBody !== bodyId;
    return { label, body: bodyId, previous: previous || null, movedFrom: oldLabel && oldLabel !== label ? oldLabel : null, diff: showDiff ? await this.diff(label) : null };
  }

  async unassign(label) {
    if (!this.findLocation(label)) throw new Error(`Unknown label "${label}"`);
    const now = new Date().toISOString();
    this.state.history.filter((h) => !h.to && h.label === label).forEach((h) => { h.to = now; });
    const had = this.state.assignments[label]?.body;
    delete this.state.assignments[label];
    this.saveState();
    if (had) this.log('info', `${label} emptied (was ${had})`);
    return this.check({ force: true });
  }

  // Convenience for first setup: CAM n gets the nth body, skipping labels and bodies already placed.
  async assignInOrder() {
    const free = this.cfg.bodies.filter((b) => !this.labelOfBody(b.id));
    const now = new Date().toISOString();
    for (const loc of this.cfg.locations) {
      if (this.state.assignments[loc.label]) continue;
      const b = free.shift();
      if (!b) break;
      this.state.assignments[loc.label] = { body: b.id, since: now };
      this.state.history.push({ label: loc.label, body: b.id, from: now });
      this.log('info', `${loc.label} ← ${b.id}`);
    }
    this.saveState();
    return this.check({ force: true });
  }

  async diff(label) {
    const id = this.state.assignments[label]?.body;
    if (!id) throw new Error(`No body on ${label}`);
    const ref = this.state.labelRef[label];
    if (!ref) return { label, body: id, ref: null, rows: [] };
    const rb = await this.readBody(this.findBody(id), { dupCheck: false });
    if (rb.error) throw new Error(`Cannot read ${id}: ${rb.error}`);
    return { label, body: id, ref: { fromBody: ref.fromBody, time: ref.time }, rows: diffAgainstRef(ref, rb.info) };
  }

  async snapshot(label) {
    const labels = label ? [label] : this.cfg.locations.map((l) => l.label);
    const out = [];
    for (const l of labels) {
      const id = this.state.assignments[l]?.body;
      if (!id) { out.push({ label: l, skipped: 'no body' }); continue; }
      const rb = await this.readBody(this.findBody(id), { dupCheck: false });
      if (rb.error) { out.push({ label: l, skipped: `${id} offline` }); continue; }
      const settings = extractCopySettings(rb.info);
      this.state.labelRef[l] = { fromBody: id, time: new Date().toISOString(), settings };
      this.log('info', `${l}: reference saved from ${id} (${Object.keys(settings).length} settings)`);
      out.push({ label: l, body: id, count: Object.keys(settings).length });
    }
    this.saveState();
    await this.check({ force: true });
    return out;
  }

  acceptLens(bodyId) {
    const rb = this.reads[bodyId];
    const k = this.state.bodies[bodyId];
    if (!k || !rb?.summary) throw new Error(`${bodyId} is not online`);
    k.lastLens = rb.summary.lens;
    delete this.lensAlerted[bodyId];
    this.saveState();
    this.log('info', `${bodyId}: lens accepted (${shortLens(rb.summary.lens)})`);
    return this.check({ force: true });
  }

  // For a genuinely replaced camera, or a MAC learned under the wrong name (record 2.9).
  forgetMac(bodyId) {
    const k = this.state.bodies[bodyId];
    if (k) { delete k.mac; this.saveState(); }
    this.log('info', `${bodyId}: learned MAC forgotten, next read learns it again`);
    return this.check({ force: true });
  }

  // ---------- views ----------
  sheet() {
    return this.cfg.locations.map((loc) => {
      const id = this.state.assignments[loc.label]?.body;
      const rb = id ? this.reads[id] : null;
      return {
        label: loc.label, atemInput: loc.atemInput || '', body: id || '', ip: id ? this.findBody(id)?.ip || '' : '',
        lens: !id ? '' : rb?.summary ? shortLens(rb.summary.lens) : 'offline',
      };
    });
  }
  sheetCsv() {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = this.sheet().map((r) => [r.label, r.atemInput, r.body, r.ip, r.lens].map(q).join(','));
    return ['Label,ATEM input,Body,IP,Lens', ...rows].join('\r\n') + '\r\n';
  }
  bodiesView() {
    return this.cfg.bodies.map((b) => {
      const rb = this.reads[b.id];
      const k = this.state.bodies[b.id] || {};
      return {
        id: b.id, model: b.model, ip: b.ip, label: this.labelOfBody(b.id) || null,
        online: rb ? !rb.error : null, error: rb?.error || null,
        mac: rb?.summary?.mac || k.mac || '', firmware: rb?.summary?.firmware || k.firmware || '',
        lens: rb?.summary ? shortLens(rb.summary.lens) : (k.lastLens ? shortLens(k.lastLens) : ''),
        lastSeen: k.lastSeen || null, learnedMac: k.mac || null,
        issues: rb ? bodyIdentity(rb, k).filter((r) => r.check !== 'Connection') : [],
      };
    });
  }
  workloadView() {
    return this.cfg.bodies.map((b) => {
      const k = this.state.bodies[b.id] || {};
      return { body: b.id, model: b.model, runtimeMs: k.runtimeMs || 0, baselineHours: k.baselineHours ?? null, byLabel: k.runtimeByLabel || {}, since: k.runtimeSince || null, lastSeen: k.lastSeen || null };
    });
  }

  // The camera's own hour meter cannot be read over the network, so it is entered once by hand.
  setBaselineHours(bodyId, hours) {
    if (!this.findBody(bodyId)) throw new Error(`Unknown body "${bodyId}"`);
    const k = (this.state.bodies[bodyId] ||= {});
    if (hours === null || hours === '') delete k.baselineHours;
    else {
      const n = Number(hours);
      if (!(n >= 0)) throw new Error('Hours must be a positive number');
      k.baselineHours = n;
      // The count starts now, so the camera's reading is not added to itself.
      k.runtimeMs = 0;
      k.runtimeByLabel = {};
      k.runtimeSince = new Date().toISOString();
      this.log('info', `${bodyId}: camera hour meter entered as ${n} h`);
    }
    this.saveState();
    return this.workloadView();
  }

  settingsView() {
    const { auth, ...rest } = this.cfg;
    return structuredClone({
      ...rest, standards: this.std,
      auth: { user: auth?.user || '', hasPass: !!(auth?.pass || auth?.passEnc) },
      autoRefresh: this.state.autoRefresh,
    });
  }

  // Two-step rename, so swapping two label names cannot overwrite either one.
  renameLabels(oldLabels, labels) {
    const maps = [this.state.assignments, this.state.labelRef, ...Object.values(this.state.bodies).map((b) => b.runtimeByLabel || {})];
    oldLabels.forEach((oldName, i) => {
      const next = labels[i];
      if (next === undefined || next === oldName) return;
      for (const m of maps) if (m[oldName] !== undefined) { m[`\0${next}`] = m[oldName]; delete m[oldName]; }
      this.state.history.forEach((h) => { if (h.label === oldName) h.label = `\0${next}`; });
    });
    for (const m of maps) for (const k of Object.keys(m)) if (k.startsWith('\0')) { m[k.slice(1)] = m[k]; delete m[k]; }
    this.state.history.forEach((h) => { if (h.label.startsWith('\0')) h.label = h.label.slice(1); });
  }

  // Labels are matched by position, so renaming "CAM 1" keeps its body, reference and workload.
  saveSettings(s) {
    const labels = s.locations.map((l) => String(l.label || '').trim());
    if (labels.some((l) => !l)) throw new Error('Every location needs a label');
    if (new Set(labels).size !== labels.length) throw new Error('Location labels must be unique');
    const inputs = s.locations.map((l) => Number(l.atemInput || 0));
    if (inputs.some((n) => !Number.isInteger(n) || n < 0)) throw new Error('ATEM input must be a whole number');
    if (new Set(inputs.filter(Boolean)).size !== inputs.filter(Boolean).length) throw new Error('Two labels point at the same ATEM input');
    const ips = s.bodies.map((b) => String(b.ip || '').trim());
    if (ips.some((ip) => !HOST_RE.test(ip))) throw new Error('A body has an invalid IP address');
    if (new Set(ips).size !== ips.length) throw new Error('Two bodies have the same IP address');
    const atemIp = String(s.atem?.ip || '').trim();
    if (atemIp && !HOST_RE.test(atemIp)) throw new Error('ATEM IP address is invalid');
    const shutter = Number(s.standards.shutterSpeed), minutes = Number(s.standards.minRecordMinutes), poll = Number(s.pollSeconds);
    if (!(shutter > 0)) throw new Error('Shutter speed must be a positive number');
    if (!(minutes >= 0)) throw new Error('Minimum record minutes cannot be negative');
    if (!(poll >= 2)) throw new Error('Safety check must be at least 2 seconds');

    this.renameLabels(this.cfg.locations.map((l) => l.label), labels);

    this.cfg.locations = s.locations.map((l, i) => {
      const out = { ...this.cfg.locations[i], label: labels[i] };
      for (const k of ['requiredModel', 'expectedLens']) { const v = String(l[k] || '').trim(); if (v) out[k] = v; else delete out[k]; }
      if (inputs[i]) out.atemInput = inputs[i]; else delete out.atemInput;
      return out;
    });
    this.cfg.bodies = this.cfg.bodies.map((b) => {
      const n = s.bodies.find((x) => x.id === b.id);
      return n ? { ...b, ip: String(n.ip).trim() } : b;
    });
    const ipChanged = this.cfg.atem?.ip !== atemIp;
    this.cfg.atem = { ip: atemIp };
    this.cfg.pollSeconds = poll;
    this.cfg.standards = {
      ...this.cfg.standards, ...s.standards, shutterSpeed: shutter, minRecordMinutes: minutes,
      allowedGamma: (Array.isArray(s.standards.allowedGamma) ? s.standards.allowedGamma : String(s.standards.allowedGamma).split(',')).map((g) => g.trim()).filter(Boolean),
    };
    this.std = { ...DEFAULT_STANDARDS, ...this.cfg.standards };

    if (s.auth) {
      const user = String(s.auth.user || '');
      const next = { user };
      if (user && typeof s.auth.pass === 'string' && s.auth.pass !== '') {
        if (this.opts.encrypt) next.passEnc = this.opts.encrypt(s.auth.pass); else next.pass = s.auth.pass;
      } else if (user) {
        // Blank means "keep the saved password".
        if (this.cfg.auth?.passEnc) next.passEnc = this.cfg.auth.passEnc;
        if (this.cfg.auth?.pass) next.pass = this.cfg.auth.pass;
      }
      this.cfg.auth = next;
    }
    this.saveConfig();
    this.saveState();
    this.log('info', 'Settings saved');
    if (ipChanged && this.atem) this.atem.connect(atemIp).catch((e) => this.log('red', `ATEM: ${e.message}`));
    this.setAutoRefresh(!!s.autoRefresh);
    return this.check({ force: true });
  }

  // ---------- auto refresh ----------
  setAutoRefresh(on) {
    this.state.autoRefresh = !!on;
    this.saveState();
    this.startStreams();
    this.startTimer();
  }
  startTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.state.autoRefresh) return;
    const tick = async () => {
      try { await this.check(); } catch (e) { this.log('red', `Check failed: ${e.message}`); }
      if (this.state.autoRefresh) this.timer = setTimeout(tick, this.cfg.pollSeconds * 1000).unref();
    };
    this.timer = setTimeout(tick, this.cfg.pollSeconds * 1000).unref();
  }
  stop() {
    clearInterval(this.fastTimer);
    clearTimeout(this.timer);
    this.timer = null;
    this.liveEnabled = false;
    this.stopStreams();
    for (const cam of Object.values(this.cams)) cam.stop();
    this.cams = {};
    this.feedReady = null;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.saveState(); }
  }
}
