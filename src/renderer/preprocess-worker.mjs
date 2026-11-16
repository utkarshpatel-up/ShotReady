// Pre-processing one video: a new MP4 with the inverse LUT already in every frame. Runs in its own
// thread, in a hidden window of its own, so neither the app nor the video out window waits for it.
//
// The graphics chip does the work where it can: WebCodecs decodes and encodes on its video engine
// (hardware first, software if the chip cannot), and the LUT is applied by WebGL2 on an off-screen
// canvas. The picture never visits the CPU in between. The sound is copied as it is. File reads
// and writes go to the main process, a range at a time, so a long file is never held in memory.
import { readMp4, Mp4Writer, avcEntry } from '../core/mp4.mjs';
import { lutCanvas } from './lut-gl.mjs';

let reqs = 0, cancelled = false, playing = false;
const waiting = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Asks the main process (through the hidden window) to read or write.
function call(name, args, transfer = []) {
  return new Promise((resolve, reject) => {
    const req = ++reqs;
    waiting.set(req, { resolve, reject });
    postMessage({ type: 'call', req, name, args }, transfer);
  });
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'reply') {
    const w = waiting.get(m.req);
    waiting.delete(m.req);
    if (m.error) w?.reject(new Error(m.error)); else w?.resolve(m.data);
  } else if (m.type === 'start') {
    cancelled = false;
    run(m.job).then((info) => postMessage({ type: 'done', id: m.job.id, info }),
      (err) => postMessage({ type: 'failed', id: m.job.id, message: cancelled ? 'cancelled' : String(err?.message || err) }));
  } else if (m.type === 'cancel') cancelled = true;
  else if (m.type === 'pace') playing = !!m.playing;
};

// The first configuration this computer takes: on the graphics chip, else in software.
async function pick(Codec, config, failure) {
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
    const c = { ...config, hardwareAcceleration };
    try { if ((await Codec.isConfigSupported(c)).supported) return c; } catch { /* the next one */ }
  }
  throw new Error(failure);
}

// Runs of samples that sit next to each other in the file, read in one go (up to 8 MB).
function runs(t) {
  const out = [];
  for (let i = 0; i < t.count;) {
    let j = i + 1, bytes = t.sizes[i];
    while (j < t.count && bytes < 8e6 && t.offsets[j] === t.offsets[j - 1] + t.sizes[j - 1]) { bytes += t.sizes[j]; j++; }
    out.push([i, j, bytes]);
    i = j;
  }
  return out;
}

async function run(job) {
  const started = performance.now();
  const src = await readMp4((offset, length) => call('read', { offset, length }), job.size);
  const v = src.video;
  if (!v || !v.count) throw new Error('The file has no video track');
  if (!v.codec) throw new Error(`Its video (${v.entryType}) cannot be pre-processed: H.264 and HEVC MP4 files can. It still plays with the LUT applied live`);
  const decoderConfig = await pick(VideoDecoder, { codec: v.codec, codedWidth: v.width, codedHeight: v.height, ...(v.description ? { description: v.description } : {}) },
    `This computer cannot decode ${v.codec}. It still plays with the LUT applied live, if the computer plays it at all`);
  const width = v.width & ~1, height = v.height & ~1; // H.264 needs even sizes
  let first = Infinity;
  for (let i = 0; i < v.count; i++) first = Math.min(first, v.cts[i]);
  const seconds = (v.dts[v.count - 1] + v.durations[v.count - 1]) / v.timescale;
  const fps = v.count / seconds;
  const pixels = width * height;
  const bitrate = pixels >= 3840 * 2160 * 0.9 ? 60e6 : pixels >= 1920 * 1080 * 0.9 ? 25e6 : 12e6;
  const level = pixels > 2228224 ? (fps > 30 ? '640034' : '640033') : pixels > 983040 ? (fps > 30 ? '64002a' : '640028') : '64001f';
  const encoderConfig = await pick(VideoEncoder, { codec: `avc1.${level}`, width, height, bitrate, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' },
    `This computer cannot encode ${width}×${height} H.264`);
  const look = lutCanvas(width, height, job.lut);
  const gop = Math.max(1, Math.round(fps));

  const writer = new Mp4Writer((bytes, position) => call('write', { bytes, position }, [bytes.buffer]));
  await writer.start();
  let track = -1, writes = Promise.resolve(), failure = null, made = 0, last = performance.now();

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      if (track < 0) track = writer.addTrack({ kind: 'video', timescale: v.timescale, width, height, entry: avcEntry(width, height, new Uint8Array(meta.decoderConfig.description)), lastDuration: v.durations[v.count - 1] });
      const dts = Math.round((chunk.timestamp * v.timescale) / 1e6);
      const key = chunk.type === 'key';
      writes = writes.then(() => writer.addSample(track, bytes, { dts, key }));
    },
    error: (e) => { failure ||= e; },
  });
  encoder.configure(encoderConfig);
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const out = look.apply(frame);
        encoder.encode(out, { keyFrame: made % gop === 0 });
        out.close();
        made++;
      } catch (e) { failure ||= e; } finally { frame.close(); }
    },
    error: (e) => { failure ||= e; },
  });
  decoder.configure(decoderConfig);

  // Feeds the decoder no faster than both coders can take, and while video out is playing, no faster
  // than one and a half times real time, so the playing clip keeps the graphics chip's attention.
  const frameMs = 1000 / fps;
  const ready = async () => {
    while (decoder.decodeQueueSize > 4 || encoder.encodeQueueSize > 4) await sleep(2);
    if (playing) {
      const wait = frameMs / 1.5 - (performance.now() - last);
      if (wait > 0) await sleep(wait);
    }
    last = performance.now();
  };
  let fed = 0;
  for (const [i, j, bytes] of runs(v)) {
    const data = await call('read', { offset: v.offsets[i], length: bytes });
    let at = 0;
    for (let k = i; k < j; k++) {
      if (cancelled) throw new Error('cancelled');
      if (failure) throw failure;
      await ready();
      decoder.decode(new EncodedVideoChunk({
        type: v.isKey(k) ? 'key' : 'delta', timestamp: Math.round(((v.cts[k] - first) * 1e6) / v.timescale),
        duration: Math.round((v.durations[k] * 1e6) / v.timescale), data: data.subarray(at, at + v.sizes[k]),
      }));
      at += v.sizes[k];
      if (++fed % 12 === 0) postMessage({ type: 'progress', id: job.id, done: made, total: v.count, speed: (made / fps) / ((performance.now() - started) / 1000) });
    }
  }
  await decoder.flush();
  await encoder.flush();
  await writes;
  if (failure) throw failure;
  decoder.close();
  encoder.close();

  // The sound, copied as it is.
  const a = src.audio;
  if (a && a.count) {
    const at = writer.addTrack({ kind: 'audio', timescale: a.timescale, entry: a.entry, lastDuration: a.durations[a.count - 1] });
    for (const [i, j, bytes] of runs(a)) {
      if (cancelled) throw new Error('cancelled');
      const data = await call('read', { offset: a.offsets[i], length: bytes });
      let off = 0;
      for (let k = i; k < j; k++) {
        await writer.addSample(at, data.slice(off, off + a.sizes[k]), { dts: a.dts[k] });
        off += a.sizes[k];
      }
    }
  }
  await writer.finish();
  const took = (performance.now() - started) / 1000;
  return {
    frames: made, seconds, width, height, fps, took, speed: seconds / took, sound: !!(a && a.count),
    decode: decoderConfig.hardwareAcceleration === 'prefer-hardware' ? 'graphics chip' : 'software',
    encode: encoderConfig.hardwareAcceleration === 'prefer-hardware' ? 'graphics chip' : 'software',
  };
}
