// A 3D LUT applied to video frames by WebGL2 on an off-screen canvas, for use in a worker thread.
// Used by pre-processing (preprocess-worker.mjs) and by the live stream (stream-worker.mjs).
const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;
// The same LUT as video out applies live, so a pre-processed clip or a stream looks the same.
const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D picture;
uniform sampler3D lut;
uniform bool inputLegal, outputLegal;
uniform vec3 domainMin, domainMax;
uniform float size;
in vec2 uv;
out vec4 color;
void main() {
  vec3 c = texture(picture, uv).rgb;
  if (inputLegal) c = (c * 219.0 + 16.0) / 255.0;
  vec3 t = clamp((c - domainMin) / (domainMax - domainMin), 0.0, 1.0);
  c = texture(lut, t * ((size - 1.0) / size) + 0.5 / size).rgb;
  if (outputLegal) c = (c * 255.0 - 16.0) / 219.0;
  color = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export function lutCanvas(width, height, lut) {
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
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
  const u = (n) => gl.getUniformLocation(prog, n);
  gl.uniform1i(u('picture'), 0);
  gl.uniform1i(u('lut'), 1);
  gl.uniform1i(u('inputLegal'), lut.input === 'legal' ? 1 : 0);
  gl.uniform1i(u('outputLegal'), lut.output === 'legal' ? 1 : 0);
  gl.uniform3fv(u('domainMin'), lut.min);
  gl.uniform3fv(u('domainMax'), lut.max);
  gl.uniform1f(u('size'), lut.size);
  gl.bindVertexArray(gl.createVertexArray());
  const params = (target) => { for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(target, k, v); };
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
  params(gl.TEXTURE_3D);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  params(gl.TEXTURE_2D);
  gl.viewport(0, 0, width, height);
  if (gl.getError()) throw new Error('the graphics card refused the LUT');
  return {
    canvas,
    // One decoded frame in, the same frame through the LUT out.
    // A frame of another shape is scaled to fit, with black around it.
    apply(frame, timestamp = frame.timestamp) {
      const fw = frame.displayWidth, fh = frame.displayHeight;
      if (fw * height !== fh * width) {
        const scale = Math.min(width / fw, height / fh);
        const w = Math.round(fw * scale), h = Math.round(fh * scale);
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport((width - w) >> 1, (height - h) >> 1, w, h);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return new VideoFrame(canvas, { timestamp, ...(frame.duration ? { duration: frame.duration } : {}) });
    },
  };
}
