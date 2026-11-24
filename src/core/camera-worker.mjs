// One camera's video, in its own thread: reads the frames, serves them to the screen on its own
// local port, and measures the waveform from them. A camera that stalls cannot slow another camera
// or the interface, and decoding pictures never takes time from the main thread.
import { parentPort, workerData, Worker } from 'node:worker_threads';
import { FrameSource } from './frames.mjs';
import { FeedServer } from './feedserver.mjs';
import { decodeJpeg } from './jpeg.mjs';
import { lumaStats } from './waveform.mjs';
import { IpVideoReceiver } from './ipvideo.mjs';

const { id } = workerData;
const post = (msg, transfer) => parentPort.postMessage(msg, transfer);
let auth = workerData.auth;
let waveGap = 0, waveAt = 0, frames = 0, bytes = 0;
// The waveform is measured in a thread of its own (wave-worker.mjs), so decoding a picture never holds
// up this camera's frames. A picture arriving while the last is still being measured is not queued.
// If that thread cannot start, it is measured here as before. A frame that cannot be decoded goes
// to the main thread to be decoded there; after three in a row, every frame does, so the waveform
// never stops.
let measureHere = true, misses = 0, waveBusy = false, waveThread = null;
try {
  waveThread = new Worker(new URL('./wave-worker.mjs', import.meta.url));
  waveThread.unref();
  waveThread.on('message', (m) => {
    waveBusy = false;
    if (m.wave) { misses = 0; post({ type: 'level', wave: m.wave }); } else failed(m.error);
  });
  waveThread.on('error', () => { waveThread = null; waveBusy = false; });
} catch { waveThread = null; }

function failed(message) {
  if (++misses >= 3 && measureHere) {
    measureHere = false;
    post({ type: 'note', text: `waveform measured on the main thread from now on (${message})` });
  }
}

function measure(jpeg) {
  if (measureHere && waveThread) {
    if (waveBusy) return;
    waveBusy = true;
    const copy = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
    waveThread.postMessage({ jpeg: copy }, [copy]);
    return;
  }
  if (measureHere) {
    try {
      const pic = decodeJpeg(jpeg, { step: 2 });
      post({ type: 'level', wave: lumaStats(pic.data, pic.width, pic.height, { bgra: false, step: 1 }) });
      misses = 0;
      return;
    } catch (e) {
      failed(e.message);
      if (measureHere) return;
    }
  }
  const copy = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
  post({ type: 'wave', jpeg: copy }, [copy]);
}

const feed = new FeedServer({
  onViewers: (_body, n) => post({ type: 'viewers', n }),
  onVideoViewers: (_body, n) => post({ type: 'videoViewers', n }),
});
// The camera's own IP video, when it is switched on for this camera: received on its UDP port.
let ipVideo = null;
function setIpVideo(port) {
  if (ipVideo?.port === port) return;
  ipVideo?.stop();
  ipVideo = null;
  if (!port) { post({ type: 'ipstats', stats: null }); return; }
  ipVideo = new IpVideoReceiver({ port, onPicture: (p) => feed.pushVideo(id, p), onStats: (stats) => post({ type: 'ipstats', stats }) });
  ipVideo.start();
}
const source = new FrameSource(workerData.url, () => auth, {
  onFrame: (jpeg) => {
    feed.push(id, jpeg);
    frames++;
    bytes += jpeg.length;
    // An occasional frame is measured for the waveform.
    const now = Date.now();
    if (waveGap > 0 && now - waveAt >= waveGap) {
      waveAt = now;
      measure(jpeg);
    }
  },
  onState: (state, reason) => post({ type: 'state', state, reason }),
});

setInterval(() => { post({ type: 'stats', frames, bytes }); frames = 0; bytes = 0; }, 1000);

parentPort.on('message', (m) => {
  if (m.type === 'mode') {
    waveGap = m.waveGap;
    source.setMode({ parallel: m.parallel, intervalMs: m.intervalMs, periodMs: m.periodMs || 0 });
  } else if (m.type === 'ipvideo') {
    setIpVideo(m.port || null);
  } else if (m.type === 'source') {
    source.url = m.url;
    auth = m.auth;
  } else if (m.type === 'stop') {
    ipVideo?.stop();
    waveThread?.terminate();
    source.stop();
    feed.stop();
    process.exit(0);
  }
});

post({ type: 'ready', base: await feed.start() });
source.start();
