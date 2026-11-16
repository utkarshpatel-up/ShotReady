// Pre-processing in the background. A hidden window runs a thread that decodes each video, applies
// the inverse LUT on the graphics chip and encodes it again (src/renderer/preprocess-worker.mjs).
// This side keeps the list of jobs, runs one at a time, and does the file reading and writing for
// the thread, a range at a time. A job writes to a .part file, renamed only when it is complete.
import { BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import { open, rename, rm, stat } from 'node:fs/promises';

export class Preprocessor extends EventEmitter {
  /** @param o.page  preprocess.html; o.preload  the preload script */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.jobs = [];
    this.current = null;
    this.win = null;
    this.ready = null;
    this.playing = false;
  }

  /** @param job { id, input, output, lut } */
  add(job) {
    if (this.current?.id === job.id || this.jobs.some((j) => j.id === job.id)) return;
    this.jobs.push(job);
    this.next();
  }

  cancel(id) {
    if (this.current?.id === id) { this.send({ type: 'cancel' }); return; }
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length !== before) this.emit('failed', { id, message: 'cancelled' });
  }

  busy(id) { return this.current?.id === id || this.jobs.some((j) => j.id === id); }

  // While video out is playing, the thread works no faster than one and a half times real time.
  pace(playing) {
    if (this.playing === playing) return;
    this.playing = playing;
    this.send({ type: 'pace', playing });
  }

  send(msg) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('shotready:preprocess', msg); }

  window() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    const win = new BrowserWindow({
      show: false, width: 320, height: 200, skipTaskbar: true, title: 'ShotReady pre-processing',
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      if (this.current) this.finish(this.current, { type: 'failed', message: 'the pre-processing window closed' });
    });
    this.win = win;
    this.ready = new Promise((resolve) => { this.onReady = resolve; });
    win.loadFile(this.page);
    return this.ready;
  }

  pageReady() { this.onReady?.(); }

  async next() {
    if (this.current || !this.jobs.length) return;
    const job = this.jobs.shift();
    this.current = job;
    try {
      const { size } = await stat(job.input);
      job.in = await open(job.input, 'r');
      job.part = `${job.output}.part`;
      job.out = await open(job.part, 'w+');
      job.end = 0;
      await this.window();
      this.send({ type: 'pace', playing: this.playing });
      this.send({ type: 'start', job: { id: job.id, size, lut: job.lut } });
      this.emit('progress', { id: job.id, done: 0, total: 0, speed: 0 });
    } catch (e) {
      await this.finish(job, { type: 'failed', message: e.message });
    }
  }

  job(id) {
    const j = this.current;
    if (!j || j.id !== id || !j.in) throw new Error('That is not the video being pre-processed');
    return j;
  }

  async read(id, offset, length) {
    const j = this.job(id);
    if (!(length > 0 && length <= 64e6) || !(offset >= 0)) throw new Error('Bad read');
    const buf = Buffer.alloc(length);
    const { bytesRead } = await j.in.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  }

  async write(id, bytes, position) {
    const j = this.job(id);
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (position === null || position === undefined) {
      await j.out.write(b, 0, b.length, j.end);
      j.end += b.length;
    } else {
      if (!(position >= 0 && position + b.length <= j.end)) throw new Error('Bad write');
      await j.out.write(b, 0, b.length, position);
    }
    return true;
  }

  report(msg) {
    const j = this.current;
    if (!j || msg.id !== j.id) return;
    if (msg.type === 'progress') this.emit('progress', { id: j.id, done: msg.done, total: msg.total, speed: msg.speed });
    else if (msg.type === 'done' || msg.type === 'failed') this.finish(j, msg);
  }

  async finish(job, msg) {
    await job.in?.close().catch(() => {});
    await job.out?.close().catch(() => {});
    job.in = job.out = null;
    if (msg.type === 'done') {
      try {
        await rename(job.part, job.output);
        this.emit('done', { id: job.id, output: job.output, info: msg.info });
      } catch (e) {
        this.emit('failed', { id: job.id, message: e.message });
      }
    } else {
      if (job.part) await rm(job.part, { force: true }).catch(() => {});
      this.emit('failed', { id: job.id, message: msg.message });
    }
    if (this.current === job) this.current = null;
    this.next();
  }

  stop() {
    this.jobs = [];
    const win = this.win;
    this.win = null;
    if (this.current) this.finish(this.current, { type: 'failed', message: 'cancelled' });
    if (win && !win.isDestroyed()) win.close();
  }
}
