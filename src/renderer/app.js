// ShotReady dashboard. Text from cameras is untrusted, so every value goes in through
// textContent (via h()); nothing is ever assigned to innerHTML.
const api = window.shotready;
const call = (m, ...a) => api.call(m, ...a);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}
const $ = (id) => document.getElementById(id);
const ICON = { red: '✖', yellow: '▲', green: '✔', info: '•' };
const VERDICT = { ready: 'READY TO MIX', warnings: 'READY WITH WARNINGS', 'not-ready': 'NOT READY' };
const fmtVideo = (v) => {
  if (!v) return 'no video';
  const [res, rate, scan] = v.split(':');
  return `${res.replace('x', '×')} ${Number(rate) / 1000}${(scan || '').toLowerCase()}`;
};
const shortLens = (l) => l.replace(/\s+(L|IS|USM|Z|STM|PZ)\b/g, '').replace(/\s+/g, ' ').trim();
const when = (t) => (t ? new Date(t).toLocaleString() : '—');

const SWITCHERS = { constellation: 'Constellation', '2me': '2 M/E 2RU' };
const fmtWave = (w) => (w ? `${w.peak}% avg ${w.avg}%` : '—');
const fmtRgb = (w) => (w && w.r !== undefined ? `R ${w.r}%  G ${w.g}%  B ${w.b}%` : '—');
const fmtRuntime = (ms) => { const m = Math.floor(ms / 60000); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };

const app = { tab: 'dashboard', profile: '4K25', switcher: 'constellation', profiles: {}, bodies: [], result: null, atem: {}, busy: false, keepOpen: new Set(), feeds: {}, focus: {}, feedBase: {}, order: [], adjust: new Set(), stopArm: null, keyMode: 'mixer', selected: null };

function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}
async function act(fn) {
  try { return await fn(); }
  catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); return undefined; }
}

// ---------- tabs ----------
const TABS = { dashboard: ['Dashboard', renderDashboard], checks: ['Checks', renderChecks], bodies: ['Bodies', renderBodies], sheet: ['Label sheet', renderSheet], workload: ['Workload', renderWorkload], log: ['Log', renderLog], settings: ['Settings', renderSettings] };
function renderTabs() {
  $('tabs').replaceChildren(...Object.entries(TABS).map(([k, [name]]) =>
    h('button', { class: app.tab === k ? 'on' : '', onclick: () => { app.tab = k; renderTabs(); refreshView(); } }, name)));
}
function refreshView() {
  const done = TABS[app.tab][1]();
  syncFeeds();
  return done;
}
function refreshLive() {
  if (app.tab === 'dashboard') renderDashboard();
  else if (app.tab === 'checks') renderChecks();
}
// Rebuilding while a dropdown is open would snap it shut under the operator's cursor, and
// swapping a button out from under a click that is halfway through would lose the click.
function rebuildBlocked() {
  const view = $('view');
  if ((document.activeElement?.tagName === 'SELECT' && view.contains(document.activeElement)) || app.pointerDown) { app.deferred = true; return true; }
  return false;
}

function renderProfile() {
  $('profile').replaceChildren(...Object.entries(app.profiles).map(([k, p]) =>
    h('button', { class: app.profile === k ? 'on' : '', title: p.label, onclick: () => setProfile(k) }, `${k}`)));
}
function renderSwitcher() {
  $('switcher').replaceChildren(...Object.entries(SWITCHERS).map(([k, name]) =>
    h('button', { class: app.switcher === k ? 'on' : '', onclick: async () => { app.switcher = k; renderSwitcher(); await runBusy(() => call('setSwitcher', k)); } }, name)));
}
// Who the W and S keys are for. Mixer: the camera on preview. Assistant: the camera clicked on.
const KEY_MODES = { mixer: 'Mixer', assistant: 'Assistant' };
function renderKeyMode() {
  $('keymode').replaceChildren(...Object.entries(KEY_MODES).map(([k, name]) => h('button', {
    class: app.keyMode === k ? 'on' : '',
    title: k === 'mixer' ? 'W and S change ISO on the camera on preview' : 'Click a camera, then W and S change its ISO',
    onclick: () => {
      app.keyMode = k;
      renderKeyMode();
      refreshLive();
      act(() => call('setKeyMode', k));
    },
  }, name)));
}

// In Assistant mode a camera on program cannot be selected or changed. The app enforces it too.
const LIVE_LOCK = 'Live on program: locked in Assistant mode';
const isLocked = (c) => app.keyMode === 'assistant' && !!c?.tally?.program?.length;

function pickCamera(body, e) {
  if (app.keyMode !== 'assistant' || e.target.closest('select, button, input, label')) return;
  if (isLocked(cardOf(body))) { toast(`${body} is live and cannot be selected`, true); return; }
  app.selected = body;
  refreshLive();
}

async function setProfile(k) {
  app.profile = k;
  renderProfile();
  await runBusy(() => call('setProfile', k));
}
async function runBusy(fn) {
  app.busy = true;
  $('check').disabled = true;
  $('check').textContent = 'Checking…';
  const r = await act(fn);
  app.busy = false;
  $('check').disabled = false;
  $('check').textContent = 'Run check';
  return r;
}

// ---------- dashboard ----------
function row(r) {
  let action = null;
  if (r.action === 'diff' && r.label) action = h('button', { class: 'small', onclick: () => showDiff(r.label) }, 'View');
  if (r.action === 'acceptLens' && r.body) action = h('button', { class: 'small', onclick: () => act(() => call('acceptLens', r.body)) }, 'Accept');
  if (r.fix && r.body && !r.locked) action = h('button', { class: 'small', onclick: () => act(() => call('applyFix', r.body, r.check)) }, r.fix);
  if (r.action === 'confirm' && r.body) action = h('button', { class: 'small', onclick: () => act(() => call('confirm', r.body, [r.confirmId])) }, 'Confirm');
  return h('div', { class: `row ${r.status}` },
    h('span', { class: 'ic' }, ICON[r.status]), h('span', { class: 'ck' }, r.check), h('span', { class: 'dt' }, r.detail), action || h('span'));
}

function cardColor(l) {
  if (l.results.some((r) => r.status === 'red')) return 'red';
  if (l.results.some((r) => r.status === 'yellow')) return 'yellow';
  return 'green';
}

// Each body card chooses its own label. Taking a label another body holds makes that body spare.
function labelSelect(c) {
  const holder = {};
  for (const l of app.result?.labels || []) if (l.body) holder[l.label] = l.body;
  return h('select', {
    'aria-label': `Label for ${c.body}`,
    onchange: async (e) => {
      const v = e.target.value;
      if (v) await assign(v, c.body);
      else if (c.label) await runBusy(() => call('unassign', c.label));
    },
  },
  h('option', { value: '' }, 'Spare'),
  (app.result?.labels || []).map((l) => h('option', { value: l.label, selected: l.label === c.label },
    holder[l.label] && holder[l.label] !== c.body ? `${l.label} (${holder[l.label]})` : l.label)));
}

async function assign(label, body) {
  const res = await runBusy(() => call('assign', label, body));
  if (!res) return;
  if (res.previous && res.previous !== body) toast(`${label} is now ${body}. ${res.previous} is now spare.`);
  else if (res.movedFrom) toast(`${body} moved from ${res.movedFrom}. ${res.movedFrom} now has no body.`);
  if (res.diff?.rows.length) showDiffResult(res.diff);
}

const cardOf = (body) => app.result && (app.result.labels.find((l) => l.body === body) || app.result.spares.find((x) => x.body === body));
const rank = (id) => { const i = app.order.indexOf(id); return i < 0 ? Infinity : i; };
const orderedBodies = () => [...app.bodies].sort((a, b) => (rank(a.id) === rank(b.id) ? 0 : rank(a.id) - rank(b.id)));
const cardsOf = (r) => orderedBodies().map((b) => r.labels.find((l) => l.body === b.id) || r.spares.find((x) => x.body === b.id)).filter(Boolean);

// One picture element per camera, kept for good. The dashboard is rebuilt on every update, but
// the same element is moved into the new card, so the picture never restarts or flickers.
// A click on the picture puts the camera's AF frame there. The box moves when the camera reports it.
function aimFocus(body, e) {
  const c = cardOf(body);
  if (!c?.online || !c.focusFrame || isLocked(c)) return;
  if (!c.focusFrame.ok) { toast(c.focusFrame.why, true); return; }
  const r = e.currentTarget.getBoundingClientRect();
  act(async () => {
    const done = await call('setFocusFrame', body, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (done?.onAir) toast(`${body} is on program: box moved, press 1-Shot AF to focus`);
  });
}

function feedEl(body) {
  let f = app.feeds[body];
  if (f) return f;
  const img = h('img', { alt: '', draggable: false });
  const box = h('div', { class: 'fbox gone' });
  const chip = h('div', { class: 'fchip', hidden: true });
  const fps = h('div', { class: 'ffps' });
  const none = h('div', { class: 'fnone' }, 'No video');
  const wrap = h('div', { class: 'feed', role: 'img', 'aria-label': `Live view of ${body}`, onclick: (e) => aimFocus(body, e) }, img, box, chip, fps, none);
  f = app.feeds[body] = { wrap, img, box, chip, fps, none, connected: false };
  img.addEventListener('error', () => {
    if (!f.connected) return;
    f.connected = false;
    setTimeout(() => connectFeed(body), 1000);
  });
  return f;
}

// A picture keeps running on every tab, so it is already there when the Dashboard comes back.
function connectFeed(body) {
  const f = app.feeds[body];
  if (!f || !app.feedBase[body]) return;
  // A short drop does not disconnect the picture: only 15 seconds of the camera not answering does.
  const online = !!cardOf(body)?.online;
  if (online) f.lastOnline = Date.now();
  const want = online || (f.connected && Date.now() - (f.lastOnline || 0) < 15000);
  if (want && !f.connected) {
    f.img.src = `${app.feedBase[body]}/${encodeURIComponent(body)}.mjpeg?${Date.now()}`;
    f.connected = true;
  } else if (!want && f.connected) {
    f.img.removeAttribute('src');
    f.connected = false;
    f.fps.textContent = '';
  }
}
function syncFeeds() { for (const body of Object.keys(app.feeds)) connectFeed(body); }

// Green box: in focus. Red box: not. No box when the camera gives no focus guide (auto focus).
function paintFeed(body) {
  const f = app.feeds[body];
  if (!f) return;
  const c = cardOf(body);
  const online = !!c?.online;
  f.wrap.classList.toggle('off', !online);
  f.wrap.classList.toggle('can-aim', online && !!c?.focusFrame?.ok && !isLocked(c));
  f.none.hidden = online;
  const focus = online ? app.focus[body] : null;
  if (focus?.box) {
    const b = focus.box;
    f.box.style.cssText = `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;
    f.box.className = `fbox ${focus.focused ? 'ok' : 'bad'}`;
  } else {
    f.box.className = 'fbox gone';
  }
  let text = '', kind = 'none';
  if (online && focus?.guide) {
    kind = focus.focused ? 'ok' : 'bad';
    text = focus.focused ? 'IN FOCUS' : `OUT OF FOCUS · ${focus.dir === 'behind' ? 'back' : 'front'} focus`;
  } else if (online) {
    text = 'Focus not detected';
  }
  f.chip.textContent = text;
  f.chip.className = `fchip ${kind}`;
  f.chip.hidden = !text;
  f.chip.title = focus?.guide ? `Focus guide level ${focus.level} of 2 (2 is sharp), off by ${focus.angle} (0 is sharp)` : 'The camera reports no focus guide in this mode';
}

// Both card slots in one field. The camera only says recordable or not, so "no card" also covers
// a full, locked or unformatted card. A slot's letter is green when it has a usable card. Red and
// bold when neither slot can record; plain light text for the empty one when only one is empty.
function sdCards(media) {
  const NOT = 'unrecordable';
  const title = 'A slot shown as No SD Card cannot record: it is empty, or the card is full, locked or not formatted';
  if (media[0].status === NOT && media[1].status === NOT) return h('dd', { class: 'sd nocard bad', title }, 'No SD Card');
  const slot = (m, name) => {
    if (m.status === '?') return h('span', { class: 'nocard soft' }, `${name} —`);
    if (m.status === NOT) return h('span', { class: 'nocard soft' }, `${name} No SD Card`);
    return h('span', {}, h('span', { class: 'slot-on' }, name), ` ${m.minutes} min`);
  };
  return h('dd', { class: 'sd', title }, slot(media[0], 'A'), '  ·  ', slot(media[1], 'B'));
}
const DETECT = { off: 'OFF', ppl_catch: 'ON', ppl_only: 'People only', anml_only: 'Animals only', anml_catch: 'Animals' };
const DETECT_TIP = { off: 'Subject detection off', ppl_catch: 'People priority', ppl_only: 'People only', anml_only: 'Animals only', anml_catch: 'Animals priority' };

// Dropdowns for one camera, opened with Adjust. A change goes to the camera as soon as it is picked.
function adjustPanel(c) {
  return h('div', { class: 'adjust' }, c.controls.map((ctl) => {
    const known = ctl.options.some((o) => o.value === ctl.value);
    return h('label', {}, ctl.name, h('select', {
      'aria-label': `${ctl.name} on ${c.body}`,
      onchange: async (e) => {
        const sel = e.target;
        sel.disabled = true;
        await act(() => call('setControl', c.body, ctl.key, sel.value));
        sel.disabled = false;
        sel.blur();
        refreshLive();
      },
    },
    known ? null : h('option', { value: ctl.value, selected: true, disabled: true }, ctl.value || '—'),
    ctl.options.map((o) => h('option', { value: o.value, selected: o.value === ctl.value }, o.text))));
  }), c.focusDrive ? focusRow(c) : null);
}

// The card is rebuilt while a button is held, so the release is watched on the window.
function holdFocus(e, body, dir) {
  if (e.button !== 0) return;
  e.preventDefault();
  act(() => call('moveFocus', body, dir));
  const events = ['pointerup', 'pointercancel', 'blur'];
  const end = () => {
    events.forEach((t) => window.removeEventListener(t, end));
    act(() => call('moveFocus', body, 'stop'));
  };
  events.forEach((t) => window.addEventListener(t, end));
}

function focusRow(c) {
  const d = c.focusDrive;
  const btn = (text, dir) => h('button', {
    class: 'small', disabled: !d.ok, title: d.ok ? `Hold to move focus ${text.toLowerCase()}` : d.why,
    'data-focus': dir, onpointerdown: (e) => holdFocus(e, c.body, dir),
  }, text);
  return h('div', { class: 'focus-drive' }, h('span', {}, 'Focus'), btn('Closer', 'near'), btn('Further', 'far'));
}

// Keyboard macros. Each key steps ISO on the camera the current mode points at.
const MACROS = { w: 1, s: -1 };
function macroKey(e) {
  const dir = MACROS[e.key.toLowerCase()];
  if (!dir || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, select, textarea, [contenteditable]') || !$('modal').hidden) return;
  e.preventDefault();
  act(async () => {
    const r = await call('stepIso', dir, app.selected);
    if (r) toast(`${r.body}: ISO ${r.iso}`);
  });
}

async function setRec(body, on) {
  await act(() => call('setRecord', body, on));
  refreshLive();
}

// Stopping takes a second click within 3 seconds, so one stray click cannot end a take.
function armStop(body) {
  app.stopArm = body;
  refreshLive();
  setTimeout(() => {
    if (app.stopArm !== body) return;
    app.stopArm = null;
    refreshLive();
  }, 3000);
}

function oneShotButton(c) {
  if (!c.online || !c.focusDrive) return null;
  return h('button', {
    class: 'small one-shot-btn',
    disabled: !c.focusDrive.ok,
    title: c.focusDrive.ok ? 'Focus once on the focus box' : c.focusDrive.why,
    onclick: () => act(() => call('moveFocus', c.body, 'one_shot')),
  }, '1-Shot AF');
}

function recButton(c) {
  if (!c.online || !c.record) return null;
  if (!c.record.on) {
    return h('button', {
      class: 'small rec-btn',
      disabled: !c.record.ready,
      title: c.record.ready ? `Start recording on ${c.body}` : 'No SD Card to record to',
      onclick: () => setRec(c.body, true),
    }, '\u25CF REC');
  }
  const armed = app.stopArm === c.body;
  return h('button', {
    class: `small rec-btn live ${armed ? 'armed' : ''}`,
    title: 'Click twice to stop recording',
    onclick: () => {
      if (!armed) { armStop(c.body); return; }
      app.stopArm = null;
      setRec(c.body, false);
    },
  }, armed ? 'Stop?' : '\u25A0 Recording');
}

function toggleAdjust(body) {
  if (app.adjust.has(body)) app.adjust.delete(body); else app.adjust.add(body);
  refreshLive();
}

function card(c) {
  const s = c.summary;
  const all = [...c.results, ...(c.checks || [])];
  const reds = all.filter((r) => r.status === 'red').length;
  const yellows = all.filter((r) => r.status === 'yellow').length;
  const tally = c.tally;
  const onPgm = tally?.program?.length, onPvw = tally?.preview?.length;
  const feed = feedEl(c.body);

  const section = h('section', { class: `card ${c.spare ? 'spare' : cardColor(c)} ${c.online ? '' : 'offline'} ${app.keyMode === 'assistant' && app.selected === c.body ? 'selected' : ''}`, 'data-body': c.body, 'data-tally': onPgm ? 'pgm' : onPvw ? 'pvw' : '', onclick: (e) => pickCamera(c.body, e) },
    h('div', { class: 'card-head', onpointerdown: startCardDrag, title: 'Drag to move this camera' },
      h('span', { class: 'name' }, c.body),
      onPgm ? h('span', { class: 'badge pgm' }, `PGM${tally.program.length > 1 || tally.program[0] > 1 ? ` M/E ${tally.program.join('+')}` : ''}`) : null,
      onPvw ? h('span', { class: 'badge pvw' }, `PVW${tally.preview.length > 1 || tally.preview[0] > 1 ? ` M/E ${tally.preview.join('+')}` : ''}`) : null,
      labelSelect(c)),
    h('div', { class: 'sub-line', title: s?.lens }, `${c.ip}${s ? ` · ${s.model} · ${shortLens(s.lens)}` : ''}`),
    feed.wrap,
    s ? h('dl', { class: 'facts' },
      h('dt', {}, 'SDI'), h('dd', {}, fmtVideo(s.output)),
      h('dt', {}, 'Gamma'), h('dd', { title: s.gamma }, s.gamma),
      h('dt', {}, 'Shutter'), h('dd', {}, s.shutterMode === 'speed' ? `1/${s.shutter}` : s.shutterMode),
      h('dt', {}, 'Focus'), h('dd', { title: 'The AF / MF switch on the lens' }, s.lensFocus === 'af' ? 'AF' : s.lensFocus === 'mf' ? 'MF' : '—'),
      h('dt', {}, 'WB'), h('dd', {}, s.wbMode === 'kelvin' ? `${s.wbKelvin} K${s.wbTint ? `  ·  Tint ${s.wbTint}` : ''}` : s.wbMode),
      h('dt', {}, 'Focus mode'), h('dd', { title: 'The focus mode as the camera reports it' }, s.focusMode || '—'),
      h('dt', {}, 'ISO'), h('dd', {}, s.iso, h('span', { class: 'nd' }, `  ·  ND ${s.nd}`)),
      h('dt', {}, 'People Priority'), h('dd', { title: DETECT_TIP[s.detect] || s.detect }, DETECT[s.detect] || s.detect || '—'),
      h('dt', { title: 'Peak and average level, calculated from the camera preview frame' }, 'WFM'), h('dd', { 'data-wfm': c.body }, fmtWave(app.waves[c.body])),
      h('dt', {}, 'Power'), h('dd', { class: s.power?.battery ? 'on-battery' : '' }, s.power?.text || '—'),
      h('dt', {}, 'SD Card'), sdCards(s.media),
      h('dt', { title: 'Peak of each colour, calculated from the camera preview frame' }, 'RGB'), h('dd', { 'data-rgb': c.body }, fmtRgb(app.waves[c.body]))) : null,
    c.spare ? h('div', { class: 'spare-note' }, c.online ? 'Spare: not counted in the verdict until it has a label.' : 'Spare and offline.') : null,
    c.online && c.controls?.length && app.adjust.has(c.body) ? adjustPanel(c) : null,
    h('div', { class: 'card-actions' },
      h('button', { class: `chip ${reds ? 'red' : yellows ? 'yellow' : 'green'}`, onclick: () => openChecks(c.body) },
      reds || yellows ? `${reds ? `${ICON.red} ${reds} red` : ''}${reds && yellows ? '  ' : ''}${yellows ? `${ICON.yellow} ${yellows} yellow` : ''}  ·  see Checks` : `${ICON.green} All checks passed`),
      oneShotButton(c),
      recButton(c),
      c.online && c.controls?.length ? h('button', { class: `small adjust-btn ${app.adjust.has(c.body) ? 'on' : ''}`, onclick: () => toggleAdjust(c.body) }, app.adjust.has(c.body) ? 'Done' : 'Adjust') : null));
  if (isLocked(c)) {
    if (app.selected === c.body) app.selected = null;
    section.classList.remove('selected');
    for (const b of section.querySelectorAll('.card-actions button:not(.chip), .adjust select, .adjust button')) { b.disabled = true; b.title = LIVE_LOCK; }
  }
  paintFeed(c.body);
  connectFeed(c.body);
  return section;
}

// Dragging a card by its header moves it. The order is remembered.
function startCardDrag(e) {
  if (e.button !== 0 || e.target.closest('select, button')) return;
  const card_ = e.currentTarget.closest('.card');
  const grid = card_.parentElement;
  const view = $('view');
  const [sx, sy] = [e.clientX, e.clientY];
  let moving = false;
  const move = (ev) => {
    if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    if (!moving) { moving = true; card_.classList.add('dragging'); document.body.classList.add('dragging-card'); }
    const box = view.getBoundingClientRect();
    if (ev.clientY < box.top + 50) view.scrollTop -= 14;
    else if (ev.clientY > box.bottom - 50) view.scrollTop += 14;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.card');
    if (!over || over === card_ || over.parentElement !== grid) return;
    const kids = [...grid.children];
    grid.insertBefore(card_, kids.indexOf(card_) > kids.indexOf(over) ? over : over.nextSibling);
  };
  const end = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    if (!moving) return;
    card_.classList.remove('dragging');
    document.body.classList.remove('dragging-card');
    app.order = [...grid.children].map((c) => c.dataset.body);
    act(() => call('setCardOrder', app.order));
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

function openChecks(body) {
  app.tab = 'checks';
  renderTabs();
  refreshView();
  setTimeout(() => document.querySelector(`.panel[data-body="${body}"]`)?.scrollIntoView({ block: 'center' }), 0);
}

async function snapshot(label) {
  const r = await act(() => call('snapshot', label));
  if (r?.[0]?.count) toast(`${label}: saved ${r[0].count} settings from ${r[0].body}`);
  else if (r?.[0]?.skipped) toast(`${label}: ${r[0].skipped}`, true);
}

// The verdict and the show-wide findings, shown above both tabs.
function banner(r) {
  const atem = app.atem;
  const liveText = r.live?.enabled ? `Live ${r.live.connected}/${r.live.total} cameras · ` : '';
  const atemText = atem.connected ? 'ATEM connected' : atem.configured ? 'ATEM not connected' : 'No ATEM set';
  const atemClass = atem.connected ? 'on' : atem.configured ? 'off' : '';
  return [
    h('div', { class: `verdict ${r.verdict}` },
      h('span', { class: 'big', id: 'verdict' }, VERDICT[r.verdict]),
      h('span', { class: 'sub' }, `${r.switcherName} · ${r.profile} (${r.profileLabel}) · ${r.reds} red · ${r.yellows} yellow`),
      h('span', { class: 'spacer' }),
      h('span', { class: `atem-status ${atemClass}`, title: atem.error || '' }, atemText),
      h('span', { class: 'sub' }, `${liveText}updated ${new Date(r.time).toLocaleTimeString()}`)),
    r.global.filter((g) => g.status !== 'green').length ? h('div', { class: 'global' }, r.global.filter((g) => g.status !== 'green').map(row)) : '',
  ];
}

function renderDashboard() {
  const r = app.result;
  const view = $('view');
  if (!r) { view.replaceChildren(h('div', { class: 'verdict pending' }, h('span', { class: 'big' }, 'Reading cameras…'))); return; }
  if (rebuildBlocked()) return;

  const unassigned = r.labels.every((l) => !l.body);
  view.replaceChildren(
    ...banner(r),
    unassigned ? h('div', { class: 'setup' }, 'No bodies are assigned yet.',
      h('button', { class: 'primary', onclick: () => runBusy(() => call('assignInOrder')) }, 'Assign in order'),
      h('span', { class: 'empty' }, 'First body gets the first label, and so on. Change any card afterwards.')) : '',
    h('div', { class: 'grid' }, cardsOf(r).map(card)),
  );
}

// ---------- checks ----------
function checkPanel(c) {
  const order = { red: 0, yellow: 1, info: 2, green: 3 };
  const all = [...c.results, ...(c.checks || [])].map((r) => ({ ...r, label: c.label, body: c.body, locked: isLocked(c) })).sort((a, b) => order[a.status] - order[b.status]);
  const toConfirm = all.filter((r) => r.action === 'confirm');
  return h('section', { class: `panel ${c.spare ? 'spare' : cardColor(c)}`, 'data-body': c.body },
    h('div', { class: 'card-head' },
      h('span', { class: 'name' }, c.body),
      h('span', { class: 'sub-line' }, `${c.label || 'Spare'}${c.summary ? ` · ${shortLens(c.summary.lens)}` : ''}`)),
    c.spare ? h('div', { class: 'spare-note' }, 'Spare: not counted in the verdict until it has a label.') : null,
    h('div', { class: 'rows' }, all.map(row)),
    c.online && toConfirm.length > 1 ? h('div', { class: 'card-foot' },
      toConfirm.length > 1 ? h('button', { class: 'small', onclick: () => act(() => call('confirm', c.body, toConfirm.map((r) => r.confirmId))) }, `Confirm all (${toConfirm.length})`) : null) : null);
}

// Shows exactly what would change on each camera, and only then writes.
// The two all-camera actions. Both list what will change, and Send always sends everything.
async function showBulk(kind) {
  const isWb = kind === 'wb';
  const kelvin = isWb ? h('input', { type: 'number', step: 100, value: '', placeholder: 'e.g. 5600', 'aria-label': 'White balance in Kelvin' }) : null;
  const tint = isWb ? h('input', { type: 'number', min: -20, max: 20, step: 1, value: '0', 'aria-label': 'Tint' }) : null;
  const wb = () => (kelvin?.value ? { kelvin: kelvin.value, tint: tint.value } : null);
  const preview = () => (isWb ? call('wbPreview', wb()) : call('defaultsPreview'));
  const first = await act(preview);
  if (!first) return;

  const area = h('div', { class: 'scroll' });
  const actions = h('div', { class: 'actions' });
  const offline = h('div', { class: 'empty' });
  const note = h('div', { class: 'note' }, isWb
    ? 'Sets every reachable camera to Kelvin white balance with this value and tint. This changes the cameras straight away, so do it between shows.'
    : `Sends Gamma ${first.defaults.gamma}, Shutter ${first.defaults.shutter}, ND 0, Tele-converter OFF and Digital IS OFF to every reachable camera. SDI output ${first.defaults.sdi} can only be set on the camera. White balance is not touched. This changes the cameras straight away, so do it between shows.`);

  const send = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Setting cameras…';
    const results = await act(() => (isWb ? call('wbApply', wb()) : call('defaultsApply')));
    if (!results) { closeModal(); return; }
    area.replaceChildren(h('table', { class: 'match-list' }, h('tbody', {}, results.filter((r) => r.applied.length || r.failed.length).map((r) => h('tr', {},
      h('td', {}, h('strong', {}, r.body)),
      h('td', {}, r.applied.length ? `${ICON.green} ${r.applied.join(', ')}` : '', r.failed.map((f) => h('div', { class: 'no' }, `${f.name}: ${f.reason}`))))))));
    note.textContent = 'Done. The checks have been re-run.';
    actions.replaceChildren(h('button', { class: 'primary', onclick: closeModal }, 'Close'));
  };

  const paint = (plan) => {
    const shown = plan.targets.filter((t) => t.changes.length);
    const count = plan.targets.filter((t) => t.steps.some((c) => c.supported)).length;
    const anyToChange = plan.targets.some((t) => t.changes.some((c) => c.supported));
    offline.textContent = [plan.offline.length ? `Not reachable, so not included: ${plan.offline.join(', ')}.` : '', plan.locked.length ? `Locked in Assistant mode, so not included: ${plan.locked.join(', ')}.` : ''].join(' ').trim();
    area.replaceChildren(
      shown.length ? h('table', { class: 'match-list' }, h('tbody', {}, shown.map((t) => h('tr', {},
        h('td', {}, h('strong', {}, t.body), t.label ? ` (${t.label})` : ''),
        h('td', {}, t.changes.flatMap((c, i) => [i ? ' · ' : '', h('span', { class: c.supported ? '' : 'no' }, `${c.name} ${c.from} → ${c.display ?? c.value}${c.supported ? '' : ` (${c.why || 'not supported'})`}`)])))))) : '',
      !anyToChange && (!isWb || wb()) ? h('p', { class: 'all-ok' }, `${ICON.green} ${isWb ? 'White balance' : 'Gamma, shutter, ND, Digital IS and Tele-converter'} already match on every reachable camera. Send applies them again.`) : '',
    );
    const need = isWb && !wb();
    actions.replaceChildren(
      h('button', { onclick: closeModal }, 'Cancel'),
      h('button', { class: 'primary', disabled: need || !count, onclick: send }, need ? 'Type a Kelvin value' : `${isWb ? 'Send WB' : 'Send default settings'} to ${count} camera${count === 1 ? '' : 's'}`),
    );
  };

  // Only the newest answer is drawn, so a slow reply cannot overwrite what was typed since.
  let latest = 0;
  const update = async () => {
    const mine = ++latest;
    const plan = await act(preview);
    if (plan && mine === latest) paint(plan);
  };
  kelvin?.addEventListener('input', update);
  tint?.addEventListener('input', update);
  paint(first);

  $('modal').replaceChildren(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
    h('h2', {}, isWb ? 'Send WB to all cameras' : 'Set default settings on all cameras'),
    isWb ? h('div', { class: 'wb-inputs' }, h('strong', {}, 'White balance'), h('label', {}, 'Kelvin', kelvin), h('label', {}, 'Tint', tint)) : '',
    area, offline, note, actions));
  $('modal').hidden = false;
}

function renderChecks() {
  const r = app.result;
  const view = $('view');
  if (!r) { view.replaceChildren(h('div', { class: 'verdict pending' }, h('span', { class: 'big' }, 'Reading cameras…'))); return; }
  if (rebuildBlocked()) return;
  view.replaceChildren(
    ...banner(r),
    r.matching.length ? h('div', { class: 'section' }, h('h2', {}, 'Camera matching'),
      h('div', { class: 'rows' }, r.matching.map((m) => row({ status: 'yellow', check: m.name, detail: m.detail })))) : '',
    h('div', { class: 'checks-actions' }, h('button', { id: 'wb-btn', onclick: () => showBulk('wb') }, 'Send WB to all cameras'), h('button', { id: 'defaults-btn', onclick: () => showBulk('defaults') }, 'Set default settings on all cameras')),
    h('div', { class: 'checks-grid' }, cardsOf(r).map(checkPanel)),
  );
}

// ---------- diff ----------
async function showDiff(label) {
  const d = await act(() => call('diff', label));
  if (d) showDiffResult(d);
}
function closeModal() { $('modal').hidden = true; $('modal').replaceChildren(); }
function showDiffResult(d) {
  const body = !d.ref
    ? h('p', {}, `${d.label} has no saved reference yet. Use "Save as reference" when the picture is right.`)
    : !d.rows.length
      ? h('p', { class: 'all-ok' }, `${ICON.green} ${d.body} has the same settings as the reference.`)
      : h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Setting', `Now on ${d.body}`, `Earlier (${d.ref.fromBody})`, 'On this body'].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.rows.map((r) => h('tr', {},
          h('td', { class: 'mono' }, r.key.replace(/^c\.1\./, '')), h('td', {}, r.current), h('td', {}, r.earlier),
          h('td', { class: r.copyable ? 'tag-ok' : 'tag-no' }, r.copyable ? 'Supported' : 'Not supported'))))));
  $('modal').replaceChildren(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
    h('h2', {}, `${d.label} ← ${d.body}: compared with the earlier camera`),
    d.ref ? h('div', { class: 'empty' }, `Reference from ${d.ref.fromBody}, saved ${when(d.ref.time)}`) : '',
    body,
    d.rows.length ? h('div', { class: 'note' }, 'Make these changes in RCCA or on the camera. Copying them from here will be switched on once Canon\'s XC documentation confirms which settings can be written.') : '',
    h('div', { class: 'actions' },
      d.ref && d.rows.length ? h('button', { onclick: async () => { await snapshot(d.label); closeModal(); } }, `Keep ${d.body}'s settings as the new reference`) : '',
      h('button', { class: 'primary', onclick: closeModal }, 'Close'))));
  $('modal').hidden = false;
}

// ---------- bodies ----------
async function renderBodies() {
  const rows = await act(() => call('bodies'));
  if (!rows || app.tab !== 'bodies') return;
  $('view').replaceChildren(h('table', {},
    h('thead', {}, h('tr', {}, ['Body', 'IP', 'Status', 'Label', 'Model', 'Firmware', 'Lens', 'MAC', 'Last seen', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.flatMap((b) => [
      h('tr', {},
        h('td', {}, h('strong', {}, b.id)), h('td', { class: 'mono' }, b.ip),
        h('td', {}, h('span', { class: `on-dot ${b.online === null ? '' : b.online ? 'on' : 'off'}` }), b.online === null ? 'Not read yet' : b.online ? 'Online' : `Offline (${b.error})`),
        h('td', {}, b.label || 'Spare'), h('td', {}, b.model), h('td', {}, b.firmware), h('td', {}, b.lens),
        h('td', { class: 'mono' }, b.mac), h('td', {}, when(b.lastSeen)),
        h('td', {}, b.learnedMac ? h('button', { class: 'small', title: 'Use after replacing this body, or if the MAC was learned under the wrong name', onclick: async () => { await act(() => call('forgetMac', b.id)); renderBodies(); } }, 'Forget MAC') : '')),
      ...b.issues.map((i) => h('tr', {}, h('td', {}), h('td', { colSpan: 9 }, row({ ...i, body: b.id })))),
    ]))));
}

// ---------- label sheet ----------
async function renderSheet() {
  const rows = await act(() => call('sheet'));
  if (!rows || app.tab !== 'sheet') return;
  $('view').replaceChildren(
    h('div', { class: 'toolbar' },
      h('span', { class: 'empty' }, 'For RCCA and the operators: which body and IP sits on each label.'), h('span', { class: 'spacer' }),
      h('button', { onclick: async () => { await act(() => call('copySheet')); toast('Label sheet copied'); } }, 'Copy'),
      h('button', { onclick: async () => { const p = await act(() => call('exportSheet')); if (p) toast(`Saved ${p}`); } }, 'Export CSV'),
      h('button', { onclick: () => act(() => call('print')) }, 'Print')),
    h('table', {},
      h('thead', {}, h('tr', {}, ['Label', 'ATEM input', 'Body', 'IP', 'Lens'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, h('strong', {}, r.label)), h('td', {}, String(r.atemInput || '—')), h('td', {}, r.body || '—'), h('td', { class: 'mono' }, r.ip || '—'), h('td', {}, r.lens || '—'))))));
}

// ---------- workload ----------
async function renderWorkload() {
  const rows = await act(() => call('workload'));
  if (!rows || app.tab !== 'workload') return;
  const save = async (id, value) => { if (await act(() => call('setBaselineHours', id, value)) !== undefined) renderWorkload(); };
  $('view').replaceChildren(
    h('div', { class: 'toolbar' }, h('span', { class: 'empty' }, 'Lifetime = the hour meter reading you enter, plus camera on-time ShotReady has counted since. The camera does not send its hour meter over the network.')),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Body'), h('th', { class: 'num' }, 'Lifetime'), h('th', {}, 'Camera hour meter when entered'), h('th', { class: 'num' }, 'Counted by ShotReady'), h('th', {}, 'By label'), h('th', {}, 'Counting since'))),
      h('tbody', {}, rows.map((w) => h('tr', { 'data-body': w.body },
        h('td', {}, h('strong', {}, w.body)),
        h('td', { class: 'num' }, w.baselineHours === null ? 'Enter hour meter' : fmtRuntime(w.baselineHours * 3.6e6 + w.runtimeMs)),
        h('td', {}, h('input', { type: 'number', min: 0, step: 'any', value: w.baselineHours ?? '', 'aria-label': `Hour meter for ${w.body}`, onchange: (e) => save(w.body, e.target.value) })),
        h('td', { class: 'num' }, fmtRuntime(w.runtimeMs)),
        h('td', {}, Object.entries(w.byLabel).map(([l, v]) => `${l} ${fmtRuntime(v)}`).join(' · ') || '—'),
        h('td', {}, when(w.since)))))));
}

// ---------- log ----------
async function renderLog() {
  const rows = await act(() => call('events'));
  if (!rows || app.tab !== 'log') return;
  $('view').replaceChildren(
    h('div', { class: 'toolbar' }, h('span', { class: 'empty' }, 'Swaps, verdict changes, lens changes and bodies dropping out. Newest first.'), h('span', { class: 'spacer' }),
      h('button', { onclick: () => call('openReports') }, 'Open saved reports')),
    h('table', {}, h('tbody', {}, [...rows].reverse().map((e) => h('tr', {},
      h('td', { class: 'mono' }, new Date(e.time).toLocaleString()), h('td', { class: `lvl-${e.level}` }, e.text))))));
}

// ---------- settings ----------
async function renderSettings() {
  const s = await act(() => call('settings'));
  if (!s || app.tab !== 'settings') return;
  const text = (props) => h('input', { type: 'text', ...props });
  const pass = h('input', { type: 'password', placeholder: s.auth.hasPass ? 'Saved. Leave blank to keep it' : '', autocomplete: 'off' });
  const f = {
    user: text({ value: s.auth.user, autocomplete: 'off' }),
    atem: text({ value: s.atem?.ip || '', placeholder: 'Leave blank to work without the ATEM' }),
    poll: h('input', { type: 'number', min: 5, value: s.pollSeconds }),
    auto: h('input', { type: 'checkbox', checked: s.autoRefresh }),
    gamma: text({ value: s.standards.allowedGamma.join(', ') }),
    shutter: h('input', { type: 'number', min: 1, value: s.standards.shutterSpeed }),
    minutes: h('input', { type: 'number', min: 0, value: s.standards.minRecordMinutes }),
    tally: h('input', { type: 'checkbox', checked: s.standards.requireTally }),
    rec: h('input', { type: 'checkbox', checked: s.standards.requireRecording }),
  };
  const locs = s.locations.map((l) => ({
    label: text({ value: l.label }), input: h('input', { type: 'number', min: 0, value: l.atemInput || '' }),
    model: text({ value: l.requiredModel || '', placeholder: 'Any' }), lens: text({ value: l.expectedLens || '', placeholder: 'Any' }),
  }));
  const ips = s.bodies.map((b) => ({ id: b.id, model: b.model, ip: text({ value: b.ip }) }));
  const msg = h('span', {});

  const useAtemLabels = async () => {
    const inputs = await act(() => call('atemInputs'));
    if (!inputs) { toast('The ATEM is not connected', true); return; }
    let n = 0;
    locs.forEach((l, i) => {
      const id = Number(l.input.value) || i + 1;
      if (inputs[id]) { l.input.value = id; l.label.value = inputs[id]; n++; }
    });
    toast(`Filled ${n} labels from the ATEM. Press Save to keep them.`);
  };
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    const payload = {
      auth: { user: f.user.value, pass: pass.value },
      atem: { ip: f.atem.value },
      pollSeconds: Number(f.poll.value),
      autoRefresh: f.auto.checked,
      standards: {
        allowedGamma: list(f.gamma.value), shutterSpeed: Number(f.shutter.value),
        minRecordMinutes: Number(f.minutes.value), requireTally: f.tally.checked, requireRecording: f.rec.checked,
      },
      locations: locs.map((l) => ({ label: l.label.value, atemInput: l.input.value, requiredModel: l.model.value, expectedLens: l.lens.value })),
      bodies: ips.map((b) => ({ id: b.id, ip: b.ip.value })),
    };
    const r = await act(() => call('saveSettings', payload));
    if (r) { pass.value = ''; $('auto').checked = f.auto.checked; toast('Settings saved'); msg.textContent = ''; }
  };

  const field = (name, input) => h('label', {}, name, input);
  const tick = (name, input) => h('label', { class: 'check' }, input, name);
  $('view').replaceChildren(h('div', { class: 'form' },
    h('div', { class: 'section' }, h('h2', {}, 'Labels'),
      h('table', {},
        h('thead', {}, h('tr', {}, ['ATEM label', 'ATEM input', 'Required model', 'Usual lens'].map((t) => h('th', {}, t)))),
        h('tbody', {}, locs.map((l) => h('tr', {}, h('td', {}, l.label), h('td', {}, l.input), h('td', {}, l.model), h('td', {}, l.lens))))),
      h('p', { class: 'hint' }, 'Use your exact ATEM names. Renaming keeps the body, reference and workload on that row. "Required model" takes text such as C80. '),
      h('button', { onclick: useAtemLabels }, 'Fill labels from the ATEM')),
    h('div', { class: 'section' }, h('h2', {}, 'Connections'),
      h('div', { class: 'fields' },
        field('ATEM IP address', f.atem), field('Camera user name', f.user), field('Camera password', pass),
        field('Safety check every (seconds)', f.poll), tick('Live updates', f.auto))),
    h('div', { class: 'section' }, h('h2', {}, 'Team standard'),
      h('div', { class: 'fields' },
        field('Allowed gamma', f.gamma), field('Shutter speed (1/x)', f.shutter),
        field('Minimum record minutes', f.minutes),
        tick('Tally must be on', f.tally), tick('Cards must be recordable', f.rec))),
    h('div', { class: 'section' }, h('h2', {}, 'Bodies'),
      h('table', {},
        h('thead', {}, h('tr', {}, ['Body', 'Model', 'IP address'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ips.map((b) => h('tr', {}, h('td', {}, h('strong', {}, b.id)), h('td', {}, b.model), h('td', {}, b.ip)))))),
    h('div', { class: 'save-bar' },
      h('button', { class: 'primary', onclick: save, id: 'save-settings' }, 'Save'), msg,
      h('button', { onclick: () => call('openDataFolder') }, 'Open data folder'))));
}

// ---------- software update ----------
let updating = false;
async function checkUpdates() {
  const btn = $('update-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const r = await act(() => call('updateCheck'));
  btn.disabled = false;
  btn.textContent = 'Check for updates';
  if (r) showUpdate(r);
}

function showUpdate(r) {
  const how = {
    installed: `Downloads the new installer from GitHub${r.sizeMB ? ` (about ${r.sizeMB} MB)` : ''}, checks it against its checksum, installs it and restarts ShotReady.`,
    source: 'Pulls the latest changes from GitHub into this folder and restarts ShotReady.',
  };
  const status = h('p', { class: 'err' });
  const close = h('button', { class: r.canUpdate ? '' : 'primary', onclick: closeModal }, r.canUpdate ? 'Not now' : 'Close');
  let title, body = [], actions = [close];
  if (r.error) {
    title = 'Could not check for updates';
    body = [h('p', { class: 'err' }, r.error)];
  } else if (!r.available) {
    title = 'ShotReady is up to date';
    body = [h('p', {}, `Version ${r.current} is the latest${r.detail ? ` (${r.detail})` : ''}.`)];
  } else {
    title = `Update available: ${r.current} → ${r.latest}`;
    body = [
      r.notes?.length ? h('ul', {}, r.notes.map((n) => h('li', {}, n))) : '',
      r.reason ? h('p', { class: 'err' }, r.reason) : h('div', { class: 'note' }, `${how[r.mode] || ''} Monitoring stops for a few seconds while it restarts, so update between shows, not during one.`),
    ];
    if (r.canUpdate) {
      actions.push(h('button', {
        class: 'primary',
        onclick: async (e) => {
          if (updating) return;
          updating = true;
          e.target.disabled = true;
          e.target.textContent = 'Updating… ShotReady will restart';
          status.textContent = '';
          try {
            await call('updateApply');
          } catch (err) {
            updating = false;
            e.target.disabled = false;
            e.target.textContent = 'Update now';
            status.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
          }
        },
      }, 'Update now'));
    } else if (r.mode === 'portable') {
      actions.push(h('button', { class: 'primary', onclick: () => call('openReleases') }, 'Open download page'));
    }
  }
  $('modal').replaceChildren(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
    h('h2', {}, title), ...body, status, h('div', { class: 'actions' }, ...actions)));
  $('modal').hidden = false;
}

// ---------- start ----------
async function start() {
  const init = await call('init');
  Object.assign(app, { profiles: init.profiles, profile: init.profile, switcher: init.switcher, bodies: init.bodies, atem: init.atem, result: init.result, waves: { ...init.waves }, feedBase: init.feed, focus: { ...init.focus }, order: init.cardOrder || [], keyMode: init.keyMode || 'mixer' });
  $('demo').hidden = !init.demo;
  $('auto').checked = init.autoRefresh;
  $('auto-text').textContent = 'Live';
  $('foot-version').textContent = `ShotReady ${init.version}`;
  $('update-btn').onclick = checkUpdates;
  renderTabs();
  renderSwitcher();
  renderKeyMode();
  renderProfile();
  refreshView();
  const showBar = (on) => { $('bar-toggle').classList.toggle('on', on); $('bar-toggle').onclick = () => act(() => call('setBar', !on)); };
  showBar(init.barOpen);
  api.on('bar', showBar);

  $('check').onclick = async () => {
    const r = await runBusy(() => call('check', { report: true }));
    if (r?.reportPath) toast('Check finished. Report saved.');
  };
  $('auto').onchange = (e) => act(() => call('setAutoRefresh', e.target.checked));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });
  document.addEventListener('keydown', macroKey);
  document.addEventListener('pointerdown', () => { app.pointerDown = true; }, true);
  document.addEventListener('pointerup', () => {
    app.pointerDown = false;
    setTimeout(() => { if (app.deferred && !app.pointerDown && document.activeElement?.tagName !== 'SELECT') { app.deferred = false; refreshLive(); } }, 50);
  }, true);
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (app.deferred && document.activeElement?.tagName !== 'SELECT') { app.deferred = false; refreshLive(); } }, 0);
  });

  api.on('result', (r) => {
    app.result = r;
    app.profile = r.profile;
    app.switcher = r.switcher;
    renderProfile();
    renderSwitcher();
    if (app.tab === 'dashboard' || app.tab === 'checks') refreshLive();
    else if (app.tab === 'bodies') renderBodies();
  });
  api.on('wave', ({ body, wave }) => {
    if (wave) app.waves[body] = wave; else delete app.waves[body];
    for (const d of document.querySelectorAll('[data-wfm]')) if (d.dataset.wfm === body) d.textContent = fmtWave(wave);
    for (const d of document.querySelectorAll('[data-rgb]')) if (d.dataset.rgb === body) d.textContent = fmtRgb(wave);
  });
  api.on('focus', ({ body, focus }) => {
    if (focus) app.focus[body] = focus; else delete app.focus[body];
    paintFeed(body);
  });
  api.on('feedstat', ({ body, fps }) => {
    const f = app.feeds[body];
    if (!f || !f.connected) return;
    f.fps.textContent = fps ? `${fps} fps` : 'no frames';
    f.fps.classList.toggle('bad', !fps);
  });
  document.addEventListener('visibilitychange', syncFeeds);
  api.on('atem', (a) => { app.atem = a; refreshLive(); });
  api.on('log', () => { if (app.tab === 'log') renderLog(); });

  await runBusy(() => call('check', { report: false }));
}
start();
