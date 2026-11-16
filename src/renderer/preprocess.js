// The hidden pre-processing window: it only carries messages between the pre-processing thread
// (preprocess-worker.mjs) and the main process, which reads and writes the files.
'use strict';

const api = window.shotready;
let job = null;
const worker = new Worker('preprocess-worker.mjs', { type: 'module' });

worker.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'call') { api.call('ppReport', m).catch(() => {}); return; }
  try {
    const data = m.name === 'read'
      ? await api.call('ppRead', job, m.args.offset, m.args.length)
      : await api.call('ppWrite', job, m.args.bytes, m.args.position);
    worker.postMessage({ type: 'reply', req: m.req, data }, data?.buffer ? [data.buffer] : []);
  } catch (err) {
    worker.postMessage({ type: 'reply', req: m.req, error: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
  }
};
worker.onerror = (e) => { e.preventDefault?.(); api.call('ppReport', { type: 'failed', id: job, message: e.message || 'the pre-processing thread stopped' }).catch(() => {}); };

api.on('preprocess', (m) => {
  if (m.type === 'start') job = m.job.id;
  worker.postMessage(m, m.job?.lut?.data?.buffer ? [m.job.lut.data.buffer] : []);
});
api.call('ppReady').catch(() => {});
