// One camera's waveform and RGB, measured in a thread of their own. Decoding a camera picture takes
// tens of milliseconds (more for a large preview); done in the camera's frame thread it would hold
// up the frames arriving meanwhile, which shows as lag and stutter. Here it holds up nothing.
import { parentPort } from 'node:worker_threads';
import { decodeJpeg } from './jpeg.mjs';
import { lumaStats } from './waveform.mjs';

parentPort.on('message', ({ jpeg }) => {
  try {
    const pic = decodeJpeg(new Uint8Array(jpeg), { step: 2 });
    parentPort.postMessage({ wave: lumaStats(pic.data, pic.width, pic.height, { bgra: false, step: 1 }) });
  } catch (e) {
    parentPort.postMessage({ error: e.message });
  }
});
