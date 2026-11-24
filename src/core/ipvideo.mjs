// A camera's own IP video stream (optional, per camera, Settings > IP video). The C80 can stream
// H.264 itself (Canon lists UDP, RTP, RTP+FEC, SRT and RTSP+RTP); set to UDP or RTP with this
// computer as the destination, it sends real video at a fraction of the bandwidth of single
// pictures. This takes the packets as they arrive and turns them back into whole pictures (access
// units) for the window to decode. Accepted, whichever the camera sends and found by looking:
//   - an MPEG-2 transport stream straight over UDP,
//   - the same transport stream inside RTP,
//   - H.264 packed straight into RTP (RFC 6184: single NAL units, STAP-A, FU-A).
// Nothing is sent to the camera. Lost packets show as a damaged picture until the next key frame.
import { createSocket } from 'node:dgram';

const TS = 188;
const START_CODE = Buffer.from([0, 0, 0, 1]);

// The RTP header of a datagram: where its payload starts and ends, or null when it is not RTP.
export function rtpHeader(buf) {
  if (buf.length < 12 || buf[0] === 0x47 || (buf[0] & 0xc0) !== 0x80) return null;
  let start = 12 + (buf[0] & 0x0f) * 4;
  if (buf[0] & 0x10) {
    if (buf.length < start + 4) return null;
    start += 4 + buf.readUInt16BE(start + 2) * 4;
  }
  const end = buf[0] & 0x20 ? buf.length - buf[buf.length - 1] : buf.length;
  if (start > end) return null;
  return { start, end, marker: !!(buf[1] & 0x80), type: buf[1] & 0x7f, seq: buf.readUInt16BE(2), time: buf.readUInt32BE(4) };
}

// The NAL units of an Annex B stream, as [type, start, end] (start is past the start code).
export function nalUnits(data) {
  const out = [];
  let i = 0, prev = -1;
  while (i + 3 <= data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const len = data[i + 2] === 1 ? 3 : 4;
      if (prev >= 0) out.push([data[prev] & 0x1f, prev, i]);
      i += len;
      prev = i;
    } else i++;
  }
  if (prev >= 0 && prev < data.length) out.push([data[prev] & 0x1f, prev, data.length]);
  // A start code's trailing zero belongs to the next unit, not to the end of this one.
  return out.map(([t, s, e]) => { while (e > s && data[e - 1] === 0) e--; return [t, s, e]; });
}

// A picture the decoder can start from: it holds an IDR slice.
export const isKeyframe = (data) => nalUnits(data).some(([t]) => t === 5);

// The codec string a decoder is configured with (avc1.PPCCLL), from the stream's SPS.
export function avcCodec(data) {
  const sps = nalUnits(data).find(([t, s, e]) => t === 7 && e - s >= 4);
  if (!sps) return null;
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(data[sps[1] + 1])}${hex(data[sps[1] + 2])}${hex(data[sps[1] + 3])}`;
}

// MPEG-2 transport stream: finds the video stream through the PAT and PMT, puts each PES packet back
// together and hands on its payload with its PTS. A video PES is one picture; it is known to be
// complete when the next one starts.
export function tsDemuxer(onPes) {
  let pmtPid = null, videoPid = null, pes = null;
  const section = (payload) => payload.subarray(1 + payload[0]);
  const parsePat = (s) => {
    if (s[0] !== 0x00 || s.length < 12) return;
    const end = Math.min(s.length, 3 + (((s[1] & 0x0f) << 8) | s[2]) - 4);
    for (let i = 8; i + 4 <= end; i += 4) {
      if (s.readUInt16BE(i) !== 0) { pmtPid = ((s[i + 2] & 0x1f) << 8) | s[i + 3]; return; }
    }
  };
  const parsePmt = (s) => {
    if (s[0] !== 0x02 || s.length < 12) return;
    const end = Math.min(s.length, 3 + (((s[1] & 0x0f) << 8) | s[2]) - 4);
    for (let i = 12 + (((s[10] & 0x0f) << 8) | s[11]); i + 5 <= end; i += 5 + (((s[i + 3] & 0x0f) << 8) | s[i + 4])) {
      if (s[i] === 0x1b && videoPid === null) { videoPid = ((s[i + 1] & 0x1f) << 8) | s[i + 2]; return; }
    }
  };
  const flush = () => {
    const d = pes && Buffer.concat(pes);
    pes = null;
    if (!d || d.length < 9 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return;
    let pts = null;
    if (d[7] & 0x80 && d.length >= 14) pts = (d[9] & 0x0e) * 536870912 + d[10] * 4194304 + (d[11] & 0xfe) * 16384 + d[12] * 128 + (d[13] >> 1);
    onPes(d.subarray(9 + d[8]), pts);
  };
  return (buf) => {
    for (let o = 0; o + TS <= buf.length; o += TS) {
      if (buf[o] !== 0x47) { const next = buf.indexOf(0x47, o + 1); if (next < 0) return; o = next - TS; continue; }
      const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2], start = buf[o + 1] & 0x40, afc = (buf[o + 3] >> 4) & 3;
      if (!(afc & 1)) continue;
      const p = afc === 3 ? o + 5 + buf[o + 4] : o + 4;
      if (p >= o + TS) continue;
      const payload = buf.subarray(p, o + TS);
      if (pid === 0 && start) parsePat(section(payload));
      else if (pid === pmtPid && start) parsePmt(section(payload));
      else if (pid === videoPid) {
        if (start) { flush(); pes = []; }
        if (pes) pes.push(Buffer.from(payload));
      }
    }
  };
}

// H.264 straight in RTP (RFC 6184). One picture is every NAL unit with the same RTP timestamp; the
// marker bit (or the next timestamp) ends it.
export function h264RtpDepacketizer(onPicture) {
  let units = [], time = null, fu = null;
  const flush = () => {
    if (units.length) onPicture(Buffer.concat(units.flatMap((u) => [START_CODE, u])), time);
    units = [];
  };
  return (payload, rtpTime, marker) => {
    if (time !== null && rtpTime !== time) { flush(); fu = null; }
    time = rtpTime;
    const type = payload[0] & 0x1f;
    if (type >= 1 && type <= 23) units.push(Buffer.from(payload));
    else if (type === 24) {
      for (let i = 1; i + 2 <= payload.length;) {
        const n = payload.readUInt16BE(i);
        units.push(Buffer.from(payload.subarray(i + 2, i + 2 + n)));
        i += 2 + n;
      }
    } else if (type === 28 && payload.length > 2) {
      const head = payload[1];
      if (head & 0x80) fu = [Buffer.from([(payload[0] & 0xe0) | (head & 0x1f)])];
      if (fu) fu.push(Buffer.from(payload.subarray(2)));
      if (head & 0x40 && fu) { units.push(Buffer.concat(fu)); fu = null; }
    }
    if (marker) flush();
  };
}

// One camera's stream on one UDP port. onPicture({ data, key, pts, codec }) for each picture, pts in
// microseconds; onStats({ fps, kbps, mode, error }) once a second.
export class IpVideoReceiver {
  constructor({ port, onPicture, onStats }) {
    Object.assign(this, { port, onPicture, onStats });
    this.codec = null;
    this.mode = null;
    this.pictures = 0;
    this.bytes = 0;
    this.error = null;
    const picture = (data, pts90k) => {
      if (!data?.length) return;
      const key = isKeyframe(data);
      if (key) this.codec = avcCodec(data) || this.codec;
      this.pictures++;
      this.onPicture({ data, key, pts: pts90k == null ? null : Math.round(pts90k / 0.09), codec: this.codec });
    };
    this.ts = tsDemuxer((data, pts) => picture(data, pts));
    this.rtp = h264RtpDepacketizer((data, time) => picture(data, time));
  }

  start() {
    const socket = this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg) => this.packet(msg));
    socket.on('error', (e) => {
      this.error = e.code === 'EADDRINUSE' ? `UDP port ${this.port} is in use by another program` : e.message;
      this.report();
    });
    socket.bind(this.port, () => {
      try { socket.setRecvBufferSize(8 * 1024 * 1024); } catch { /* the system's own size */ }
    });
    this.timer = setInterval(() => this.report(), 1000);
    this.timer.unref?.();
  }

  packet(msg) {
    this.bytes += msg.length;
    const rtp = rtpHeader(msg);
    const payload = rtp ? msg.subarray(rtp.start, rtp.end) : msg;
    if (!payload.length) return;
    if (payload[0] === 0x47) {
      this.mode = rtp ? 'MPEG-TS in RTP' : 'MPEG-TS over UDP';
      this.ts(payload);
    } else if (rtp) {
      this.mode = 'H.264 in RTP';
      this.rtp(payload, rtp.time, rtp.marker);
    }
  }

  report() {
    this.onStats?.({ fps: this.pictures, kbps: Math.round((this.bytes * 8) / 1000), mode: this.mode, error: this.error, port: this.port });
    this.pictures = 0;
    this.bytes = 0;
  }

  stop() {
    clearInterval(this.timer);
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
  }
}
