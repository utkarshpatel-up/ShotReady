// ShotReady phone view: the cameras' pictures and essentials, read-only, live from ShotReady on the
// computer. Served by src/core/mobile.mjs. Pictures run only for cards on screen, and stop while the
// page is in the background, so a phone on Wi-Fi does not pull every camera at once.
'use strict';

const $ = (id) => document.getElementById(id);
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const BIG_FPS = 15;
const store = {
  get(k, d) { try { return localStorage.getItem(`shotready.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`shotready.${k}`, v); } catch { /* private window: not kept */ } },
};
const ui = { view: null, show: store.get('show', 'all'), rate: Number(store.get('rate', '10')), cards: new Map(), visible: new Set(), big: null };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}°`;
const keyOf = (c) => c.body || `label:${c.label}`;
const feedUrl = (body, fps) => `feed/${encodeURIComponent(body)}.mjpeg?fps=${fps}&t=${Date.now()}`;

// ---------- the essentials of one camera ----------
function facts(c) {
  const out = [];
  const f = (name, value, bad, title) => {
    if (value === null || value === undefined || value === '') return;
    const e = el('span', `f${bad ? ' bad' : ''}`);
    e.append(el('b', '', name), String(value));
    if (title) e.title = title;
    out.push(e);
  };
  f('ISO', c.iso, c.isoOver, c.isoOver ? `Above the Base ISO ${c.baseIso}` : '');
  f('Base', c.baseIso);
  f('Shutter', c.shutter, c.shutterBad);
  f('Iris', c.iris);
  f('WB', c.wb);
  f('SDI', c.sdi, !!c.sdiBad, c.sdiBad || '');
  if (c.sensor) {
    f('Sensor', c.sensor, false, c.sensor === 'Super 35' ? 'Super 35 crop' : '');
    if (c.sensor === 'Super 35') out.at(-1).classList.add('crop');
  }
  if (c.digitalIS && !/^off$/i.test(c.digitalIS)) f('Dig IS', c.digitalIS, true);
  return out;
}

function levelLine(c) {
  const line = el('div', 'line');
  const l = c.level;
  const parts = [];
  if (l) {
    for (const [name, v] of [['Roll', l.roll], ['Tilt', l.tilt]]) {
      if (v === null || v === undefined) continue;
      const s = el('span');
      if (Math.abs(v) <= 0.5) s.append(el('i', 'dot'));
      s.append(`${name} ${signed(v)}`);
      parts.push(s);
    }
  }
  if (c.wfm) parts.push(el('span', '', `WFM ${c.wfm.peak}% avg ${c.wfm.avg}%`));
  parts.forEach((p, i) => { if (i) line.append('  ·  '); line.append(p); });
  return parts.length ? line : null;
}

function checksLine(c) {
  const line = el('div', 'checks');
  if (!c.body) { line.append(el('span', '', 'No camera on this label')); return line; }
  if (!c.online) { line.append(el('span', 'red', 'Offline')); return line; }
  if (!c.reds.length && !c.yellows.length) { line.append(el('span', 'ok', '✓ All checks passed')); return line; }
  if (c.reds.length) line.append(el('span', 'red', `✖ ${c.reds.join(', ')}`));
  if (c.reds.length && c.yellows.length) line.append('  ');
  if (c.yellows.length) line.append(el('span', 'yellow', `▲ ${c.yellows.join(', ')}`));
  return line;
}

function tags(c) {
  const t = [];
  if (c.program) t.push(el('span', 'tag pgm', 'PGM'));
  if (c.preview) t.push(el('span', 'tag pvw', 'PVW'));
  if (c.spare) t.push(el('span', 'tag spare', 'SPARE'));
  return t;
}

// ---------- the cards ----------
function makeCard(key) {
  const card = el('section', 'card');
  const head = el('div', 'head');
  const label = el('span', 'label'), body = el('span', 'body'), tagBox = el('span', 'tags');
  head.append(label, body, tagBox);
  const pic = el('button', 'pic');
  pic.type = 'button';
  const img = el('img');
  img.alt = '';
  const none = el('div', 'none'), focus = el('span', 'focus');
  pic.append(img, none, focus);
  const factsBox = el('div', 'facts'), extra = el('div');
  card.append(head, pic, factsBox, extra);
  const c = { key, card, label, body, tagBox, pic, img, none, focus, factsBox, extra, src: null, cam: null };
  pic.addEventListener('click', () => openBig(key));
  img.addEventListener('error', () => {
    if (!c.src) return;
    c.src = null;
    none.textContent = 'No video';
    none.hidden = false;
    setTimeout(() => updatePic(c), 3000);
  });
  img.addEventListener('load', () => { none.hidden = true; });
  pic.dataset.key = key;
  seen.observe(pic);
  return c;
}

function fillCard(c, cam) {
  c.cam = cam;
  c.card.className = `card${cam.program ? ' pgm' : cam.preview ? ' pvw' : ''}${cam.body ? '' : ' empty'}`;
  c.label.textContent = cam.label || cam.body;
  c.body.textContent = cam.label ? cam.body || '' : cam.model || '';
  c.tagBox.replaceChildren(...tags(cam));
  c.focus.hidden = !cam.focus;
  c.focus.className = `focus ${cam.focus || ''}`;
  c.focus.textContent = cam.focus === 'in' ? 'IN FOCUS' : cam.focus === 'out' ? 'OUT OF FOCUS' : '';
  c.factsBox.replaceChildren(...facts(cam));
  c.extra.replaceChildren(...[levelLine(cam), checksLine(cam)].filter(Boolean));
  updatePic(c);
}

// A camera's picture runs while its card is on screen, the page is in front, pictures are on, and
// the large view is closed.
function updatePic(c) {
  const cam = c.cam;
  const want = cam && cam.body && cam.online && ui.rate > 0 && ui.visible.has(c.key) && !document.hidden && !ui.big;
  if (!cam?.body) { c.none.textContent = 'No camera'; c.none.hidden = false; }
  else if (!cam.online) { c.none.textContent = 'Offline'; c.none.hidden = false; }
  else if (ui.rate === 0) { c.none.textContent = 'Pictures off'; c.none.hidden = false; }
  if (want && c.src !== `${cam.body}@${ui.rate}`) {
    c.src = `${cam.body}@${ui.rate}`;
    if (c.none.textContent !== 'No video') c.none.hidden = true;
    c.img.src = feedUrl(cam.body, ui.rate);
  } else if (!want && c.src) {
    c.src = null;
    c.img.src = BLANK; // ends the picture stream
  }
}

const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const key = e.target.dataset.key;
    if (e.isIntersecting) ui.visible.add(key); else ui.visible.delete(key);
    const c = ui.cards.get(key);
    if (c) updatePic(c);
  }
}, { rootMargin: '100px 0px' });

function shown(view) {
  return view.cams.filter((c) => ui.show !== 'air' || c.program || c.preview);
}

function render() {
  const v = ui.view;
  if (!v) return;
  const atem = $('atem');
  atem.className = `pill ${v.atem.connected ? 'ok' : 'bad'}`;
  atem.textContent = v.atem.connected ? `ATEM${v.atem.mode ? ` · ${v.atem.mode}` : ''}` : v.atem.searching ? 'ATEM searching' : 'ATEM not connected';
  const sum = $('sum');
  sum.replaceChildren();
  if (v.reds) sum.append(el('span', 'red', `✖ ${v.reds} red`));
  if (v.yellows) sum.append(el('span', 'yellow', `▲ ${v.yellows} yellow`));
  if (!v.reds && !v.yellows && v.time) sum.append(el('span', '', '✓ Camera checks passed'));
  const online = v.cams.filter((c) => c.online && !c.spare).length;
  sum.append(el('span', '', `${online}/${v.cams.filter((c) => !c.spare).length} cameras online`));
  if (v.time) sum.append(el('span', '', `updated ${new Date(v.time).toLocaleTimeString()}`));

  const list = shown(v);
  const main = $('cams');
  const keep = new Set(list.map(keyOf));
  for (const [key, c] of ui.cards) {
    if (keep.has(key)) continue;
    c.img.src = BLANK;
    seen.unobserve(c.pic);
    c.card.remove();
    ui.cards.delete(key);
    ui.visible.delete(key);
  }
  if (!list.length) {
    main.replaceChildren(el('p', 'note', ui.show === 'air' ? 'No camera is on program or preview.' : 'No cameras yet.'));
  } else {
    main.querySelector('.note')?.remove();
    list.forEach((cam, i) => {
      const key = keyOf(cam);
      let c = ui.cards.get(key);
      if (!c) { c = makeCard(key); ui.cards.set(key, c); }
      // Moved only when out of place, so a picture is not interrupted by every update.
      if (main.children[i] !== c.card) main.insertBefore(c.card, main.children[i] || null);
      fillCard(c, cam);
    });
  }
  if (ui.big) paintBig();
}

// ---------- one camera, large ----------
function openBig(key) {
  if (!ui.cards.get(key)?.cam?.body) return;
  const first = !ui.big;
  ui.big = key;
  $('big').hidden = false;
  if (first) history.pushState({ big: true }, '');
  for (const c of ui.cards.values()) updatePic(c);
  paintBig();
}

function closeBig(fromHistory) {
  if (!ui.big) return;
  ui.big = null;
  ui.bigSrc = null;
  $('big').hidden = true;
  $('big-img').src = BLANK;
  if (!fromHistory && history.state?.big) history.back();
  for (const c of ui.cards.values()) updatePic(c);
}

function stepBig(dir) {
  const keys = shown(ui.view).filter((c) => c.body).map(keyOf);
  const i = keys.indexOf(ui.big);
  if (keys.length) openBig(keys[(i + dir + keys.length) % keys.length]);
}

function paintBig() {
  const cam = ui.view.cams.find((c) => keyOf(c) === ui.big);
  if (!cam) { closeBig(); return; }
  $('big-label').textContent = cam.label || cam.body;
  $('big-body').textContent = cam.label ? ` ${cam.body}` : '';
  const tag = $('big-tag');
  tag.className = `tag ${cam.program ? 'pgm' : cam.preview ? 'pvw' : ''}`;
  tag.textContent = cam.program ? 'PGM' : cam.preview ? 'PVW' : '';
  tag.hidden = !cam.program && !cam.preview;
  $('big-facts').replaceChildren(...facts(cam), ...[levelLine(cam), checksLine(cam)].filter(Boolean));
  const src = `${cam.body}@${cam.online}`;
  if (ui.bigSrc !== src) {
    ui.bigSrc = src;
    $('big-img').src = cam.online && !document.hidden ? feedUrl(cam.body, BIG_FPS) : BLANK;
  }
}

$('big-close').addEventListener('click', () => closeBig());
$('big-prev').addEventListener('click', () => stepBig(-1));
$('big-next').addEventListener('click', () => stepBig(1));
addEventListener('popstate', () => closeBig(true));
addEventListener('keydown', (e) => {
  if (!ui.big) return;
  if (e.key === 'Escape') closeBig();
  if (e.key === 'ArrowLeft') stepBig(-1);
  if (e.key === 'ArrowRight') stepBig(1);
});
let touch = null;
$('big-stage').addEventListener('touchstart', (e) => { touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
$('big-stage').addEventListener('touchend', (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) stepBig(dx < 0 ? 1 : -1);
  else if (dy > 90) closeBig();
});

// ---------- choices ----------
function paintChoices() {
  for (const b of $('show').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === ui.show);
  for (const b of $('rate').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.v) === ui.rate);
}
$('show').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  ui.show = v;
  store.set('show', v);
  paintChoices();
  render();
});
$('rate').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (v === undefined) return;
  ui.rate = Number(v);
  store.set('rate', v);
  paintChoices();
  for (const c of ui.cards.values()) updatePic(c);
});
// In the background, every picture stops; back in front, they start again.
document.addEventListener('visibilitychange', () => {
  for (const c of ui.cards.values()) updatePic(c);
  if (ui.big) { ui.bigSrc = null; if (document.hidden) $('big-img').src = BLANK; else paintBig(); }
});
paintChoices();

// ---------- live updates ----------
function connect() {
  const live = $('live');
  const es = new EventSource('events');
  let dropped = false;
  es.addEventListener('view', (e) => {
    ui.view = JSON.parse(e.data);
    live.className = 'live on';
    live.lastChild.textContent = 'Live';
    render();
  });
  es.addEventListener('open', () => {
    // Back after a drop: the pictures start again too, as ShotReady may have restarted.
    if (dropped) { for (const c of ui.cards.values()) { c.src = null; updatePic(c); } ui.bigSrc = null; }
    dropped = false;
  });
  es.addEventListener('error', () => {
    dropped = true;
    live.className = 'live';
    live.lastChild.textContent = 'Reconnecting…';
  });
}
connect();
