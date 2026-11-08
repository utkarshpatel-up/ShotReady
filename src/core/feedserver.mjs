// Hands camera pictures to the screen. Each camera is a picture stream on a local address that
// the interface shows in an <img>, which the browser draws as fast as frames arrive. Listens on
// 127.0.0.1 only, behind a random per-run key, and checks the Host header so a web page cannot
// reach it from outside the app. A browser keeps at most 6 connections to one address, and each
// watched camera holds one open, so the pictures are spread over several ports.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const BOUNDARY = 'shotreadyframe';
const FRESH_MS = 2000;
const PORTS = 4;

export class FeedServer {
  /** @param on { onViewers(body, count) } called whenever a camera gains or loses a viewer */
  constructor(on = {}) {
    this.on = on;
    this.key = randomBytes(12).toString('hex');
    this.clients = new Map(); // body -> Set of responses
    this.latest = new Map();  // body -> { part, at }
    this.servers = [];
    this.ports = [];
    this.starting = null;
  }

  start() {
    this.starting ||= (async () => {
      for (let i = 0; i < PORTS; i++) {
        const server = createServer((req, res) => this.handle(req, res));
        await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
        this.servers.push(server);
        this.ports.push(server.address().port);
      }
      return this.bases();
    })();
    return this.starting;
  }

  // One base address per port. Camera number n uses bases[n % bases.length].
  bases() { return this.ports.map((port) => `http://127.0.0.1:${port}/feed/${this.key}`); }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const match = url.pathname.match(/^\/feed\/([0-9a-f]+)\/(.+)\.mjpeg$/);
    if (req.method !== 'GET' || !this.ports.some((port) => req.headers.host === `127.0.0.1:${port}`) || !match || match[1] !== this.key) {
      res.writeHead(404).end();
      return;
    }
    const body = decodeURIComponent(match[2]);
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
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

  stop() {
    for (const set of this.clients.values()) for (const res of set) res.destroy();
    this.clients.clear();
    for (const server of this.servers) { server.close(); server.closeAllConnections?.(); }
    this.servers = [];
    this.ports = [];
    this.starting = null;
  }
}
