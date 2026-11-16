// Live streaming to YouTube, a Zoom webinar or event, or any RTMP server.
//
// The picture comes from a video input on this computer: the switcher's USB output, or a capture
// box on its program output. A hidden window of its own opens that input and encodes it in a
// thread (src/renderer/stream-worker.mjs: H.264 on the graphics chip where it has a video encoder,
// AAC sound). This side keeps the connection (src/core/rtmp.mjs), sends what was encoded, connects
// again by itself when the network drops, and reports how it is going.
import { BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { parseRtmpUrl } from '../core/rtmp.mjs';

// A thread cannot be started from inside the app's archive, so it comes from the unpacked copy.
const WORKER = fileURLToPath(new URL('../core/stream-worker.mjs', import.meta.url)).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);

// The sending thread (src/core/stream-worker.mjs): the RTMP connection and the test server.
class SendThread extends EventEmitter {
  constructor() {
    super();
    this.waiting = new Map();
    this.reqs = 0;
    this.worker = new Worker(WORKER);
    this.worker.unref();
    this.worker.on('message', (m) => {
      if (m.type === 'reply' || m.type === 'stats') {
        const w = this.waiting.get(m.req);
        this.waiting.delete(m.req);
        if (!w) return;
        if (m.error) w.reject(new Error(m.error)); else w.resolve(m.type === 'stats' ? m : m.data);
      } else if (m.type === 'dropped') this.emit('dropped', m.why);
    });
    const gone = (why) => {
      if (this.dead) return;
      this.dead = why;
      for (const w of this.waiting.values()) w.reject(new Error(why));
      this.waiting.clear();
      this.emit('dead', why);
    };
    this.worker.on('error', (e) => gone(`the sending thread stopped (${e.message})`));
    this.worker.on('exit', (code) => gone(`the sending thread stopped (exit ${code})`));
  }

  ask(msg, ms = 20000) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    return new Promise((resolve, reject) => {
      const req = ++this.reqs;
      const timer = setTimeout(() => { this.waiting.delete(req); reject(new Error('the sending thread did not answer')); }, ms);
      this.waiting.set(req, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.worker.postMessage({ ...msg, req });
    });
  }

  post(msg, transfer) { if (!this.dead) this.worker.postMessage(msg, transfer); }
  quit() { this.post({ type: 'quit' }); }
}

export const DESTINATIONS = {
  youtube: { name: 'YouTube', url: 'rtmps://a.rtmps.youtube.com/live2' },
  zoom: { name: 'Zoom webinar or event', url: '' },
  custom: { name: 'Other (RTMP)', url: '' },
  test: { name: 'Test on this computer' },
};
export const SIZES = { 1080: [1920, 1080], 720: [1280, 720] };
const RATES = [25, 30, 50, 60];
// Megabits per second that suit a size and frame rate, in YouTube's recommended range.
export const suggestedMbps = (height, fps) => (height >= 1080 ? (fps > 30 ? 9 : 6) : fps > 30 ? 6 : 4);
const clock = () => Date.now();

export class Streamer extends EventEmitter {
  /**
   * @param o.page, o.preload       the hidden window's page and preload script
   * @param o.settings(), o.save(p) saved choices
   * @param o.encrypt, o.decrypt    stream key protection (Windows keeps the key encrypted)
   * @param o.lut(gamma)            a monitoring LUT's data, or null
   * @param o.version               shown to the server as the encoder's name
   * @param o.testFile()            where the test destination keeps what it received (FLV)
   * @param o.audioCodec            tests only: another sound codec where there is no AAC encoder
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.state = 'off'; // off, starting, live, reconnecting
    this.error = null;
    this.notes = [];
    this.info = null;
    this.devices = null;
    this.stats = { fps: 0, kbps: 0, skipped: 0, dropped: 0, frames: 0 };
    this.keys = {}; // keys that could not be saved encrypted are kept for this run only
    this.run = 0;
  }

  get cfg() {
    const s = this.settings() || {};
    const height = SIZES[s.height] ? s.height : 1080;
    const fps = RATES.includes(s.fps) ? s.fps : 25;
    return {
      destination: DESTINATIONS[s.destination] ? s.destination : 'youtube',
      destinations: s.destinations || {},
      video: s.video || null,
      audio: s.audio?.mode ? s.audio : { mode: 'same' },
      height, fps,
      mbps: s.mbps > 0 ? s.mbps : suggestedMbps(height, fps),
      lut: s.lut || null,
    };
  }

  urlOf(dest, c = this.cfg) { return c.destinations[dest]?.url ?? DESTINATIONS[dest].url; }
  keyOf(dest, c = this.cfg) {
    if (this.keys[dest]) return this.keys[dest];
    const enc = c.destinations[dest]?.keyEnc;
    return enc && this.decrypt ? this.decrypt(enc) : '';
  }

  /** What the Stream tab shows. Stream keys never leave this process. */
  status() {
    const c = this.cfg;
    const live = this.state === 'live' || this.state === 'reconnecting';
    return {
      state: this.state, error: this.error, notes: this.notes, info: this.info, devices: this.devices,
      seconds: live && this.startedAt ? Math.round((clock() - this.startedAt) / 1000) : 0,
      stats: this.stats,
      test: this.state !== 'off' && this.target === 'test' ? this.testNow : this.lastTest || null,
      settings: {
        destination: c.destination, video: c.video, audio: c.audio, height: c.height, fps: c.fps, mbps: c.mbps, lut: c.lut,
        autoMbps: !(this.settings()?.mbps > 0), suggested: suggestedMbps(c.height, c.fps),
        destinations: Object.fromEntries(Object.entries(DESTINATIONS).map(([id, d]) => [id, { name: d.name, url: id === 'test' ? '' : this.urlOf(id, c), hasKey: id !== 'test' && !!this.keyOf(id, c) }])),
      },
    };
  }

  changed() { this.emit('status', this.status()); }

  /** Changes saved choices. Not while live: what is going out stays as it is. */
  set(patch) {
    if (this.state !== 'off') throw new Error('Stop the stream first, then change this');
    const c = this.cfg, next = {};
    if ('destination' in patch) { if (!DESTINATIONS[patch.destination]) throw new Error('Unknown destination'); next.destination = patch.destination; }
    if ('url' in patch) {
      const dest = patch.dest || c.destination;
      if (!DESTINATIONS[dest] || dest === 'test') throw new Error('Unknown destination');
      const url = String(patch.url || '').trim();
      if (url && !/^rtmps?:\/\/[^/\s]+\/\S+$/i.test(url)) throw new Error('The server address must look like rtmp://server/app or rtmps://server/app');
      next.destinations = { ...c.destinations, [dest]: { ...c.destinations[dest], url: url || undefined } };
      if (!url) delete next.destinations[dest].url;
    }
    if ('video' in patch) next.video = patch.video ? { id: String(patch.video.id), label: String(patch.video.label || '') } : null;
    if ('audio' in patch) {
      const a = patch.audio || {};
      if (!['same', 'device', 'none'].includes(a.mode)) throw new Error('Unknown audio choice');
      next.audio = a.mode === 'device' ? { mode: 'device', id: String(a.id), label: String(a.label || '') } : { mode: a.mode };
    }
    if ('height' in patch) { if (!SIZES[patch.height]) throw new Error('Unknown size'); next.height = Number(patch.height); }
    if ('fps' in patch) { if (!RATES.includes(Number(patch.fps))) throw new Error('Unknown frame rate'); next.fps = Number(patch.fps); }
    if ('mbps' in patch) { const m = Number(patch.mbps); if (m && !(m >= 1 && m <= 51)) throw new Error('The bitrate must be 1 to 51 Mbps'); next.mbps = m || 0; }
    if ('lut' in patch) next.lut = patch.lut ? String(patch.lut) : null;
    this.save(next);
    this.error = null;
    this.changed();
    return this.status();
  }

  /** Saves a destination's stream key, encrypted. An empty key forgets it. */
  setKey(dest, key) {
    if (this.state !== 'off') throw new Error('Stop the stream first, then change this');
    if (!DESTINATIONS[dest] || dest === 'test') throw new Error('Unknown destination');
    key = String(key || '').trim();
    const c = this.cfg;
    const entry = { ...c.destinations[dest] };
    delete entry.keyEnc;
    delete this.keys[dest];
    let kept = true;
    if (key) {
      try { entry.keyEnc = this.encrypt(key); } catch { this.keys[dest] = key; kept = false; }
    }
    this.save({ destinations: { ...c.destinations, [dest]: entry } });
    this.changed();
    return { ...this.status(), keyNote: key && !kept ? 'This computer could not protect the key, so it is kept only until ShotReady closes' : null };
  }

  send(msg) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('shotready:stream', msg); }

  window() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    const win = new BrowserWindow({
      show: false, width: 320, height: 200, skipTaskbar: true, title: 'ShotReady stream',
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      if (this.state !== 'off') this.fail('the stream window closed');
    });
    this.win = win;
    this.ready = new Promise((resolve) => { this.onReady = resolve; });
    win.loadFile(this.page);
    return this.ready;
  }

  pageReady() { this.onReady?.(); }

  thread() {
    if (this.sender && !this.sender.dead) return this.sender;
    const t = this.sender = new SendThread();
    t.on('dropped', (why) => { if (this.sender !== t) return; if (this.state === 'live') this.reconnect(why); else if (this.state === 'starting') this.fail(why); });
    t.on('dead', (why) => { if (this.sender === t) { this.sender = null; if (this.state !== 'off') this.fail(why); } });
    return t;
  }

  connect() {
    return this.thread().ask({ type: 'connect', url: this.rtmp.url, key: this.rtmp.key, maxBacklog: Math.max(1e6, (this.encode.videoBitrate / 8) * 3) });
  }

  /** Go live. Resolves once the server has accepted the stream and the video device is being opened. */
  async start() {
    if (this.state !== 'off') return this.status();
    const c = this.cfg;
    const run = ++this.run;
    this.error = null;
    this.notes = [];
    this.info = null;
    this.devices = null;
    this.lastTest = null;
    this.stats = { fps: 0, kbps: 0, skipped: 0, dropped: 0, frames: 0 };
    this.testNow = null;
    this.target = c.destination;
    const [width, height] = SIZES[c.height];
    const lut = c.lut ? this.lut(c.lut) : null;
    if (c.lut && !lut) this.note(`The ${c.lut} LUT is no longer loaded: the stream goes out as it is`);
    this.encode = {
      width, height, fps: c.fps, videoBitrate: Math.round(c.mbps * 1e6), audioBitrate: 160000,
      lut: lut && { size: lut.size, data: lut.data, min: lut.min, max: lut.max, input: lut.input, output: lut.output },
      ...(this.audioCodec ? { audioCodec: this.audioCodec } : {}),
    };
    try {
      if (c.destination === 'test') {
        this.rtmp = { url: await this.thread().ask({ type: 'testServer', file: this.testFile?.() }), key: 'test' };
      } else {
        const url = this.urlOf(c.destination, c), key = this.keyOf(c.destination, c);
        if (!url) throw new Error(`Enter the server address for ${DESTINATIONS[c.destination].name} first`);
        if (!key && c.destination !== 'custom') throw new Error(`Enter the stream key for ${DESTINATIONS[c.destination].name} first`);
        parseRtmpUrl(url, key);
        this.rtmp = { url, key };
      }
      this.state = 'starting';
      this.changed();
      await this.connect();
      if (run !== this.run) return this.status();
      await this.window();
      if (run !== this.run) return this.status();
      this.send({ type: 'start', cfg: { video: c.video, audio: c.audio, width, height, fps: c.fps, encode: this.encode } });
      // A device that never gives a picture must not leave the button saying Starting for ever.
      this.watchdog = setTimeout(() => { if (this.state === 'starting') this.fail('no picture came from the video device in 15 seconds'); }, 15000);
      this.timer = setInterval(() => this.tick(), 1000);
      this.emit('info', `Stream: connected to ${DESTINATIONS[c.destination].name}, opening the video device`);
    } catch (e) {
      if (run === this.run) { this.fail(e.message, true); this.emit('note', `Stream did not start: ${e.message}`); }
    }
    return this.status();
  }

  // The connection dropped while live: connect again, for as long as it takes, until Stop.
  async reconnect(why) {
    const run = this.run;
    this.state = 'reconnecting';
    this.emit('note', `Stream: the connection dropped (${why}). Connecting again…`);
    this.changed();
    for (let attempt = 0; run === this.run && this.state === 'reconnecting'; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * 2 ** Math.min(attempt, 4))));
      if (run !== this.run || this.state !== 'reconnecting') return;
      try {
        await this.connect();
        if (run !== this.run || this.state !== 'reconnecting') return;
        this.error = null;
        this.send({ type: 'keyframe' });
        this.state = 'live';
        this.emit('info', 'Stream: connected again');
        this.changed();
        return;
      } catch (e) {
        this.error = `Connecting again: ${e.message}`;
        this.changed();
      }
    }
  }

  note(text) {
    if (!this.notes.includes(text)) this.notes.push(text);
    this.emit('note', `Stream: ${text}`);
  }

  /** From the hidden window: encoded pictures and sound, and what the encoder thread has to say. */
  report(m) {
    if (this.state === 'off') return;
    const t = this.sender;
    if (m.type === 'chunk') {
      // Straight on to the sending thread, the bytes moved rather than copied.
      t?.post({ type: m.kind, ms: m.ms, key: m.key, data: m.data }, [m.data.buffer]);
      if (m.kind === 'video') {
        if (this.state === 'starting') {
          this.state = 'live';
          this.startedAt = clock();
          clearTimeout(this.watchdog);
          this.emit('info', `Stream: LIVE to ${DESTINATIONS[this.target].name}, ${this.encode.width}×${this.encode.height} ${this.encode.fps} fps at ${this.encode.videoBitrate / 1e6} Mbps`);
          this.changed();
        }
      }
    } else if (m.type === 'config') {
      t?.post({ type: m.kind === 'video' ? 'vconf' : 'aconf', data: m.data });
    } else if (m.type === 'info') {
      this.info = { encoder: m.encoder, codec: m.codec, sound: m.sound, source: m.source, lut: m.lut };
      if (m.soundNote) this.note(m.soundNote);
      this.meta = {
        width: this.encode.width, height: this.encode.height, framerate: this.encode.fps, videocodecid: 7, videodatarate: this.encode.videoBitrate / 1000,
        ...(m.sound ? { audiocodecid: 10, audiodatarate: this.encode.audioBitrate / 1000, audiosamplerate: m.soundRate, audiosamplesize: 16, stereo: m.soundChannels === 2 } : {}),
        encoder: `ShotReady ${this.version || ''}`.trim(),
      };
      t?.post({ type: 'meta', meta: this.meta });
      this.emit('info', `Stream: ${m.source.width}×${m.source.height} from the video device, encoded ${m.encoder === 'software' ? 'in software' : 'on the graphics chip'} (${m.codec})${m.sound ? `, sound ${m.sound}` : ', no sound'}${m.lut ? ', through the LUT' : ''}`);
      this.changed();
    } else if (m.type === 'devices') {
      this.devices = { video: m.video, audio: m.audio };
    } else if (m.type === 'stats') {
      this.stats.fps = m.fps;
      this.stats.skipped = m.skipped;
      this.stats.frames = m.frames;
    } else if (m.type === 'note') {
      this.note(m.text);
      this.changed();
    } else if (m.type === 'failed') {
      this.fail(m.message);
    }
  }

  async tick() {
    const run = this.run;
    let r;
    try { r = await this.sender?.ask({ type: 'stats' }, 3000); } catch { return; }
    if (!r || run !== this.run) return;
    this.stats.kbps = Math.round(((r.sent - (this.lastSent ?? r.sent)) * 8) / 1000);
    this.lastSent = r.sent;
    this.stats.dropped = r.dropped;
    this.stats.behind = Math.round(((r.backlog * 8) / Math.max(1, this.encode.videoBitrate)) * 10) / 10;
    this.testNow = r.test;
    this.changed();
  }

  // Ends the stream because something went wrong, and says what.
  fail(message, quiet = false) {
    this.end();
    this.error = message;
    if (!quiet) this.emit('alarm', `Stream stopped: ${message}`);
    this.changed();
  }

  end() {
    this.run++;
    clearTimeout(this.watchdog);
    clearInterval(this.timer);
    this.lastSent = undefined;
    this.send({ type: 'stop' });
    const target = this.target;
    this.lastTest = target === 'test' ? this.testNow : null;
    // What the test server received, once the last of the stream has reached it.
    this.sender?.ask({ type: 'end' }, 5000).then((test) => {
      if (target !== 'test' || this.state !== 'off' || !test) return;
      setTimeout(() => this.sender?.ask({ type: 'stats' }, 3000).then((r) => { if (this.state === 'off' && r.test) { this.lastTest = r.test; this.changed(); } }).catch(() => {}), 400);
      this.lastTest = test;
      this.changed();
    }).catch(() => {});
    this.state = 'off';
    // The window is closed so the video device is let go (and its light goes out).
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.close();
  }

  /** Stop the stream. */
  stop() {
    if (this.state === 'off') return this.status();
    const was = this.state, seconds = this.startedAt ? Math.round((clock() - this.startedAt) / 1000) : 0;
    this.end();
    this.startedAt = null;
    this.emit('info', was === 'starting' ? 'Stream: stopped before it went live' : `Stream: stopped after ${Math.floor(seconds / 60)} min ${seconds % 60} s`);
    this.changed();
    return this.status();
  }

  /** On quit. */
  close() {
    if (this.state !== 'off') this.end();
    this.sender?.quit();
    this.sender = null;
  }
}
