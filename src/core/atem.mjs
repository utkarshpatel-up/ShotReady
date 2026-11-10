// Read-only ATEM link: live video mode, input labels, program/preview per M/E.
// No setter of atem-connection is ever called. The library is loaded lazily so a
// load failure only disables ATEM features rather than the whole app.
import { EventEmitter } from 'node:events';

const MODE_LABEL = { P4KHDp25: '2160p25', P1080p25: '1080p25' };

// Turn the library's state into the small shape ShotReady uses. Exported for tests.
export function readAtemState(state, VideoMode) {
  const name = VideoMode[state?.settings?.videoMode];
  const inputs = {};
  for (const [id, input] of Object.entries(state?.inputs || {})) {
    if (input) inputs[id] = input.longName || '';
  }
  const mixEffects = (state?.video?.mixEffects || []).filter(Boolean).map((m) => ({
    program: m.programInput, preview: m.previewInput,
  }));
  return { modeName: name || null, modeLabel: MODE_LABEL[name] || name || 'unknown', inputs, mixEffects };
}

export class AtemLink extends EventEmitter {
  constructor() {
    super();
    this.status = { configured: false, connected: false, error: null };
    this.data = null;
    this.atem = null;
  }

  async connect(ip) {
    await this.disconnect();
    if (!ip) { this.status = { configured: false, connected: false, error: null }; this.emit('change'); return; }
    this.status = { configured: true, connected: false, error: null, ip };
    this.emit('change');
    let lib;
    try {
      lib = await import('atem-connection');
    } catch (e) {
      this.status = { configured: true, connected: false, error: `ATEM library failed to load: ${e.message}`, ip };
      this.emit('change');
      return;
    }
    const { Atem, Enums } = lib.default?.Atem ? lib.default : lib;
    const atem = new Atem({ disableMultithreaded: true });
    this.atem = atem;
    const refresh = () => {
      if (this.atem !== atem) return;
      // Everything visible on M/E 1, including keyers and anything fed in from another M/E.
      const visible = (mode) => { try { return atem.listVisibleInputs(mode, 0); } catch { return []; } };
      this.data = { ...readAtemState(atem.state, Enums.VideoMode), tally: { program: visible('program'), preview: visible('preview') } };
      this.emit('change');
    };
    atem.on('connected', () => {
      if (this.atem !== atem) return;
      this.status = { configured: true, connected: true, error: null, ip };
      refresh();
    });
    atem.on('disconnected', () => {
      if (this.atem !== atem) return;
      this.status = { configured: true, connected: false, error: 'Disconnected, retrying', ip };
      this.emit('change');
    });
    atem.on('stateChanged', refresh);
    atem.on('error', (msg) => {
      if (this.atem !== atem) return;
      this.status = { ...this.status, error: String(msg) };
      this.emit('change');
    });
    await atem.connect(ip);
  }

  async disconnect() {
    const atem = this.atem;
    this.atem = null;
    this.data = null;
    if (atem) { try { await atem.disconnect(); await atem.destroy(); } catch { /* closing anyway */ } }
  }
}

// Stand-in used by demo mode and tests.
export class FakeAtemLink extends EventEmitter {
  constructor(data) {
    super();
    this.data = data;
    this.status = { configured: true, connected: true, error: null, ip: 'simulated' };
  }
  async connect() { this.emit('change'); }
  async disconnect() {}
  set(data) { this.data = data; this.emit('change'); }
}
