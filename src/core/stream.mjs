// Push updates from a camera: info.cgi?type=stream (XC spec 3.2.2.1). The camera sends every
// item first, then only what changed, as multipart/x-mixed-replace parts. GET only.
import { httpGet } from './http.mjs';
import { parseInfo } from './engine.mjs';

// Splits a multipart byte stream into part bodies. Chunks can break anywhere, including inside
// a multi-byte character, so this works on bytes and uses Content-Length when it is present.
export class MultipartParser {
  constructor(boundary) {
    this.mark = Buffer.from(`--${boundary}`);
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const parts = [];
    for (;;) {
      const start = this.buf.indexOf(this.mark);
      if (start < 0) break;
      const after = start + this.mark.length;
      if (this.buf.length < after + 2) break;
      if (this.buf.subarray(after, after + 2).toString() === '--') { this.buf = this.buf.subarray(after + 2); break; }
      const headEnd = this.buf.indexOf('\r\n\r\n', after);
      const altEnd = this.buf.indexOf('\n\n', after);
      const useAlt = altEnd >= 0 && (headEnd < 0 || altEnd < headEnd);
      if (headEnd < 0 && !useAlt) break;
      const bodyStart = useAlt ? altEnd + 2 : headEnd + 4;
      const length = this.buf.subarray(after, bodyStart).toString().match(/content-length:\s*(\d+)/i);
      let bodyEnd;
      if (length) {
        bodyEnd = bodyStart + Number(length[1]);
        if (this.buf.length < bodyEnd) break;
      } else {
        bodyEnd = this.buf.indexOf(this.mark, bodyStart);
        if (bodyEnd < 0) break;
      }
      parts.push(this.buf.subarray(bodyStart, bodyEnd).toString('utf8'));
      this.buf = this.buf.subarray(bodyEnd);
    }
    return parts;
  }
}

const CONNECT_TIMEOUT_MS = 4000;
const RETRY_MS = 2000;
const RETRY_REFUSED_MS = 30000; // The camera is at its client limit: leave room for RCCA.

export class CameraStream {
  /**
   * @param url       full info.cgi URL without the query
   * @param getAuth   returns the current login, or null
   * @param on        { update(items), up(), down(reason, { refused }) }
   */
  constructor(url, getAuth, on) {
    Object.assign(this, { url: `${url}?type=stream`, getAuth, on });
    this.stopped = false;
    this.connected = false;
    this.run();
  }

  async run() {
    while (!this.stopped) {
      let wait = RETRY_MS;
      try {
        await this.once();
        this.drop('stream ended');
      } catch (e) {
        if (this.stopped) return;
        if (e.refused) wait = RETRY_REFUSED_MS;
        this.drop(e.message, e.refused);
      }
      if (this.stopped) return;
      await new Promise((r) => { this.retryTimer = setTimeout(r, wait); this.retryTimer.unref?.(); });
    }
  }

  drop(reason, refused = false) {
    const was = this.connected;
    this.connected = false;
    if (!this.stopped) this.on.down(reason, { refused, wasConnected: was });
  }

  async once() {
    const abort = new AbortController();
    this.abort = abort;
    const guard = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
    let res;
    try {
      res = await httpGet(this.url, this.getAuth(), CONNECT_TIMEOUT_MS, abort.signal);
    } finally {
      clearTimeout(guard);
    }
    const status = res.headers.get('livescope-status');
    const type = res.headers.get('content-type') || '';
    const boundary = type.match(/boundary="?([^";]+)"?/i)?.[1];
    if (!res.ok || (status && status !== '0') || !/multipart/i.test(type) || !boundary) {
      abort.abort();
      const err = new Error(status && status !== '0' ? `camera refused the stream (status ${status})` : `no stream (HTTP ${res.status})`);
      err.refused = true;
      throw err;
    }
    this.connected = true;
    this.on.up();
    const parser = new MultipartParser(boundary);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || this.stopped) return;
      for (const part of parser.push(Buffer.from(value))) {
        const items = parseInfo(part);
        delete items.timestamp;
        delete items.realtime;
        if (Object.keys(items).length) this.on.update(items);
      }
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.abort?.abort();
  }
}
