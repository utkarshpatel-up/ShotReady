// Focus state from the camera's metadata stream (meta.cgi, MessagePack). The camera pushes the
// focus guide: a box position and how close to focus it is. GET only.
import { httpGet } from './http.mjs';
import { decodeMsgpack, decodeMsgpackPrefix } from './msgpack.mjs';

const clamp = (n) => Math.max(0, Math.min(1, n));

// Turns the camera's metadata into what the screen needs. Coordinates are 0..10000 across the
// picture and the box is given by its centre, so they become fractions of the picture from the
// top left. focused is true only at level 2 (the spec: 2 is in focus), and null when the camera
// gives no focus guide at all, for example in auto focus.
export function normalizeFocus(meta) {
  const g = Array.isArray(meta?.fguide) ? meta.fguide[0] : null;
  if (!g || !g.status || !g.pos) return { guide: false, focused: null, level: null, angle: null, dir: null, box: null };
  const { x, y, w, h } = g.pos;
  const left = clamp((x - w / 2) / 10000), top = clamp((y - h / 2) / 10000);
  return {
    guide: true,
    focused: g.level >= 2,
    level: g.level,
    angle: g.angle,
    dir: g.dir,
    box: { x: left, y: top, w: Math.min(w / 10000, 1 - left), h: Math.min(h / 10000, 1 - top) },
  };
}

const CONNECT_TIMEOUT_MS = 4000;
const VERIFY_MS = 2000;
const RETRY_MS = 1500;

export class FocusStream {
  /**
   * @param url     full meta.cgi URL without the query
   * @param getAuth returns the current login, or null
   * @param on      { onMeta(metadata), onDown(reason) }
   */
  constructor(url, getAuth, on) {
    Object.assign(this, { url, getAuth, on });
    this.stopped = false;
    this.meta = {};
    this.run();
  }

  async run() {
    while (!this.stopped) {
      try {
        await this.once();
        this.drop('stream ended');
      } catch (e) {
        if (this.stopped) return;
        this.drop(e.message);
      }
      if (this.stopped) return;
      await new Promise((r) => { this.retry = setTimeout(r, RETRY_MS); this.retry.unref?.(); });
    }
  }

  drop(reason) {
    this.meta = {};
    if (!this.stopped) this.on.onDown?.(reason);
  }

  async once() {
    const abort = new AbortController();
    this.abort = abort;
    const guard = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
    let res;
    try {
      res = await httpGet(`${this.url}?type=stream`, this.getAuth(), CONNECT_TIMEOUT_MS, abort.signal);
    } finally {
      clearTimeout(guard);
    }
    const status = res.headers.get('livescope-status');
    if (!res.ok || (status && status !== '0') || !/msgpack/i.test(res.headers.get('content-type') || '')) {
      abort.abort();
      throw new Error(`no focus data (HTTP ${res.status}, status ${status})`);
    }
    // The camera sends only changes. If the network dies without a clean close, silence looks
    // the same as "nothing changed", so a quick read of the latest state runs alongside.
    const verify = setInterval(() => this.verify(abort), VERIFY_MS);
    verify.unref?.();
    try {
      const reader = res.body.getReader();
      let buf = Buffer.alloc(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.stopped) return;
        buf = Buffer.concat([buf, Buffer.from(value)]);
        for (;;) {
          const got = decodeMsgpackPrefix(buf);
          if (!got) break;
          buf = buf.subarray(got.length);
          this.apply(got.value);
        }
      }
    } finally {
      clearInterval(verify);
    }
  }

  apply(msg) {
    this.meta = { ...this.meta, ...msg };
    this.on.onMeta(this.meta);
  }

  async verify(abort) {
    try {
      const res = await httpGet(`${this.url}?type=once`, this.getAuth(), 2000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const latest = decodeMsgpack(Buffer.from(await res.arrayBuffer()));
      if (JSON.stringify(latest.fguide) !== JSON.stringify(this.meta.fguide)) this.apply(latest);
    } catch {
      abort.abort(); // The stream ends, the loop reconnects, and the picture shows no focus data meanwhile.
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.abort?.abort();
  }
}
