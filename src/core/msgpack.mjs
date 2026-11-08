// Minimal MessagePack reader. Canon's meta.cgi sends focus and detection data in this format.
// Reads one value from a buffer. Throws on truncated or unknown data, so callers can skip a bad part.

function decodeWithLength(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const need = (n) => { if (i + n > buf.length) throw new Error('truncated msgpack'); };
  const str = (n) => { need(n); const s = buf.toString('utf8', i, i + n); i += n; return s; };
  const bin = (n) => { need(n); const b = buf.subarray(i, i + n); i += n; return b; };
  const arr = (n) => { const a = new Array(n); for (let k = 0; k < n; k++) a[k] = read(); return a; };
  const map = (n) => { const o = {}; for (let k = 0; k < n; k++) { const key = read(); o[String(key)] = read(); } return o; };
  const u = (n, get) => { need(n); const v = get.call(view, i); i += n; return v; };

  function read() {
    need(1);
    const t = buf[i++];
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 0x100;
    if (t >= 0xa0 && t <= 0xbf) return str(t & 0x1f);
    if (t >= 0x90 && t <= 0x9f) return arr(t & 0x0f);
    if (t >= 0x80 && t <= 0x8f) return map(t & 0x0f);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u(1, DataView.prototype.getUint8));
      case 0xc5: return bin(u(2, DataView.prototype.getUint16));
      case 0xc6: return bin(u(4, DataView.prototype.getUint32));
      case 0xca: return u(4, DataView.prototype.getFloat32);
      case 0xcb: return u(8, DataView.prototype.getFloat64);
      case 0xcc: return u(1, DataView.prototype.getUint8);
      case 0xcd: return u(2, DataView.prototype.getUint16);
      case 0xce: return u(4, DataView.prototype.getUint32);
      case 0xcf: return Number(u(8, DataView.prototype.getBigUint64));
      case 0xd0: return u(1, DataView.prototype.getInt8);
      case 0xd1: return u(2, DataView.prototype.getInt16);
      case 0xd2: return u(4, DataView.prototype.getInt32);
      case 0xd3: return Number(u(8, DataView.prototype.getBigInt64));
      case 0xd9: return str(u(1, DataView.prototype.getUint8));
      case 0xda: return str(u(2, DataView.prototype.getUint16));
      case 0xdb: return str(u(4, DataView.prototype.getUint32));
      case 0xdc: return arr(u(2, DataView.prototype.getUint16));
      case 0xdd: return arr(u(4, DataView.prototype.getUint32));
      case 0xde: return map(u(2, DataView.prototype.getUint16));
      case 0xdf: return map(u(4, DataView.prototype.getUint32));
      default: throw new Error(`unsupported msgpack type 0x${t.toString(16)}`);
    }
  }
  const value = read();
  return { value, length: i };
}

export const decodeMsgpack = (buf) => decodeWithLength(buf).value;

// For a stream of back-to-back values: the first complete value and how many bytes it used, or
// null when the buffer ends part-way through one and more data is needed.
export function decodeMsgpackPrefix(buf) {
  try {
    return decodeWithLength(buf);
  } catch (e) {
    if (e.message === 'truncated msgpack') return null;
    throw e;
  }
}

// Writer for the shapes this app needs (the simulator and tests): null, booleans, numbers,
// strings, arrays and plain objects.
export function encodeMsgpack(value) {
  const parts = [];
  const push = (...bytes) => parts.push(Buffer.from(bytes));
  const sized = (n, small, b8, b16, b32) => {
    if (small && n < small.max) push(small.base | n);
    else if (b8 && n < 256) push(b8, n);
    else if (n < 65536) { const b = Buffer.alloc(3); b[0] = b16; b.writeUInt16BE(n, 1); parts.push(b); }
    else { const b = Buffer.alloc(5); b[0] = b32; b.writeUInt32BE(n, 1); parts.push(b); }
  };
  const write = (v) => {
    if (v === null || v === undefined) push(0xc0);
    else if (v === true) push(0xc3);
    else if (v === false) push(0xc2);
    else if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= 0 && v < 128) push(v);
      else if (Number.isInteger(v) && v >= -32 && v < 0) push(0x100 + v);
      else if (Number.isInteger(v) && v >= 0 && v < 65536) { const b = Buffer.alloc(3); b[0] = 0xcd; b.writeUInt16BE(v, 1); parts.push(b); }
      else if (Number.isInteger(v) && v >= 0 && v < 2 ** 32) { const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(v, 1); parts.push(b); }
      else if (Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31) { const b = Buffer.alloc(5); b[0] = 0xd2; b.writeInt32BE(v, 1); parts.push(b); }
      else { const b = Buffer.alloc(9); b[0] = 0xcb; b.writeDoubleBE(v, 1); parts.push(b); }
    } else if (typeof v === 'string') {
      const s = Buffer.from(v, 'utf8');
      sized(s.length, { base: 0xa0, max: 32 }, 0xd9, 0xda, 0xdb);
      parts.push(s);
    } else if (Array.isArray(v)) {
      sized(v.length, { base: 0x90, max: 16 }, null, 0xdc, 0xdd);
      v.forEach(write);
    } else {
      const keys = Object.keys(v);
      sized(keys.length, { base: 0x80, max: 16 }, null, 0xde, 0xdf);
      for (const k of keys) { write(k); write(v[k]); }
    }
  };
  write(value);
  return Buffer.concat(parts);
}
