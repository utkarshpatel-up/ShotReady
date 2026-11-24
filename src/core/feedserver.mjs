// Hands one camera's pictures to the screen, as a picture stream on a local address that the
// interface shows in an <img>, which the browser draws as fast as frames arrive. Each camera's
// thread runs its own server. Listens on 127.0.0.1 only, behind a random per-run key, and checks
// the Host header so a web page cannot reach it from outside the app.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const BOUNDARY = 'shotreadyframe';
const FRESH_MS = 2000;
// The camera's own IP video (ipvideo.mjs), handed on as H.264: each picture is a 13-byte header
// (length, 1 for a key frame, its time in microseconds or -1) and the picture in Annex B.
const VIDEO_HEAD = 13;
const GOP_MAX = 32e6; // never keep more than this since the last key frame

export class FeedServer {
  /** @param on { onViewers(body, count), onVideoViewers(body, count) } called whenever a camera gains or loses a viewer */
  constructor(on = {}) {
    this.on = on;
    this.key = randomBytes(12).toString('hex');
    this.clients = new Map(); // body -> Set of responses
    this.latest = new Map();  // body -> { part, at }
    this.videoClients = new Map(); // body -> Set of responses for the H.264 stream
    this.gop = new Map();     // body -> { parts, bytes } since the last key frame
    this.server = null;
    this.port = 0;
    this.starting = null;
  }

  start() {
    this.starting ||= new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.base()); });
    });
    return this.starting;
  }

  base() { return `http://127.0.0.1:${this.port}/feed/${this.key}`; }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const match = url.pathname.match(/^\/feed\/([0-9a-f]+)\/(.+)\.(mjpeg|h264)$/);
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${this.port}` || !match || match[1] !== this.key) {
      res.writeHead(404).end();
      return;
    }
    const body = decodeURIComponent(match[2]);
    if (match[3] === 'h264') { this.handleVideo(req, res, body); return; }
    // The LUT view reads the feed with fetch from the app's own page (a file:// page, whose origin is
    // "null"), which needs permission to read it. Only that origin is given it; the per-run key and
    // the Host check above still keep everything else out.
    const origin = req.headers.origin;
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(origin === 'null' || origin === 'file://' ? { 'Access-Control-Allow-Origin': origin } : {}),
    });
    res.flushHeaders(); // the viewer is connected even before the first frame exists
    req.socket.setNoDelay(true);
    let set = this.clients.get(body);
    if (!set) this.clients.set(body, set = new Set());
    set.add(res);
    this.on.onViewers?.(body, set.size);
    // Something to show straight away, as long as it is not stale.
    const last = this.latest.get(body);
    if (last && Date.now() - last.at < FRESH_MS) res.write(last.part);
    res.on('close', () => {
      set.delete(res);
      this.on.onViewers?.(body, set.size);
    });
  }

  push(body, jpeg) {
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    const part = Buffer.concat([head, jpeg, Buffer.from('\r\n')]);
    this.latest.set(body, { part, at: Date.now() });
    for (const res of this.clients.get(body) || []) {
      // A viewer that cannot keep up skips frames, so the picture stays current instead of lagging.
      if (!res.writableNeedDrain) res.write(part);
    }
  }

  viewers(body) { return this.clients.get(body)?.size || 0; }

  // The H.264 stream: the pictures since the last key frame first, so decoding starts at once.
  handleVideo(req, res, body) {
    const origin = req.headers.origin;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(origin === 'null' || origin === 'file://' ? { 'Access-Control-Allow-Origin': origin } : {}),
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    let set = this.videoClients.get(body);
    if (!set) this.videoClients.set(body, set = new Set());
    set.add(res);
    this.on.onVideoViewers?.(body, set.size);
    for (const part of this.gop.get(body)?.parts || []) res.write(part);
    res.on('close', () => {
      set.delete(res);
      this.on.onVideoViewers?.(body, set.size);
    });
  }

  pushVideo(body, { data, key, pts }) {
    const head = Buffer.alloc(VIDEO_HEAD);
    head.writeUInt32BE(data.length, 0);
    head[4] = key ? 1 : 0;
    head.writeDoubleBE(pts == null ? -1 : pts, 5);
    const part = Buffer.concat([head, data]);
    let gop = this.gop.get(body);
    if (key || !gop || gop.bytes > GOP_MAX) this.gop.set(body, gop = { parts: [], bytes: 0 });
    if (key || gop.parts.length) { gop.parts.push(part); gop.bytes += part.length; }
    for (const res of this.videoClients.get(body) || []) {
      // H.264 cannot skip a picture and go on, so every picture is sent. A window that has fallen far
      // behind is cut off; it connects again and starts from the last key frame.
      if (res.writableLength > 64e6) res.destroy(); else res.write(part);
    }
  }

  videoViewers(body) { return this.videoClients.get(body)?.size || 0; }

  stop() {
    for (const set of [...this.clients.values(), ...this.videoClients.values()]) for (const res of set) res.destroy();
    this.clients.clear();
    this.videoClients.clear();
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    this.starting = null;
  }
}
