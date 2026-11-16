// Video out: plays a video full screen on another display, the computer's HDMI output, which goes
// to a switcher input (through an HDMI-to-SDI converter on an SDI switcher). Every frame goes
// through the inverse LUT, so the clip arrives as flat as the cameras. The output window has no
// frame, no cursor and nothing else on it, and is black until something plays.
//
// Windows sets the output's resolution and frame rate; ShotReady scales the picture to whatever
// resolution the display runs at, and says when the display is not in the show's format. Nothing
// here ever holds the output back: a format that differs, a missing LUT or a graphics chip that
// cannot apply one are all said on the Video out tab, and the video still goes out. The output may
// feed an LED wall, or a mixer that matches frame rates itself.
//
// The Screen source sends a display instead of a clip, live, through a LUT picked for it: whatever is
// on that screen (slides, a browser, a document) goes out graded like a clip. With the source display
// apart from the output display, the output shows a copy of it. With the two the same, a single
// display included, the window covers that display with its own picture through the LUT: it is kept
// out of the capture (Windows 10 version 2004 or later), so it never films itself, and clicks go
// through it to the apps under it. A key turns it off from anywhere.
import { BrowserWindow, screen, desktopCapturer, globalShortcut } from 'electron';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { basename, join } from 'node:path';
import { existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const SHOW_FORMAT = { '4K25': { width: 3840, height: 2160, hz: 25 }, HD25: { width: 1920, height: 1080, hz: 25 } };
// Turns the Screen source's output off from any app, as its picture may cover the only display.
export const SCREEN_OFF_KEY = 'CommandOrControl+Shift+F12';
export const SCREEN_OFF_LABEL = 'Ctrl+Shift+F12';

export class Playout extends EventEmitter {
  /**
   * @param o.page          the output page (playout.html)
   * @param o.preload       the preload script
   * @param o.settings()    saved choices: { display: { id, label }, audio: { id, label }, volume, loop, applyLut,
   *                        source: 'clips' | 'screen', screen: { id, label }, screenLut: 'video' | 'own' | 'gamma:<gamma>' | 'none' }
   * @param o.save(patch)   saves changed choices
   * @param o.profile()     the show profile, 4K25 or HD25
   * @param o.lut()         the inverse LUT's data, or null
   * @param o.lutView()     the inverse LUT's name and ranges, or null
   * @param o.screenLuts()  the LUTs the Screen source can use: { video, own, gammas: { [gamma]: view } }
   * @param o.screenLutData(choice)  the data of one of them, or null
   * @param o.allowPrimary  allow the main display as the output (tests only)
   * @param o.preprocessor  the background pre-processing (Preprocessor)
   * @param o.outDir        where pre-processed files are kept
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.win = null;
    this.winKey = null;
    this.on_ = false;
    this.shortcut = null; // the screen-off key while it is held, false when another app has it
    this.media = { playing: false, position: 0, duration: 0, error: null, outputNote: null, ended: false };
    // The queue: the clips to play, in order, each with its pre-processing state. Kept between runs.
    this.ids = 0;
    this.queue = (this.settings().queue || []).filter((q) => q?.file && existsSync(q.file)).map((q) => ({
      id: this.newId(), file: q.file, name: basename(q.file),
      pre: q.pre?.state === 'done' && q.pre.output && existsSync(q.pre.output) ? q.pre : { state: 'none' },
    }));
    this.cued = this.queue[0]?.id || null;
    this.wirePreprocessor();
    const changed = () => this.reconcile();
    screen.on('display-added', changed);
    screen.on('display-removed', changed);
    screen.on('display-metrics-changed', changed);
  }

  displays() {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: d.id, label: d.label || `Display ${d.id}`, internal: !!d.internal, primary: d.id === primary,
      width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor),
      hz: Math.round(d.displayFrequency || 0), bounds: d.bounds,
    }));
  }

  source() { return this.settings().source === 'screen' ? 'screen' : 'clips'; }

  // The output display: the one chosen in ShotReady (by its id, or by its name after a restart),
  // never the main display for clips. With none chosen, the first other display; for the Screen
  // source, the main display when it is the only one. A chosen display that is not connected means no
  // output, rather than video on a screen nobody picked.
  target() {
    const all = this.displays(), screenOut = this.source() === 'screen';
    const usable = all.filter((d) => this.allowPrimary || screenOut || !d.primary);
    const want = this.settings().display;
    if (want) return usable.find((d) => d.id === want.id) || usable.find((d) => d.label === want.label) || null;
    if (screenOut) return all.find((d) => !d.primary) || all[0] || null;
    return usable[0] || null;
  }

  // The display the Screen source sends: the one chosen, else the main display.
  screenSource() {
    const all = this.displays(), want = this.settings().screen;
    if (want) return all.find((d) => d.id === want.id) || all.find((d) => d.label === want.label) || null;
    return all.find((d) => d.primary) || all[0] || null;
  }

  screenLutChoice() {
    const c = this.settings().screenLut;
    return c === 'own' || c === 'none' || /^gamma:/.test(c || '') ? c : 'video';
  }

  screenLutView() {
    const c = this.screenLutChoice(), views = this.screenLuts?.() || {};
    if (c === 'none') return null;
    if (c.startsWith('gamma:')) return views.gammas?.[c.slice(6)] || null;
    return views[c] || null;
  }

  // The LUT the output window applies: the inverse LUT for clips, the one picked for the screen.
  currentLut() {
    if (this.source() !== 'screen') return this.lut();
    const c = this.screenLutChoice();
    return c === 'none' ? null : this.screenLutData?.(c) || null;
  }

  formatWarning(t) {
    const want = SHOW_FORMAT[this.profile()];
    if (!t || !want) return null;
    const bad = [];
    if (t.width !== want.width || t.height !== want.height) bad.push(`${want.width}×${want.height}`);
    if (t.hz && t.hz !== want.hz) bad.push(`${want.hz} Hz`); // 0 means Windows did not say
    return bad.length ? `The output display runs at ${t.width}×${t.height} ${t.hz ? `${t.hz} Hz` : '(rate unknown)'}; the show is ${this.profile()} (${want.width}×${want.height} at ${want.hz} Hz). The video still goes out, scaled to fit. A switcher input that needs the show's format will not take it: then set the display to ${bad.join(' and ')} in Windows (Settings > System > Display, pick this display, then Advanced display). A mixer that matches frame rates itself, or an LED processor, takes it as it is.` : null;
  }

  newId() { return `q${Date.now().toString(36)}${++this.ids}`; }
  item(id) { return this.queue.find((q) => q.id === id) || null; }
  cuedItem() { return this.item(this.cued); }

  // A pre-processed copy is played when it was made with the LUT loaded now and the LUT is to be
  // applied; otherwise the original plays with the LUT applied live.
  isBaked(q) {
    const v = this.lutView()?.version;
    return !!(q && this.settings().applyLut !== false && q.pre.state === 'done' && v && q.pre.lutVersion === v && existsSync(q.pre.output));
  }

  preState(q) {
    if (q.pre.state === 'done' && !this.isBaked(q)) return this.settings().applyLut === false ? 'done' : 'stale';
    return q.pre.state;
  }

  persist() {
    this.save({ queue: this.queue.map((q) => ({ file: q.file, pre: q.pre.state === 'done' ? { state: 'done', output: q.pre.output, lutVersion: q.pre.lutVersion, info: q.pre.info } : { state: 'none' } })) });
  }

  wirePreprocessor() {
    const pre = this.preprocessor;
    if (!pre) return;
    pre.on('progress', ({ id, done, total, speed }) => {
      const q = this.item(id);
      if (!q) return;
      q.pre = { ...q.pre, state: 'working', progress: total ? done / total : 0, speed };
      this.emitStatus();
    });
    pre.on('done', ({ id, output, info }) => {
      const q = this.item(id);
      if (!q) { rmSync(output, { force: true }); return; }
      q.pre = { state: 'done', output, lutVersion: q.pre.lutVersion, info, progress: 1 };
      this.persist();
      const where = (w) => (w === 'software' ? 'in software' : 'on the graphics chip');
      this.emit('info', `Video out: ${q.name} pre-processed at ${info.speed.toFixed(1)}× real time (decoded ${where(info.decode)}, encoded ${where(info.encode)})`);
      this.emitStatus();
    });
    pre.on('failed', ({ id, message }) => {
      const q = this.item(id);
      if (!q) return;
      q.pre = message === 'cancelled' ? { state: 'none' } : { state: 'failed', error: message };
      if (message !== 'cancelled') this.emit('note', `Video out: ${q.name} could not be pre-processed (${message}). It plays with the LUT applied live.`);
      this.emitStatus();
    });
  }

  // Starts pre-processing one clip: a new MP4 with the LUT in every frame, in the data folder.
  preprocess(q) {
    const view = this.lutView(), lut = this.lut();
    if (!view || !lut) throw new Error('Load the inverse LUT first: pre-processing puts it into the file');
    if (!/\.(mp4|m4v|mov)$/i.test(q.file)) throw new Error(`${q.name}: pre-processing takes MP4 files (H.264 or HEVC). It plays with the LUT applied live`);
    if (this.preprocessor.busy(q.id)) return;
    mkdirSync(this.outDir, { recursive: true });
    const st = statSync(q.file);
    const tag = createHash('sha1').update(`${q.file}|${st.size}|${st.mtimeMs}|${view.version}`).digest('hex').slice(0, 8);
    const output = join(this.outDir, `${basename(q.file).replace(/\.[^.]+$/, '')} [LUT ${tag}].mp4`);
    q.pre = { state: 'waiting', progress: 0, lutVersion: view.version, output };
    this.preprocessor.add({ id: q.id, input: q.file, output, lut: { size: lut.size, data: lut.data, min: lut.min, max: lut.max, input: lut.input, output: lut.output } });
  }

  // With "pre-process the queue" on, every clip not yet done with this LUT is queued for it.
  preprocessAll() {
    if (!this.settings().preAll || !this.lutView()) return;
    for (const q of this.queue) {
      const st = this.preState(q);
      if ((st === 'none' || st === 'stale') && /\.(mp4|m4v|mov)$/i.test(q.file)) { try { this.preprocess(q); } catch { /* said when pressed by hand */ } }
    }
  }

  // Puts a clip in the player: paused and black, or playing.
  cue(q, play = false) {
    this.cued = q?.id || null;
    this.media = { ...this.media, playing: false, position: 0, duration: 0, error: null, ended: false };
    if (q) {
      const baked = this.isBaked(q);
      this.clipSend({ type: 'load', url: pathToFileURL(baked ? q.pre.output : q.file).href, position: 0, loop: !!this.settings().loop, baked });
      if (play) this.command('play');
    }
    this.emitStatus();
  }

  status() {
    const t = this.target();
    const q = this.cuedItem();
    const src = this.screenSource();
    const screenOut = this.source() === 'screen';
    return {
      source: this.source(), screen: src, screenChosen: this.settings().screen || null,
      overlay: !!(screenOut && src && t && src.id === t.id),
      screenLut: { choice: this.screenLutChoice(), view: this.screenLutView() }, screenLuts: this.screenLuts?.() || {},
      screenLutMissing: this.screenLutChoice() !== 'none' && !this.screenLutView(),
      shortcut: this.shortcut === false ? null : SCREEN_OFF_LABEL, // null: another app holds the key
      file: q?.file || null, name: q?.name || null, cued: this.cued, baked: this.isBaked(q),
      queue: this.queue.map((x) => ({ id: x.id, name: x.name, file: x.file, state: this.preState(x), progress: x.pre.progress || 0, speed: x.pre.speed || 0, error: x.pre.error || null, info: x.pre.info || null, mp4: /\.(mp4|m4v|mov)$/i.test(x.file) })),
      displays: this.displays(), target: t, chosen: this.settings().display || null, on: this.on_, open: !!this.win,
      warning: this.formatWarning(t), lut: this.lutView(), settings: this.settings(),
      lutMissing: this.settings().applyLut !== false && !this.lutView(), ...this.media,
    };
  }

  emitStatus() { this.emit('status', this.status()); }

  send(msg) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('shotready:playout', msg); }
  // Clip commands go to a window playing clips only, never into a screen being sent.
  clipSend(msg) { if (this.source() === 'clips') this.send(msg); }

  // Opens, moves or closes the output window to match: output on, and the output display present.
  // For the Screen source, the source display must be there too. A window is opened again when what
  // it shows changes (the source, or the size of the display sent); otherwise it is only moved.
  reconcile() {
    const t = this.target();
    const src = this.source() === 'screen' ? this.screenSource() : null;
    if (this.on_ && t && (this.source() === 'clips' || src)) this.openOn(t, src);
    else this.close();
    this.emitStatus();
  }

  openOn(d, src = null) {
    const key = src ? `screen|${d.id}|${src.id}|${src.width}x${src.height}` : `clips|${d.id}`;
    if (this.win && !this.win.isDestroyed()) {
      if (this.winKey === key) { this.win.setBounds(d.bounds); return; }
      this.close();
    }
    this.winKey = key;
    this.pageReady = false;
    const overlay = !!src && src.id === d.id;
    const win = new BrowserWindow({
      ...d.bounds, frame: false, show: false, backgroundColor: '#000000', skipTaskbar: true, focusable: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, enableLargerThanScreen: true, title: 'ShotReady video out',
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    // Above everything on that display, the taskbar included.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    if (src) {
      // Kept out of every screen capture, its own included, so a screen it covers is captured as it is
      // under it. Set again once shown: Windows can forget it when a window is first shown.
      win.setContentProtection(true);
      // Over the display it captures, the window lets the mouse through to the apps under it.
      if (overlay) win.setIgnoreMouseEvents(true);
      this.holdShortcut();
    }
    win.once('ready-to-show', () => { win.setBounds(d.bounds); win.showInactive(); if (src) win.setContentProtection(true); });
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      this.winKey = null;
      this.media.playing = false;
      this.releaseShortcut();
      this.emitStatus();
    });
    this.win = win;
    win.loadFile(this.page);
  }

  holdShortcut() {
    if (this.shortcut) return;
    try {
      this.shortcut = globalShortcut.register(SCREEN_OFF_KEY, () => {
        this.emit('note', `Video out: the screen output was turned off with ${SCREEN_OFF_LABEL}`);
        this.command('on', false);
      }) ? SCREEN_OFF_KEY : false;
    } catch { this.shortcut = false; }
  }

  releaseShortcut() {
    if (this.shortcut) { try { globalShortcut.unregister(SCREEN_OFF_KEY); } catch { /* already gone */ } }
    this.shortcut = null;
  }

  // The screen to send, found among the screens Windows offers for capture, by its display id.
  async startScreen() {
    const win = this.win, src = this.screenSource(), t = this.target();
    if (!win || !src) return;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const pick = sources.find((x) => String(x.display_id) === String(src.id)) || (sources.length === 1 ? sources[0] : null);
      if (!pick) throw new Error('Windows does not offer it for capture');
      if (this.win !== win) return;
      this.send({ type: 'screen', id: pick.id, width: src.width, height: src.height, fps: Math.max(25, Math.min(60, t?.hz || 60)), overlay: src.id === t?.id });
    } catch (e) {
      if (this.win !== win) return;
      this.media.error = `${src.label} cannot be sent: ${e.message}`;
      this.emitStatus();
    }
  }

  close() {
    const win = this.win;
    this.win = null;
    this.pageReady = false;
    this.pendingPlay = false;
    this.winKey = null;
    this.media.playing = false;
    this.releaseShortcut();
    if (win && !win.isDestroyed()) win.close();
  }

  // The output page is ready: it gets the LUT, the audio output and the loaded file, paused unless
  // Play was pressed while the window was still opening.
  restore() {
    const s = this.settings();
    this.pageReady = true;
    this.sendLut();
    if (this.source() === 'screen') {
      this.send({ type: 'applyLut', on: true });
      this.startScreen();
      return;
    }
    this.send({ type: 'applyLut', on: s.applyLut !== false });
    this.send({ type: 'volume', v: s.volume ?? 1 });
    this.send({ type: 'audio', ...(s.audio || { auto: true }) });
    const q = this.cuedItem();
    if (q) { const baked = this.isBaked(q); this.send({ type: 'load', url: pathToFileURL(baked ? q.pre.output : q.file).href, position: this.media.position, loop: !!s.loop, baked }); }
    if (this.pendingPlay && q) this.send({ type: 'play' });
    this.pendingPlay = false;
  }

  sendLut() {
    const l = this.currentLut();
    this.send({ type: 'lut', lut: l && { size: l.size, data: l.data, min: l.min, max: l.max, input: l.input, output: l.output } });
  }

  report(state) {
    const was = JSON.stringify([this.media.playing, Math.round(this.media.position), this.media.error]);
    // A screen being sent has no position: the clip's is kept for when it goes back to the player.
    const clip = this.source() === 'clips';
    Object.assign(this.media, {
      playing: !!state.playing, error: state.error || null,
      ...(clip ? { position: Number(state.position) || 0, duration: Number(state.duration) || this.media.duration } : {}),
      ...('note' in state ? { outputNote: state.note || null } : {}),
    });
    if (state.audioError) this.emit('note', `Video out: audio output could not be set (${state.audioError})`);
    // A screen covered by a window that is captured black would leave nothing to see: off it goes.
    if (state.screenBlack && this.status().overlay) {
      this.emit('note', 'Video out: the screen came out black, as Windows did not keep ShotReady\'s own window out of the capture (that needs Windows 10 version 2004 or later). The screen output was turned off; send the screen to another display instead.');
      this.command('on', false);
      return;
    }
    this.preprocessor?.pace(this.media.playing);
    // The end of a clip: with "next plays automatically" on, the next one in the queue starts.
    if (state.ended && !this.media.ended) {
      this.media.ended = true;
      const s = this.settings(), i = this.queue.findIndex((x) => x.id === this.cued);
      if (s.autoNext && !s.loop && i >= 0 && this.queue[i + 1]) { this.cue(this.queue[i + 1], true); return; }
    } else if (!state.ended) this.media.ended = false;
    // The time is sent on a few times a second; the screen only needs it when it moves on.
    if (was !== JSON.stringify([this.media.playing, Math.round(this.media.position), this.media.error]) || state.error || 'note' in state) this.emitStatus();
  }

  // The commands from the Video out tab.
  command(cmd, arg) {
    const s = this.settings();
    switch (cmd) {
      case 'on':
        this.on_ = !!arg;
        this.reconcile();
        break;
      case 'display':
        this.save({ display: arg ? { id: Number(arg.id), label: String(arg.label || '') } : null });
        this.reconcile();
        break;
      case 'source':
        this.save({ source: arg === 'screen' ? 'screen' : 'clips' });
        this.media = { ...this.media, playing: false, error: null, outputNote: null };
        this.reconcile();
        break;
      case 'screen':
        this.save({ screen: arg ? { id: Number(arg.id), label: String(arg.label || '') } : null });
        this.media.error = null;
        this.reconcile();
        break;
      case 'screenLut':
        this.save({ screenLut: String(arg || 'video') });
        this.sendLut();
        this.emitStatus();
        break;
      case 'add': {
        const added = (Array.isArray(arg) ? arg : [arg]).filter((f) => typeof f === 'string' && existsSync(f)).map((file) => ({ id: this.newId(), file, name: basename(file), pre: { state: 'none' } }));
        this.queue.push(...added);
        this.persist();
        this.preprocessAll();
        if (!this.cuedItem() && added[0]) this.cue(added[0]);
        break;
      }
      case 'remove': {
        const q = this.item(arg);
        if (!q) break;
        if (this.preprocessor?.busy(q.id)) this.preprocessor.cancel(q.id);
        if (q.pre.output) rmSync(q.pre.output, { force: true });
        const i = this.queue.indexOf(q);
        this.queue.splice(i, 1);
        if (this.cued === q.id) { this.clipSend({ type: 'stop' }); this.cue(this.queue[i] || this.queue[i - 1] || null); }
        this.persist();
        break;
      }
      case 'move': {
        const i = this.queue.findIndex((x) => x.id === arg?.id), j = i + (arg?.dir < 0 ? -1 : 1);
        if (i >= 0 && j >= 0 && j < this.queue.length) { [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]]; this.persist(); }
        break;
      }
      case 'cue': { const q = this.item(arg); if (q) this.cue(q); break; }
      case 'next': {
        const i = this.queue.findIndex((x) => x.id === this.cued);
        if (this.queue[i + 1]) this.cue(this.queue[i + 1], true); else throw new Error('That was the last clip in the queue');
        break;
      }
      case 'preprocess': { const q = this.item(arg); if (q) this.preprocess(q); break; }
      case 'cancelPre': this.preprocessor?.cancel(arg); break;
      case 'autoNext': this.save({ autoNext: !!arg }); break;
      case 'preAll': this.save({ preAll: !!arg }); this.preprocessAll(); break;
      case 'clearPre':
        for (const q of this.queue) {
          if (this.preprocessor?.busy(q.id)) this.preprocessor.cancel(q.id);
          if (q.pre.output) rmSync(q.pre.output, { force: true });
          q.pre = { state: 'none' };
        }
        this.persist();
        break;
      case 'load': // one file: added to the queue and put in the player
        this.command('add', [arg]);
        this.cue(this.queue[this.queue.length - 1]);
        break;
      case 'play': {
        // A missing LUT is said on the tab and when Play is pressed; it does not stop the video.
        if (!this.cuedItem() && this.queue[0]) this.cue(this.queue[0]);
        if (!this.cuedItem()) throw new Error('Add a video first');
        // Play while the screen is being sent goes back to clips.
        const fromScreen = this.source() === 'screen';
        if (fromScreen) { this.save({ source: 'clips' }); this.media = { ...this.media, playing: false, error: null, outputNote: null }; }
        if (!this.target()) throw new Error('No output display is connected');
        if (this.media.error) throw new Error(this.media.error);
        if (fromScreen || !this.on_) { this.on_ = true; this.reconcile(); }
        // A window that is still opening plays as soon as its page is ready.
        if (this.pageReady && this.win) this.send({ type: 'play' }); else this.pendingPlay = true;
        break;
      }
      case 'pause': this.clipSend({ type: 'pause' }); break;
      case 'stop': this.clipSend({ type: 'stop' }); if (this.source() === 'clips') this.media.position = 0; this.emitStatus(); break;
      case 'seek': this.clipSend({ type: 'seek', t: Number(arg) || 0 }); break;
      case 'loop': this.save({ loop: !!arg }); this.clipSend({ type: 'loop', on: !!arg }); this.emitStatus(); break;
      case 'volume': this.save({ volume: Math.max(0, Math.min(1, Number(arg))) }); this.clipSend({ type: 'volume', v: Number(arg) }); break;
      case 'audio': this.save({ audio: arg ? { id: String(arg.id || ''), label: String(arg.label || '') } : null }); this.clipSend({ type: 'audio', ...(arg || {}) }); this.emitStatus(); break;
      case 'applyLut': this.save({ applyLut: !!arg }); this.clipSend({ type: 'applyLut', on: !!arg }); this.emitStatus(); break;
      case 'lutChanged':
        // Copies made with the old LUT are out of date; one being made now is started again.
        for (const q of this.queue) if (this.preprocessor?.busy(q.id) && q.pre.lutVersion !== this.lutView()?.version) this.preprocessor.cancel(q.id);
        this.sendLut();
        this.preprocessAll();
        this.emitStatus();
        break;
      default: throw new Error('Unknown video out command');
    }
    return this.status();
  }

  stop() { this.close(); }
}
