// One camera's picture through a 3D LUT, drawn on the GPU. Runs in its own thread in the window:
// it reads the camera's picture feed, decodes each frame (createImageBitmap decodes off this
// thread too), and draws it with WebGL2, where the GPU looks every pixel up in the LUT. Only the
// newest frame is drawn: a frame that arrives while one is being decoded replaces the waiting one.
// Nothing here changes the camera, and the waveform still reads the Log picture.
//
// The same thread also shows a camera's own IP video (source 'h264'): the pictures come whole from
// the camera's thread (ipvideo.mjs), are decoded here with WebCodecs, and drawn the same way, with the
// LUT or without it.
'use strict';

const BOUNDARY = '--shotreadyframe';
let gl = null, canvas = null, running = false, abort = null;
let pictureTex = null, lutTex = null, lutReady = false, uni = {};
let waiting = null, decoding = false, shown = false;
let source = 'mjpeg', needLut = true, lastDraw = 0, watch = null;
let decoder = null, codec = null, waitKey = true, count = 0, held = null, saidWaiting = false, since = 0;

const fail = (message) => { postMessage({ type: 'failed', message }); stop(); };

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') start(m);
  else if (m.type === 'lut') setLut(m);
  else if (m.type === 'nolut') { needLut = false; lutReady = false; if (gl) gl.uniform1i(uni.useLut, 0); }
  else if (m.type === 'stop') stop();
};

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  // One triangle that covers the picture; the top of the picture is row 0 of the texture.
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D picture;
uniform sampler3D lut;
uniform bool useLut;
uniform bool inputFull;   // the LUT wants full-range input: the picture's video levels are expanded first
uniform bool outputLegal; // the LUT gives video levels: expanded for the computer screen
uniform bool pictureFull; // decoded IP video is already full range: a legal-input LUT gets it squeezed back
uniform vec3 domainMin, domainMax;
uniform float size;
in vec2 uv;
out vec4 color;
void main() {
  vec3 c = texture(picture, uv).rgb;
  if (useLut) {
    if (pictureFull) { if (!inputFull) c = (c * 219.0 + 16.0) / 255.0; }
    else if (inputFull) c = clamp((c * 255.0 - 16.0) / 219.0, 0.0, 1.0);
    vec3 t = clamp((c - domainMin) / (domainMax - domainMin), 0.0, 1.0);
    c = texture(lut, t * ((size - 1.0) / size) + 0.5 / size).rgb;
    if (outputLegal) c = (c * 255.0 - 16.0) / 219.0;
  }
  color = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function shader(type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader did not compile');
  return s;
}

function start({ canvas: c, url, source: from = 'mjpeg', lut = true }) {
  canvas = c;
  source = from;
  needLut = lut;
  try {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this computer');
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'shader did not link');
    gl.useProgram(prog);
    for (const n of ['picture', 'lut', 'useLut', 'inputFull', 'outputLegal', 'pictureFull', 'domainMin', 'domainMax', 'size']) uni[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(uni.pictureFull, source === 'h264' ? 1 : 0);
    gl.uniform1i(uni.picture, 0);
    gl.uniform1i(uni.lut, 1);
    gl.uniform1i(uni.useLut, 0);
    gl.bindVertexArray(gl.createVertexArray());
    pictureTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pictureTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  } catch (e) {
    fail(e.message);
    return;
  }
  running = true;
  // Said when no picture has been drawn for 3 seconds (an IP stream that has not started, or stopped).
  since = Date.now();
  watch = setInterval(() => {
    if (Date.now() - (lastDraw || since) > 3000 && !saidWaiting) { shown = false; saidWaiting = true; postMessage({ type: 'waiting' }); }
  }, 1000);
  if (source === 'h264') readVideo(url); else read(url);
}

// ---------- the camera's own IP video ----------
// Pictures as the camera's thread hands them on: a 13-byte header (length, 1 for a key frame, time
// in microseconds or -1) and the picture in Annex B.
async function readVideo(url) {
  while (running) {
    try {
      abort = new AbortController();
      const res = await fetch(url, { signal: abort.signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`video HTTP ${res.status}`);
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      waitKey = true; // a new connection starts at the last key frame
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !running) break;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
        let o = 0;
        while (buf.length - o >= 13) {
          const view = new DataView(buf.buffer, buf.byteOffset + o, 13);
          const len = view.getUint32(0), key = buf[o + 4] === 1, pts = view.getFloat64(5);
          if (buf.length - o - 13 < len) break;
          picture(buf.slice(o + 13, o + 13 + len), key, pts);
          o += 13 + len;
        }
        buf = buf.subarray(o);
      }
    } catch { /* the stream dropped: try again */ }
    if (running) await new Promise((r) => setTimeout(r, 1000));
  }
}

function nalTypes(data) {
  const out = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) { out.push([data[i + 3] & 0x1f, i + 3]); i += 2; }
  }
  return out;
}

function codecOf(data) {
  const sps = nalTypes(data).find(([t]) => t === 7);
  if (!sps || sps[1] + 3 >= data.length) return null;
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(data[sps[1] + 1])}${hex(data[sps[1] + 2])}${hex(data[sps[1] + 3])}`;
}

// While the decoder is being set up, the pictures that arrive are held, then decoded in order.
function picture(data, key, pts) {
  if (key) {
    const c = codecOf(data);
    if (c && c !== codec) {
      held = [[data, key, pts]];
      configure(c).then(() => { const list = held || []; held = null; for (const p of list) feed(...p); });
      return;
    }
  }
  if (held) { held.push([data, key, pts]); return; }
  feed(data, key, pts);
}

function feed(data, key, pts) {
  if (!decoder || decoder.state !== 'configured') return;
  // Too far behind: the pictures until the next key frame are left out and decoding starts again there.
  if (!key && (waitKey || decoder.decodeQueueSize > 8)) { waitKey = true; return; }
  if (key && waitKey && decoder.decodeQueueSize > 8) { decoder.reset(); decoder.configure({ codec, optimizeForLatency: true }); }
  waitKey = false;
  count++;
  try {
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts >= 0 ? pts : count * 40000, data }));
  } catch { waitKey = true; }
}

async function configure(c) {
  codec = c;
  try {
    if (typeof VideoDecoder === 'undefined') throw new Error('this computer cannot decode video here (no WebCodecs)');
    const ok = await VideoDecoder.isConfigSupported({ codec: c, optimizeForLatency: true });
    if (!ok.supported) throw new Error(`this computer cannot decode the camera's video (${c})`);
    decoder?.close?.();
    decoder = new VideoDecoder({
      output: (frame) => { draw(frame); frame.close(); },
      error: () => { waitKey = true; decoder = null; codec = null; }, // started again at the next key frame
    });
    decoder.configure({ codec: c, optimizeForLatency: true });
    waitKey = true;
  } catch (e) {
    fail(e.message);
  }
}

function setLut({ size, data, min, max, input, output }) {
  if (!gl) return;
  try {
    lutTex ||= gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uni.useLut, 1);
    gl.uniform1i(uni.inputFull, input === 'full' ? 1 : 0);
    gl.uniform1i(uni.outputLegal, output === 'legal' ? 1 : 0);
    gl.uniform3fv(uni.domainMin, min);
    gl.uniform3fv(uni.domainMax, max);
    gl.uniform1f(uni.size, size);
    const err = gl.getError();
    if (err) throw new Error(`the graphics card refused the LUT (error ${err})`);
    lutReady = true;
  } catch (e) {
    fail(e.message);
  }
}

// The picture feed: parts of "--shotreadyframe", headers with a Content-Length, then the JPEG.
async function read(url) {
  while (running) {
    try {
      abort = new AbortController();
      const res = await fetch(url, { signal: abort.signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`feed HTTP ${res.status}`);
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !running) break;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
        for (;;) {
          const part = takePart(buf);
          if (!part) break;
          buf = part.rest;
          frame(part.jpeg);
        }
        if (buf.length > 32e6) buf = new Uint8Array(0); // never hold more than a few frames' worth
      }
    } catch { /* the feed dropped: try again */ }
    if (running) await new Promise((r) => setTimeout(r, 1000));
  }
}

function takePart(buf) {
  let end = -1;
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) { end = i; break; }
  if (end < 0) return null;
  const head = new TextDecoder().decode(buf.subarray(0, end));
  const start = head.indexOf(BOUNDARY);
  const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1]);
  if (start < 0 || !(length > 0)) return { jpeg: null, rest: buf.subarray(end + 4) };
  const from = end + 4;
  if (buf.length < from + length) return null;
  return { jpeg: buf.slice(from, from + length), rest: buf.subarray(from + length) };
}

function frame(jpeg) {
  if (!jpeg) return;
  waiting = jpeg;
  if (!decoding) decodeNewest();
}

async function decodeNewest() {
  decoding = true;
  while (waiting && running) {
    const jpeg = waiting;
    waiting = null;
    try {
      // The camera's own code values, untouched by colour management, are what the LUT expects.
      const pic = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      draw(pic);
      pic.close();
    } catch { /* one bad frame is skipped */ }
  }
  decoding = false;
}

function draw(pic) {
  if (!gl || !running) return;
  const w = pic.displayWidth ?? pic.width, h = pic.displayHeight ?? pic.height;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, pictureTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pic);
  if (needLut && !lutReady) return; // nothing is shown until the LUT is in, so the Log picture never flashes up as if graded
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  lastDraw = Date.now();
  saidWaiting = false;
  if (!shown) { shown = true; postMessage({ type: 'drawing' }); }
}

function stop() {
  running = false;
  clearInterval(watch);
  abort?.abort();
  try { decoder?.close(); } catch { /* already closed */ }
  decoder = null;
}
