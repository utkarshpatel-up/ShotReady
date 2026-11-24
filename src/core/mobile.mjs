// Phone view: a read-only page of the cameras' pictures and essentials for a phone or tablet on the
// same network as this computer. Off until it is turned on in Settings. It listens on every network
// of this computer (that is the point), so every address carries a key: a link without it gets
// nothing. Nothing here changes a camera or the switcher; there is no way to send a command.
//
// The pictures are the ones the app already shows: each phone is handed the camera's local picture
// stream (feedserver.mjs) through this server, at a lower frame rate, so a phone never opens a
// connection of its own to a camera.
import { createServer, get as httpGet } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fmtVideo, shortLens } from './engine.mjs';

export const MOBILE_DEFAULT_PORT = 8780;
const BOUNDARY = 'shotreadyframe';
// No 0/o, 1/l/i: the key can be typed from the screen.
const KEY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
export const newMobileKey = () => Array.from({ length: 8 }, () => KEY_CHARS[randomInt(KEY_CHARS.length)]).join('');

// What the phone shows, from the last check, the ATEM, the focus data and the waveform. Plain data.
export function mobileView({ result, atem = {}, focus = {}, waves = {} }) {
  const card = (c, spare) => {
    const s = c.summary, e = c.essentials, f = focus[c.body];
    const results = c.results || [];
    const named = (status) => results.filter((r) => r.status === status).map((r) => r.check);
    const sdiBad = results.find((r) => r.check === 'SDI output' && r.status === 'red');
    const w = waves[c.body];
    return {
      label: spare ? null : c.label, body: c.body || null, online: !!c.online, spare: !!spare, pictureOff: !!c.pictureOff,
      program: !!c.tally?.program?.length, preview: !!c.tally?.preview?.length,
      model: s?.model || null, lens: s?.lens ? shortLens(s.lens) : null, gamma: s?.gamma || null,
      sdi: s ? fmtVideo(s.output) : null, sdiBad: sdiBad ? sdiBad.detail : null,
      iso: e?.iso ?? null, isoOver: !!e?.isoOver, baseIso: e?.baseIso ?? null,
      shutter: e?.shutter ?? null, shutterBad: !!e?.shutterBad, iris: e?.aperture ?? null,
      wb: e?.wb ?? null, digitalIS: e?.digitalIS ?? null, sensor: e?.sensor ?? null,
      focus: f?.guide ? (f.focused ? 'in' : 'out') : null,
      wfm: w ? { peak: w.peak, avg: w.avg } : null,
      reds: named('red'), yellows: named('yellow'),
    };
  };
  const r = result || { labels: [], spares: [] };
  return {
    time: r.time || null, reds: r.reds || 0, yellows: r.yellows || 0, profile: r.profileLabel || null,
    atem: { connected: !!atem.connected, searching: !!atem.searching, name: atem.name || null, mode: atem.modeLabel || null },
    cams: [...(r.labels || []).map((c) => card(c, false)), ...(r.spares || []).filter((c) => c.online).map((c) => card(c, true))],
  };
}

// Splits a picture stream (multipart JPEG, as feedserver.mjs writes it) back into its parts.
export function partSplitter(onPart) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const start = buf.indexOf(`--${BOUNDARY}`);
      if (start < 0) { buf = buf.subarray(Math.max(0, buf.length - BOUNDARY.length - 2)); return; }
      const headEnd = buf.indexOf('\r\n\r\n', start);
      if (headEnd < 0) { buf = buf.subarray(start); return; }
      const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(start, headEnd).toString('latin1'))?.[1]);
      if (!Number.isFinite(len)) { buf = buf.subarray(headEnd + 4); continue; }
      const end = headEnd + 4 + len + 2;
      if (buf.length < end) { buf = buf.subarray(start); return; }
      onPart(buf.subarray(start, end));
      buf = buf.subarray(end);
    }
  };
}

export class MobileServer extends EventEmitter {
  /**
   * @param o.dir        the folder holding mobile.html and mobile.js
   * @param o.view()     the current mobileView
   * @param o.feedBase() the local picture stream address of each camera: { body: base }
   * @param o.key()      the key every address must carry
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.server = null;
    this.port = 0;
    this.events = new Set();  // phones on the live updates
    this.feeds = new Set();   // pictures being sent
    this.last = '';
    this.timer = null;
  }

  get running() { return !!this.server?.listening; }

  start(port) {
    if (this.server) this.stop();
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }));
      server.once('error', (e) => {
        this.server = null;
        reject(new Error(e.code === 'EADDRINUSE' ? `port ${port} is in use by another program: pick another` : e.code === 'EACCES' ? `port ${port} is not allowed: pick one above 1024` : e.message));
      });
      server.listen(port, '0.0.0.0', () => { this.port = server.address().port; resolve(this.port); });
      this.server = server;
    });
  }

  stop() {
    clearTimeout(this.timer);
    for (const res of [...this.events, ...this.feeds]) res.destroy();
    this.events.clear();
    this.feeds.clear();
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    this.port = 0;
    this.emit('viewers', 0);
  }

  // The addresses a phone can open: one per network of this computer, and this computer's own.
  urls() {
    if (!this.running) return [];
    const ips = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list || [])
      .filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, ip: a.address })));
    return [...ips, { name: 'this computer', ip: 'localhost' }].map(({ name, ip }) => ({ name, url: `http://${ip}:${this.port}/m/${this.key()}/` }));
  }

  viewers() { return this.events.size; }

  // Something the phone shows has changed: sent on, at most about three times a second.
  update() {
    if (!this.events.size || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const json = JSON.stringify(this.view());
      if (json === this.last) return;
      this.last = json;
      for (const res of this.events) res.write(`event: view\ndata: ${json}\n\n`);
    }, 300);
  }

  async handle(req, res) {
    const head = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    const url = new URL(req.url, 'http://x');
    const m = /^\/m\/([a-z0-9]+)\/(.*)$/.exec(url.pathname);
    if (req.method !== 'GET' || !m || m[1] !== this.key()) {
      res.writeHead(404, { ...head, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ShotReady phone view: open the full link shown in ShotReady, Settings > Phone view.');
      return;
    }
    const path = m[2];
    if (path === '') {
      res.writeHead(200, {
        ...head, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      });
      res.end(readFileSync(join(this.dir, 'mobile.html')));
    } else if (path === 'mobile.js') {
      res.writeHead(200, { ...head, 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(readFileSync(join(this.dir, 'mobile.js')));
    } else if (path === 'view.json') {
      res.writeHead(200, { ...head, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.view()));
    } else if (path === 'events') {
      res.writeHead(200, { ...head, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(`retry: 2000\nevent: view\ndata: ${JSON.stringify(this.view())}\n\n`);
      this.events.add(res);
      this.emit('viewers', this.events.size);
      // A comment now and then keeps Wi-Fi and phone networks from dropping a quiet connection.
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      res.on('close', () => { clearInterval(ping); this.events.delete(res); this.emit('viewers', this.events.size); });
    } else if (/^feed\/.+\.mjpeg$/.test(path)) {
      await this.feed(decodeURIComponent(path.slice(5, -6)), Number(url.searchParams.get('fps')) || 5, req, res, head);
    } else {
      res.writeHead(404, head);
      res.end();
    }
  }

  // One camera's pictures to one phone: the latest frame, at most fps a second.
  async feed(body, fps, req, res, head) {
    const base = (await this.feedBase())[body];
    if (!base) { res.writeHead(404, head); res.end(); return; }
    const gap = 1000 / Math.max(1, Math.min(25, fps));
    res.writeHead(200, { ...head, 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}` });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    this.feeds.add(res);
    let latest = null;
    const send = setInterval(() => {
      // A phone that cannot keep up skips frames, so its picture stays current instead of lagging.
      if (latest && !res.writableNeedDrain) { res.write(latest); latest = null; }
    }, gap);
    const up = httpGet(`${base}/${encodeURIComponent(body)}.mjpeg`, (stream) => {
      if (stream.statusCode !== 200) { stream.resume(); res.end(); return; }
      stream.on('data', partSplitter((part) => { latest = part; }));
      stream.on('end', () => res.end());
    });
    up.on('error', () => res.end());
    res.on('close', () => { clearInterval(send); up.destroy(); this.feeds.delete(res); });
  }
}
