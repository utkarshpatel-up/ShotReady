// A stand-in for a camera's IP video stream, for the tests and the demo: an MP4 clip's H.264 sent
// over UDP the ways a camera sends it (MPEG-2 transport stream over UDP, the same in RTP, or H.264
// straight in RTP), in real time and looped.
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { readMp4 } from '../core/mp4.mjs';

const START = Buffer.from([0, 0, 0, 1]);

// The clip's pictures as Annex B, each key frame led by the SPS and PPS from the MP4's avcC.
export async function annexBPictures(file) {
  const b = readFileSync(file);
  const { video } = await readMp4(async (o, l) => b.subarray(o, o + l), b.length);
  if (!video || video.entryType !== 'avc1') throw new Error('the clip has no H.264 video');
  const c = Buffer.from(video.description);
  const params = [];
  let i = 6;
  for (let n = c[5] & 0x1f; n > 0; n--) { const len = c.readUInt16BE(i); params.push(c.subarray(i + 2, i + 2 + len)); i += 2 + len; }
  for (let n = c[i++]; n > 0; n--) { const len = c.readUInt16BE(i); params.push(c.subarray(i + 2, i + 2 + len)); i += 2 + len; }
  const lengthSize = (c[4] & 3) + 1;
  const pictures = [];
  for (let s = 0; s < video.count; s++) {
    const sample = b.subarray(video.offsets[s], video.offsets[s] + video.sizes[s]);
    const units = [];
    for (let o = 0; o + lengthSize <= sample.length;) {
      const len = sample.readUIntBE(o, lengthSize);
      units.push(sample.subarray(o + lengthSize, o + lengthSize + len));
      o += lengthSize + len;
    }
    const key = video.isKey(s);
    pictures.push({ data: Buffer.concat([...(key ? params : []), ...units].flatMap((u) => [START, u])), key, duration: video.durations[s] / video.timescale });
  }
  return pictures;
}

// ---------- MPEG-2 transport stream ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const x of buf) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ x) & 0xff]) >>> 0; return c; };
const PMT_PID = 0x1000, VIDEO_PID = 0x100;

function psiPacket(pid, table, cc) {
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(table));
  const body = Buffer.concat([Buffer.from([0]), table, crc]);
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47; p[1] = 0x40 | (pid >> 8); p[2] = pid & 0xff; p[3] = 0x10 | (cc & 0x0f);
  body.copy(p, 4);
  return p;
}
const pat = (cc) => psiPacket(0, Buffer.from([0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]), cc);
const pmt = (cc) => psiPacket(PMT_PID, Buffer.from([0x02, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0, 0x1b, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0]), cc);

export function tsMuxer() {
  let cc = 0, psiCc = 0;
  return ({ data, key }, pts90k) => {
    const out = [];
    if (key) { out.push(pat(psiCc), pmt(psiCc)); psiCc++; }
    const ts = Buffer.from([0x21 | ((pts90k / 2 ** 29) & 0x0e), (pts90k / 2 ** 22) & 0xff, ((pts90k / 2 ** 14) & 0xfe) | 1, (pts90k / 2 ** 7) & 0xff, ((pts90k * 2) & 0xfe) | 1]);
    const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]), ts, data]);
    for (let o = 0, first = true; o < pes.length; first = false) {
      const p = Buffer.alloc(188, 0xff);
      p[0] = 0x47; p[1] = (first ? 0x40 : 0) | (VIDEO_PID >> 8); p[2] = VIDEO_PID & 0xff;
      const left = pes.length - o;
      if (left >= 184) {
        p[3] = 0x10 | (cc++ & 0x0f);
        pes.copy(p, 4, o, o + 184);
        o += 184;
      } else {
        // The last part is padded with an adaptation field of stuffing.
        p[3] = 0x30 | (cc++ & 0x0f);
        const af = 183 - left;
        p[4] = af;
        if (af > 0) { p[5] = 0; }
        pes.copy(p, 5 + af, o);
        o = pes.length;
      }
      out.push(p);
    }
    return Buffer.concat(out);
  };
}

// ---------- RTP ----------
function rtp(type, seq, time, marker, payload) {
  const h = Buffer.alloc(12);
  h[0] = 0x80; h[1] = (marker ? 0x80 : 0) | type;
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(time >>> 0, 4);
  h.writeUInt32BE(0x5a5a1234, 8);
  return Buffer.concat([h, payload]);
}

// H.264 into RTP datagrams (RFC 6184): small NAL units whole, large ones split into FU-A.
export function h264RtpPackets(data, time, seq, mtu = 1400) {
  const units = [];
  for (let i = 0, prev = -1; i <= data.length; i++) {
    const at = i + 3 <= data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (at || i === data.length) {
      if (prev >= 0) { let e = i; while (e > prev && data[e - 1] === 0) e--; units.push(data.subarray(prev, e)); }
      if (at) { prev = i + 3; i += 2; }
    }
  }
  const out = [];
  units.forEach((u, n) => {
    const last = n === units.length - 1;
    if (u.length <= mtu) { out.push(rtp(96, seq++, time, last, u)); return; }
    for (let o = 1; o < u.length; o += mtu) {
      const end = o + mtu >= u.length;
      const head = Buffer.from([(u[0] & 0xe0) | 28, (o === 1 ? 0x80 : 0) | (end ? 0x40 : 0) | (u[0] & 0x1f)]);
      out.push(rtp(96, seq++, time, last && end, Buffer.concat([head, u.subarray(o, o + mtu)])));
    }
  });
  return { packets: out, seq };
}

/**
 * Sends the clip to host:port, looped, until stop().
 * @param mode 'ts' (transport stream over UDP), 'ts-rtp' (the same in RTP) or 'h264-rtp'
 */
export async function startIpVideoSender({ host = '127.0.0.1', port, file, mode = 'ts' }) {
  const pictures = await annexBPictures(file);
  const socket = createSocket('udp4');
  const mux = tsMuxer();
  let n = 0, seq = 0, stopped = false, timer = null, pts = 0;
  const sendOne = () => {
    if (stopped) return;
    const pic = pictures[n % pictures.length];
    n++;
    const time = Math.round(pts * 90000);
    if (mode === 'h264-rtp') {
      const r = h264RtpPackets(pic.data, time, seq);
      seq = r.seq;
      for (const p of r.packets) socket.send(p, port, host);
    } else {
      const ts = mux(pic, time);
      for (let o = 0; o < ts.length; o += 7 * 188) {
        const chunk = ts.subarray(o, Math.min(ts.length, o + 7 * 188));
        socket.send(mode === 'ts-rtp' ? rtp(33, seq++, time, false, chunk) : chunk, port, host);
      }
    }
    pts += pic.duration;
    timer = setTimeout(sendOne, pic.duration * 1000);
    timer.unref?.();
  };
  sendOne();
  return { stop() { stopped = true; clearTimeout(timer); socket.close(); }, pictures };
}
