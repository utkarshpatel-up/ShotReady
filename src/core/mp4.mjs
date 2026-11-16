// MP4 files for video out's pre-processing: reading a file's tracks and the place of every sample
// without loading the whole file, and writing a new file with the samples streamed straight to disk
// and the index (moov) at the end. Runs in the pre-processing thread and in the tests.
// The file comes from the operator, so every size and count is checked against what was read.

const MAX_SAMPLES = 20e6;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hex = (n) => n.toString(16).padStart(2, '0');

// The boxes in b[start, end): { type, at (the box), start (its contents), end }.
function children(b, start, end) {
  const out = [];
  for (let o = start; o + 8 <= end;) {
    let size = u32(b, o), head = 8;
    const type = fourcc(b, o + 4);
    if (size === 1) { if (o + 16 > end) break; size = u64(b, o + 8); head = 16; } else if (size === 0) size = end - o;
    if (size < head || o + size > end) break;
    out.push({ type, at: o, start: o + head, end: o + size });
    o += size;
  }
  return out;
}
const find = (b, box, type) => box && children(b, box.start, box.end).find((c) => c.type === type);
const need = (box, what) => { if (!box) throw new Error(`The MP4 file has no ${what}`); return box; };

// The WebCodecs codec string of a video track, from its sample entry and configuration record.
export function codecString(type, d) {
  if (/^avc[13]$/.test(type) && d?.length >= 4) return `avc1.${hex(d[1])}${hex(d[2])}${hex(d[3])}`;
  if (/^(hvc1|hev1)$/.test(type) && d?.length >= 13) {
    const space = d[1] >> 6, tier = (d[1] >> 5) & 1, profile = d[1] & 31;
    let compat = u32(d, 2), reversed = 0;
    for (let i = 0; i < 32; i++) { reversed = reversed * 2 + (compat % 2); compat = Math.floor(compat / 2); }
    const constraints = [...d.subarray(6, 12)];
    while (constraints.length && !constraints[constraints.length - 1]) constraints.pop();
    return [type, `${['', 'A', 'B', 'C'][space]}${profile}`, reversed.toString(16), `${tier ? 'H' : 'L'}${d[12]}`, ...constraints.map((x) => x.toString(16))].join('.');
  }
  return null;
}

function sampleTable(b, stbl, what) {
  const stsz = need(find(b, stbl, 'stsz'), `sample sizes (${what})`);
  const fixed = u32(b, stsz.start + 4), count = u32(b, stsz.start + 8);
  if (count > MAX_SAMPLES || (!fixed && stsz.start + 12 + count * 4 > stsz.end)) throw new Error('The MP4 sample table is damaged');
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || u32(b, stsz.start + 12 + i * 4);

  const co = find(b, stbl, 'stco') || find(b, stbl, 'co64');
  need(co, `chunk offsets (${what})`);
  const wide = co.type === 'co64', chunks = u32(b, co.start + 4);
  if (co.start + 8 + chunks * (wide ? 8 : 4) > co.end) throw new Error('The MP4 chunk table is damaged');
  const chunkAt = (c) => (wide ? u64(b, co.start + 8 + c * 8) : u32(b, co.start + 8 + c * 4));

  const stsc = need(find(b, stbl, 'stsc'), `sample-to-chunk table (${what})`);
  const runs = u32(b, stsc.start + 4);
  if (stsc.start + 8 + runs * 12 > stsc.end) throw new Error('The MP4 sample-to-chunk table is damaged');
  const offsets = new Float64Array(count);
  let s = 0;
  for (let r = 0; r < runs && s < count; r++) {
    const first = u32(b, stsc.start + 8 + r * 12), per = u32(b, stsc.start + 12 + r * 12);
    const next = r + 1 < runs ? u32(b, stsc.start + 8 + (r + 1) * 12) : chunks + 1;
    for (let c = first; c < next && c <= chunks && s < count; c++) {
      let at = chunkAt(c - 1);
      for (let k = 0; k < per && s < count; k++) { offsets[s] = at; at += sizes[s]; s++; }
    }
  }
  if (s < count) throw new Error('The MP4 chunk tables do not cover every sample');

  const stts = need(find(b, stbl, 'stts'), `sample times (${what})`);
  const dts = new Float64Array(count), durations = new Uint32Array(count);
  const tRuns = u32(b, stts.start + 4);
  if (stts.start + 8 + tRuns * 8 > stts.end) throw new Error('The MP4 time table is damaged');
  let t = 0;
  s = 0;
  for (let r = 0; r < tRuns && s < count; r++) {
    const n = u32(b, stts.start + 8 + r * 8), delta = u32(b, stts.start + 12 + r * 8);
    for (let k = 0; k < n && s < count; k++) { dts[s] = t; durations[s] = delta; t += delta; s++; }
  }
  const cts = Float64Array.from(dts);
  const ctts = find(b, stbl, 'ctts');
  if (ctts) {
    const cRuns = u32(b, ctts.start + 4);
    s = 0;
    for (let r = 0; r < cRuns && s < count && ctts.start + 16 + r * 8 <= ctts.end; r++) {
      const n = u32(b, ctts.start + 8 + r * 8), off = i32(b, ctts.start + 12 + r * 8);
      for (let k = 0; k < n && s < count; k++) { cts[s] += off; s++; }
    }
  }
  let keys = null;
  const stss = find(b, stbl, 'stss');
  if (stss) {
    keys = new Uint8Array(count);
    const n = u32(b, stss.start + 4);
    for (let i = 0; i < n && stss.start + 12 + i * 4 <= stss.end; i++) { const k = u32(b, stss.start + 8 + i * 4); if (k >= 1 && k <= count) keys[k - 1] = 1; }
  }
  return { count, sizes, offsets, dts, cts, durations, isKey: (i) => !keys || keys[i] === 1 };
}

function track(b, trak) {
  const mdia = need(find(b, trak, 'mdia'), 'media box');
  const mdhd = need(find(b, mdia, 'mdhd'), 'media header');
  const v1 = b[mdhd.start] === 1;
  const timescale = u32(b, mdhd.start + (v1 ? 20 : 12));
  const hdlr = need(find(b, mdia, 'hdlr'), 'handler');
  const handler = fourcc(b, hdlr.start + 8);
  const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : null;
  if (!kind || !timescale) return null;
  const stbl = need(find(b, find(b, mdia, 'minf'), 'stbl'), 'sample table');
  const stsd = need(find(b, stbl, 'stsd'), 'sample description');
  const entry = children(b, stsd.start + 8, stsd.end)[0];
  if (!entry) return null;
  const out = { kind, timescale, entryType: entry.type, entry: b.slice(entry.at, entry.end), ...sampleTable(b, stbl, kind) };
  if (kind === 'video') {
    out.width = u16(b, entry.start + 24);
    out.height = u16(b, entry.start + 26);
    const config = children(b, entry.start + 78, entry.end).find((c) => c.type === 'avcC' || c.type === 'hvcC');
    out.description = config ? b.slice(config.start, config.end) : null;
    out.codec = codecString(entry.type, out.description);
  }
  return out;
}

/**
 * Reads an MP4 file's tracks.
 * @param read  async (offset, length) => Uint8Array, from the file
 * @param size  the file's size in bytes
 */
export async function readMp4(read, size) {
  let moov = null;
  for (let o = 0; o + 8 <= size;) {
    const h = await read(o, Math.min(16, size - o));
    let len = u32(h, 0);
    if (len === 1) len = u64(h, 8); else if (len === 0) len = size - o;
    if (len < 8) throw new Error('This is not an MP4 file');
    if (fourcc(h, 4) === 'moov') {
      if (len > 512e6) throw new Error('The MP4 index is too big');
      moov = await read(o, len);
      break;
    }
    o += len;
  }
  if (!moov) throw new Error('This file has no MP4 index (moov): it is not an MP4, or was not finished');
  const top = children(moov, 0, moov.length)[0];
  const tracks = children(moov, top.start, top.end).filter((c) => c.type === 'trak').map((t) => track(moov, t)).filter(Boolean);
  return { tracks, video: tracks.find((t) => t.kind === 'video') || null, audio: tracks.find((t) => t.kind === 'audio') || null };
}

// ---------- writing ----------
const ascii = (s) => new TextEncoder().encode(s);
function be(n, bytes) {
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) { out[i] = n % 256; n = Math.floor(n / 256); }
  return out;
}
const zeros = (n) => new Uint8Array(n);
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const box = (type, ...parts) => { const body = concat(parts); return concat([be(body.length + 8, 4), ascii(type), body]); };
const full = (type, version, flags, ...parts) => box(type, new Uint8Array([version, flags >> 16, (flags >> 8) & 255, flags & 255]), ...parts);
const MATRIX = concat([be(0x10000, 4), zeros(4), zeros(4), zeros(4), be(0x10000, 4), zeros(4), zeros(4), zeros(4), be(0x40000000, 4)]);

// The sample entry of an H.264 track, with its configuration record (avcC) from the encoder.
export function avcEntry(width, height, avcC) {
  return box('avc1', zeros(6), be(1, 2), zeros(16), be(width, 2), be(height, 2), be(0x480000, 4), be(0x480000, 4), zeros(4), be(1, 2), zeros(32), be(0x18, 2), be(0xffff, 2), box('avcC', avcC));
}

export class Mp4Writer {
  /** @param write  async (bytes, position) => void; position null means at the end of what is written */
  constructor(write) {
    this.write = write;
    this.pos = 0;
    this.tracks = [];
  }

  // The bytes may be handed to another thread, which empties them: their length is taken first.
  async put(bytes) { const n = bytes.length; await this.write(bytes, null); this.pos += n; }

  async start() {
    await this.put(box('ftyp', ascii('isom'), be(512, 4), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41')));
    this.mdatAt = this.pos;
    await this.put(concat([be(1, 4), ascii('mdat'), zeros(8)])); // a 64-bit size, filled in at the end
  }

  /** @param t { kind: 'video' | 'audio', timescale, entry (the whole sample entry box), width, height, lastDuration } */
  addTrack(t) { this.tracks.push({ ...t, samples: [] }); return this.tracks.length - 1; }

  async addSample(t, bytes, { dts, cts = dts, key = true }) {
    this.tracks[t].samples.push({ offset: this.pos, size: bytes.length, dts, cts, key });
    await this.put(bytes);
  }

  async finish() {
    await this.write(be(this.pos - this.mdatAt, 8), this.mdatAt + 8);
    const movieScale = 1000;
    const traks = this.tracks.filter((t) => t.samples.length).map((t, i) => {
      const s = t.samples;
      const dur = s.map((x, k) => (k + 1 < s.length ? s[k + 1].dts - x.dts : t.lastDuration || (k ? x.dts - s[k - 1].dts : 1)));
      const total = dur.reduce((a, b) => a + b, 0);
      const stts = [];
      for (const d of dur) { const last = stts[stts.length - 1]; if (last && last[1] === d) last[0]++; else stts.push([1, d]); }
      const offs = s.map((x) => x.cts - x.dts);
      const ctts = [];
      if (offs.some((o) => o)) for (const o of offs) { const last = ctts[ctts.length - 1]; if (last && last[1] === o) last[0]++; else ctts.push([1, o]); }
      const keys = s.map((x, k) => (x.key ? k + 1 : 0)).filter(Boolean);
      const stbl = box('stbl',
        full('stsd', 0, 0, be(1, 4), t.entry),
        full('stts', 0, 0, be(stts.length, 4), ...stts.flatMap(([n, d]) => [be(n, 4), be(d, 4)])),
        ...(ctts.length ? [full('ctts', 1, 0, be(ctts.length, 4), ...ctts.flatMap(([n, o]) => [be(n, 4), be(o >>> 0, 4)]))] : []),
        ...(t.kind === 'video' && keys.length < s.length ? [full('stss', 0, 0, be(keys.length, 4), ...keys.map((k) => be(k, 4)))] : []),
        full('stsz', 0, 0, be(0, 4), be(s.length, 4), ...s.map((x) => be(x.size, 4))),
        full('stsc', 0, 0, be(1, 4), be(1, 4), be(1, 4), be(1, 4)),
        full('co64', 0, 0, be(s.length, 4), ...s.map((x) => be(x.offset, 8))));
      const video = t.kind === 'video';
      const minf = box('minf', video ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4)),
        box('dinf', full('dref', 0, 0, be(1, 4), full('url ', 0, 1))), stbl);
      const mdia = box('mdia',
        full('mdhd', 0, 0, zeros(8), be(t.timescale, 4), be(total, 4), be(0x55c4, 2), zeros(2)),
        full('hdlr', 0, 0, zeros(4), ascii(video ? 'vide' : 'soun'), zeros(12), ascii(video ? 'ShotReady video\0' : 'ShotReady sound\0')), minf);
      const movieDur = Math.round((total / t.timescale) * movieScale);
      t.movieDur = movieDur;
      return box('trak',
        full('tkhd', 0, 3, zeros(8), be(i + 1, 4), zeros(4), be(movieDur, 4), zeros(8), zeros(2), zeros(2), be(video ? 0 : 0x100, 2), zeros(2), MATRIX,
          be((t.width || 0) * 0x10000, 4), be((t.height || 0) * 0x10000, 4)),
        mdia);
    });
    const longest = Math.max(0, ...this.tracks.map((t) => t.movieDur || 0));
    const mvhd = full('mvhd', 0, 0, zeros(8), be(movieScale, 4), be(longest, 4), be(0x10000, 4), be(0x100, 2), zeros(10), MATRIX, zeros(24), be(traks.length + 1, 4));
    await this.put(box('moov', mvhd, ...traks));
  }
}
