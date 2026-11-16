// A small RTMP server on this computer. It takes one live stream the way YouTube or Zoom would and
// says what arrived: used by the Stream tab's "Test on this computer", by demo mode and by the
// tests. It can also keep what it received as an FLV file, which VLC plays.
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { EventEmitter } from 'node:events';
import { ChunkReader, chunkMessage, amfEncode, amfDecode, MSG } from '../core/rtmp.mjs';

export class RtmpTestServer extends EventEmitter {
  /** @param o.key  when set, only this stream key is accepted. @param o.file()  path to keep the stream in (FLV), or nothing */
  constructor(o = {}) {
    super();
    this.o = o;
    this.reset();
    this.server = net.createServer((sock) => this.#client(sock));
  }

  reset() {
    this.stats = { connected: false, publishing: false, app: '', key: '', meta: null, videoConfig: null, audioConfig: null, frames: 0, keyFrames: 0, audioFrames: 0, bytes: 0, firstMs: null, lastMs: 0, lastVideoMs: -1, backwards: 0, file: null };
  }

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }

  get url() { return `rtmp://127.0.0.1:${this.port}/live`; }

  close() {
    this.sock?.destroy();
    this.out?.end();
    return new Promise((r) => this.server.close(() => r()));
  }

  #client(sock) {
    this.sock?.destroy();
    this.out?.end();
    this.out = null;
    this.sock = sock;
    this.reset();
    const st = this.stats;
    st.connected = true;
    const reader = new ChunkReader();
    let shaken = 0, buf = Buffer.alloc(0), chunk = 128;
    const send = (csid, type, payload, streamId = 0) => sock.write(chunkMessage({ csid, type, streamId, payload }, chunk));
    const u32 = (n, extra = []) => { const b = Buffer.alloc(4 + extra.length); b.writeUInt32BE(n); extra.forEach((v, i) => { b[4 + i] = v; }); return b; };
    const tag = (type, ms, body) => {
      if (!this.out) return;
      const h = Buffer.alloc(11);
      h[0] = type;
      h.writeUIntBE(body.length, 1, 3);
      h.writeUIntBE(ms & 0xffffff, 4, 3);
      h[7] = (ms >>> 24) & 0xff;
      this.out.write(h);
      this.out.write(body);
      this.out.write(u32(11 + body.length));
    };

    const onMessage = (m) => {
      if (m.type === MSG.COMMAND) {
        const [name, id, , ...args] = amfDecode(m.payload);
        if (name === 'connect') {
          st.app = amfDecode(m.payload)[2]?.app || '';
          send(2, MSG.WINDOW, u32(2500000));
          send(2, MSG.PEER_BW, u32(2500000, [2]));
          send(2, MSG.CHUNK_SIZE, u32(4096));
          chunk = 4096;
          send(3, MSG.COMMAND, amfEncode('_result', id, { fmsVer: 'FMS/3,5,7,7009', capabilities: 31 }, { level: 'status', code: 'NetConnection.Connect.Success', description: 'Connection succeeded.', objectEncoding: 0 }));
        } else if (name === 'createStream') {
          send(3, MSG.COMMAND, amfEncode('_result', id, null, 1));
        } else if (name === 'publish') {
          st.key = String(args[0] || '');
          if (this.o.key && st.key !== this.o.key) {
            send(5, MSG.COMMAND, amfEncode('onStatus', 0, null, { level: 'error', code: 'NetStream.Publish.BadName', description: 'Wrong stream key.' }), 1);
            setTimeout(() => sock.destroy(), 50);
            return;
          }
          const file = this.o.file?.();
          if (file) {
            this.out = createWriteStream(file);
            this.out.on('error', () => { this.out = null; });
            this.out.write(Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]));
            st.file = file;
          }
          st.publishing = true;
          send(5, MSG.COMMAND, amfEncode('onStatus', 0, null, { level: 'status', code: 'NetStream.Publish.Start', description: 'Publishing.' }), 1);
          this.emit('publish', st);
        }
      } else if (m.type === MSG.DATA) {
        const d = amfDecode(m.payload);
        const at = d.indexOf('onMetaData');
        if (at >= 0) st.meta = d[at + 1];
        tag(18, 0, amfEncode('onMetaData', new Map(Object.entries(st.meta || {}))));
      } else if (m.type === MSG.VIDEO || m.type === MSG.AUDIO) {
        st.bytes += m.payload.length;
        const config = m.payload[1] === 0;
        if (m.type === MSG.VIDEO) {
          if (config) st.videoConfig = Buffer.from(m.payload.subarray(5));
          else {
            st.frames++;
            if (m.payload[0] >> 4 === 1) st.keyFrames++;
            if (m.timestamp < st.lastVideoMs) st.backwards++;
            st.lastVideoMs = m.timestamp;
          }
        } else if (config) st.audioConfig = Buffer.from(m.payload.subarray(2));
        else st.audioFrames++;
        if (!config) { st.firstMs ??= m.timestamp; st.lastMs = Math.max(st.lastMs, m.timestamp); }
        tag(m.type, m.timestamp, m.payload);
      }
    };

    sock.on('data', (d) => {
      try {
        if (shaken < 2) {
          buf = Buffer.concat([buf, d]);
          if (shaken === 0) {
            if (buf.length < 1537) return;
            // S0 + S1 + S2 (C1 echoed).
            sock.write(Buffer.concat([Buffer.from([3]), Buffer.alloc(8), randomBytes(1528), buf.subarray(1, 1537)]));
            buf = buf.subarray(1537);
            shaken = 1;
          }
          if (buf.length < 1536) return;
          d = buf.subarray(1536);
          buf = null;
          shaken = 2;
          if (!d.length) return;
        }
        for (const m of reader.push(d)) onMessage(m);
      } catch (e) {
        this.emit('problem', e.message);
        sock.destroy();
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.sock !== sock) return;
      st.connected = false;
      st.publishing = false;
      this.out?.end();
      this.out = null;
      this.emit('end', st);
    });
  }
}
