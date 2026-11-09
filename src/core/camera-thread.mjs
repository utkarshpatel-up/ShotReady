// The main thread's handle on one camera's video thread (camera-worker.mjs).
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';

// A packaged app cannot start a thread from inside its archive, so these files are unpacked.
const WORKER = fileURLToPath(new URL('./camera-worker.mjs', import.meta.url)).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);

export class CameraThread {
  /** @param on { viewers(n), state(state, reason), wave(jpegBuffer), stats(frames), failed(message) } */
  constructor(id, { url, auth }, on) {
    this.id = id;
    this.base = null;
    this.mode = { parallel: 0, intervalMs: 0, waveGap: 0 };
    this.worker = new Worker(WORKER, { workerData: { id, url, auth } });
    this.worker.unref();
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('error', (e) => { on.failed?.(e.message); reject(e); });
      this.worker.on('message', (m) => {
        if (m.type === 'ready') { this.base = m.base; resolve(m.base); }
        else if (m.type === 'viewers') on.viewers?.(m.n);
        else if (m.type === 'state') on.state?.(m.state, m.reason);
        else if (m.type === 'wave') on.wave?.(Buffer.from(m.jpeg));
        else if (m.type === 'stats') on.stats?.(m.frames);
      });
    });
    this.ready.catch(() => {});
  }

  setMode(mode) {
    this.mode = mode;
    this.worker.postMessage({ type: 'mode', ...mode });
  }

  setSource(url, auth) { this.worker.postMessage({ type: 'source', url, auth }); }

  stop() {
    this.worker.postMessage({ type: 'stop' });
    setTimeout(() => this.worker.terminate(), 500).unref?.();
  }
}
