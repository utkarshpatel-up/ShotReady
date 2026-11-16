// RTMP and RTMPS, the way YouTube, Zoom Webinars/Events and most streaming services take a live
// stream: H.264 video and AAC sound inside FLV messages, over one TCP (or TLS) connection.
//
// Three parts: AMF0 (how commands are written), the chunk layer (how messages are cut up on the
// wire), and RtmpPublisher (connect, publish, then send pictures and sound). The chunk layer is
// also used by the test server in src/sim/rtmp-server.mjs.
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

// ---------- AMF0 ----------
export function amfEncode(...values) {
  const parts = [];
  const str = (s) => { const b = Buffer.from(String(s), 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); parts.push(l, b); };
  const props = (o) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) continue; str(k); put(v); } parts.push(Buffer.from([0, 0, 9])); };
  const put = (v) => {
    if (typeof v === 'number') { const b = Buffer.alloc(9); b.writeDoubleBE(v, 1); parts.push(b); }
    else if (typeof v === 'boolean') parts.push(Buffer.from([1, v ? 1 : 0]));
    else if (typeof v === 'string') { parts.push(Buffer.from([2])); str(v); }
    else if (v === null || v === undefined) parts.push(Buffer.from([5]));
    else if (v instanceof Map) { const b = Buffer.alloc(5); b[0] = 8; b.writeUInt32BE(v.size, 1); parts.push(b); props(Object.fromEntries(v)); } // ECMA array
    else { parts.push(Buffer.from([3])); props(v); }
  };
  values.forEach(put);
  return Buffer.concat(parts);
}

export function amfDecode(buf) {
  let at = 0;
  const str = (long) => { const n = long ? buf.readUInt32BE(at) : buf.readUInt16BE(at); at += long ? 4 : 2; const s = buf.toString('utf8', at, at + n); at += n; return s; };
  const props = () => {
    const o = {};
    for (;;) {
      if (at + 3 > buf.length) break;
      if (buf[at] === 0 && buf[at + 1] === 0 && buf[at + 2] === 9) { at += 3; break; }
      const k = str(false);
      o[k] = get();
    }
    return o;
  };
  const get = () => {
    const t = buf[at++];
    switch (t) {
      case 0: { const v = buf.readDoubleBE(at); at += 8; return v; }
      case 1: return buf[at++] !== 0;
      case 2: return str(false);
      case 3: return props();
      case 5: case 6: return null;
      case 8: at += 4; return props();
      case 10: { const n = buf.readUInt32BE(at); at += 4; return Array.from({ length: n }, get); }
      case 11: { const v = buf.readDoubleBE(at); at += 10; return v; }
      case 12: return str(true);
      default: throw new Error(`AMF type ${t} is not understood`);
    }
  };
  const out = [];
  while (at < buf.length) out.push(get());
  return out;
}

// ---------- the chunk layer ----------
export const MSG = { CHUNK_SIZE: 1, ABORT: 2, ACK: 3, USER: 4, WINDOW: 5, PEER_BW: 6, AUDIO: 8, VIDEO: 9, DATA: 18, COMMAND: 20 };

/** One message, cut into chunks of at most `chunkSize` bytes. Always a full (type 0) header. */
export function chunkMessage({ csid, type, streamId = 0, timestamp = 0, payload }, chunkSize) {
  const ts = Math.max(0, Math.floor(timestamp)) >>> 0;
  const ext = ts >= 0xffffff;
  const head = Buffer.alloc(12 + (ext ? 4 : 0));
  head[0] = csid & 0x3f;
  head.writeUIntBE(ext ? 0xffffff : ts, 1, 3);
  head.writeUIntBE(payload.length, 4, 3);
  head[7] = type;
  head.writeUInt32LE(streamId, 8);
  if (ext) head.writeUInt32BE(ts, 12);
  const parts = [head];
  for (let at = 0; at < payload.length || at === 0; at += chunkSize) {
    if (at > 0) {
      // A continuation chunk: one byte, and the long timestamp again when the message has one.
      const c = Buffer.alloc(1 + (ext ? 4 : 0));
      c[0] = 0xc0 | (csid & 0x3f);
      if (ext) c.writeUInt32BE(ts, 1);
      parts.push(c);
    }
    parts.push(payload.subarray(at, at + chunkSize));
    if (!payload.length) break;
  }
  return Buffer.concat(parts);
}

/** Puts chunks back together into messages. push(bytes) returns the messages that are complete. */
export class ChunkReader {
  constructor() {
    this.chunkSize = 128;
    this.buf = Buffer.alloc(0);
    this.streams = new Map();
    this.received = 0;
  }

  push(data) {
    this.received += data.length;
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    const out = [];
    for (;;) {
      const m = this.#chunk();
      if (m === false) break;
      if (m) {
        if (m.type === MSG.CHUNK_SIZE && m.payload.length >= 4) this.chunkSize = Math.max(1, m.payload.readUInt32BE(0) & 0x7fffffff);
        out.push(m);
      }
    }
    return out;
  }

  // One chunk from the front of the buffer. false: not all there yet. null: taken, message not complete.
  #chunk() {
    const b = this.buf;
    if (b.length < 1) return false;
    const fmt = b[0] >> 6;
    let csid = b[0] & 0x3f, at = 1;
    if (csid === 0) { if (b.length < 2) return false; csid = 64 + b[1]; at = 2; }
    else if (csid === 1) { if (b.length < 3) return false; csid = 64 + b[1] + b[2] * 256; at = 3; }
    const need = [11, 7, 3, 0][fmt];
    if (b.length < at + need) return false;
    let s = this.streams.get(csid);
    if (!s) { s = { ts: 0, delta: 0, len: 0, type: 0, streamId: 0, ext: false, parts: [], got: 0 }; this.streams.set(csid, s); }
    const fresh = s.got === 0;
    let field = null;
    if (fmt <= 2) field = b.readUIntBE(at, 3);
    if (fmt <= 1) { s.len = b.readUIntBE(at + 3, 3); s.type = b[at + 6]; }
    if (fmt === 0) s.streamId = b.readUInt32LE(at + 7);
    at += need;
    let ext = fmt === 3 ? s.ext : field === 0xffffff;
    if (ext) {
      if (b.length < at + 4) return false;
      field = b.readUInt32BE(at);
      at += 4;
    }
    const want = Math.min(this.chunkSize, s.len - s.got);
    if (b.length < at + want) return false;
    // All of this chunk is here: now it may change what is remembered.
    if (fmt <= 2) s.ext = ext;
    if (fresh) {
      if (fmt === 0) { s.ts = field; s.delta = 0; }
      else if (fmt <= 2) { s.delta = field; s.ts = (s.ts + field) >>> 0; }
      else s.ts = (s.ts + s.delta) >>> 0;
    }
    s.parts.push(b.subarray(at, at + want));
    s.got += want;
    this.buf = b.subarray(at + want);
    if (s.got < s.len) return null;
    const payload = s.parts.length === 1 ? s.parts[0] : Buffer.concat(s.parts);
    s.parts = [];
    s.got = 0;
    return { csid, type: s.type, streamId: s.streamId, timestamp: s.ts, payload };
  }
}

// ---------- FLV message bodies ----------
/** A picture: `avcc` is the H.264 setup (avcC) when `config` is set, else the frame's length-prefixed NAL units. */
export function flvVideo(data, { key = false, config = false, offset = 0 } = {}) {
  const b = Buffer.alloc(5 + data.length);
  b[0] = (key || config ? 0x10 : 0x20) | 7; // key or inter frame, AVC
  b[1] = config ? 0 : 1;
  b.writeIntBE(offset, 2, 3); // composition time: frames are sent in display order, so 0
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(b, 5);
  return b;
}

/** Sound: `data` is the AAC setup (AudioSpecificConfig) when `config` is set, else one raw AAC frame. */
export function flvAudio(data, { config = false } = {}) {
  const b = Buffer.alloc(2 + data.length);
  b[0] = 0xaf; // AAC, 44 kHz flag (always set for AAC), 16-bit, stereo
  b[1] = config ? 0 : 1;
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(b, 2);
  return b;
}

/** rtmp[s]://host[:port]/app[/more] and a stream key. A key left in the URL's last part is taken from there. */
export function parseRtmpUrl(url, key = '') {
  const m = /^(rtmps?):\/\/([^/:\s]+)(?::(\d+))?\/(.+?)\/?$/i.exec(String(url || '').trim());
  if (!m) throw new Error('The server address must look like rtmp://server/app or rtmps://server/app');
  const secure = m[1].toLowerCase() === 'rtmps';
  let app = m[4];
  let streamKey = String(key || '').trim();
  if (!streamKey) {
    const cut = app.lastIndexOf('/');
    if (cut < 0) throw new Error('The stream key is missing');
    streamKey = app.slice(cut + 1);
    app = app.slice(0, cut);
  }
  const port = Number(m[3]) || (secure ? 443 : 1935);
  const host = m[2];
  return { secure, host, port, app, key: streamKey, tcUrl: `${m[1].toLowerCase()}://${host}${m[3] ? `:${port}` : ''}/${app}` };
}

const FAILURES = {
  'NetStream.Publish.BadName': 'the stream key was not accepted, or that stream is already live',
  'NetStream.Publish.Denied': 'the server refused the stream (check the stream key)',
  'NetConnection.Connect.Rejected': 'the server refused the connection (check the address and the stream key)',
  'NetConnection.Connect.InvalidApp': 'the server does not know that address (check the part after the server name)',
};

/**
 * One live stream to one server.
 *   const p = new RtmpPublisher({ url, key });  await p.connect();  p.metadata({ width, ... });
 *   p.videoConfig(avcC); p.audioConfig(asc); p.video(ms, bytes, key); p.audio(ms, bytes); p.close();
 * Events: 'close' (why) once the connection is gone after it was live.
 * When the network cannot keep up, pictures are left out until the next key frame (p.dropped counts
 * them): sound keeps going and the stream stays close to live instead of falling behind.
 */
export class RtmpPublisher extends EventEmitter {
  constructor({ url, key, meta = {}, connectMs = 10000, maxBacklogBytes = 3e6 }) {
    super();
    this.target = parseRtmpUrl(url, key);
    this.meta = meta;
    this.connectMs = connectMs;
    this.maxBacklog = maxBacklogBytes;
    this.reader = new ChunkReader();
    this.outChunk = 128;
    this.window = 2500000;
    this.acked = 0;
    this.streamId = 0;
    this.live = false;
    this.closed = false;
    this.sent = 0;
    this.dropped = 0;
    this.waitKey = true;
    this.pending = new Map();
    this.tx = 0;
    // Rejects when the connection dies, so no step of connecting waits for ever.
    this.dead = new Promise((_, reject) => { this.kill = reject; });
    this.dead.catch(() => {});
  }

  #write(buf) { this.sent += buf.length; return this.socket.write(buf); }

  #send(csid, type, payload, streamId = 0, timestamp = 0) {
    return this.#write(chunkMessage({ csid, type, streamId, timestamp, payload }, this.outChunk));
  }

  #command(name, ...args) {
    const id = ++this.tx;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.#send(3, MSG.COMMAND, amfEncode(name, id, ...args), name === 'publish' ? this.streamId : 0);
    return done;
  }

  async connect() {
    const t = this.target;
    const timer = setTimeout(() => this.#fail(new Error(`no answer from ${t.host} in ${Math.round(this.connectMs / 1000)} seconds`)), this.connectMs);
    const alive = (step) => Promise.race([step, this.dead]);
    try {
      await alive(new Promise((resolve) => {
        const opts = { host: t.host, port: t.port };
        this.socket = t.secure ? tls.connect({ ...opts, servername: net.isIP(t.host) ? undefined : t.host }) : net.connect(opts);
        this.socket.setNoDelay(true);
        this.socket.once(t.secure ? 'secureConnect' : 'connect', resolve);
        this.socket.on('error', (e) => this.#fail(new Error(describeNet(e, t))));
        this.socket.on('close', () => this.#fail(new Error('the server closed the connection')));
      }));
      await alive(this.#handshake());
      this.socket.on('data', (d) => { try { this.#incoming(d); } catch (e) { this.#fail(e); } });
      if (this.early?.length) { const d = this.early; this.early = null; this.#incoming(d); }
      // Bigger chunks than the 128-byte default: less overhead on every picture.
      const size = Buffer.alloc(4);
      size.writeUInt32BE(4096);
      this.#send(2, MSG.CHUNK_SIZE, size);
      this.outChunk = 4096;
      await alive(this.#command('connect', { app: t.app, type: 'nonprivate', flashVer: 'FMLE/3.0 (compatible; ShotReady)', tcUrl: t.tcUrl }));
      // These two have no answer on some servers, so they are not waited for.
      this.#command('releaseStream', null, t.key).catch(() => {});
      this.#command('FCPublish', null, t.key).catch(() => {});
      const [, id] = await alive(this.#command('createStream', null));
      this.streamId = Number(id) || 1;
      const started = new Promise((resolve, reject) => { this.publishing = { resolve, reject }; });
      this.#command('publish', null, t.key, 'live').catch(() => {});
      await alive(started);
      this.live = true;
      if (Object.keys(this.meta).length) this.metadata(this.meta);
    } finally {
      clearTimeout(timer);
    }
    return this;
  }

  // The plain handshake: C0+C1, then S0+S1+S2 back, then C2 (S1 echoed).
  #handshake() {
    return new Promise((resolve, reject) => {
      this.dead.catch(reject);
      const c1 = Buffer.concat([Buffer.alloc(8), randomBytes(1528)]);
      this.socket.write(Buffer.concat([Buffer.from([3]), c1]));
      let got = Buffer.alloc(0);
      const onData = (d) => {
        got = Buffer.concat([got, d]);
        if (got.length < 1 + 1536 + 1536) return;
        this.socket.off('data', onData);
        if (got[0] !== 3) { reject(new Error('the server is not an RTMP server')); return; }
        this.socket.write(got.subarray(1, 1537));
        this.early = got.subarray(1 + 1536 + 1536);
        resolve();
      };
      this.socket.on('data', onData);
    });
  }

  #incoming(data) {
    for (const m of this.reader.push(data)) {
      if (m.type === MSG.WINDOW && m.payload.length >= 4) this.window = m.payload.readUInt32BE(0) || this.window;
      else if (m.type === MSG.USER && m.payload.length >= 6 && m.payload.readUInt16BE(0) === 6) {
        // A ping: answered with the same time, or the server hangs up.
        const pong = Buffer.alloc(6);
        pong.writeUInt16BE(7, 0);
        m.payload.copy(pong, 2, 2, 6);
        this.#send(2, MSG.USER, pong);
      } else if (m.type === MSG.COMMAND || m.type === 17) {
        this.#answer(amfDecode(m.type === 17 ? m.payload.subarray(1) : m.payload));
      }
    }
    // The server is told how much has been read, once per window.
    if (this.reader.received - this.acked >= this.window) {
      this.acked = this.reader.received;
      const ack = Buffer.alloc(4);
      ack.writeUInt32BE(this.acked >>> 0);
      this.#send(2, MSG.ACK, ack);
    }
  }

  #answer([name, id, ...rest]) {
    if (name === '_result' || name === '_error') {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (!p) return;
      if (name === '_result') p.resolve(rest);
      else p.reject(new Error(FAILURES[rest[1]?.code] || rest[1]?.description || rest[1]?.code || 'the server refused'));
    } else if (name === 'onStatus') {
      const info = rest[1] || {};
      if (info.code === 'NetStream.Publish.Start') this.publishing?.resolve();
      else if (info.level === 'error' || /BadName|Denied|Failed|Rejected/.test(info.code || '')) {
        const e = new Error(FAILURES[info.code] || info.description || info.code);
        if (this.live) this.#fail(e); else this.publishing?.reject(e);
      }
    }
  }

  #fail(e) {
    if (this.closed) return;
    this.closed = true;
    const wasLive = this.live;
    this.live = false;
    this.socket?.destroy();
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.publishing?.reject(e);
    this.kill(e);
    if (wasLive) this.emit('close', e.message);
  }

  /** Bytes waiting to go out: grows when the network is slower than the stream. */
  get backlog() { return this.socket?.writableLength || 0; }

  /** What the stream is (size, rates, codecs): told to the server once, before the first picture. */
  metadata(meta) {
    if (!this.live) return;
    this.#send(5, MSG.DATA, amfEncode('@setDataFrame', 'onMetaData', new Map(Object.entries(meta))), this.streamId);
  }

  videoConfig(avcc) {
    if (!this.live) return;
    this.#send(6, MSG.VIDEO, flvVideo(avcc, { config: true }), this.streamId, 0);
  }

  audioConfig(asc) {
    if (!this.live) return;
    this.#send(4, MSG.AUDIO, flvAudio(asc, { config: true }), this.streamId, 0);
  }

  /** One encoded picture. Returns false when it was left out because the network is behind. */
  video(ms, data, key) {
    if (!this.live) return false;
    if (this.backlog > this.maxBacklog) this.waitKey = true;
    if (this.waitKey) {
      if (!key || this.backlog > this.maxBacklog) { this.dropped++; return false; }
      this.waitKey = false;
    }
    this.#send(6, MSG.VIDEO, flvVideo(data, { key }), this.streamId, ms);
    return true;
  }

  audio(ms, data) {
    if (!this.live || this.backlog > this.maxBacklog * 2) return false;
    this.#send(4, MSG.AUDIO, flvAudio(data), this.streamId, ms);
    return true;
  }

  /** Ends the stream cleanly. */
  close() {
    if (this.closed) return;
    this.closed = true;
    const was = this.live;
    this.live = false;
    try {
      if (was) {
        this.#send(3, MSG.COMMAND, amfEncode('FCUnpublish', ++this.tx, null, this.target.key));
        this.#send(3, MSG.COMMAND, amfEncode('deleteStream', ++this.tx, null, this.streamId));
      }
      this.socket?.end();
    } catch { /* already gone */ }
    setTimeout(() => this.socket?.destroy(), 1500).unref?.();
  }
}

function describeNet(e, t) {
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return `${t.host} was not found: check the address, and that this computer is on the internet`;
  if (e.code === 'ECONNREFUSED') return `${t.host} refused the connection on port ${t.port}`;
  if (e.code === 'ETIMEDOUT' || e.code === 'ENETUNREACH' || e.code === 'EHOSTUNREACH') return `${t.host} could not be reached: check the internet connection`;
  if (/certificate|CERT|SSL|TLS/i.test(`${e.code} ${e.message}`)) return `the secure connection to ${t.host} failed (${e.message})`;
  return e.message;
}
