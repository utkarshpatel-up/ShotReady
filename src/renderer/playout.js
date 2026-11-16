// The video out window: plays one video full screen on the output display (the HDMI output) and
// draws every frame through the inverse LUT on the graphics card, so the clip goes to the switcher
// as flat as the cameras. The picture is scaled to the display, keeping its shape, with black
// around it: a 4K file on a 1080 output is scaled down, an HD file on a 4K output scaled up.
// Black whenever nothing is playing. Audio goes to the output device chosen in ShotReady.
// For the Screen source it shows a display, captured live, through the LUT picked for it instead.
'use strict';

const api = window.shotready;
const canvas = document.getElementById('out');
const video = document.createElement('video');
video.preload = 'auto';
video.playsInline = true;
let gl = null, uni = {}, pictureTex = null, lutTex = null;
let lut = null, applyLut = true, black = true, failed = null, startAt = 0;
// Without WebGL2 the video is shown as it is, straight from the video element: never held back.
let direct = false;
// A pre-processed clip already has the LUT in it, so it is not applied a second time.
let baked = false;
// The screen being sent, for the Screen source.
let screenStream = null;

const VERTEX = `#version 300 es
uniform vec4 area; // x, y, width, height of the picture in clip space
out vec2 uv;
void main() {
  vec2 c = vec2(gl_VertexID == 1 || gl_VertexID == 4 || gl_VertexID == 5 ? 1.0 : 0.0, gl_VertexID == 2 || gl_VertexID == 3 || gl_VertexID == 5 ? 1.0 : 0.0);
  uv = vec2(c.x, 1.0 - c.y);
  gl_Position = vec4(area.xy + c * area.zw, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D picture;
uniform sampler3D lut;
uniform bool useLut;
uniform bool inputLegal;  // the LUT wants video levels: the decoded picture (full range) is squeezed first
uniform bool outputLegal; // the LUT gives video levels: expanded, as the computer's output is full range
uniform vec3 domainMin, domainMax;
uniform float size;
in vec2 uv;
out vec4 color;
void main() {
  vec3 c = texture(picture, uv).rgb;
  if (useLut) {
    if (inputLegal) c = (c * 219.0 + 16.0) / 255.0;
    vec3 t = clamp((c - domainMin) / (domainMax - domainMin), 0.0, 1.0);
    c = texture(lut, t * ((size - 1.0) / size) + 0.5 / size).rgb;
    if (outputLegal) c = (c * 255.0 - 16.0) / 219.0;
  }
  color = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function report(extra = {}) {
  api.call('playoutReport', {
    playing: !video.paused && !video.ended && !black, position: video.currentTime || 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0, ended: video.ended, error: failed, ...extra,
  }).catch(() => {});
}

function fail(message) {
  failed = message;
  report();
}

function setup() {
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL2 is not available on this computer, so the LUT cannot be applied');
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader did not compile');
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'shader did not link');
  gl.useProgram(prog);
  for (const n of ['area', 'picture', 'lut', 'useLut', 'inputLegal', 'outputLegal', 'domainMin', 'domainMax', 'size']) uni[n] = gl.getUniformLocation(prog, n);
  gl.uniform1i(uni.picture, 0);
  gl.uniform1i(uni.lut, 1);
  gl.bindVertexArray(gl.createVertexArray());
  pictureTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, pictureTex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
}

// The canvas is the display's own size in pixels, so the picture is scaled exactly once, here.
function fit() {
  const w = Math.round(innerWidth * devicePixelRatio), h = Math.round(innerHeight * devicePixelRatio);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function clearBlack() {
  if (direct) { video.style.visibility = 'hidden'; return; }
  if (!gl) return;
  fit();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function draw() {
  if (direct) { video.style.visibility = black || !video.videoWidth ? 'hidden' : 'visible'; return; }
  if (!gl || black || !video.videoWidth) { clearBlack(); return; }
  fit();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, pictureTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  // Keep the picture's shape: as large as fits, centred, black around it.
  const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const w = (video.videoWidth * scale) / canvas.width * 2, h = (video.videoHeight * scale) / canvas.height * 2;
  gl.uniform4f(uni.area, -w / 2, -h / 2, w, h);
  gl.uniform1i(uni.useLut, applyLut && lut && !baked ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// The screen to send: captured at its own size, as smooth as the output display runs.
async function startScreen(m) {
  failed = null;
  baked = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: m.id,
      minWidth: m.width, maxWidth: m.width, minHeight: m.height, maxHeight: m.height, maxFrameRate: m.fps,
    } } });
    screenStream = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (screenStream === stream) { black = true; clearBlack(); fail('the screen capture stopped'); } });
    video.loop = false;
    video.muted = true;
    video.srcObject = stream;
    black = false;
    await video.play();
    report();
    if (m.overlay) checkNotBlack();
  } catch (e) {
    fail(`the screen cannot be captured (${e.message || e.name})`);
  }
}

// Over the display it captures, this window must be kept out of the capture; where Windows cannot
// do that, the capture is black and so would be the screen. Said in the first seconds, while a
// screen that is meant to be all black is unlikely.
function checkNotBlack() {
  const probe = document.createElement('canvas');
  probe.width = 32; probe.height = 18;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  let looks = 0, dark = 0;
  const timer = setInterval(() => {
    if (!screenStream || !video.videoWidth) return;
    ctx.drawImage(video, 0, 0, probe.width, probe.height);
    const px = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let max = 0;
    for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
    looks++;
    if (max < 4) dark++;
    if (looks >= 4) {
      clearInterval(timer);
      if (dark === looks) report({ screenBlack: true });
    }
  }, 500);
}

function onFrame() {
  draw();
  video.requestVideoFrameCallback(onFrame);
}

function setLut(m) {
  lut = m.lut || null;
  if (!lut || !gl) { draw(); return; }
  lutTex ||= gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(uni.inputLegal, lut.input === 'legal' ? 1 : 0);
  gl.uniform1i(uni.outputLegal, lut.output === 'legal' ? 1 : 0);
  gl.uniform3fv(uni.domainMin, lut.min);
  gl.uniform3fv(uni.domainMax, lut.max);
  gl.uniform1f(uni.size, lut.size);
  if (gl.getError()) {
    lut = null; // the video goes on, as it is, and the tab says why
    report({ note: 'The graphics card refused the LUT: the video goes out without it' });
  } else report({ note: null });
  draw();
}

// The audio output, by its id, or else by its name. With nothing chosen, the first output that is not
// a display's (HDMI) audio, so the sound goes to the computer's own audio jack, not to the switcher.
const DISPLAY_AUDIO = /hdmi|displayport|display audio|nvidia high definition|amd high definition|intel\(r\) display/i;
async function setAudio({ id, label, auto }) {
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const pick = auto
      ? outs.find((d) => d.label && !['default', 'communications'].includes(d.deviceId) && !DISPLAY_AUDIO.test(d.label))
      : outs.find((d) => id && d.deviceId === id) || outs.find((d) => label && d.label === label);
    if (auto && !pick) return; // no names to go by: the computer's default output
    await video.setSinkId(pick ? pick.deviceId : '');
  } catch (e) {
    report({ audioError: e.message });
  }
}

const commands = {
  load: (m) => {
    failed = null;
    black = true;
    video.loop = !!m.loop;
    baked = !!m.baked;
    startAt = m.position || 0; // applied once the file is open: loading starts it from 0
    video.src = m.url;
    video.load();
  },
  play: () => {
    black = false;
    video.play().then(() => report(), (e) => fail(`could not play: ${e.message}`));
  },
  pause: () => { video.pause(); report(); },
  stop: () => { video.pause(); video.currentTime = 0; black = true; clearBlack(); report(); },
  seek: (m) => { video.currentTime = Math.max(0, Number(m.t) || 0); },
  loop: (m) => { video.loop = !!m.on; },
  volume: (m) => { video.volume = Math.max(0, Math.min(1, Number(m.v))); },
  audio: (m) => setAudio(m),
  lut: (m) => setLut(m),
  applyLut: (m) => { applyLut = !!m.on; draw(); },
  screen: (m) => startScreen(m),
};

try {
  setup();
} catch (e) {
  // No LUT is possible, but the video still goes out.
  direct = true;
  gl = null;
  canvas.style.display = 'none';
  video.className = 'direct';
  document.body.append(video);
  report({ note: `${e.message}: the video goes out without the LUT` });
}
clearBlack();
video.requestVideoFrameCallback(onFrame);
video.addEventListener('seeked', draw);
video.addEventListener('ended', () => { black = true; clearBlack(); report(); });
video.addEventListener('error', () => fail(`this file cannot be played here (${video.error?.message || `code ${video.error?.code}`}). MP4 (H.264 or HEVC) and WebM play; ProRes, DNxHR and MXF do not`));
video.addEventListener('loadedmetadata', () => { if (startAt) video.currentTime = startAt; startAt = 0; report(); });
addEventListener('resize', draw);
addEventListener('contextmenu', (e) => e.preventDefault());
setInterval(() => { if (!video.paused && !screenStream) report(); }, 250);
api.on('playout', (m) => commands[m?.type]?.(m));
api.call('playoutReady').catch(() => {});
