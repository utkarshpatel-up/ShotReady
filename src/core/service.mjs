// ShotReady application service: config + state files, reading bodies, running
// checks, label assignment, references, workload, event log. No Electron imports.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  PROFILES, DEFAULT_STANDARDS, OLD_DEFAULT_GAMMA, parseInfo, summarize, checkCamera, extractCopySettings, diffAgainstRef,
  bodyIdentity, matchCameras, verdictOf, mandatoryChecks, essentials, shortLens, defaultsPlan, digitalIsPlan, wbPlan, validateOnBody, cameraControls, recordState, focusDrive, focusFrame, oneShotAf, continuousAf, checkFixes, fmtVideo, copyPlan, atemVideoFormat, resolutionControl, resolutionFor,
} from './engine.mjs';
import { httpGet } from './http.mjs';
import { decodeMsgpack } from './msgpack.mjs';
import { CameraStream } from './stream.mjs';
import { lumaStats } from './waveform.mjs';
import { FocusStream, normalizeFocus } from './focus.mjs';
import { CameraThread } from './camera-thread.mjs';
import { describeNetworks } from './atem-discovery.mjs';
import { parseCube, rangesFromName } from './cube.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const LOG_KEEP = 500;
const SWITCHERS = {
  constellation: { name: 'Constellation' },
  '2me': { name: '2 M/E 2RU' },
};
// What the screen needs to know about a focus action: whether it can be done, and why not.
const okWhy = (x) => (x ? { ok: x.ok, why: x.why || null, ...('continuous' in x ? { continuous: x.continuous } : {}) } : null);
const DEFAULT_LABELS = Array.from({ length: 8 }, (_, i) => `CAM ${i + 1}`);
// How long a tally lamp change not on the M/E 1 program or preview bus must hold before the lamp
// follows it: two frames at 25p.
export const TALLY_SETTLE_MS = 80;
// Overlapping picture requests shared between the cameras on screen (see applyViewing).
export const LIVE_BUDGET = 32;
// The most frames a second a camera's live picture is fetched at.
export const LIVE_FPS = 25;

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
   * @param opts.waveform       measure the waveform (on by default when decodeJpeg is given)
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
    this.powerSeen = {};
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
    this.lampAt = {};         // when each lamp command went out
    this.lampDrift = {};      // what a lamp was last found set to by something else, so it is said once
    this.focusStreams = {};
    this.focus = {};
    this.viewers = {};
    this.videoViewers = {}; // windows watching a camera's IP video
    this.pictureMbps = {};  // each camera's single pictures, megabits a second
    this.ipStatus = {};     // each camera's IP video stream: frame rate, kbps, kind, error
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

  // Logs a camera's power source when it changes: to the battery in red (the cable is out), back in
  // green. On first sight only a source other than plain 'dc' or 'battery' is logged, so what a C50
  // reports for USB-C power can be read in the Log.
  notePower(id, power) {
    if (!power) return;
    const was = this.powerSeen[id];
    this.powerSeen[id] = power;
    const raw = `(the camera reports ${power.source})`;
    if (!was) {
      if (!/^(dc|battery)$/i.test(power.source)) this.log('info', `${id}: power ${power.text} ${raw}`);
    } else if (was.battery !== power.battery) {
      this.log(power.battery ? 'red' : 'green', `${id}: ${power.battery ? 'now on its battery' : 'back on outside power'}: ${power.text} ${raw}`);
    } else if (was.source !== power.source) {
      this.log('info', `${id}: power ${power.text} ${raw}`);
    }
  }

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
    this.notePower(rb.body.id, rb.summary.power);
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
    // A camera that pushed a change while these reads were out keeps what it pushed: the read began
    // earlier, so it may still carry the old value (a display just turned off showing as on again).
    this.pushedAt ||= {};
    this.reads = Object.fromEntries(reads.map((r) => {
      const prev = this.reads[r.body.id];
      return [r.body.id, prev?.info && this.pushedAt[r.body.id] > now ? prev : r];
    }));
    // If a lamp was changed by something else, set it again. A read that began before ShotReady's
    // own last lamp command may still show the lamp as it was, so it is not taken as a change.
    for (const r of reads) {
      const id = r.body.id, sent = this.lampSent[id];
      if (!sent || !r.info || this.cfg.tallyFromAtem === false || this.lampAt[id] >= now) continue;
      const ok = sent === 'off' ? r.info['f.tally'] === 'off' : r.info['f.tally'] === 'on' && r.info['f.tally.mode'] === sent;
      if (ok) { delete this.lampDrift[id]; continue; }
      const found = r.info['f.tally'] === 'on' ? `showing ${r.info['f.tally.mode'] || 'an unknown mode'}` : r.info['f.tally'] === 'off' ? 'off' : 'not reported';
      if (this.lampDrift[id] !== found) {
        this.lampDrift[id] = found;
        this.log('yellow', `${id}: tally lamp found ${found} on the camera, but ShotReady had set it to ${sent}. Something else changed it: setting it again`);
      }
      delete this.lampSent[id];
    }
    return this.#evaluate({ report });
  }

  // Judges what is currently known about every body. Makes no network calls, so a pushed
  // change reaches the screen without waiting for any camera.
  #evaluate({ report = false, pushed = false } = {}) {
    const profile = PROFILES[this.profile];
    const sw = SWITCHERS[this.state.switcher];
    const target = this.sdiTarget();
    const checkProfile = target.why ? { ...profile, sdi: target.sdi, sdiWhy: target.why } : profile;
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
        pictureOff: this.pictureOff(id),
        ipVideo: this.ipVideoOf(id),
        sdi: rb.error ? null : { now: fmtVideo(rb.summary?.output), want: fmtVideo(target.sdi), settable: !!resolutionControl(rb.info) },
        record: rb.error ? null : recordState(rb.info),
        focusDrive: rb.error ? null : focusDrive(rb.info),
        focusFrame: rb.error ? null : focusFrame(rb.info),
        oneShot: rb.error ? null : okWhy(oneShotAf(rb.info)),
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
      spares.push({ body: rb.body.id, ip: rb.body.ip, online: !rb.error, summary: rb.summary || null, results, checks, spare: true, essentials: rb.error ? null : essentials(rb.info, rb.summary, this.std), controls: rb.error ? null : cameraControls(rb.info), pictureOff: this.pictureOff(rb.body.id), ipVideo: this.ipVideoOf(rb.body.id), sdi: rb.error ? null : { now: fmtVideo(rb.summary?.output), want: fmtVideo(target.sdi), settable: !!resolutionControl(rb.info) }, record: rb.error ? null : recordState(rb.info), focusDrive: rb.error ? null : focusDrive(rb.info), focusFrame: rb.error ? null : focusFrame(rb.info), oneShot: rb.error ? null : okWhy(oneShotAf(rb.info)) });
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
      const words = { ready: 'Camera checks all passed', warnings: 'Camera checks: warnings only', 'not-ready': 'Camera checks: red findings' };
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
    const n = Object.keys(this.cams).length;
    this.log('info', `Threads: the main thread, ${n} camera thread${n === 1 ? '' : 's'} (pictures and waveform)${this.atem?.thread ? ', and one for the ATEM link' : ''}`);
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
        videoViewers: (n) => { this.videoViewers[body.id] = n; this.applyViewing(); },
        ipstats: (stats) => this.onIpStats(body.id, stats),
        state: (state) => { if (state === 'down') this.setWave(body.id, null); },
        // A frame still on its way when the picture is switched off is not measured.
        level: (wave) => { if (!this.pictureOff(body.id)) this.setWave(body.id, wave); },
        wave: (jpeg) => { if (!this.pictureOff(body.id)) this.measureWave(body.id, jpeg); },
        note: (text) => this.log('info', `${body.id}: ${text}`),
        // A camera on IP video says its stream's frame rate instead (onIpStats).
        // The frame rate and the picture bandwidth (megabits a second), measured each second.
        stats: (frames, bytes) => {
          this.pictureMbps[body.id] = (bytes * 8) / 1e6;
          if (this.viewers[body.id] > 0 && !(this.ipVideoOf(body.id) && this.videoViewers[body.id] > 0)) this.emit('feedstat', { body: body.id, fps: frames, mbps: this.pictureMbps[body.id] });
        },
        failed: (message) => this.log('red', `${body.id}: video thread stopped (${message})`),
      });
    }
    for (const body of this.cfg.bodies) this.cams[body.id].setIpVideo(this.ipVideoOf(body.id)?.port);
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
  // A camera's picture switched off on its card (to save network bandwidth): kept between runs.
  pictureOff(id) { return !!this.state.picturesOff?.[id]; }

  // ---------- the camera's own IP video (optional) ----------
  // Settings > IP video: per camera, on or off, and the UDP port it streams to. See ipvideo.mjs.
  ipVideoOf(id) {
    const v = this.cfg.ipVideo?.[id];
    return v?.on && v.port ? { port: Number(v.port) } : null;
  }

  onIpStats(id, stats) {
    if (stats) this.ipStatus[id] = { ...stats, at: Date.now() }; else delete this.ipStatus[id];
    if (stats && this.videoViewers[id] > 0) this.emit('feedstat', { body: id, fps: stats.fps, mbps: stats.kbps / 1000, ip: true });
    this.emit('ipstatus', { body: id, status: this.ipStatus[id] || null });
  }

  // Checked before anything is saved; applied at once to the cameras' threads, each one listening
  // on its port or stopping.
  setIpVideoConfig(map) { this.applyIpVideo(this.checkIpVideo(map)); }

  applyIpVideo(next) {
    this.cfg.ipVideo = next;
    for (const b of this.cfg.bodies) this.cams[b.id]?.setIpVideo(this.ipVideoOf(b.id)?.port);
  }

  checkIpVideo(map) {
    const next = {};
    const used = new Map();
    for (const b of this.cfg.bodies) {
      const v = map?.[b.id];
      if (!v) continue;
      const port = Number(v.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${b.id}: the IP video port must be a whole number from 1024 to 65535`);
      if (v.on) {
        if (used.has(port)) throw new Error(`${b.id} and ${used.get(port)} have the same IP video port (${port})`);
        used.set(port, b.id);
      }
      next[b.id] = { on: !!v.on, port };
    }
    return next;
  }

  setPicture(id, on) {
    if (!this.findBody(id)) throw new Error(`Unknown body "${id}"`);
    const off = { ...this.state.picturesOff };
    if (on) delete off[id]; else off[id] = true;
    this.state.picturesOff = off;
    this.saveStateSoon();
    if (!on) this.setWave(id, null);
    this.applyViewing();
    this.log('info', `${id}: picture ${on ? 'on' : 'off'}`);
    this.scheduleEvaluate();
    return !on;
  }

  applyViewing() {
    if (!this.framesOn) return;
    const watched = Object.keys(this.viewers).filter((id) => this.viewers[id] > 0 && !this.pictureOff(id));
    const fixed = Number(this.cfg.liveViewParallel);
    // LIVE_BUDGET overlapping requests shared between the watched cameras, at most 4 each (more than
    // 4 made the C80 return errors): up to 8 cameras get 4 each, more get fewer. Each camera still
    // backs off by itself if its frames get slower (frames.mjs), and the cards show each camera's
    // bandwidth. Settings > Connections can fix the number instead.
    const parallel = fixed >= 1 && fixed <= 4 ? fixed : Math.max(1, Math.min(4, Math.floor(LIVE_BUDGET / Math.max(1, watched.length))));
    // Each camera's thread measures its own frames; opts.decodeJpeg is the main-thread fallback.
    const measure = (this.opts.waveform ?? !!this.opts.decodeJpeg) && this.cfg.waveformMs > 0;
    const idle = measure ? { parallel: 1, intervalMs: this.cfg.waveformMs, waveGap: this.cfg.waveformMs } : { parallel: 0, intervalMs: 0, waveGap: 0 };
    // Waveform from the same frames: quicker while someone is watching.
    // Never more than LIVE_FPS frames a second from a camera: smooth for the show's 25p, and no more
    // bandwidth than that. Each of the overlapping requests starts at most every parallel × 40 ms.
    const live = { parallel, intervalMs: 0, periodMs: Math.round((parallel * 1000) / LIVE_FPS), waveGap: measure ? 250 : 0 };
    // A camera whose picture is switched off sends nothing at all: no live frames, no slow frames for
    // the waveform, no focus data. Only its settings are read, as for any camera.
    const none = { parallel: 0, intervalMs: 0, waveGap: 0 };
    // A camera on IP video on screen: its picture comes from its stream, but the waveform and RGB keep
    // their 4 readings a second from single pictures, one every 250 ms, each one measured.
    const ipWave = measure ? { parallel: 1, intervalMs: 0, periodMs: 250, waveGap: 200 } : none;
    for (const [id, cam] of Object.entries(this.cams)) {
      cam.setMode(this.pictureOff(id) ? none : this.viewers[id] > 0 ? live : this.videoViewers[id] > 0 ? ipWave : idle);
    }
    for (const body of this.cfg.bodies) {
      // Focus data for a camera on screen, whether its picture comes as single frames or as IP video.
      const want = (this.viewers[body.id] > 0 || this.videoViewers[body.id] > 0) && !this.pictureOff(body.id);
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
    // Monitoring and assist settings (View Assist and the like) go to configuration.cgi with their
    // full names; control.cgi refuses them with 406 (read from a real C80).
    const config = entries.every(([k]) => /^(monitoring|assist)\./.test(k));
    const path = this.cfg.infoPath.replace(/info\.cgi$/, menu ? 'menu.cgi' : config ? 'configuration.cgi' : 'control.cgi');
    const query = new URLSearchParams(menu ? entries.map(([k, v]) => [k.slice(2), v]) : params);
    const res = await httpGet(`http://${body.ip}${path}?${query}`, this.authForRequests());
    const status = res.headers.get('livescope-status');
    await res.arrayBuffer();
    if (res.status === 401) throw new Error('login rejected');
    // The camera answered but would not take it: another way of asking may still work.
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { refused: true });
    if (status && status !== '0') throw Object.assign(new Error(status), { refused: true });
  }

  // ---------- tally from the ATEM to the camera lamps ----------
  tallyDriven(atem) { return this.cfg.tallyFromAtem !== false && !!atem.connected; }

  // The moment a camera is taken to program, its on-screen display and any open menu come off, so
  // they never stay on air. Runs on every ATEM change, before the lamps, and whatever the mode.
  closeOsdOnAir() {
    this.osdClosing ||= new Set();
    for (const b of this.cfg.bodies) {
      const info = this.reads[b.id]?.info;
      if (!info || this.osdClosing.has(b.id)) continue;
      const showing = info['m.onscreen'] === 'on' || (info['m.menu.type'] || '0') !== '0';
      if (!showing || !this.isLive(b.id)) continue;
      this.osdClosing.add(b.id);
      // Display off first: that alone clears the picture. Then the menu is closed as well.
      this.control(b, { 'm.onscreen': 'off' })
        .then(() => { info['m.onscreen'] = 'off'; return this.control(b, { 'm.type': '0' }); })
        .then(() => { info['m.menu.type'] = '0'; this.log('yellow', `${b.id} went to program: display and menu turned off`); })
        .catch((e) => this.log('red', `${b.id} went to program but its display could not be turned off: ${e.message}`))
        .finally(() => { this.osdClosing.delete(b.id); this.check({ force: true }).catch(() => {}); });
    }
  }

  // The lamps follow M/E 1. A camera on the program or preview bus itself changes at once, so a cut
  // shows straight away. Any other change (a camera on air only through a key, SuperSource or the
  // other M/E, or a lamp going off) waits until it has held for TALLY_SETTLE_MS: the ATEM can report
  // such a state for a moment during a cut, and lamps lit for less than two frames would flash.
  syncTally() {
    if (this.liveEnabled) this.closeOsdOnAir();
    if (!this.liveEnabled || this.cfg.tallyFromAtem === false) return;
    const atem = this.atemSummary();
    const me = atem.mixEffects?.[0];
    const tally = atem.tally || (me ? { program: [me.program], preview: [me.preview] } : null);
    const wanted = {}, onBus = {};
    if (atem.connected && tally) {
      this.cfg.locations.forEach((loc) => {
        const id = this.state.assignments[loc.label]?.body;
        if (!id) return;
        const input = this.atemInputOf(loc);
        const want = tally.program.includes(input) ? 'program' : tally.preview.includes(input) ? 'preview' : 'off';
        wanted[id] = want;
        onBus[id] = !!input && ((want === 'program' && me?.program === input) || (want === 'preview' && me?.preview === input));
      });
    }
    // Any lamp ShotReady lit but no longer controls goes out, so nothing stays red by mistake.
    for (const id of Object.keys(this.lampSent)) wanted[id] ||= 'off';
    const list = (l) => (l?.length ? l.join('+') : 'none');
    const source = atem.connected && tally ? `ATEM program ${list(tally.program)}, preview ${list(tally.preview)}` : 'ATEM not connected';
    const now = Date.now();
    const pending = this.lampPending ||= {};
    const apply = [], brief = [];
    for (const [id, want] of Object.entries(wanted)) {
      const body = this.findBody(id);
      if (!body || !this.reads[id]?.info) continue;
      const p = pending[id];
      if (this.lampWant[id] === want) {
        // What the lamp is already meant to show: a change that came and went before it settled was
        // only a moment of the ATEM's state.
        if (p) { brief.push(`${id} ${p.want}`); delete pending[id]; }
        if (this.lampSent[id] !== want) this.setLamp(body, want); // a lamp to set again, or still being set
        continue;
      }
      if (onBus[id] || (p?.want === want && now - p.at >= TALLY_SETTLE_MS)) {
        delete pending[id];
        apply.push([body, want]);
      } else if (p?.want !== want) pending[id] = { want, at: now, source };
    }
    for (const id of Object.keys(pending)) if (!(id in wanted)) delete pending[id];
    if (brief.length) this.log('info', `Tally: left as they were, as the ATEM showed it for less than 2 frames: ${brief.join(', ')}`);
    if (apply.length) this.log('info', `Tally (${source}): ${apply.map(([b, want]) => `${b.id} ${want}`).join(', ')}`);
    for (const [body, want] of apply) this.setLamp(body, want);
    // A change still settling is looked at again once its time is up.
    clearTimeout(this.lampTimer);
    const next = Math.min(...Object.values(pending).map((x) => x.at + TALLY_SETTLE_MS - now));
    if (Number.isFinite(next)) { this.lampTimer = setTimeout(() => this.syncTally(), Math.max(1, next)); this.lampTimer.unref?.(); }
  }

  // Tally lamps stop following the ATEM (Settings): the lamps ShotReady lit go out, once.
  releaseLamps() {
    for (const [id, sent] of Object.entries(this.lampSent)) {
      const body = this.findBody(id);
      if (body && sent !== 'off') this.setLamp(body, 'off');
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
        this.lampAt[id] = Date.now();
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
  kelvinSent = {};
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
    const input = this.atemInputOf(this.findLocation(label));
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

  // ---------- camera menu from the keyboard ----------
  // M: display on and main menu open, on the camera the mode points at (never one on program).
  // W A S D and Space move and select while a menu is open. Q and Esc go back a level, and at the
  // top level that closes the menu. Esc with no menu open turns the display off.
  // Canon XC spec, menu.cgi: cmd=up|down|left|right|enter|cancel moves and selects, and type picks
  // the screen (0 none, 1 MENU, 2 Custom Picture, 3 FUNC). Checked on a real C80: one cancel at the
  // top level closes the menu. m.menu.type is not exact while a screen is open, so any value other
  // than 0 counts as open.
  // Presses run one at a time so a quick run of taps lands in order.
  menuKey(key, selected) {
    const run = (this.menuChain || Promise.resolve()).catch(() => {}).then(() => this.#menuKey(key, selected));
    this.menuChain = run;
    return run;
  }

  osdCameras() {
    return this.cfg.bodies.filter((b) => this.reads[b.id]?.info?.['m.onscreen'] === 'on').map((b) => b.id);
  }

  // The camera the mode points at: the one picked (a click in Assistant mode, the number pad in
  // either mode), else in Mixer mode the one on preview.
  #modeCamera(selected) {
    if (selected) return selected;
    if (this.state.keyMode === 'assistant') throw new Error('Pick a camera first: click it, or press its number on the number pad');
    const cam = this.previewCamera();
    if (!cam) throw new Error('No camera on preview');
    return cam.body;
  }

  // Asked fresh each time: the menu is opened and closed on the camera too.
  async #menuState(id) {
    const body = this.findBody(id);
    const res = await httpGet(`http://${body.ip}${this.cfg.infoPath}?item=m.menu.type&item=m.onscreen`, this.authForRequests());
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
    const got = parseInfo(await res.text());
    return { type: got['m.menu.type'] || '0', osd: got['m.onscreen'] === 'on' };
  }

  async #menuKey(key, selected) {
    if (key === 'open') {
      const id = this.#modeCamera(selected);
      if (this.isLive(id)) throw new Error(`${id} is on program: the display and menu were not turned on`);
      this.#guardLive(id);
      if (this.reads[id]?.info?.['m.onscreen'] !== 'on') await this.setControl(id, 'm.onscreen', 'on');
      await this.control(this.findBody(id), { 'm.type': '1' });
      this.log('info', `${id}: menu opened`);
      return { body: id, did: 'open' };
    }
    if (!['up', 'down', 'left', 'right', 'enter', 'back', 'escape'].includes(key)) throw new Error('Unknown menu key');
    const on = this.osdCameras();
    if (!on.length) return null;
    const preview = this.previewCamera()?.body;
    const id = on.includes(selected) ? selected : on.includes(preview) ? preview : on.length === 1 ? on[0] : null;
    if (!id) throw new Error(`The display is on for ${on.join(', ')}: select one to use the menu keys`);
    // The menu would show on the program feed.
    if (this.isLive(id)) throw new Error(`${id} is on program: menu keys are not sent`);
    const body = this.findBody(id);
    const { type } = await this.#menuState(id);
    if (type === '0') {
      // No menu open: Esc turns the display off, the other keys are left for their normal use.
      if (key !== 'escape') return null;
      await this.setControl(id, 'm.onscreen', 'off');
      return { body: id, did: 'osd off' };
    }
    const press = key === 'back' || key === 'escape' ? 'cancel' : key;
    await this.control(body, { 'm.cmd': press });
    return { body: id, did: press };
  }

  // One ISO step. Run one at a time so quick taps each move a full step.
  stepIso(dir, selected) {
    const run = this.isoChain.catch(() => {}).then(() => this.#stepIso(dir, selected));
    this.isoChain = run;
    return run;
  }

  // The camera the picture keys change: the one picked (a click in Assistant mode, the number pad in
  // either mode), else in Mixer mode the one on preview. Never a camera on program.
  #isoTarget(selected, what = 'ISO') {
    if (selected) {
      if (this.state.keyMode === 'assistant') this.#guardLive(selected);
      else if (this.isLive(selected)) throw new Error(`${selected} is on program, so its ${what} was not changed`);
      return selected;
    }
    if (this.state.keyMode === 'assistant') throw new Error('Pick a camera first: click it, or press its number on the number pad');
    const cam = this.previewCamera();
    if (!cam) throw new Error('No camera on preview');
    if (cam.tally.program.length) throw new Error(`${cam.body} is on program too, so its ${what} was not changed`);
    return cam.body;
  }

  // One Base ISO step (Ctrl+W up, Ctrl+S down) through the camera's own list, Auto left out. On the
  // same camera W and S change ISO on, and never one on program.
  stepBaseIso(dir, selected) {
    const run = this.isoChain.catch(() => {}).then(() => this.#stepBaseIso(dir, selected));
    this.isoChain = run;
    return run;
  }

  async #stepBaseIso(dir, selected) {
    const id = this.#isoTarget(selected, 'Base ISO');
    const body = this.findBody(id);
    const info = this.reads[id]?.info;
    if (!body || !info) throw new Error(`${id} is not online`);
    const control = cameraControls(info).find((c) => c.name === 'Base ISO');
    if (!control) throw new Error(`${id} does not offer its Base ISO to be changed`);
    const num = (v) => Number(String(v).match(/\d{3,}/)?.[0]);
    const steps = control.options.filter((o) => num(o.value) > 0).sort((a, b) => num(a.value) - num(b.value));
    const sent = this.baseIsoSent?.[id];
    const from = sent && Date.now() - sent.at < 1500 ? sent.value : control.value;
    if (!(num(from) > 0)) throw new Error(`${id}: Base ISO is on Auto. Pick one in Adjust first`);
    const next = dir > 0 ? steps.find((o) => num(o.value) > num(from)) : steps.findLast((o) => num(o.value) < num(from));
    if (!next) throw new Error(`${id} is already at its ${dir > 0 ? 'highest' : 'lowest'} Base ISO`);
    await this.control(body, { [control.key]: next.value });
    (this.baseIsoSent ||= {})[id] = { value: next.value, at: Date.now() };
    this.log('info', `${id}: Base ISO set to ${num(next.value)} from the keyboard`);
    clearTimeout(this.isoRefresh);
    this.isoRefresh = setTimeout(() => this.check({ force: true }).catch(() => {}), 400);
    await sleep(50);
    return { body: id, baseIso: num(next.value) };
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

  // F1 and F2: Media Player 1 or 2 straight to program on M/E 1, as a cut. This is the only thing
  // ShotReady ever changes on the switcher, and only from the Mixer seat.
  // F1 / F2 put Media Player 1 / 2 on preview on M/E 1; with Shift they cut it to program.
  async cutMediaPlayer(n, to = 'preview') {
    if (n !== 1 && n !== 2) throw new Error('Unknown media player');
    if (to !== 'preview' && to !== 'program') throw new Error('Unknown destination');
    const key = `${to === 'program' ? 'Shift+' : ''}F${n}`;
    if (this.state.keyMode === 'assistant') throw new Error(`${key} works only in Mixer mode. Nothing was changed.`);
    const a = this.atemSummary();
    if (!a.connected) throw new Error('The ATEM is not connected. Nothing was changed.');
    const input = n === 1 ? 3010 : 3020;
    if (a.inputs && Object.keys(a.inputs).length && !(input in a.inputs)) throw new Error(`This switcher has no Media Player ${n}`);
    if (to === 'program') await this.atem.changeProgram(input, 0); else await this.atem.changePreview(input, 0);
    const name = a.inputs?.[input] || `Media Player ${n}`;
    this.log('info', `${key}: ${name} ${to === 'program' ? 'cut to program' : 'put on preview'} on M/E 1`);
    return { input, name, to };
  }

  // One Kelvin step (A down, D up), on the same camera W and S change ISO on. Run one at a time.
  stepKelvin(dir, selected) {
    const run = this.isoChain.catch(() => {}).then(() => this.#stepKelvin(dir, selected));
    this.isoChain = run;
    return run;
  }

  async #stepKelvin(dir, selected) {
    const id = this.#isoTarget(selected, 'Kelvin');
    const body = this.findBody(id);
    const info = this.reads[id]?.info;
    if (!body || !info) throw new Error(`${id} is not online`);
    const control = cameraControls(info).find((c) => c.key === 'c.1.wb.kelvin');
    if (!control) throw new Error(`${id}: white balance is not on Kelvin, so there is no Kelvin to step`);
    // The camera's report can lag a quick tap, so step from the value just sent.
    const sent = this.kelvinSent[id];
    const from = sent && Date.now() - sent.at < 1500 ? sent.value : control.value;
    const i = control.options.findIndex((o) => o.value === from);
    if (i < 0) throw new Error(`${id}: ${from} K is not in the camera's list`);
    const next = control.options[i + dir];
    if (!next) throw new Error(`${id} is already at its ${dir > 0 ? 'highest' : 'lowest'} Kelvin`);
    await this.control(body, { [control.key]: next.value });
    this.kelvinSent[id] = { value: next.value, at: Date.now() };
    this.log('info', `${id}: Kelvin set to ${next.text} from the keyboard`);
    clearTimeout(this.isoRefresh);
    this.isoRefresh = setTimeout(() => this.check({ force: true }).catch(() => {}), 400);
    await sleep(50);
    return { body: id, kelvin: next.text };
  }

  // Push focus closer or further while held. If the stop never arrives the camera is stopped anyway.
  moveFocus(bodyId, dir) {
    if (!['near', 'far', 'one_shot', 'stop'].includes(dir)) throw new Error('Unknown focus direction');
    const body = this.findBody(bodyId);
    const info = this.reads[bodyId]?.info;
    if (!body || !info) throw new Error(`${bodyId} is not online`);
    // A stop always goes through, even if the camera went live while focus was moving. 1-Shot AF is
    // a deliberate press, so it works in Mixer and Assistant mode alike, live or not. It has its own
    // check, made against what the camera says at the moment of the press: see #oneShot.
    if (dir === 'one_shot') {
      if (!oneShotAf(info)) throw new Error(`${bodyId} cannot do 1-Shot AF from here`);
    } else if (dir !== 'stop') {
      this.#guardLive(bodyId);
      const drive = focusDrive(info);
      if (!drive?.ok) throw new Error(drive?.why || `${bodyId} cannot move focus`);
    }
    if (dir !== 'one_shot') clearTimeout(this.focusTimers[bodyId]);
    if (dir === 'near' || dir === 'far') this.focusTimers[bodyId] = setTimeout(() => this.moveFocus(bodyId, 'stop').catch(() => {}), 4000);
    const send = dir === 'one_shot' ? () => this.#oneShot(body, this.reads[bodyId]?.info || info) : () => this.control(body, { 'c.1.focus.action': dir });
    const run = (this.focusChain[bodyId] || Promise.resolve()).catch(() => {}).then(send);
    this.focusChain[bodyId] = run;
    return run.then(() => {
      if (dir === 'one_shot') this.log('info', `${bodyId}: 1-Shot AF`);
      return true;
    }, (e) => {
      if (dir === 'one_shot') this.log('yellow', `${bodyId}: 1-Shot AF did not go through (${e.message})`);
      throw e;
    });
  }

  // 1-Shot AF. The lens switch and focus mode are asked fresh, so a reading a few seconds old (the
  // switch just flipped to AF, or the camera mid-way through focusing) never blocks a press. If the
  // camera cannot be asked, the last reading is used.
  async #oneShot(body, info) {
    const items = ['c.1.lens.focus', 'c.1.focus', 'c.1.focus.auto', 'c.1.focus.action.list'];
    let now = info;
    try {
      const res = await httpGet(`http://${body.ip}${this.cfg.infoPath}?${new URLSearchParams(items.map((k) => ['item', k]))}`, this.authForRequests(), 1000);
      if (res.ok) now = { ...info, ...parseInfo(await res.text()) }; else await res.arrayBuffer();
    } catch { /* the last reading is used */ }
    const shot = oneShotAf(now);
    if (!shot?.ok) throw new Error(shot?.why || `${body.id} cannot do 1-Shot AF from here`);
    try {
      await this.control(body, shot.params);
    } catch (e) {
      throw new Error(e.refused ? `the camera refused 1-Shot AF (${e.message})` : e.message);
    }
  }

  // A click on the picture. Where the AF frame can be placed, it goes there and the camera focuses
  // on it. With the AF frame on Auto there is no position to set, so the click is a 1-Shot AF and the
  // camera picks the subject itself. x and y are fractions of the picture.
  // opts.person: the click picked a person the camera detected (x and y are that person). With the
  // AF frame on Auto the camera would focus whoever it chose, not that person, so nothing is sent and
  // the answer offers an AF frame type that can be placed. opts.frame: switch to that type first.
  async setFocusFrame(bodyId, x, y, opts = {}) {
    const body = this.findBody(bodyId);
    const info = this.reads[bodyId]?.info;
    if (!body || !info) throw new Error(`${bodyId} is not online`);
    this.#guardLive(bodyId);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Unknown position');
    let frame = focusFrame(info);
    if (frame?.auto && opts.person) {
      const offered = (info['c.1.focus.frame.1.list'] || '').split(',');
      // Zone first: people detection keeps working in it. Then the other types that can be placed.
      const placeable = ['zone', 'large_zone_horizontal', 'large_zone_vertical', 'spot'].find((t) => offered.includes(t));
      if (!opts.frame) return { needFrame: true, offer: placeable || null };
      if (!offered.includes(opts.frame) || opts.frame === 'auto') throw new Error(`${bodyId} does not offer that AF frame`);
      await this.control(body, { 'c.1.focus.frame.1': opts.frame });
      info['c.1.focus.frame.1'] = opts.frame; // the camera reports it shortly; the frame is placed now
      this.log('info', `${bodyId}: AF frame set to ${opts.frame} so a click can choose the person`);
      await sleep(150);
      frame = focusFrame(info);
    }
    const shot = oneShotAf(info);
    const onAir = !!this.lastResult?.labels.find((l) => l.body === bodyId)?.tally?.program?.length;
    let placed = false;
    if (frame?.ok) {
      // With Continuous AF on, moving the frame pulls focus straight away.
      if (onAir && continuousAf(info)) throw new Error(`${bodyId} is on program with Continuous AF on, so the box was not moved`);
      const place = (n) => String(Math.round(Math.max(0, Math.min(1, n)) * 9999));
      await this.control(body, { 'c.1.focus.frame.1.x': place(x), 'c.1.focus.frame.1.y': place(y) });
      placed = true;
    }
    // Focusing on air would show on the program feed, so that stays a deliberate press of 1-Shot AF.
    if (onAir) return { onAir: true, placed };
    // With Continuous AF on, the camera follows a placed box by itself, and a click is not meant to
    // take it out of continuous focusing.
    if (shot?.ok && shot.continuous) {
      if (placed) return { onAir: false, placed, focused: false };
      throw new Error(`${bodyId} has Continuous AF on and the AF frame on Auto, so the camera is already choosing focus by itself. Press 1-Shot AF to focus once anyway`);
    }
    if (shot?.ok) {
      if (placed) await sleep(100);
      await this.moveFocus(bodyId, 'one_shot');
      return { onAir: false, placed, focused: true, autoFrame: !!frame?.auto };
    }
    // Continuous AF follows a placed box by itself.
    if (placed) return { onAir: false, placed, focused: false };
    throw new Error(shot?.why || frame?.why || `${bodyId} cannot be focused from the picture`);
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

  // Every setting a camera reports, read fresh and saved as a text file in the reports folder. Used
  // to find the names of settings (a model's saturation or resolution keys) to add to ShotReady.
  async saveSettingsList(bodyId) {
    const body = this.findBody(bodyId);
    if (!body) throw new Error(`Unknown body "${bodyId}"`);
    const info = await this.fetchInfo(body, this.authForRequests());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = join(this.reportsDir, `${bodyId}-settings-${stamp}.txt`);
    const head = [`# ShotReady settings list: ${bodyId} at ${body.ip}`, `# ${info['s.hardware'] || '?'} firmware ${info['s.firmware'] || '?'}, read ${new Date().toLocaleString()}`, ''];
    // One sample of the camera's metadata stream as well: where an electronic level (roll and tilt)
    // or other live readings would be, flattened to key=value like the settings.
    let meta = ['', '# metadata (meta.cgi, one sample)'];
    try {
      const res = await httpGet(`http://${body.ip}${this.cfg.infoPath.replace(/info\.cgi$/, 'meta.cgi')}?type=once`, this.authForRequests(), 3000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const flat = (o, p = '') => Object.entries(o || {}).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}=${v}`]));
      meta.push(...flat(decodeMsgpack(Buffer.from(await res.arrayBuffer()))).sort());
    } catch (e) { meta.push(`# not read: ${e.message}`); }
    writeFileSync(path, [...head, ...Object.keys(info).sort().map((k) => `${k}=${info[k]}`), ...meta, ''].join('\r\n'));
    this.log('info', `${bodyId}: settings list saved (${Object.keys(info).length} settings)`);
    return path;
  }

  // ---------- copy settings from another camera ----------
  // What would change on toId to match fromId's picture settings. Read fresh from both cameras.
  async copyPreview(fromId, toId) {
    if (fromId === toId) throw new Error('Pick another camera to copy from');
    const [from, to] = await Promise.all([fromId, toId].map(async (id) => {
      const body = this.findBody(id);
      if (!body || !this.reads[id]?.info) throw new Error(`${id} is not online`);
      return this.fetchInfo(body, this.authForRequests());
    }));
    return { from: fromId, to: toId, live: this.isLive(toId), rows: copyPlan(from, to) };
  }

  // Sends the chosen settings in order. A value that only appears once a mode has changed (Kelvin
  // after White balance goes to Kelvin) is caught by a second pass on a fresh read of the camera.
  async copyApply(fromId, toId, keys) {
    this.#guardLive(toId);
    const body = this.findBody(toId), source = this.findBody(fromId);
    if (!body || !source) throw new Error('Unknown camera');
    const auth = this.authForRequests();
    const from = await this.fetchInfo(source, auth);
    const applied = [], failed = new Map();
    for (let pass = 0; pass < 2; pass++) {
      const to = await this.fetchInfo(body, auth);
      const plan = copyPlan(from, to).filter((r) => keys.includes(r.key) && !applied.includes(r.name));
      for (const r of plan) {
        if (!r.ok) { failed.set(r.key, { name: r.name, reason: r.why }); continue; }
        try {
          await this.control(body, { [r.key]: r.from });
          applied.push(r.name);
          failed.delete(r.key);
        } catch (e) { failed.set(r.key, { name: r.name, reason: e.message }); }
        await sleep(50);
      }
      if (!failed.size) break;
    }
    this.log('info', `${toId}: ${applied.length} setting(s) copied from ${fromId}${failed.size ? `; not taken: ${[...failed.values()].map((f) => f.name).join(', ')}` : ''}`);
    await this.check({ force: true });
    return { applied, failed: [...failed.values()] };
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
    // A new resolution drops the camera's signal for a moment: never on air.
    if (control.name === 'Resolution' && this.isLive(bodyId)) throw new Error(`${bodyId} is live: changing its resolution would drop its picture on air`);
    // A new sensor mode changes the picture's framing and drops it for a moment: never on air.
    if (control.name === 'Sensor mode' && this.isLive(bodyId)) throw new Error(`${bodyId} is live: changing its sensor mode would change its picture on air`);
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
        // A new resolution drops the camera's signal for a moment: never on air.
        if (c.name === 'SDI output' && this.isLive(t.body)) { failed.push({ name: c.name, reason: 'camera is live: set it when it is off air' }); continue; }
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

  // The SDI format the cameras must send: the ATEM's own video mode when it is connected (the
  // cameras must match the switcher), else the show profile's.
  sdiTarget() {
    const atem = this.atemSummary();
    const fromAtem = atem.connected ? atemVideoFormat(atem.modeName) : null;
    return fromAtem ? { sdi: fromAtem, why: `the ATEM (${atem.modeLabel})` } : { sdi: PROFILES[this.profile].output, why: null };
  }

  // SDI output goes with the default settings where the camera offers its resolution as a setting;
  // otherwise it is listed, to be set on the camera.
  #defaultTargets() {
    const { sdi } = this.sdiTarget();
    const resStep = (info) => {
      const ctl = resolutionControl(info), value = resolutionFor(ctl, sdi);
      return ctl && value && info['f.output1.videoinfo'] !== sdi ? [{ key: ctl.key, name: 'SDI output', value }] : [];
    };
    const manualFor = (info) => (info['f.output1.videoinfo'] === sdi || resolutionFor(resolutionControl(info), sdi) ? [] : [{
      name: 'SDI output', value: fmtVideo(sdi), from: fmtVideo(info['f.output1.videoinfo']), supported: false, why: 'this camera does not take it over the network: set it on the camera',
    }]);
    return this.#bulkTargets((info) => [...defaultsPlan(this.std, info), ...resStep(info)], manualFor);
  }

  defaultsPreview() {
    const value = (key) => defaultsPlan(this.std).find((p) => p.key === key).value;
    const { sdi } = this.sdiTarget();
    return { ...this.#defaultTargets(), defaults: { sdi: fmtVideo(sdi), gamma: value('c.1.gamma'), shutter: `1/${value('c.1.me.shutter')}` } };
  }

  defaultsApply() {
    return this.#bulkSend(this.#defaultTargets().targets, 'Default settings');
  }

  // Digital IS on or off on every reachable camera (from the Adjust panel). As with the default
  // settings, a camera locked in Assistant mode is left out; in Mixer mode a camera on program
  // changes too, and is named in the answer so the operator knows.
  async digitalIsAll(on) {
    const plan = this.#bulkTargets((info) => digitalIsPlan(this.std, info, on));
    const none = plan.targets.filter((t) => !t.steps.length).map((t) => t.body);
    const targets = plan.targets.filter((t) => t.steps.length);
    const live = targets.filter((t) => this.isLive(t.body)).map((t) => t.body);
    const results = await this.#bulkSend(targets, `Digital IS ${on ? 'on' : 'off'}`);
    return { on, results, offline: plan.offline, locked: plan.locked, none, live };
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
    (this.pushedAt ||= {})[body.id] = Date.now();
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
  // A label's ATEM input: the one set in Settings, or else its place in the list (Cam-01 is input 1).
  // The laptop's video input is never a camera's, so it never lights a camera's tally lamp or badge.
  atemInputOf(loc) {
    if (!loc) return 0;
    const input = Number(loc.atemInput) || this.cfg.locations.findIndex((l) => l.label === loc.label) + 1;
    return input && input === this.laptopInput() ? 0 : input;
  }
  laptopInput() { return Number(this.cfg.laptopVideo?.atemInput) || 0; }

  // Which M/Es have this label's input on program and on preview. A source that only shows through
  // a key still counts as on program, the same as for the camera lamp.
  atemTally(loc, atem) {
    const input = this.atemInputOf(loc);
    if (!atem.connected || !input || !atem.mixEffects) return null;
    const on = (k) => {
      const list = atem.mixEffects.flatMap((m, i) => (m[k] === input ? [i + 1] : []));
      return !list.length && atem.tally?.[k]?.includes(input) ? [1] : list;
    };
    return { program: on('program'), preview: on('preview'), input };
  }
  // Finds and connects the ATEM. The address in Settings is tried first; blank (or not answering)
  // means every network the computer is on is searched, Ethernet and Wi-Fi alike. The cameras'
  // networks are searched too, as the switcher is usually on the same one.
  startAtem() {
    if (!this.atem?.start) return null;
    const a = this.cfg.atem || {};
    return this.atem.start({
      ip: a.ip || '',
      search: a.search !== false,
      hints: () => ({ subnetsOf: this.cfg.bodies.map((b) => b.ip) }),
      lastIp: this.state.atemLastIp || '',
      onFound: (ip) => { if (this.state.atemLastIp !== ip) { this.state.atemLastIp = ip; this.saveStateSoon(); } },
    }).catch((e) => this.log('red', `ATEM: ${e.message}`));
  }

  // Settings > Search now: what answers on each network right now, and a nudge to the link so it
  // does not wait for its next search.
  async searchAtem() {
    if (!this.atem?.find) throw new Error('ATEM search is not available');
    const r = await this.atem.find({ hints: { subnetsOf: this.cfg.bodies.map((b) => b.ip), hosts: [this.cfg.atem?.ip, this.state.atemLastIp].filter(Boolean) } });
    this.log('info', `ATEM search: ${r.found.length ? r.found.map((f) => `${f.name || 'ATEM'} at ${f.ip} (${f.via})`).join(', ') : 'none found'}`);
    if (!this.atemSummary().connected) this.atem.searchNow?.();
    return { networks: r.networks, searched: describeNetworks(r.networks, this.cfg.bodies.map((b) => b.ip)), found: r.found, connectedIp: this.atemSummary().connected ? this.atemSummary().ip : null };
  }

  atemStateKey() {
    const a = this.atemSummary();
    return `${a.connected}|${a.modeName}|${a.ip}|${!!a.notFound}`;
  }
  onAtemChange() {
    this.syncTally();
    const a = this.atemSummary();
    const key = this.atemStateKey();
    if (key !== this.atemKey) {
      const was = this.atemKey;
      this.atemKey = key;
      if (a.thread && a.thread !== this.atemThreadSaid) {
        this.atemThreadSaid = a.thread;
        if (a.thread === 'main') this.log('yellow', `ATEM link running on the main thread: its own thread could not start (${a.threadError})`);
      }
      if (a.connected) this.log('green', `ATEM connected: ${a.name || 'switcher'} at ${a.ip}${a.via && a.via !== 'Settings' ? ` (found by ${a.via}${a.network ? ` on ${a.network}` : ''})` : ''}, ${a.modeLabel || 'reading'}`);
      else if (a.notFound && !a.configured) this.log('yellow', `No ATEM found. Searched ${a.searchedText || 'every network'}. Searching again automatically.`);
      else if (a.configured && was?.startsWith('true')) this.log('yellow', 'ATEM not connected, searching for it');
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
    const laptop = Number(s.laptopVideo?.atemInput || 0);
    if (!Number.isInteger(laptop) || laptop < 0) throw new Error('The laptop video\'s ATEM input must be a whole number');
    const clash = laptop && labels.find((_, i) => inputs[i] === laptop);
    if (clash) throw new Error(`${clash} and the laptop video point at the same ATEM input (${laptop})`);
    const ips = s.bodies.map((b) => String(b.ip || '').trim());
    if (ips.some((ip) => !HOST_RE.test(ip))) throw new Error('A body has an invalid IP address');
    if (new Set(ips).size !== ips.length) throw new Error('Two bodies have the same IP address');
    const atemIp = String(s.atem?.ip || '').trim();
    if (atemIp && !HOST_RE.test(atemIp)) throw new Error('ATEM IP address is invalid');
    const shutter = Number(s.standards.shutterSpeed), minutes = Number(s.standards.minRecordMinutes), poll = Number(s.pollSeconds);
    if (!(shutter > 0)) throw new Error('Shutter speed must be a positive number');
    if (!(minutes >= 0)) throw new Error('Minimum record minutes cannot be negative');
    if (!(poll >= 2)) throw new Error('Safety check must be at least 2 seconds');
    const ipNext = 'ipVideo' in s ? this.checkIpVideo(s.ipVideo) : null;
    let liveNext = null;
    if ('liveViewParallel' in s) {
      liveNext = s.liveViewParallel === 'auto' || s.liveViewParallel === '' || s.liveViewParallel == null ? 'auto' : Number(s.liveViewParallel);
      if (liveNext !== 'auto' && !(Number.isInteger(liveNext) && liveNext >= 1 && liveNext <= 4)) throw new Error('Live view requests per camera must be Automatic or 1 to 4');
    }

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
    const atemSearch = s.atem?.search !== false;
    const atemChanged = this.cfg.atem?.ip !== atemIp || (this.cfg.atem?.search !== false) !== atemSearch;
    this.cfg.atem = { ip: atemIp, search: atemSearch };
    if (laptop) this.cfg.laptopVideo = { atemInput: laptop }; else delete this.cfg.laptopVideo;
    this.cfg.pollSeconds = poll;
    if (ipNext) this.applyIpVideo(ipNext);
    if (liveNext === 'auto') delete this.cfg.liveViewParallel; else if (liveNext) this.cfg.liveViewParallel = liveNext;
    const tallyWas = this.cfg.tallyFromAtem !== false;
    if ('tallyFromAtem' in s) this.cfg.tallyFromAtem = s.tallyFromAtem !== false;
    const tallyNow = this.cfg.tallyFromAtem !== false;
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
    this.applyViewing();
    if (tallyWas && !tallyNow) { this.log('info', 'Tally lamps no longer follow the ATEM: the lamps ShotReady lit are turned off'); this.releaseLamps(); }
    if (!tallyWas && tallyNow) { this.log('info', 'Tally lamps follow the ATEM again'); this.syncTally(); }
    if (atemChanged) this.startAtem();
    this.setAutoRefresh(!!s.autoRefresh);
    return this.check({ force: true });
  }

  // ---------- monitoring LUTs ----------
  // One 3D LUT per Log gamma, shown over the pictures in ShotReady only: nothing is sent to a camera,
  // and the waveform still reads the Log picture. Each camera shows the LUT for the gamma it is set
  // to, when its LUT button is on. The files are kept in the data folder.
  lutPath(gamma) { return join(this.dataDir, 'luts', `${gamma}.cube`); }

  lutsView() {
    const set = this.cfg.luts || {};
    return {
      gammas: [...new Set([...this.std.allowedGamma, ...Object.keys(set)])],
      luts: Object.fromEntries(Object.entries(set).map(([g, l]) => [g, { name: l.name, size: l.size, input: l.input, output: l.output, version: l.version }])),
      on: { ...this.state.lutOn },
    };
  }

  loadLut(gamma, path) {
    if (!/^[a-z0-9_]+$/i.test(gamma)) throw new Error('Unknown gamma');
    if (statSync(path).size > 64e6) throw new Error('That file is too big to be a LUT');
    const text = readFileSync(path, 'utf8');
    const cube = parseCube(text);
    const name = basename(path);
    mkdirSync(join(this.dataDir, 'luts'), { recursive: true });
    writeFileSync(this.lutPath(gamma), text);
    this.cfg.luts = { ...this.cfg.luts, [gamma]: { name, size: cube.size, ...rangesFromName(name), version: Date.now() } };
    this.saveConfig();
    this.log('info', `LUT for ${gamma}: ${name} (${cube.size}-point)`);
    return this.lutsView();
  }

  clearLut(gamma) {
    if (this.cfg.luts?.[gamma]) {
      const { [gamma]: gone, ...rest } = this.cfg.luts;
      this.cfg.luts = rest;
      this.saveConfig();
      rmSync(this.lutPath(gamma), { force: true });
      this.log('info', `LUT for ${gamma} removed (${gone.name})`);
    }
    return this.lutsView();
  }

  // Whether the LUT expects the picture as full range or video (legal) levels, and gives either.
  setLutRange(gamma, input, output) {
    const l = this.cfg.luts?.[gamma];
    if (!l) throw new Error(`No LUT is loaded for ${gamma}`);
    const ok = (v) => v === 'full' || v === 'legal';
    if (!ok(input) || !ok(output)) throw new Error('Range must be full or legal');
    this.cfg.luts = { ...this.cfg.luts, [gamma]: { ...l, input, output, version: Date.now() } };
    this.saveConfig();
    return this.lutsView();
  }

  lutData(gamma) {
    const l = this.cfg.luts?.[gamma];
    if (!l) return null;
    const cube = parseCube(readFileSync(this.lutPath(gamma), 'utf8'));
    return { gamma, name: l.name, version: l.version, input: l.input, output: l.output, size: cube.size, min: cube.min, max: cube.max, data: cube.data };
  }

  // LUTs kept in a file of their own, apart from the monitoring LUTs: the inverse LUT for video out
  // (video colour to Log), and the screen's own LUT for video out's Screen source.
  fileLutView(key) {
    const l = this.cfg[key];
    return l ? { name: l.name, size: l.size, input: l.input, output: l.output, version: l.version } : null;
  }

  loadFileLut(key, file, what, path) {
    if (statSync(path).size > 64e6) throw new Error('That file is too big to be a LUT');
    const text = readFileSync(path, 'utf8');
    const cube = parseCube(text);
    const name = basename(path);
    mkdirSync(join(this.dataDir, 'luts'), { recursive: true });
    writeFileSync(join(this.dataDir, 'luts', file), text);
    this.cfg[key] = { name, size: cube.size, ...rangesFromName(name), version: Date.now() };
    this.saveConfig();
    this.log('info', `${what}: ${name} (${cube.size}-point)`);
    return this.fileLutView(key);
  }

  clearFileLut(key, file, what) {
    if (this.cfg[key]) {
      delete this.cfg[key];
      this.saveConfig();
      rmSync(join(this.dataDir, 'luts', file), { force: true });
      this.log('info', `${what} removed`);
    }
    return null;
  }

  setFileLutRange(key, what, input, output) {
    const l = this.cfg[key];
    if (!l) throw new Error(`No ${what} is loaded`);
    if (![input, output].every((v) => v === 'full' || v === 'legal')) throw new Error('Range must be full or legal');
    this.cfg[key] = { ...l, input, output, version: Date.now() };
    this.saveConfig();
    return this.fileLutView(key);
  }

  fileLutData(key, file) {
    const l = this.cfg[key];
    if (!l) return null;
    const cube = parseCube(readFileSync(join(this.dataDir, 'luts', file), 'utf8'));
    return { name: l.name, version: l.version, input: l.input, output: l.output, size: cube.size, min: cube.min, max: cube.max, data: cube.data };
  }

  playoutLutView() { return this.fileLutView('playoutLut'); }
  loadPlayoutLut(path) { return this.loadFileLut('playoutLut', 'video-out.cube', 'Video out LUT', path); }
  clearPlayoutLut() { return this.clearFileLut('playoutLut', 'video-out.cube', 'Video out LUT'); }
  setPlayoutLutRange(input, output) { return this.setFileLutRange('playoutLut', 'video out LUT', input, output); }
  playoutLutData() { return this.fileLutData('playoutLut', 'video-out.cube'); }

  screenLutView() { return this.fileLutView('screenLut'); }
  loadScreenLut(path) { return this.loadFileLut('screenLut', 'screen-out.cube', 'Video out screen LUT', path); }
  clearScreenLut() { return this.clearFileLut('screenLut', 'screen-out.cube', 'Video out screen LUT'); }
  setScreenLutRange(input, output) { return this.setFileLutRange('screenLut', 'screen LUT', input, output); }
  screenLutData() { return this.fileLutData('screenLut', 'screen-out.cube'); }

  setLutOn(bodyId, on) {
    if (!this.findBody(bodyId)) throw new Error(`Unknown body "${bodyId}"`);
    this.state.lutOn = { ...this.state.lutOn };
    if (on) this.state.lutOn[bodyId] = true; else delete this.state.lutOn[bodyId];
    this.saveStateSoon();
    return this.state.lutOn;
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
    clearTimeout(this.lampTimer);
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
