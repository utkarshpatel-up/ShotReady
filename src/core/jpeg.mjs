// A small JPEG decoder for the waveform. It runs inside each camera's own thread, where Electron's
// image decoder is not available, so measuring levels never takes time from the main thread.
//
// Baseline and extended sequential JPEG (Huffman coded, 8 bits), any chroma sampling, restart
// markers, one or several scans: what a camera's preview picture is. Progressive, lossless and
// arithmetic-coded pictures are refused with an error, and the caller falls back to decoding on the
// main thread. The picture is read on a grid of every step-th pixel, which is all the waveform uses.
// Camera data is untrusted: sizes are capped and every read is bounds checked.

const ZIGZAG = Int32Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);
const MAX_PIXELS = 40e6;

// The 8x8 inverse DCT as a table: COS[x * 8 + u] = c(u) / 2 * cos((2x + 1) u pi / 16).
const COS = new Float64Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u ? 1 : Math.SQRT1_2) / 2 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
const DC_WEIGHT = Math.SQRT1_2 / 2;

class Bits {
  constructor(buf, pos) { Object.assign(this, { buf, pos, acc: 0, n: 0, atMarker: false }); }
  bit() {
    if (this.n === 0) {
      let b = 0;
      if (!this.atMarker && this.pos < this.buf.length) {
        b = this.buf[this.pos];
        if (b === 0xff) {
          if (this.buf[this.pos + 1] === 0) this.pos += 2; // a stuffed 0xFF byte
          else { this.atMarker = true; b = 0; } // a marker ends the data: read zeros from here
        } else this.pos++;
      }
      this.acc = b;
      this.n = 8;
    }
    this.n--;
    return (this.acc >> this.n) & 1;
  }
  bits(k) { let v = 0; while (k-- > 0) v = (v << 1) | this.bit(); return v; }
  // At a restart interval: leftover bits are dropped and the RSTn marker stepped over.
  restart() {
    const { buf } = this;
    while (this.pos + 1 < buf.length && !(buf[this.pos] === 0xff && buf[this.pos + 1] >= 0xd0 && buf[this.pos + 1] <= 0xd7)) this.pos++;
    this.pos += 2;
    this.n = 0;
    this.atMarker = false;
  }
  // Where the next marker after this scan starts.
  nextMarker() {
    const { buf } = this;
    let p = this.pos;
    while (p + 1 < buf.length && !(buf[p] === 0xff && buf[p + 1] !== 0 && !(buf[p + 1] >= 0xd0 && buf[p + 1] <= 0xd7))) p++;
    return p;
  }
}

// Huffman table, decoded as in the JPEG standard (Annex F.2.2.3).
function huffman(counts, values) {
  const maxcode = new Int32Array(17).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1];
    if (n) { valptr[l] = k; mincode[l] = code; code += n; k += n; maxcode[l] = code - 1; }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, values };
}

function decodeHuffman(bits, t) {
  if (!t) throw new Error('missing Huffman table');
  let code = bits.bit(), l = 1;
  while (code > t.maxcode[l]) {
    if (++l > 16) throw new Error('bad Huffman code');
    code = (code << 1) | bits.bit();
  }
  const v = t.values[t.valptr[l] + code - t.mincode[l]];
  if (v === undefined) throw new Error('bad Huffman code');
  return v;
}

const extend = (v, t) => (v < 1 << (t - 1) ? v - (1 << t) + 1 : v);

// One 8x8 block, dequantized and transformed, written into the component's plane.
function decodeBlock(bits, c, coef, tmp, bx, by) {
  coef.fill(0);
  const q = c.quant;
  const t = decodeHuffman(bits, c.dc);
  if (t > 16) throw new Error('bad DC value');
  c.pred += t ? extend(bits.bits(t), t) : 0;
  coef[0] = c.pred * q[0];
  let ac = false;
  for (let k = 1; k < 64;) {
    const rs = decodeHuffman(bits, c.ac);
    const s = rs & 15, r = rs >> 4;
    if (!s) { if (r === 15) { k += 16; continue; } break; }
    k += r;
    if (k > 63) break;
    const z = ZIGZAG[k];
    coef[z] = extend(bits.bits(s), s) * q[z];
    ac = true;
    k++;
  }
  const { plane, stride } = c;
  const base = by * 8 * stride + bx * 8;
  if (!ac) {
    // Flat block: only the average level.
    const v = Math.max(0, Math.min(255, Math.round(coef[0] / 8 + 128)));
    for (let y = 0; y < 8; y++) plane.fill(v, base + y * stride, base + y * stride + 8);
    return;
  }
  // Rows first, skipping rows with nothing but their average, then columns. Where only every other
  // pixel is read later (c.even), only those are worked out: a quarter of the work.
  const d = c.even ? 2 : 1;
  for (let v = 0; v < 8; v++) {
    const r = v * 8;
    const c0 = coef[r], c1 = coef[r + 1], c2 = coef[r + 2], c3 = coef[r + 3], c4 = coef[r + 4], c5 = coef[r + 5], c6 = coef[r + 6], c7 = coef[r + 7];
    if (!(c1 || c2 || c3 || c4 || c5 || c6 || c7)) {
      const flat = c0 * DC_WEIGHT;
      for (let x = 0; x < 8; x += d) tmp[r + x] = flat;
      continue;
    }
    for (let x = 0; x < 8; x += d) {
      const k = x * 8;
      tmp[r + x] = COS[k] * c0 + COS[k + 1] * c1 + COS[k + 2] * c2 + COS[k + 3] * c3 + COS[k + 4] * c4 + COS[k + 5] * c5 + COS[k + 6] * c6 + COS[k + 7] * c7;
    }
  }
  for (let y = 0; y < 8; y += d) {
    const k = y * 8, row = base + y * stride;
    const w0 = COS[k], w1 = COS[k + 1], w2 = COS[k + 2], w3 = COS[k + 3], w4 = COS[k + 4], w5 = COS[k + 5], w6 = COS[k + 6], w7 = COS[k + 7];
    for (let x = 0; x < 8; x += d) {
      const v = w0 * tmp[x] + w1 * tmp[8 + x] + w2 * tmp[16 + x] + w3 * tmp[24 + x] + w4 * tmp[32 + x] + w5 * tmp[40 + x] + w6 * tmp[48 + x] + w7 * tmp[56 + x] + 128.5;
      plane[row + x] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
    }
  }
}

function decodeScan(buf, start, frame, scan, restartInterval) {
  const bits = new Bits(buf, start);
  const coef = new Float64Array(64), tmp = new Float64Array(64);
  const comps = scan.comps;
  for (const c of comps) c.pred = 0;
  let mcus, each;
  if (comps.length === 1) {
    // Not interleaved: one block at a time across the component's own size.
    const c = comps[0];
    const across = Math.ceil(Math.ceil((frame.width * c.h) / frame.hmax) / 8);
    const down = Math.ceil(Math.ceil((frame.height * c.v) / frame.vmax) / 8);
    mcus = across * down;
    each = (n) => decodeBlock(bits, c, coef, tmp, n % across, Math.floor(n / across));
  } else {
    mcus = frame.mcusX * frame.mcusY;
    each = (n) => {
      const mx = n % frame.mcusX, my = Math.floor(n / frame.mcusX);
      for (const c of comps) {
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(bits, c, coef, tmp, mx * c.h + h, my * c.v + v);
      }
    };
  }
  for (let n = 0; n < mcus; n++) {
    if (restartInterval && n && n % restartInterval === 0) {
      bits.restart();
      for (const c of comps) c.pred = 0;
    }
    each(n);
  }
  return bits.nextMarker();
}

// One chroma value at a picture position. Half-width and half-size chroma (4:2:2 and 4:2:0, what
// cameras send) is smoothed between neighbouring samples exactly as libjpeg's default "fancy"
// upsampling does, so the colour readings match Electron's own decoder. Anything else is nearest.
function chromaAt(c, x, y) {
  const { rx, ry, cw, ch, plane: P, stride: S } = c;
  if (rx === 2 && ry === 2) {
    const i = x >> 1, j = y >> 1;
    const far = Math.min(ch - 1, Math.max(0, y & 1 ? j + 1 : j - 1));
    const col = (k) => 3 * P[j * S + k] + P[far * S + k];
    const t = col(i);
    if (x & 1) return i + 1 >= cw ? (t * 4 + 7) >> 4 : (t * 3 + col(i + 1) + 7) >> 4;
    return i === 0 ? (t * 4 + 8) >> 4 : (t * 3 + col(i - 1) + 8) >> 4;
  }
  if (rx === 2 && ry === 1) {
    const i = x >> 1, row = y * S, v = P[row + i];
    if (x & 1) return i + 1 >= cw ? v : (v * 3 + P[row + i + 1] + 2) >> 2;
    return i === 0 ? v : (v * 3 + P[row + i - 1] + 1) >> 2;
  }
  return P[Math.floor(y / ry) * S + Math.floor(x / rx)];
}

/**
 * Decodes a JPEG and returns its pixels on a grid of every step-th pixel.
 * @returns { width, height, data } with data RGBA, width and height the size of that grid
 */
export function decodeJpeg(input, { step = 1 } = {}) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const u16 = (p) => {
    if (p + 1 >= buf.length) throw new Error('JPEG ends early');
    return (buf[p] << 8) | buf[p + 1];
  };
  const quant = [], dc = [], ac = [];
  const evenGrid = Math.max(1, Math.floor(step)) % 2 === 0;
  let frame = null, restartInterval = 0, scanned = false;
  let pos = 2;
  while (pos + 1 < buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const m = buf[pos + 1];
    if (m === 0xff) { pos++; continue; } // fill byte
    pos += 2;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9) break; // end of picture
    const len = u16(pos);
    const seg = pos + 2, end = pos + len;
    if (len < 2 || end > buf.length) throw new Error('JPEG segment runs past the end');
    if (m === 0xdb) {
      for (let p = seg; p < end;) {
        const wide = buf[p] >> 4, id = buf[p] & 15;
        const table = new Int32Array(64);
        p++;
        for (let k = 0; k < 64; k++) { table[ZIGZAG[k]] = wide ? u16(p) : buf[p]; p += wide ? 2 : 1; }
        quant[id] = table;
      }
    } else if (m === 0xc4) {
      for (let p = seg; p < end;) {
        const cls = buf[p] >> 4, id = buf[p] & 15;
        const counts = buf.subarray(p + 1, p + 17);
        const total = counts.reduce((a, b) => a + b, 0);
        if (p + 17 + total > end) throw new Error('bad Huffman table');
        (cls ? ac : dc)[id] = huffman(counts, buf.slice(p + 17, p + 17 + total));
        p += 17 + total;
      }
    } else if (m === 0xc0 || m === 0xc1) {
      if (buf[seg] !== 8) throw new Error(`${buf[seg]}-bit JPEG is not supported`);
      const height = u16(seg + 1), width = u16(seg + 3), n = buf[seg + 5];
      if (!width || !height || width * height > MAX_PIXELS || !n || n > 4) throw new Error('unsupported JPEG size');
      const comps = [];
      for (let i = 0; i < n; i++) {
        const p = seg + 6 + i * 3;
        comps.push({ id: buf[p], h: buf[p + 1] >> 4 || 1, v: buf[p + 1] & 15 || 1, tq: buf[p + 2] });
      }
      const hmax = Math.max(...comps.map((c) => c.h)), vmax = Math.max(...comps.map((c) => c.v));
      const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));
      for (const c of comps) {
        c.stride = mcusX * c.h * 8;
        c.plane = new Uint8Array(c.stride * mcusY * c.v * 8);
      }
      for (const c of comps) {
        Object.assign(c, { rx: hmax / c.h, ry: vmax / c.v, cw: Math.ceil((width * c.h) / hmax), ch: Math.ceil((height * c.v) / vmax) });
        // Full-size brightness read on an even grid: only even positions are ever looked at.
        c.even = c === comps[0] && c.rx === 1 && c.ry === 1 && evenGrid;
      }
      frame = { width, height, comps, hmax, vmax, mcusX, mcusY };
    } else if ((m >= 0xc2 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      throw new Error('progressive, lossless or arithmetic-coded JPEG is not supported');
    } else if (m === 0xdd) {
      restartInterval = u16(seg);
    } else if (m === 0xda) {
      if (!frame) throw new Error('scan before frame header');
      const n = buf[seg];
      const comps = [];
      for (let i = 0; i < n; i++) {
        const c = frame.comps.find((x) => x.id === buf[seg + 1 + i * 2]);
        if (!c) throw new Error('scan names an unknown component');
        const sel = buf[seg + 2 + i * 2];
        c.dc = dc[sel >> 4];
        c.ac = ac[sel & 15];
        c.quant = quant[c.tq];
        if (!c.quant) throw new Error('missing quantization table');
        comps.push(c);
      }
      pos = decodeScan(buf, end, frame, { comps }, restartInterval);
      scanned = true;
      continue;
    }
    pos = end;
  }
  if (!frame || !scanned) throw new Error('JPEG has no picture data');

  // Colour on the requested grid.
  const s = Math.max(1, Math.floor(step));
  const ow = Math.ceil(frame.width / s), oh = Math.ceil(frame.height / s);
  const data = new Uint8Array(ow * oh * 4);
  const [Y, Cb, Cr] = frame.comps;
  let o = 0;
  for (let y = 0; y < frame.height; y += s) {
    for (let x = 0; x < frame.width; x += s) {
      const l = Y.plane[Math.floor((y * Y.v) / frame.vmax) * Y.stride + Math.floor((x * Y.h) / frame.hmax)];
      if (Cb && Cr) {
        const b = chromaAt(Cb, x, y) - 128, r = chromaAt(Cr, x, y) - 128;
        data[o] = Math.max(0, Math.min(255, Math.round(l + 1.402 * r)));
        data[o + 1] = Math.max(0, Math.min(255, Math.round(l - 0.344136 * b - 0.714136 * r)));
        data[o + 2] = Math.max(0, Math.min(255, Math.round(l + 1.772 * b)));
      } else {
        data[o] = data[o + 1] = data[o + 2] = l;
      }
      data[o + 3] = 255;
      o += 4;
    }
  }
  return { width: ow, height: oh, data };
}
