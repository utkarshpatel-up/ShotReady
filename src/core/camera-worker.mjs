// One camera's video, in its own thread: reads the frames, serves them to the screen on its own
// local port, and measures the waveform from them. A camera that stalls cannot slow another camera
// or the interface, and decoding pictures never takes time from the main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { FrameSource } from './frames.mjs';
import { FeedServer } from './feedserver.mjs';
import { decodeJpeg } from './jpeg.mjs';
import { lumaStats } from './waveform.mjs';

const { id } = workerData;
const post = (msg, transfer) => parentPort.postMessage(msg, transfer);
let auth = workerData.auth;
let waveGap = 0, waveAt = 0, frames = 0;
// The waveform is measured here. A frame this thread cannot decode goes to the main thread to be
// decoded there instead; after three in a row, every frame does, so the waveform never stops.
let measureHere = true, misses = 0;

function measure(jpeg) {
  if (measureHere) {
    try {
      const pic = decodeJpeg(jpeg, { step: 2 });
      post({ type: 'level', wave: lumaStats(pic.data, pic.width, pic.height, { bgra: false, step: 1 }) });
      misses = 0;
      return;
    } catch (e) {
      if (++misses >= 3) {
        measureHere = false;
        post({ type: 'note', text: `waveform measured on the main thread from now on (${e.message})` });
      }
    }
  }
  const copy = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
  post({ type: 'wave', jpeg: copy }, [copy]);
}

const feed = new FeedServer({ onViewers: (_body, n) => post({ type: 'viewers', n }) });
const source = new FrameSource(workerData.url, () => auth, {
  onFrame: (jpeg) => {
    feed.push(id, jpeg);
    frames++;
    // An occasional frame is measured for the waveform.
    const now = Date.now();
    if (waveGap > 0 && now - waveAt >= waveGap) {
      waveAt = now;
      measure(jpeg);
    }
  },
  onState: (state, reason) => post({ type: 'state', state, reason }),
});

setInterval(() => { post({ type: 'stats', frames }); frames = 0; }, 1000);

parentPort.on('message', (m) => {
  if (m.type === 'mode') {
    waveGap = m.waveGap;
    source.setMode({ parallel: m.parallel, intervalMs: m.intervalMs });
  } else if (m.type === 'source') {
    source.url = m.url;
    auth = m.auth;
  } else if (m.type === 'stop') {
    source.stop();
    feed.stop();
    process.exit(0);
  }
});

post({ type: 'ready', base: await feed.start() });
source.start();
