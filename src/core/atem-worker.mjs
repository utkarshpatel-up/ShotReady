// The ATEM link in its own thread. atem-connection keeps the switcher's whole state here and answers
// its packets on time, whatever the main thread is doing. The main thread only hears what ShotReady
// uses (video format, input names, program and preview, what is visible on air), and only when that
// changes: a switcher sends many updates a second during a transition, and most change none of it.
// The one command it carries the other way is a program cut (F1 / F2), answered when the ATEM took it.
import { parentPort, workerData } from 'node:worker_threads';
import { readAtemState } from './atem-state.mjs';

const post = (msg) => parentPort.postMessage(msg);
let lib;
try {
  const m = await import(workerData.lib);
  lib = m.default?.Atem ? m.default : m;
} catch (e) {
  post({ type: 'failed', message: `ATEM library failed to load: ${e.message}` });
  process.exit(1);
}
const { Atem, Enums } = lib;
let current = null; // { id, atem, last }

async function close() {
  const c = current;
  current = null;
  if (c) { try { await c.atem.disconnect(); await c.atem.destroy(); } catch { /* closing anyway */ } }
}

function open(id, ip) {
  // This thread is the ATEM's own, so the library does not start another one.
  const atem = new Atem({ disableMultithreaded: true });
  const c = current = { id, atem, last: '' };
  const send = (type, extra = {}) => { if (current === c) post({ type, id, ...extra }); };
  const snapshot = () => {
    // Everything visible on M/E 1, including keyers and anything fed in from another M/E.
    const visible = (mode) => { try { return atem.listVisibleInputs(mode, 0); } catch { return []; } };
    return { ...readAtemState(atem.state, Enums.VideoMode), tally: { program: visible('program'), preview: visible('preview') } };
  };
  atem.on('connected', () => {
    const data = snapshot();
    c.last = JSON.stringify(data);
    send('connected', { data });
  });
  atem.on('disconnected', () => send('disconnected'));
  atem.on('stateChanged', () => {
    const data = snapshot();
    const key = JSON.stringify(data);
    if (key === c.last) return;
    c.last = key;
    send('state', { data });
  });
  atem.on('error', (e) => send('error', { message: String(e?.message || e) }));
  atem.connect(ip).catch((e) => send('error', { message: e.message }));
}

parentPort.on('message', async (m) => {
  if (m.type === 'connect') {
    await close();
    open(m.id, m.ip);
  } else if (m.type === 'program') {
    const reply = (error) => post({ type: 'done', id: m.id, req: m.req, error });
    if (current?.id !== m.id) { reply('the ATEM is not connected'); return; }
    current.atem.changeProgramInput(m.input, m.me).then(() => reply(null), (e) => reply(e.message));
  } else if (m.type === 'close') {
    if (current?.id === m.id) await close();
  } else if (m.type === 'stop') {
    await close();
    process.exit(0);
  }
});

post({ type: 'ready' });
