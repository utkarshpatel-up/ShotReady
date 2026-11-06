// Prints every change a camera pushes, so a setting's key can be found by changing it on the
// camera. Read-only. Usage: npm run watch -- 192.168.8.10
import { CameraStream } from '../src/core/stream.mjs';

const ip = process.argv[2] || '192.168.8.10';
let known = null;
new CameraStream(`http://${ip}/-wvhttp-01-/info.cgi`, () => null, {
  up: () => console.log(`Connected to ${ip}. Change a setting on the camera. Ctrl+C to stop.`),
  down: (reason) => console.log(`Disconnected: ${reason}`),
  update: (items) => {
    if (!known) { known = items; console.log(`${Object.keys(items).length} settings read.`); return; }
    for (const [k, v] of Object.entries(items)) {
      console.log(`${new Date().toLocaleTimeString()}  ${k}: ${known[k] ?? '(new)'} -> ${v}`);
      known[k] = v;
    }
  },
});
