// One camera's video, in its own thread: reads the frames and serves them to the screen on its
// own local port. A camera that stalls cannot slow another camera or the interface.
import { parentPort, workerData } from 'node:worker_threads';
import { FrameSource } from './frames.mjs';
import { FeedServer } from './feedserver.mjs';

const { id } = workerData;
const post = (msg, transfer) => parentPort.postMessage(msg, transfer);
let auth = workerData.auth;
let waveGap = 0, waveAt = 0, frames = 0;

const feed = new FeedServer({ onViewers: (_body, n) => post({ type: 'viewers', n }) });
const source = new FrameSource(workerData.url, () => auth, {
  onFrame: (jpeg) => {
    feed.push(id, jpeg);
    frames++;
    // Only an occasional frame goes to the main thread, to measure the waveform.
    const now = Date.now();
    if (waveGap > 0 && now - waveAt >= waveGap) {
      waveAt = now;
      const copy = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
      post({ type: 'wave', jpeg: copy }, [copy]);
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
