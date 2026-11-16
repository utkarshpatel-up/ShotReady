// The live stream's sending, in a thread of its own: the RTMP connection, and for "Test on this
// computer" the server that receives it. The main thread hands it encoded pictures and sound and
// is never held up by the network; this thread is never held up by the app.
import { parentPort } from 'node:worker_threads';
import { RtmpPublisher } from './rtmp.mjs';

const post = (m) => parentPort.postMessage(m);
let pub = null, conn = 0, base = null, server = null, meta = null, vconf = null, aconf = null, sentBefore = 0, droppedBefore = 0;

async function connect({ req, url, key, maxBacklog }) {
  const id = ++conn;
  const old = pub;
  pub = null;
  if (old) { sentBefore += old.sent; droppedBefore += old.dropped; old.close(); }
  try {
    const p = new RtmpPublisher({ url, key, maxBacklogBytes: maxBacklog });
    await p.connect();
    if (id !== conn) { p.close(); post({ type: 'reply', req, error: 'cancelled' }); return; }
    pub = p;
    base = null;
    // A new connection is told again what the stream is, before the next key frame.
    if (meta) p.metadata(meta);
    if (vconf) p.videoConfig(vconf);
    if (aconf) p.audioConfig(aconf);
    p.on('close', (why) => {
      if (pub !== p) return;
      sentBefore += p.sent;
      droppedBefore += p.dropped;
      pub = null;
      post({ type: 'dropped', why });
    });
    post({ type: 'reply', req });
  } catch (e) {
    post({ type: 'reply', req, error: e.message });
  }
}

async function testServer({ req, file }) {
  try {
    if (!server) {
      const { RtmpTestServer } = await import('../sim/rtmp-server.mjs');
      server = new RtmpTestServer({ file: () => file });
      await server.listen();
    }
    post({ type: 'reply', req, data: server.url });
  } catch (e) { post({ type: 'reply', req, error: e.message }); }
}

function testView() {
  if (!server) return null;
  const t = server.stats;
  return { frames: t.frames, keyFrames: t.keyFrames, audioFrames: t.audioFrames, seconds: t.firstMs === null ? 0 : (t.lastMs - t.firstMs) / 1000, megabytes: t.bytes / 1e6, video: !!t.videoConfig, sound: !!t.audioConfig, width: t.meta?.width, height: t.meta?.height, file: t.file };
}

parentPort.on('message', (m) => {
  const p = pub;
  switch (m.type) {
    case 'connect': connect(m); break;
    case 'testServer': testServer(m); break;
    case 'video': {
      if (!p?.live) break;
      const data = Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength);
      // Each connection's times start at 0, on a key frame.
      if (base === null) { if (!m.key) break; base = m.ms; }
      p.video(m.ms - base, data, m.key);
      break;
    }
    case 'audio':
      if (p?.live && base !== null && m.ms >= base) p.audio(m.ms - base, Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength));
      break;
    case 'meta': meta = m.meta; p?.metadata(meta); break;
    case 'vconf': vconf = Buffer.from(m.data); p?.videoConfig(vconf); break;
    case 'aconf': aconf = Buffer.from(m.data); p?.audioConfig(aconf); break;
    case 'stats': post({ type: 'stats', req: m.req, sent: sentBefore + (p?.sent || 0), dropped: droppedBefore + (p?.dropped || 0), backlog: p?.backlog || 0, test: testView() }); break;
    case 'end':
      conn++;
      pub = null;
      p?.close();
      meta = vconf = aconf = null;
      base = null;
      sentBefore = droppedBefore = 0;
      post({ type: 'reply', req: m.req, data: testView() });
      break;
    case 'quit':
      p?.close();
      server?.close();
      setTimeout(() => process.exit(0), 300);
      break;
  }
});
post({ type: 'ready' });
