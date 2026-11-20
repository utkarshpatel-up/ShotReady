// Read-only ATEM link: live video mode, input labels, program/preview per M/E.
// No setter of atem-connection is ever called. The connection runs in its own thread
// (atem-worker.mjs); if that thread cannot start, it runs on the main thread instead. The library
// is loaded lazily so a load failure only disables ATEM features rather than the whole app.
import { EventEmitter } from 'node:events';
import { findAtems, localNetworks, describeNetworks } from './atem-discovery.mjs';
import { readAtemState } from './atem-state.mjs';
import { AtemThread } from './atem-thread.mjs';

export { readAtemState };
const CONNECT_MS = 6000;      // a big switcher sends its whole state before it counts as connected
const GONE_MS = 10000;        // a connected switcher gone this long is searched for again
const RETRY_MS = [15000, 30000, 60000];

export class AtemLink extends EventEmitter {
  /**
   * @param opts.find  the search; opts.load  loads atem-connection. Both replaceable for tests, as are
   *                   the timings.
   */
  constructor({ find = findAtems, load = () => import('atem-connection'), thread = () => new AtemThread(), connectMs = CONNECT_MS, goneMs = GONE_MS, retryMs = RETRY_MS } = {}) {
    super();
    Object.assign(this, { find, load, thread, connectMs, goneMs, retryMs });
    this.host = null;
    this.status = { enabled: false, configured: false, connected: false, searching: false, error: null, ip: null, thread: null };
    this.data = null;
    this.atem = null;
    this.run = 0;
  }

  set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('change');
  }

  // Keeps an ATEM connected, wherever it is. The address from Settings is tried first, then the
  // address it was last found at. If neither answers, every network the computer is on (Ethernet
  // and Wi-Fi alike) is searched, and the search repeats until a switcher answers. A connected
  // switcher that stays gone for 10 seconds is searched for again, in case it came back on another
  // address. With search off, only the address from Settings is used, as before.
  async start({ ip = '', search = true, hints = {}, lastIp = '', onFound = () => {} } = {}) {
    const run = ++this.run;
    this.wake?.();
    await this.dropAtem();
    this.opts = { ip, search, hints, lastIp, onFound };
    this.everFound = false;
    this.data = null;
    this.status = { enabled: !!ip || search, configured: !!ip, connected: false, searching: false, notFound: false, error: null, ip: ip || null, search, thread: this.status.thread, threadError: this.status.threadError };
    this.emit('change');
    if (!ip && !search) return;
    // The ATEM's thread starts now, so it is ready before the first switcher answers.
    if (this.thread && this.threadOk !== false && !this.host) { try { this.host = this.thread(); } catch { this.host = null; } }
    if (!search) { await this.open(ip, 'Settings'); return; }
    this.loop(run).catch((e) => this.set({ error: e.message, searching: false }));
  }

  // The old entry point: one fixed address, no search.
  connect(ip) { return this.start({ ip, search: false }); }

  // Cuts a wait short, so a search runs now.
  searchNow() { this.wake?.(); }

  // A cut to program (Shift+F1 / F2) or a change of preview (F1 / F2) on an M/E. The only commands
  // ShotReady sends a switcher.
  async changeProgram(input, me = 0) {
    if (!this.status.connected || !this.atem) throw new Error('The ATEM is not connected');
    await this.atem.changeProgramInput(input, me);
  }
  async changePreview(input, me = 0) {
    if (!this.status.connected || !this.atem) throw new Error('The ATEM is not connected');
    await this.atem.changePreviewInput(input, me);
  }

  async loop(run) {
    let misses = 0;
    while (run === this.run) {
      const tries = [...new Set([this.opts.ip, this.opts.lastIp].filter(Boolean))].map((ip) => ({ ip, via: ip === this.opts.ip ? 'Settings' : 'last address' }));
      let got = null;
      // Read each time, so a camera address changed in Settings is searched from the next search on.
      const hints = (typeof this.opts.hints === 'function' ? this.opts.hints() : this.opts.hints) || {};
      for (const t of tries) if (!got && run === this.run && await this.tryOpen(run, t.ip, t.via)) got = t;
      if (!got && run === this.run) {
        const networks = localNetworks();
        this.set({ searching: true, networks, searchedText: describeNetworks(networks, hints.subnetsOf), trying: null });
        const { found } = await this.find({ hints: { ...hints, hosts: [...(hints.hosts || []), ...tries.map((t) => t.ip)] }, networks });
        if (run !== this.run) return;
        this.set({ searching: false, lastSearchAt: Date.now(), candidates: found });
        for (const f of found) if (!got && run === this.run && await this.tryOpen(run, f.ip, f.via, f)) got = f;
      }
      if (run !== this.run) return;
      if (got) {
        misses = 0;
        this.opts.lastIp = got.ip;
        this.opts.onFound(got.ip);
        await this.whileConnected();
        continue;
      }
      const wait = this.retryMs[Math.min(misses++, this.retryMs.length - 1)];
      this.set({ notFound: true, nextSearchAt: Date.now() + wait, error: this.everFound ? 'Lost, searching again' : null });
      await this.pause(wait);
    }
  }

  pause(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      function done() { clearTimeout(t); resolve(); }
      this.wake = done;
    });
  }

  // Resolves once the switcher has been gone for GONE_MS, or the link is restarted.
  whileConnected() {
    return new Promise((resolve) => {
      const atem = this.atem;
      let gone = null;
      const finish = () => { clearTimeout(gone); atem?.off('disconnected', lost); atem?.off('connected', back); resolve(); };
      const lost = () => { clearTimeout(gone); gone = setTimeout(async () => { await this.dropAtem(); finish(); }, this.goneMs); gone.unref?.(); };
      const back = () => clearTimeout(gone);
      if (!atem) { resolve(); return; }
      atem.on('disconnected', lost);
      atem.on('connected', back);
      this.wake = finish;
    });
  }

  async tryOpen(run, ip, via, found = {}) {
    this.set({ trying: ip });
    const atem = await this.open(ip, via, found);
    if (!atem) return false;
    const ok = this.status.connected || await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), this.connectMs);
      t.unref?.();
      atem.once('connected', () => { clearTimeout(t); resolve(true); });
    });
    if (ok && run === this.run) { this.set({ trying: null }); return true; }
    if (this.atem === atem) await this.dropAtem();
    this.set({ trying: null });
    return false;
  }

  // A connection in the ATEM's own thread. If the thread cannot start (or keeps stopping), the
  // connection is made on the main thread instead, as before, and the status says so.
  async makeAtem() {
    if (this.thread && this.threadOk !== false) {
      try {
        if (this.host?.dead) { this.host = null; this.threadRestarts = (this.threadRestarts || 0) + 1; }
        if (this.threadRestarts > 3) throw new Error('it stopped more than 3 times');
        this.host ||= this.thread();
        await this.host.ready;
        this.status.thread = 'own';
        return { atem: this.host.session() };
      } catch (e) {
        this.host?.stop?.();
        this.host = null;
        this.threadOk = false;
        this.set({ thread: 'main', threadError: e.message });
      }
    }
    let lib;
    try {
      lib = await this.load();
    } catch (e) {
      this.set({ error: `ATEM library failed to load: ${e.message}` });
      return null;
    }
    const { Atem, Enums } = lib.default?.Atem ? lib.default : lib;
    this.status.thread = 'main';
    return { atem: new Atem({ disableMultithreaded: true }), Enums };
  }

  async open(ip, via, found = {}) {
    await this.dropAtem();
    const made = await this.makeAtem();
    if (!made) return null;
    const { atem, Enums } = made;
    this.atem = atem;
    const refresh = () => {
      if (this.atem !== atem) return;
      if (atem.snapshot) {
        // Worked out in the ATEM's own thread, and sent only when it changed.
        const data = atem.snapshot();
        if (!data) return;
        this.data = { ...data };
      } else {
        // Everything visible on M/E 1, including keyers and anything fed in from another M/E.
        const visible = (mode) => { try { return atem.listVisibleInputs(mode, 0); } catch { return []; } };
        this.data = { ...readAtemState(atem.state, Enums.VideoMode), tally: { program: visible('program'), preview: visible('preview') } };
      }
      if (!this.data.name && found.name) this.data.name = found.name;
      this.emit('change');
    };
    atem.on('connected', () => {
      if (this.atem !== atem) return;
      this.everFound = true;
      this.status = { ...this.status, configured: true, connected: true, searching: false, notFound: false, error: null, ip, via, network: found.network || '', trying: null };
      refresh();
    });
    atem.on('disconnected', () => {
      if (this.atem !== atem) return;
      this.set({ connected: false, error: 'Disconnected, retrying' });
    });
    atem.on('stateChanged', refresh);
    atem.on('error', (msg) => { if (this.atem === atem) this.status.error = String(msg); });
    try {
      await atem.connect(ip);
    } catch (e) {
      if (this.atem === atem) await this.dropAtem();
      this.set({ error: e.message });
      return null;
    }
    return atem;
  }

  async dropAtem() {
    const atem = this.atem;
    this.atem = null;
    this.data = null;
    if (this.status.connected) this.status = { ...this.status, connected: false };
    if (atem) { try { await atem.disconnect(); await atem.destroy(); } catch { /* closing anyway */ } }
  }

  async disconnect() {
    this.run++;
    this.wake?.();
    await this.dropAtem();
    this.host?.stop?.();
    this.host = null;
  }
}

// Stand-in used by demo mode and tests.
export class FakeAtemLink extends EventEmitter {
  constructor(data) {
    super();
    this.data = { name: 'ATEM 2 M/E Constellation 4K', ...data };
    this.status = { enabled: true, configured: true, connected: true, searching: false, error: null, ip: 'simulated', via: 'demo' };
  }
  async start() { this.emit('change'); }
  async connect() { this.emit('change'); }
  async disconnect() {}
  searchNow() {}
  async changeProgram(input, me = 0) {
    const mixEffects = (this.data.mixEffects || []).map((m, i) => (i === me ? { ...m, program: input } : m));
    this.set({ mixEffects, tally: undefined });
  }
  async changePreview(input, me = 0) {
    const mixEffects = (this.data.mixEffects || []).map((m, i) => (i === me ? { ...m, preview: input } : m));
    this.set({ mixEffects, tally: undefined });
  }
  find() { return Promise.resolve({ networks: [], found: [{ ip: 'simulated', name: this.data.name, via: 'demo', network: '' }] }); }
  set(data) { this.data = { ...this.data, ...data }; this.emit('change'); }
}
