// Picture frames from a camera, one request each (image.cgi). The C80 does not offer a
// continuous video stream, and one request takes about 125 ms on a good link, so several requests
// overlap to make it look like video: up to 4 in flight gives about 18 frames a second.
//
// How many overlap is decided by what the link can take, not fixed. It starts at one and adds
// another only while frames are not getting slower. If frames slow down (the link or the camera is
// full) it backs off, and on a slow link it leaves idle gaps so the camera's small status requests
// are not stuck behind picture data. GET only.
import { httpGet } from './http.mjs';

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const TIMEOUT_MS = 6000;
const WINDOW_MS = 30000;
const ADJUST_EVERY_MS = 1500;

export class FrameSource {
  /**
   * @param url     full image.cgi URL
   * @param getAuth returns the current login, or null
   * @param on      { onFrame(jpegBuffer), onState('up' | 'down', reason) }
   */
  constructor(url, getAuth, on) {
    Object.assign(this, { url, getAuth, on });
    this.parallel = 0;       // the most requests in flight at once; 0 means idle
    this.limit = 1;          // how many the link is coping with now, never above parallel
    this.intervalMs = 0;     // pause after each request, for a slow background rate
    this.running = false;
    this.active = new Set();
    this.ids = 0;
    this.seq = 0;
    this.delivered = 0;
    this.state = null;
    this.rtt = null;         // smoothed time for one frame
    this.recent = [];        // [time, frame time] over the last 30 s
    this.lastAdjust = 0;
  }

  cap() { return Math.min(this.parallel, this.limit); }

  setMode({ parallel, intervalMs }) {
    this.parallel = parallel;
    this.intervalMs = intervalMs;
    this.fill();
  }

  start() { this.running = true; this.fill(); }
  stop() { this.running = false; }

  fill() {
    while (this.running && this.active.size < this.cap()) this.spawn();
  }

  async spawn() {
    const id = ++this.ids;
    this.active.add(id);
    // Staggered, so the requests finish evenly spaced instead of all at once.
    if (this.active.size > 1) await sleep(40 * (this.active.size - 1));
    let failures = 0;
    // The first worker to notice there are too many leaves.
    while (this.running && this.active.size <= this.cap()) {
      const seq = ++this.seq;
      const started = performance.now();
      try {
        const frame = await this.fetchFrame();
        // A frame that finishes after a newer one was shown is dropped, never shown late.
        if (seq > this.delivered) { this.delivered = seq; this.on.onFrame(frame); }
        failures = 0;
        this.mark('up');
        this.observe(performance.now() - started);
      } catch (e) {
        failures++;
        this.mark('down', e.message);
        // Trouble: fall back to one request and forget what "normal" looked like.
        this.limit = 1;
        this.rtt = null;
        this.recent = [];
        await sleep(Math.min(3000, 300 * failures));
        continue;
      }
      // On a slow link, rest for half a frame time so other requests get through.
      const rest = (this.rtt > 400 ? this.rtt * 0.5 : 0) + this.intervalMs;
      if (rest > 0) await sleep(rest);
    }
    this.active.delete(id);
  }

  observe(ms) {
    const now = Date.now();
    this.rtt = this.rtt == null ? ms : this.rtt * 0.7 + ms * 0.3;
    this.recent.push([now, ms]);
    while (this.recent.length && now - this.recent[0][0] > WINDOW_MS) this.recent.shift();
    if (now - this.lastAdjust < ADJUST_EVERY_MS) return;
    const best = Math.min(...this.recent.map((r) => r[1]));
    if (this.rtt > Math.max(500, best * 2.5) && this.limit > 1) {
      this.limit--;            // frames got slower: the link or camera is full
      this.lastAdjust = now;
    } else if (this.rtt < best * 1.4 + 20 && this.limit < this.parallel) {
      this.limit++;            // frames did not slow down: there is room for more
      this.lastAdjust = now;
      this.fill();
    }
  }

  mark(state, reason) {
    if (this.state === state) return;
    this.state = state;
    this.on.onState?.(state, reason);
  }

  async fetchFrame() {
    const res = await httpGet(this.url, this.getAuth(), TIMEOUT_MS);
    const status = res.headers.get('livescope-status');
    const type = res.headers.get('content-type') || '';
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status === 401) throw new Error('login rejected');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (status && status !== '0') throw new Error(`camera status ${status}`);
    if (!/jpeg/i.test(type)) throw new Error(`not a picture (${type || 'no type'})`);
    return body;
  }
}
