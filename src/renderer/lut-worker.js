// One camera's picture through a 3D LUT, drawn on the GPU. Runs in its own thread in the window:
// it reads the camera's picture feed, decodes each frame (createImageBitmap decodes off this
// thread too), and draws it with WebGL2, where the GPU looks every pixel up in the LUT. Only the
// newest frame is drawn: a frame that arrives while one is being decoded replaces the waiting one.
// Nothing here changes the camera, and the waveform still reads the Log picture.
'use strict';

const BOUNDARY = '--shotreadyframe';
let gl = null, canvas = null, running = false, abort = null;
let pictureTex = null, lutTex = null, lutReady = false, uni = {};
let waiting = null, decoding = false, shown = false;

const fail = (message) => { postMessage({ type: 'failed', message }); stop(); };

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') start(m);
  else if (m.type === 'lut') setLut(m);
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
uniform vec3 domainMin, domainMax;
uniform float size;
in vec2 uv;
out vec4 color;
void main() {
  vec3 c = texture(picture, uv).rgb;
  if (useLut) {
    if (inputFull) c = clamp((c * 255.0 - 16.0) / 219.0, 0.0, 1.0);
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

function start({ canvas: c, url }) {
  canvas = c;
  try {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this computer');
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'shader did not link');
    gl.useProgram(prog);
    for (const n of ['picture', 'lut', 'useLut', 'inputFull', 'outputLegal', 'domainMin', 'domainMax', 'size']) uni[n] = gl.getUniformLocation(prog, n);
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
  read(url);
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
  if (canvas.width !== pic.width || canvas.height !== pic.height) {
    canvas.width = pic.width;
    canvas.height = pic.height;
    gl.viewport(0, 0, pic.width, pic.height);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, pictureTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pic);
  if (!lutReady) return; // nothing is shown until the LUT is in, so the Log picture never flashes up as if graded
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (!shown) { shown = true; postMessage({ type: 'drawing' }); }
}

function stop() {
  running = false;
  abort?.abort();
}
