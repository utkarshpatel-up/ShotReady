// The live stream's encoder, in its own thread inside a hidden window of its own, so neither the
// app nor the cameras' pictures wait for it. Frames from the video device are scaled to the stream
// size (through a LUT when one is chosen) and encoded to H.264 on the graphics chip's video engine
// where it has one, in software otherwise. Sound is encoded to AAC. Encoded pictures and sound go
// back to the page, which hands them to the main process for sending.
import { lutCanvas } from './lut-gl.mjs';

let run = null;

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    run?.stop();
    run = start(m);
  } else if (m.type === 'stop') { run?.stop(); run = null; }
  else if (m.type === 'keyframe' && run) run.wantKey = true;
};

const fail = (message) => postMessage({ type: 'failed', message: String(message?.message || message) });

// H.264 level for a size and frame rate, as the two hex digits at the end of the codec name.
const level = (w, h, fps) => (w * h > 921600 ? (fps > 30 ? '2a' : '28') : fps > 30 ? '20' : '1f');

// The first encoder this computer has: on the graphics chip before software, High profile before
// Main and Baseline, a constant bitrate (what streaming services ask for) before a variable one.
async function pickVideo(cfg) {
  const lv = level(cfg.width, cfg.height, cfg.fps);
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
    for (const profile of ['6400', '4d00', '42e0']) {
      for (const bitrateMode of ['constant', 'variable']) {
        const c = { codec: `avc1.${profile}${lv}`, width: cfg.width, height: cfg.height, bitrate: cfg.videoBitrate, framerate: cfg.fps, avc: { format: 'avc' }, latencyMode: 'realtime', bitrateMode, hardwareAcceleration };
        try { if ((await VideoEncoder.isConfigSupported(c)).supported) return c; } catch { /* the next one */ }
      }
    }
  }
  throw new Error(`This computer cannot encode ${cfg.width}×${cfg.height} H.264`);
}

// The AAC setup bytes for a sample rate and channel count, for an encoder that does not give them.
function aacConfig(rate, channels) {
  const index = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(rate);
  return new Uint8Array([(2 << 3) | (index >> 1), ((index & 1) << 7) | (channels << 3)]);
}

// Sound as two channels at a rate AAC takes. Most devices already give that, and pass straight through.
function soundShaper(first) {
  const okRate = first.sampleRate === 48000 || first.sampleRate === 44100;
  const rate = okRate ? first.sampleRate : 48000;
  const channels = Math.min(2, first.numberOfChannels);
  if (okRate && first.numberOfChannels <= 2) return { rate, channels, shape: (d) => d, passthrough: true };
  const step = first.sampleRate / rate;
  let phase = 0, made = 0, t0 = null;
  return {
    rate, channels,
    shape(d) {
      t0 ??= d.timestamp;
      const n = d.numberOfFrames;
      const planes = [];
      for (let c = 0; c < channels; c++) { const p = new Float32Array(n); d.copyTo(p, { planeIndex: c, format: 'f32-planar' }); planes.push(p); }
      const count = Math.floor((n - phase) / step) + 1;
      const out = new Float32Array(Math.max(0, count) * channels);
      let k = 0;
      for (let x = phase; x < n; x += step, k++) {
        const i = Math.floor(x), f = x - i;
        for (let c = 0; c < channels; c++) {
          const a = planes[c][i], b = i + 1 < n ? planes[c][i + 1] : a;
          out[c * count + k] = a + (b - a) * f;
        }
      }
      phase = phase + k * step - n;
      const shaped = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: k, numberOfChannels: channels, timestamp: t0 + Math.round((made * 1e6) / rate), data: k === count ? out : compact(out, count, k, channels) });
      made += k;
      d.close();
      return shaped;
    },
  };
}
function compact(out, count, k, channels) {
  const o = new Float32Array(k * channels);
  for (let c = 0; c < channels; c++) o.set(out.subarray(c * count, c * count + k), c * k);
  return o;
}

function start({ cfg, video, audio }) {
  const state = { wantKey: true, stopped: false, stop };
  const t0 = performance.now();
  const nowMs = () => performance.now() - t0;
  let venc = null, aenc = null, vreader = null, areader = null;

  function stop() {
    state.stopped = true;
    vreader?.cancel().catch(() => {});
    areader?.cancel().catch(() => {});
    try { if (venc && venc.state !== 'closed') venc.close(); } catch { /* closed */ }
    try { if (aenc && aenc.state !== 'closed') aenc.close(); } catch { /* closed */ }
  }
  const die = (e) => { if (!state.stopped) { stop(); fail(e); } };

  // ---- sound ----
  // Resolves once the sound is being encoded, or it is known there will be none.
  const sound = !audio ? Promise.resolve({ sound: null, soundNote: cfg.audioWanted ? 'No sound: the audio input could not be opened' : null }) : new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ sound: null, soundNote: 'No sound has come from the audio input yet' }), 2500);
    const settle = (v) => { clearTimeout(timer); resolve(v); };
    (async () => {
      areader = audio.getReader();
      let shaper = null, base = null;
      for (;;) {
        const { value: data, done } = await areader.read();
        if (done || state.stopped) { data?.close(); break; }
        if (!shaper) {
          shaper = soundShaper(data);
          const config = { codec: cfg.audioCodec || 'mp4a.40.2', sampleRate: shaper.rate, numberOfChannels: shaper.channels, bitrate: cfg.audioBitrate, ...(cfg.audioCodec ? {} : { aac: { format: 'aac' } }) };
          let ok = false;
          try { ok = (await AudioEncoder.isConfigSupported(config)).supported; } catch { /* not supported */ }
          if (!ok) {
            data.close();
            areader.cancel().catch(() => {});
            settle({ sound: null, soundNote: 'No sound: this computer has no AAC encoder. The stream is picture only' });
            return;
          }
          let sentConfig = false;
          aenc = new AudioEncoder({
            output: (chunk, meta) => {
              if (!sentConfig) {
                sentConfig = true;
                const d = meta?.decoderConfig?.description;
                const bytes = d ? new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0)) : aacConfig(shaper.rate, shaper.channels);
                postMessage({ type: 'config', kind: 'audio', data: bytes }, [bytes.buffer]);
              }
              const bytes = new Uint8Array(chunk.byteLength);
              chunk.copyTo(bytes);
              postMessage({ type: 'chunk', kind: 'audio', ms: Math.max(0, Math.round((chunk.timestamp + base) / 1000)), data: bytes }, [bytes.buffer]);
            },
            error: (e) => { postMessage({ type: 'note', text: `Sound stopped: ${e.message}` }); areader?.cancel().catch(() => {}); },
          });
          aenc.configure(config);
          settle({ sound: `${cfg.audioCodec ? cfg.audioCodec.toUpperCase() : 'AAC'} ${shaper.rate / 1000} kHz ${shaper.channels === 2 ? 'stereo' : 'mono'}`, soundRate: shaper.rate, soundChannels: shaper.channels });
        }
        const d = shaper.shape(data);
        // Sound carries the device's own clock: it is lined up with the stream's clock on the first
        // block, and again if the two ever move more than a quarter of a second apart.
        const want = nowMs() * 1000 - (d.numberOfFrames * 1e6) / d.sampleRate;
        if (base === null || Math.abs(d.timestamp + base - want) > 250000) base = want - d.timestamp;
        if (aenc.state === 'configured' && aenc.encodeQueueSize < 50) aenc.encode(d);
        d.close();
      }
      if (!state.stopped) postMessage({ type: 'note', text: 'The audio input stopped: the stream goes on without sound' });
    })().catch((e) => { settle({ sound: null, soundNote: `No sound: ${e.message}` }); });
  });

  // ---- pictures ----
  (async () => {
    const config = await pickVideo(cfg);
    const info = await sound;
    if (state.stopped) return;
    let sentConfig = false, encoded = 0;
    venc = new VideoEncoder({
      output: (chunk, meta) => {
        const d = meta?.decoderConfig?.description;
        if (d && !sentConfig) {
          sentConfig = true;
          const bytes = new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
          postMessage({ type: 'config', kind: 'video', data: bytes }, [bytes.buffer]);
        }
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        encoded++;
        postMessage({ type: 'chunk', kind: 'video', ms: Math.round(chunk.timestamp / 1000), key: chunk.type === 'key', data: bytes }, [bytes.buffer]);
      },
      error: (e) => die(`The video encoder stopped: ${e.message}`),
    });
    venc.configure(config);

    const look = cfg.lut ? lutCanvas(cfg.width, cfg.height, cfg.lut) : null;
    let plain = null, ctx = null;
    // The frame at the stream's size: as it is when it already fits, else scaled with black around it.
    const fit = (frame, timestamp) => {
      if (look) return look.apply(frame, timestamp);
      if (frame.displayWidth === cfg.width && frame.displayHeight === cfg.height) return new VideoFrame(frame, { timestamp });
      if (!plain) { plain = new OffscreenCanvas(cfg.width, cfg.height); ctx = plain.getContext('2d', { alpha: false }); }
      const scale = Math.min(cfg.width / frame.displayWidth, cfg.height / frame.displayHeight);
      const w = Math.round(frame.displayWidth * scale), h = Math.round(frame.displayHeight * scale);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cfg.width, cfg.height);
      ctx.drawImage(frame, (cfg.width - w) >> 1, (cfg.height - h) >> 1, w, h);
      return new VideoFrame(plain, { timestamp });
    };

    vreader = video.getReader();
    const frameMs = 1000 / cfg.fps;
    let due = 0, lastKey = -Infinity, skipped = 0, taken = 0, lastStat = nowMs(), statFrames = 0, source = null, told = false;
    for (;;) {
      const { value: frame, done } = await vreader.read();
      if (done || state.stopped) { frame?.close(); break; }
      const now = nowMs();
      if (!told) {
        told = true;
        source = { width: frame.displayWidth, height: frame.displayHeight };
        postMessage({ type: 'info', ...info, source, codec: config.codec, encoder: config.hardwareAcceleration === 'prefer-hardware' ? 'graphics chip' : 'software', lut: !!look });
      }
      // A device that gives more frames than the stream takes: the extra ones are left out.
      if (now < due - frameMs * 0.3) { frame.close(); continue; }
      due = Math.max(due + frameMs, now - frameMs);
      // An encoder that is behind: this frame is left out so the stream stays live.
      if (venc.encodeQueueSize > 3) { frame.close(); skipped++; continue; }
      try {
        const out = fit(frame, Math.round(now * 1000));
        const keyFrame = state.wantKey || now - lastKey >= 2000;
        if (keyFrame) { lastKey = now; state.wantKey = false; }
        venc.encode(out, { keyFrame });
        out.close();
        taken++;
        statFrames++;
      } catch (e) { frame.close(); die(e); return; }
      frame.close();
      if (now - lastStat >= 1000) {
        postMessage({ type: 'stats', fps: Math.round((statFrames * 1000) / (now - lastStat)), skipped, frames: taken, encoded });
        lastStat = now;
        statFrames = 0;
      }
    }
    if (!state.stopped) die('The video device stopped sending pictures (unplugged, or taken by another program)');
  })().catch(die);

  return state;
}
