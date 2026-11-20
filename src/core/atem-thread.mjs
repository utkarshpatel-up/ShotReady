// The main thread's handle on the ATEM's own thread (atem-worker.mjs). One thread serves every
// connection attempt in turn, so searching does not load the library again for each address.
// A session looks like an atem-connection Atem to AtemLink: connect, disconnect, destroy, the
// connected / disconnected / stateChanged / error events, and snapshot() for the state it uses.
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sep } from 'node:path';

// A thread cannot be started from inside the app's archive, or load a library from it, so both the
// thread's file and the library are taken from the unpacked copy (asarUnpack in package.json).
const unpacked = (p) => p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const WORKER = unpacked(fileURLToPath(new URL('./atem-worker.mjs', import.meta.url)));
const libraryUrl = () => pathToFileURL(unpacked(createRequire(import.meta.url).resolve('atem-connection'))).href;

class AtemSession extends EventEmitter {
  constructor(host, id) {
    super();
    Object.assign(this, { host, id, data: null, waiting: new Map(), reqs: 0 });
  }
  receive(m) {
    if (m.type === 'done') {
      const w = this.waiting.get(m.req);
      this.waiting.delete(m.req);
      if (w) { clearTimeout(w.timer); if (m.error) w.reject(new Error(m.error)); else w.resolve(); }
      return;
    }
    if (m.type === 'connected') { this.data = m.data; this.emit('connected'); }
    else if (m.type === 'state') { this.data = m.data; this.emit('stateChanged'); }
    else if (m.type === 'disconnected') this.emit('disconnected');
    else if (m.type === 'error' && this.listenerCount('error')) this.emit('error', m.message);
  }
  snapshot() { return this.data; }
  // Program or preview on an M/E, the way atem-connection's Atem takes them. Settles when the ATEM
  // has the command.
  changeProgramInput(input, me = 0) { return this.#send('program', input, me); }
  changePreviewInput(input, me = 0) { return this.#send('preview', input, me); }
  #send(type, input, me) {
    return new Promise((resolve, reject) => {
      const req = ++this.reqs;
      const timer = setTimeout(() => { this.waiting.delete(req); reject(new Error('the ATEM did not answer')); }, 3000);
      this.waiting.set(req, { resolve, reject, timer });
      this.host.post({ type, id: this.id, req, input, me });
    });
  }
  async connect(ip) { this.host.post({ type: 'connect', id: this.id, ip }); }
  async disconnect() {
    this.host.sessions.delete(this.id);
    this.host.post({ type: 'close', id: this.id });
  }
  async destroy() {}
}

export class AtemThread {
  /** @param opts.lib  the library's file URL, replaceable for tests */
  constructor({ lib } = {}) {
    this.sessions = new Map();
    this.ids = 0;
    this.dead = null;
    this.worker = new Worker(WORKER, { workerData: { lib: lib || libraryUrl() } });
    this.worker.unref();
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', (m) => {
        if (m.type === 'ready') resolve();
        else if (m.type === 'failed') reject(new Error(m.message));
        else this.sessions.get(m.id)?.receive(m);
      });
      // The thread stopping takes any connection with it: AtemLink reconnects, on a new thread.
      const gone = (why) => {
        reject(new Error(why));
        if (this.dead) return;
        this.dead = why;
        for (const s of this.sessions.values()) { s.receive({ type: 'error', message: why }); s.receive({ type: 'disconnected' }); }
      };
      this.worker.on('error', (e) => gone(e.message));
      this.worker.on('exit', (code) => gone(`the ATEM thread stopped (exit ${code})`));
    });
    this.ready.catch(() => {});
  }

  session() {
    const s = new AtemSession(this, ++this.ids);
    this.sessions.set(s.id, s);
    return s;
  }

  post(msg) { if (!this.dead) this.worker.postMessage(msg); }

  stop() {
    this.post({ type: 'stop' });
    setTimeout(() => this.worker.terminate(), 500).unref?.();
  }
}
