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
const fmtVideo = (v) => {
  if (!v) return 'no video';
  const [res, rate, scan] = v.split(':');
  return `${res.replace('x', '×')} ${Number(rate) / 1000}${(scan || '').toLowerCase()}`;
};
const shortLens = (l) => l.replace(/\s+(L|IS|USM|Z|STM|PZ)\b/g, '').replace(/\s+/g, ' ').trim();
const when = (t) => (t ? new Date(t).toLocaleString() : '—');

const SWITCHERS = { constellation: 'Constellation', '2me': '2 M/E 2RU' };
const fmtWave = (w) => (w ? `${w.peak}% avg ${w.avg}%` : '—');
// Short, so the right-hand column of the card is not cut off: R100 G98 B95 (percent).
const fmtRgb = (w) => (w && w.r !== undefined ? `R${w.r} G${w.g} B${w.b}` : '—');
const fmtRuntime = (ms) => { const m = Math.floor(ms / 60000); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };

const app = { luts: { gammas: [], luts: {}, on: {} }, lutOn: {}, tab: 'dashboard', profile: '4K25', switcher: 'constellation', profiles: {}, bodies: [], result: null, atem: {}, busy: false, keepOpen: new Set(), feeds: {}, focus: {}, feedBase: {}, order: [], adjust: new Set(), keyMode: 'mixer', selected: null };

// action: { label, run } adds a button to the message, which then stays up longer.
function toast(text, bad = false, action = null) {
  const t = $('toast');
  t.replaceChildren(text, ...(action ? [h('button', { class: 'small toast-act', onclick: () => { t.hidden = true; action.run(); } }, action.label)] : []));
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, action ? 12000 : bad ? 7000 : 3500);
}
async function act(fn) {
  try { return await fn(); }
  catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); return undefined; }
}

// ---------- tabs ----------
const TABS = { dashboard: ['Dashboard', renderDashboard], checks: ['Checks', renderChecks], videoout: ['Video out', renderVideoOut], stream: ['Stream', renderStream], bodies: ['Bodies', renderBodies], sheet: ['Label sheet', renderSheet], workload: ['Workload', renderWorkload], log: ['Log', renderLog], settings: ['Settings', renderSettings] };
function renderTabs() {
  $('tabs').replaceChildren(...Object.entries(TABS).map(([k, [name]]) =>
    h('button', { class: `${app.tab === k ? 'on' : ''}${k === 'stream' && streamLive(app.stream) ? ' live-tab' : ''}`, onclick: () => { app.tab = k; renderTabs(); refreshView(); } }, k === 'stream' && streamLive(app.stream) ? 'Stream ● LIVE' : name)));
}
function refreshView() {
  if (app.tab !== 'stream') stopPreview();
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

// Rebuilding a tab keeps it where it was scrolled to, and a tab that was not on screen starts at the
// top. The position is read before anything is rebuilt: building the new cards moves the pictures out
// of the old ones, and if the button just clicked is then removed, Chromium lays the shorter page out
// and cuts the scroll position to fit it.
const scrollNow = () => (app.shown === app.tab ? $('view').scrollTop : 0);
function show(top, ...nodes) {
  const view = $('view');
  view.replaceChildren(...nodes);
  view.scrollTop = top;
  app.shown = app.tab;
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
    title: k === 'mixer' ? 'W and S change ISO, A and D Kelvin, Ctrl+W and Ctrl+S Base ISO on the camera on preview, or on the camera picked with the number pad (0 goes back to preview). F1 and F2 put Media Player 1 and 2 on preview; Shift+F1 and Shift+F2 cut them to program' : 'Click a camera or press its number on the number pad, then W and S change its ISO, A and D its Kelvin, Ctrl+W and Ctrl+S its Base ISO',
    onclick: () => {
      // A camera picked in one mode is not carried into the other: Mixer starts on preview again.
      if (app.keyMode !== k) app.selected = null;
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

// A message a click can bring up is shown once a minute at most per camera, so clicking the
// picture again and again (in Assistant mode that is also how a camera is selected) does not stack
// up the same notice. The picture says the same thing for as long as it applies.
const told = {};
function tellOnce(key, text, bad = false, ms = 60000) {
  if (told[key] && Date.now() - told[key] < ms) return;
  told[key] = Date.now();
  toast(text, bad);
}

// A click on the picture focuses the camera there. Where the AF frame can be placed, it moves to the
// click and the camera focuses on it (the box moves when the camera reports it). With the AF frame on
// Auto the camera picks the subject itself, so the click is a plain 1-Shot AF.
const canAim = (c) => !!(c?.online && !isLocked(c) && (c.focusFrame?.ok || (c.oneShot?.ok && !c.oneShot.continuous)));
// ---------- people the camera has detected ----------
// The person a click at x, y (fractions of the picture) means: one whose box, with a margin, holds
// the point, or else the nearest within a quarter of the picture. Distances allow for the 16:9 shape.
function personNear(found, x, y) {
  let best = null, bestD = Infinity;
  for (const p of found || []) {
    const b = p.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const inside = x >= b.x - b.w * 0.3 && x <= b.x + b.w * 1.3 && y >= b.y - b.h * 0.3 && y <= b.y + b.h * 1.3;
    const d = Math.hypot(((x - cx) * 16) / 9, y - cy) - (inside ? 1 : 0);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD <= 0.25 ? best : null;
}
// Where on a person the AF frame goes: the middle of a face or head, the top of a whole body.
function aimOf(p) {
  const b = p.box;
  return [b.x + b.w / 2, /body|person|human/i.test(p.type) ? b.y + b.h * 0.15 : b.y + b.h / 2];
}

// A box over each detected person: blue for the one the camera is following, white and bright for
// the one a click would pick.
function paintPeople(body) {
  const f = app.feeds[body];
  if (!f) return;
  const found = cardOf(body)?.online ? app.focus[body]?.people || [] : [];
  const pick = f.mouse ? personNear(found, f.mouse.x, f.mouse.y) : null;
  while (f.people.length < found.length) { const d = h('div', { class: 'fperson' }); f.wrap.insertBefore(d, f.box); f.people.push(d); }
  while (f.people.length > found.length) f.people.pop().remove();
  found.forEach((p, i) => {
    const b = p.box;
    f.people[i].style.cssText = `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;
    f.people[i].className = `fperson${p.track ? ' track' : ''}${p === pick ? ' hover' : ''}`;
  });
}

function hoverFeed(body, e) {
  const f = app.feeds[body];
  if (!f) return;
  const r = f.wrap.getBoundingClientRect();
  f.mouse = e ? { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } : null;
  if (f.people.length || f.mouse === null) paintPeople(body);
}

// With the AF frame on Auto the camera picks the person itself, so a click cannot choose one until
// the frame is a type that can be placed. One button switches it and focuses the person clicked.
const FRAME_NAMES = { zone: 'Zone', spot: 'Spot', large_zone_horizontal: 'Large zone H', large_zone_vertical: 'Large zone V' };
function offerFrame(body, x, y, offer) {
  const text = `${body}: the AF frame is on Auto, so People Priority picks the person itself. To focus the person you click, the AF frame needs a position.`;
  if (!offer) { tellOnce(`${body}|need-frame`, `${text} Set AF frame under Adjust.`, true); return; }
  const name = FRAME_NAMES[offer] || offer;
  toast(text, false, {
    label: `Use ${name} AF frame`,
    run: () => act(async () => {
      const done = await call('setFocusFrame', body, x, y, { person: true, frame: offer });
      toast(done?.onAir ? `${body}: AF frame set to ${name} and moved to the person. On program: press 1-Shot AF to focus` : `${body}: AF frame set to ${name} and on the person you clicked${done?.focused ? ', focused' : ''}`);
    }),
  });
}

function aimFocus(body, e) {
  const c = cardOf(body);
  if (!c?.online || isLocked(c) || (!c.focusFrame && !c.oneShot)) return;
  // A click near a detected person means that person: the AF frame goes on them, not on the
  // exact spot clicked.
  const r = e.currentTarget.getBoundingClientRect();
  let [x, y] = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  const person = c.focusFrame ? personNear(app.focus[body]?.people, x, y) : null;
  if (person) [x, y] = aimOf(person);
  if (!canAim(c) && !(person && c.focusFrame?.auto)) {
    const why = c.oneShot?.ok && c.oneShot.continuous ? 'Continuous AF is on and the AF frame is on Auto, so the camera is already choosing focus by itself. Press 1-Shot AF to focus once anyway' : c.oneShot?.why || c.focusFrame?.why;
    tellOnce(`${body}|${why}`, `${body}: ${why}`, true);
    return;
  }
  act(async () => {
    const done = await call('setFocusFrame', body, x, y, { person: !!person });
    if (done?.needFrame) { offerFrame(body, x, y, done.offer); return; }
    if (done?.onAir) toast(done.placed ? `${body} is on program: box moved, press 1-Shot AF to focus` : `${body} is on program, so the click did not focus it. Press 1-Shot AF to focus`);
    else if (done?.autoFrame) tellOnce(`${body}|auto-frame`, `${body}: 1-Shot AF done. The AF frame is on Auto, so the camera chose what to focus on. To focus where you click, set AF frame to Spot or Zone under Adjust.`, false, 10 * 60000);
  });
}

// One picture element per camera, kept for good. The dashboard is rebuilt on every update, but
// the same element is moved into the new card, so the picture never restarts or flickers.
function feedEl(body) {
  let f = app.feeds[body];
  if (f) return f;
  const img = h('img', { alt: '', draggable: false });
  const box = h('div', { class: 'fbox gone' });
  const chip = h('div', { class: 'fchip', hidden: true });
  const fps = h('div', { class: 'ffps' });
  const none = h('div', { class: 'fnone' }, 'No video');
  const osd = h('div', { class: 'fosd', hidden: true }, 'OSD IS ON');
  const frame = h('div', { class: 'fframe', hidden: true }, 'AF frame: Auto');
  const wrap = h('div', {
    class: 'feed', role: 'img', 'aria-label': `Live view of ${body}`,
    onclick: (e) => aimFocus(body, e), onmousemove: (e) => hoverFeed(body, e), onmouseleave: () => hoverFeed(body, null),
  }, img, box, chip, fps, none, osd, frame);
  f = app.feeds[body] = { wrap, img, box, chip, fps, none, osd, frame, people: [], mouse: null, connected: false };
  img.addEventListener('error', () => {
    if (!f.connected) return;
    f.connected = false;
    setTimeout(() => connectFeed(body), 1000);
  });
  return f;
}

// ---------- monitoring LUT ----------
// The LUT a camera's picture is shown through: its LUT button is on, a LUT is loaded for the gamma
// the camera is set to, and the LUT view has not failed on this computer.
function lutFor(body) {
  const gamma = cardOf(body)?.summary?.gamma;
  const l = gamma && app.luts?.luts?.[gamma];
  return app.lutOn[body] && l && !app.feeds[body]?.lutFailed ? { gamma, l } : null;
}

// The picture through the LUT: a thread in this window reads the feed and the graphics card applies
// the LUT (lut-worker.js). The plain picture stays connected until the first LUT frame is on screen,
// then is disconnected so frames are decoded once. The camera never loses its viewer in between,
// which would close and reopen its focus connection.
function showLut(f, body, lut) {
  if (f.lut?.drawing && f.connected) { f.img.removeAttribute('src'); f.connected = false; }
  if (!f.lut) {
    try {
      const canvas = h('canvas', { class: 'flut' });
      const offscreen = canvas.transferControlToOffscreen();
      const worker = new Worker('lut-worker.js');
      worker.onmessage = (e) => {
        if (e.data?.type === 'failed') lutFailed(body, e.data.message);
        else if (e.data?.type === 'drawing' && f.lut?.worker === worker) {
          f.lut.drawing = true;
          if (f.connected) { f.img.removeAttribute('src'); f.connected = false; }
        }
      };
      worker.onerror = (e) => { e.preventDefault?.(); lutFailed(body, e.message || 'the LUT view stopped'); };
      worker.postMessage({ type: 'start', canvas: offscreen, url: `${app.feedBase[body]}/${encodeURIComponent(body)}.mjpeg?${Date.now()}` }, [offscreen]);
      f.img.after(canvas);
      f.lut = { canvas, worker, key: null, drawing: false };
      f.wrap.classList.add('lut');
    } catch (e) {
      lutFailed(body, e.message);
      return;
    }
  }
  const key = `${lut.gamma}|${lut.l.version}`;
  if (f.lut.key === key) return;
  f.lut.key = key;
  call('lutData', lut.gamma).then((data) => {
    if (data && f.lut?.key === key) f.lut.worker.postMessage({ type: 'lut', ...data }, [data.data.buffer]);
  }).catch((e) => lutFailed(body, String(e.message || e)));
}

// The LUT picture keeps running until the plain picture has a frame of its own, so the camera never
// loses its viewer in between. If the plain picture does not come back (the camera went away), it
// stops after a second and a half anyway.
function stopLut(f) {
  if (!f?.lut) return;
  const { canvas, worker } = f.lut;
  f.lut = null;
  f.wrap.classList.remove('lut');
  let done = false;
  const gone = () => {
    if (done) return;
    done = true;
    worker.postMessage({ type: 'stop' });
    worker.terminate();
    canvas.remove();
  };
  f.img.addEventListener('load', gone, { once: true });
  setTimeout(gone, 1500);
}

// Back to the plain picture, said once.
function lutFailed(body, message) {
  const f = app.feeds[body];
  if (!f) return;
  stopLut(f);
  f.lutFailed = message;
  tellOnce(`${body}|lut`, `${body}: the LUT cannot be shown (${message}). Showing the Log picture.`, true);
  connectFeed(body);
  refreshLive();
}

function toggleLut(body) {
  const on = !app.lutOn[body];
  app.lutOn = { ...app.lutOn };
  if (on) app.lutOn[body] = true; else delete app.lutOn[body];
  if (app.feeds[body]) app.feeds[body].lutFailed = null;
  act(() => call('setLutOn', body, on));
  refreshLive();
}

function lutButton(c) {
  if (!c.online || !c.summary) return null;
  const gamma = c.summary.gamma;
  const l = app.luts?.luts?.[gamma];
  const on = !!app.lutOn[c.body];
  const failed = app.feeds[c.body]?.lutFailed;
  return h('button', {
    class: `small lut-btn ${on && l && !failed ? 'on' : ''}`,
    disabled: !l && !on,
    title: failed ? `The LUT cannot be shown on this computer: ${failed}`
      : !l ? `No LUT is loaded for ${gamma}. Load one in Settings > Monitoring LUTs`
        : on ? `Showing ${l.name}. Click for the Log picture` : `Show the picture through ${l.name}. Only on this screen: the camera does not change`,
    onclick: () => toggleLut(c.body),
  }, 'LUT');
}

// A picture keeps running on every tab, so it is already there when the Dashboard comes back.
function connectFeed(body) {
  const f = app.feeds[body];
  if (!f || !app.feedBase[body]) return;
  // A short drop does not disconnect the picture: only 15 seconds of the camera not answering does.
  const online = !!cardOf(body)?.online;
  if (online) f.lastOnline = Date.now();
  const want = online || ((f.connected || f.lut) && Date.now() - (f.lastOnline || 0) < 15000);
  const lut = want ? lutFor(body) : null;
  if (lut) { showLut(f, body, lut); return; }
  stopLut(f);
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
  f.wrap.classList.toggle('can-aim', canAim(c));
  f.wrap.title = !online ? '' : !canAim(c) ? (c.oneShot?.ok && c.oneShot.continuous ? 'Continuous AF is on and the AF frame is on Auto: the camera chooses focus by itself' : c.oneShot?.why || c.focusFrame?.why || '') : c.focusFrame?.ok ? 'Click to put the AF frame here and focus' : 'Click for 1-Shot AF. The AF frame is on Auto, so the camera chooses what to focus on';
  // On Auto the camera picks the focus point itself, so the box cannot be placed. Said on the
  // picture for as long as it applies, instead of in a message on every click.
  f.frame.hidden = !(online && c.focusFrame?.auto);
  f.frame.title = c?.focusFrame?.why || '';
  f.none.hidden = online;
  paintPeople(body);
  // The camera's display goes out on its outputs, so say so over the picture.
  f.osd.hidden = !(online && c.controls?.find((k) => k.key === 'm.onscreen')?.value === 'on');
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
// Only the slots with a card that can record are shown, so the column stays narrow: one card is
// "A 180 min", two are "A 180 · B 180 min". No card in either slot is red.
function sdCards(media) {
  const usable = media.filter((m) => m.status !== 'unrecordable' && m.status !== '?');
  const name = (m) => (m.slot === 1 ? 'A' : 'B');
  const title = media.map((m) => `Slot ${name(m)}: ${m.status === 'unrecordable' ? 'no card that can record (empty, full, locked or not formatted)' : m.status === '?' ? 'not reported' : `${m.minutes} min left`}`).join('\n');
  if (!usable.length) return h('dd', { class: 'sd nocard bad', title }, 'No SD Card');
  const parts = usable.flatMap((m, i) => [i ? ' · ' : '', h('span', { class: 'slot-on' }, name(m)), ` ${m.minutes}${i === usable.length - 1 ? ' min' : ''}`]);
  return h('dd', { class: 'sd', title }, ...parts.filter((x) => x !== ''));
}
const DETECT = { off: 'OFF', ppl_catch: 'ON', ppl_only: 'People only', anml_only: 'Animals only', anml_catch: 'Animals' };
const DETECT_TIP = { off: 'Subject detection off', ppl_catch: 'People priority', ppl_only: 'People only', anml_only: 'Animals only', anml_catch: 'Animals priority' };

// Copy another camera's picture settings onto this one. The dialog shows what would change first.
function copyRow(c) {
  const others = cardsOf(app.result).filter((x) => x.online && x.body !== c.body);
  if (!others.length) return null;
  const from = h('select', { 'aria-label': `Copy settings to ${c.body} from` }, others.map((x) => h('option', { value: x.body }, `${x.body}${x.label ? ` (${x.label})` : ''}`)));
  return h('div', { class: 'copy-row' }, h('span', {}, 'Copy settings from'), from, h('button', { class: 'small', onclick: () => showCopy(from.value, c.body) }, 'Compare…'));
}

// Where the camera cannot take its resolution over the network, Adjust says so, with what it sends
// now and what the switcher needs. Where it can, Resolution is one of the settings below.
function sdiRow(c) {
  if (!c.sdi || c.sdi.settable) return null;
  const ok = c.sdi.now === c.sdi.want;
  return h('div', { class: `dis-row${ok ? '' : ' warn-text'}` },
    `SDI output ${c.sdi.now}${ok ? '' : `, needs ${c.sdi.want}`}: this camera does not take its resolution over the network. Set it in the camera's menu.`);
}

// Digital IS on or off on every camera at once, from any camera's Adjust panel.
function digitalIsRow(c) {
  const now = c.results?.find((r) => r.check === 'Digital IS')?.detail?.match(/^(ON|OFF)/i)?.[1];
  const set = async (e, on) => {
    const row = e.target.closest('.dis-row');
    for (const b of row.querySelectorAll('button')) b.disabled = true;
    const r = await act(() => call('digitalIsAll', on));
    for (const b of row.querySelectorAll('button')) b.disabled = false;
    if (!r) return;
    const done = r.results.filter((x) => x.applied.length).map((x) => x.body);
    const failed = r.results.filter((x) => x.failed.length).map((x) => `${x.body} (${x.failed.map((f) => f.reason).join(', ')})`);
    toast([
      done.length ? `Digital IS ${on ? 'ON' : 'OFF'}: ${done.join(', ')}` : `Digital IS: no camera was changed`,
      r.live.length ? `on program: ${r.live.join(', ')}` : '',
      failed.length ? `not taken: ${failed.join('; ')}` : '',
      r.none.length ? `no Digital IS: ${r.none.join(', ')}` : '',
      r.offline.length ? `offline: ${r.offline.join(', ')}` : '',
      r.locked.length ? `locked in Assistant mode: ${r.locked.join(', ')}` : '',
    ].filter(Boolean).join(' · '), !!(failed.length || !done.length));
    refreshLive();
  };
  return h('div', { class: 'dis-row', title: 'Sets Digital IS on every reachable camera. In Mixer mode a camera on program changes on air too; in Assistant mode live cameras are left out.' },
    h('span', {}, 'Digital IS · all cameras'), now ? h('span', { class: 'empty' }, `(${c.body}: ${now})`) : null,
    h('button', { class: 'small', onclick: (e) => set(e, true) }, 'On'),
    h('button', { class: 'small', onclick: (e) => set(e, false) }, 'Off'));
}

async function showCopy(from, to) {
  const plan = await act(() => call('copyPreview', from, to));
  if (!plan) return;
  const boxes = [];
  const rows = plan.rows.map((r) => {
    const cb = h('input', { type: 'checkbox', checked: r.ok, disabled: !r.ok, 'aria-label': `Copy ${r.name}` });
    if (r.ok) boxes.push([cb, r.key]);
    return h('tr', { class: r.ok ? '' : 'no' }, h('td', {}, cb), h('td', {}, r.name), h('td', { class: 'mono' }, r.now), h('td', { class: 'mono' }, r.from), h('td', { class: 'empty' }, r.why || ''));
  });
  const area = h('div', { class: 'scroll' }, plan.rows.length
    ? h('table', { class: 'match-list copy-list' }, h('thead', {}, h('tr', {}, ['', 'Setting', `Now on ${to}`, `On ${from}`, ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows))
    : h('p', { class: 'all-ok' }, `${ICON.green} ${to} already has ${from}'s picture settings.`));
  const note = h('div', { class: `note${plan.live ? ' warn' : ''}` }, plan.live
    ? `${to} is on program: its picture changes on air when you copy.`
    : 'Picture settings only: gamma, white balance, Base ISO and ISO, shutter, ND, and the picture\'s detail and saturation settings. Iris, sensor mode and recording are not copied.');
  const actions = h('div', { class: 'actions' });
  const send = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Copying…';
    const r = await act(() => call('copyApply', from, to, boxes.filter(([cb]) => cb.checked).map(([, k]) => k)));
    if (!r) { closeModal(); return; }
    area.replaceChildren(
      h('p', { class: r.applied.length ? 'all-ok' : '' }, r.applied.length ? `${ICON.green} Copied to ${to}: ${r.applied.join(', ')}` : 'Nothing was copied.'),
      ...r.failed.map((f) => h('div', { class: 'no' }, `${f.name} not taken: ${f.reason}`)));
    note.className = 'note';
    note.textContent = 'Done. The checks have been re-run.';
    actions.replaceChildren(h('button', { class: 'primary', onclick: closeModal }, 'Close'));
  };
  const paintActions = () => {
    const n = boxes.filter(([cb]) => cb.checked).length;
    actions.replaceChildren(h('button', { onclick: closeModal }, 'Cancel'),
      h('button', { class: 'primary', disabled: !n, onclick: send }, `Copy ${n} setting${n === 1 ? '' : 's'} to ${to}`));
  };
  boxes.forEach(([cb]) => cb.addEventListener('change', paintActions));
  paintActions();
  $('modal').replaceChildren(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, h('h2', {}, `Copy settings from ${from} to ${to}`), area, note, actions));
  $('modal').hidden = false;
}

// Dropdowns for one camera, opened with Adjust. A change goes to the camera as soon as it is picked.
function adjustPanel(c) {
  return h('div', { class: 'adjust' }, copyRow(c), digitalIsRow(c), sdiRow(c), c.controls.map((ctl) => {
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

// Keyboard macros. W and S step ISO on the camera the current mode points at.
// M turns that camera's display on and opens its menu. While a menu is open, W A S D move,
// Space selects, and Q or Esc go back a level (closing the menu at the top). Esc with no menu
// open turns the display off.
const MACROS = { w: 1, s: -1 };
const KELVIN = { d: 1, a: -1 }; // D warmer number, A cooler number: one Kelvin step per press
const MENU_KEYS = { w: 'up', a: 'left', s: 'down', d: 'right', ' ': 'enter', q: 'back', escape: 'escape' };
// Holding a direction steps at most every MENU_REPEAT_MS, and only after the camera has taken the
// last key. Repeats that arrive meanwhile are dropped, not queued, so the cursor stops on release.
const MENU_REPEAT_MS = 250;
const menuHold = { busy: false, last: 0 };
const osdOn = () => cardsOf(app.result || { labels: [], spares: [] }).some((c) => c.online && c.controls?.find((k) => k.key === 'm.onscreen')?.value === 'on');
// Number pad 1–9: pick the camera on that label (1 = the first label, Cam-01), in either mode. The
// keys then act on it; in Mixer mode, 0 hands them back to the camera on preview. A camera on
// program is never picked, as with a click.
const onProgram = (body) => !!cardOf(body)?.tally?.program?.length;
function numpadSelect(n) {
  if (n === 0) {
    app.selected = null;
    refreshLive();
    toast(app.keyMode === 'mixer' ? 'Keys back on the camera on preview' : 'No camera picked');
    return;
  }
  const l = app.result?.labels?.[n - 1];
  if (!l) { toast(`There is no label ${n}`, true); return; }
  if (!l.body) { toast(`${l.label} has no camera`, true); return; }
  if (isLocked(cardOf(l.body)) || onProgram(l.body)) { toast(`${l.label} (${l.body}) is live and cannot be picked`, true); return; }
  app.selected = l.body;
  refreshLive();
  document.querySelector(`.card[data-body="${l.body}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toast(`${l.label} picked (${l.body})${app.keyMode === 'mixer' ? ': the keys act on it. 0 goes back to preview' : ''}`);
}

// Ctrl+W and Ctrl+S: Base ISO up and down, one step of the camera's own list, on the camera the keys
// act on. In either mode; never a camera on program.
function stepBaseIso(dir) {
  act(async () => { const r = await call('stepBaseIso', dir, app.selected); if (r) toast(`${r.body}: Base ISO ${r.baseIso}`); });
}

function macroKey(e) {
  const k = e.key.toLowerCase();
  if (e.target.closest?.('input, select, textarea, [contenteditable]') || !$('modal').hidden) return;
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyW' || e.code === 'KeyS')) {
    e.preventDefault();
    if (!e.repeat) stepBaseIso(e.code === 'KeyW' ? 1 : -1);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // e.code names the key itself, so this works with Num Lock on or off.
  const pad = /^Numpad([0-9])$/.exec(e.code);
  if (pad) {
    e.preventDefault();
    if (!e.repeat) numpadSelect(Number(pad[1]));
    return;
  }
  // F1 and F2: Media Player 1 or 2 on preview on M/E 1 (Mixer mode); with Shift, cut to program.
  // One change per press.
  if (e.key === 'F1' || e.key === 'F2') {
    e.preventDefault();
    if (e.repeat) return;
    const n = e.key === 'F1' ? 1 : 2;
    const to = e.shiftKey ? 'program' : 'preview';
    act(async () => { const r = await call('cutMediaPlayer', n, to); if (r) toast(`${r.name} ${r.to === 'program' ? 'cut to program' : 'on preview'}`); });
    return;
  }
  if (k === 'm') {
    if (e.repeat) return;
    e.preventDefault();
    act(async () => { const r = await call('menuKey', 'open', app.selected); if (r) toast(`${r.body}: menu open`); });
    return;
  }
  if (MENU_KEYS[k] && osdOn()) {
    e.preventDefault();
    // Space, Q and Esc act once per press. A held direction repeats at a steady pace.
    if (e.repeat && (!'wasd'.includes(k) || menuHold.busy || Date.now() - menuHold.last < MENU_REPEAT_MS)) return;
    const held = e.repeat;
    menuHold.busy = true;
    menuHold.last = Date.now();
    act(async () => {
      const r = await call('menuKey', MENU_KEYS[k], app.selected).finally(() => { menuHold.busy = false; });
      if (r?.did === 'osd off') toast(`${r.body}: display off`);
      // No menu open: W and S keep their ISO job, and A and D their Kelvin job, one step per press.
      if (r === null && MACROS[k] && !held) {
        const iso = await call('stepIso', MACROS[k], app.selected);
        if (iso) toast(`${iso.body}: ISO ${iso.iso}`);
      }
      if (r === null && KELVIN[k] && !held) {
        const wb = await call('stepKelvin', KELVIN[k], app.selected);
        if (wb) toast(`${wb.body}: ${wb.kelvin}`);
      }
    });
    return;
  }
  if (KELVIN[k] && !e.repeat) {
    e.preventDefault();
    act(async () => {
      const r = await call('stepKelvin', KELVIN[k], app.selected);
      if (r) toast(`${r.body}: ${r.kelvin}`);
    });
    return;
  }
  const dir = MACROS[k];
  if (!dir || e.repeat) return;
  e.preventDefault();
  act(async () => {
    const r = await call('stepIso', dir, app.selected);
    if (r) toast(`${r.body}: ISO ${r.iso}`);
  });
}

// The camera's electronic level: roll and tilt in degrees, live from its metadata (or its settings).
// Within LEVEL_OK of level an axis gets a small green dot, like the camera's bubble turning green;
// otherwise it is plain text, so a slight slope does not shout.
const LEVEL_OK = 0.5;
const LEVEL_TIP = `The camera's electronic level. Roll: the horizon's slope; Tilt: pointing up or down. A green dot means within ${LEVEL_OK}° of level.`;
function levelParts(body) {
  const l = app.focus[body]?.tiltRoll || cardOf(body)?.essentials?.level;
  if (!l) return [h('span', { class: 'empty', title: 'This camera does not report its electronic level' }, '—')];
  const axis = (name, v) => (v === null || v === undefined ? null : h('span', { class: 'lvl' },
    Math.abs(v) <= LEVEL_OK ? h('i', { class: 'lvl-ok', title: `${name} level` }) : null,
    `${name} ${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}°`));
  const parts = [axis('Roll', l.roll), axis('Tilt', l.tilt)].filter(Boolean);
  return parts.flatMap((p, i) => (i ? ['  ·  ', p] : [p]));
}
function paintLevel(body) {
  for (const d of document.querySelectorAll('[data-level]')) if (d.dataset.level === body) d.replaceChildren(...levelParts(body));
}

async function setRec(body, on) {
  await act(() => call('setRecord', body, on));
  refreshLive();
}

// Needs the lens on AF, nothing else: the camera takes it in any focus mode.
function oneShotButton(c) {
  if (!c.online || !c.oneShot) return null;
  return h('button', {
    class: 'small one-shot-btn',
    disabled: !c.oneShot.ok,
    title: !c.oneShot.ok ? c.oneShot.why : c.oneShot.continuous ? 'Focus once. Continuous AF is on, so the camera is also focusing by itself' : c.focusFrame?.auto ? 'Focus once. The AF frame is on Auto, so the camera chooses what to focus on' : 'Focus once on the focus box',
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
  return h('button', {
    class: 'small rec-btn live',
    title: `Stop recording on ${c.body}`,
    onclick: () => setRec(c.body, false),
  }, '\u25A0 Recording');
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

  const section = h('section', { class: `card ${c.spare ? 'spare' : cardColor(c)} ${c.online ? '' : 'offline'} ${app.selected === c.body ? 'selected' : ''}`, 'data-body': c.body, 'data-tally': onPgm ? 'pgm' : onPvw ? 'pvw' : '', onclick: (e) => pickCamera(c.body, e) },
    h('div', { class: 'card-head', onpointerdown: startCardDrag, title: 'Drag to move this camera' },
      h('span', { class: 'name' }, c.body),
      h('span', { class: 'tally-tags' },
        onPgm ? h('span', { class: 'badge pgm' }, `PROGRAM${tally.program.length > 1 || tally.program[0] > 1 ? ` M/E ${tally.program.join('+')}` : ''}`) : null,
        onPvw ? h('span', { class: 'badge pvw' }, `PREVIEW${tally.preview.length > 1 || tally.preview[0] > 1 ? ` M/E ${tally.preview.join('+')}` : ''}`) : null),
      labelSelect(c)),
    h('div', { class: 'sub-line', title: s?.lens }, `${c.ip}${s ? ` · ${s.model} · ${shortLens(s.lens)}` : ''}`),
    feed.wrap,
    s ? h('dl', { class: 'facts' },
      // SDI not in the switcher's format is red, as on the Checks tab.
      h('dt', {}, 'SDI'), (() => {
        const bad = c.results?.find((r) => r.check === 'SDI output' && r.status === 'red');
        return h('dd', bad ? { class: 'sdi-bad', title: bad.detail } : {}, fmtVideo(s.output));
      })(),
      h('dt', {}, 'Gamma'), h('dd', { title: s.gamma }, s.gamma),
      h('dt', {}, 'Shutter'), h('dd', {}, s.shutterMode === 'speed' ? `1/${s.shutter}` : s.shutterMode),
      h('dt', {}, 'Focus'), h('dd', { title: 'The AF / MF switch on the lens' }, s.lensFocus === 'af' ? 'AF' : s.lensFocus === 'mf' ? 'MF' : '—'),
      h('dt', {}, 'WB'), h('dd', {}, s.wbMode === 'kelvin' ? `${s.wbKelvin} K${s.wbTint ? `  ·  Tint ${s.wbTint}` : ''}` : s.wbMode),
      h('dt', {}, 'Continuous AF'), h('dd', { title: 'ON when the camera focus is auto and its auto mode is continuous (c.1.focus=auto, c.1.focus.auto=continuous)' }, s.continuousAf === 'on' ? 'ON' : s.continuousAf === 'off' ? 'OFF' : '—'),
      // ISO above the Base ISO range is red: a grainy picture that has lost sharpness.
      h('dt', {}, 'ISO'), h('dd', {},
        c.essentials?.isoOver ? h('span', { class: 'iso-over', title: `ISO ${s.iso} is above the Base ISO ${c.essentials.baseIso}: grainy picture, lost sharpness` }, s.iso) : s.iso,
        h('span', { class: 'nd', title: 'The camera\'s Base ISO. ISO above it is shown red.' }, `  ·  Base ${c.essentials?.baseIso ?? '—'}`)),
      h('dt', {}, 'People Priority'), h('dd', { title: DETECT_TIP[s.detect] || s.detect }, DETECT[s.detect] || s.detect || '—'),
      h('dt', { title: 'Peak and average level, calculated from the camera preview frame' }, 'WFM'), h('dd', { 'data-wfm': c.body }, fmtWave(app.waves[c.body])),
      h('dt', {}, 'Power'), h('dd', { class: s.power?.battery ? 'on-battery' : '', title: s.power ? `The camera reports its power source as ${s.power.source}` : '' }, s.power?.text || '—'),
      h('dt', {}, 'SD Card'), sdCards(s.media),
      h('dt', { title: 'Peak of each colour, calculated from the camera preview frame' }, 'RGB'), h('dd', { 'data-rgb': c.body, title: 'Peak of red, green and blue, in percent, from the camera preview frame' }, fmtRgb(app.waves[c.body])),
      // Iris on a row of its own, so the readings above keep their places.
      h('dt', { class: 'row-start' }, 'Iris'), h('dd', { title: c.essentials?.aperture ? 'The f-stop the lens is set to' : 'No lens reported, or the camera does not report its iris' }, c.essentials?.aperture || '—'),
      h('dt', { class: 'row-start', title: LEVEL_TIP }, 'Level'), h('dd', { 'data-level': c.body }, ...levelParts(c.body))) : null,
    c.spare ? h('div', { class: 'spare-note' }, c.online ? 'Spare: not counted in the verdict until it has a label.' : 'Spare and offline.') : null,
    c.online && c.controls?.length && app.adjust.has(c.body) ? adjustPanel(c) : null,
    h('div', { class: 'card-actions' },
      h('button', { class: `chip ${reds ? 'red' : yellows ? 'yellow' : 'green'}`, onclick: () => openChecks(c.body) },
      reds || yellows ? `${reds ? `${ICON.red} ${reds} red` : ''}${reds && yellows ? '  ' : ''}${yellows ? `${ICON.yellow} ${yellows} yellow` : ''}  ·  see Checks` : `${ICON.green} All checks passed`),
      oneShotButton(c),
      recButton(c),
      lutButton(c),
      c.online && c.controls?.length ? h('button', { class: `small adjust-btn ${app.adjust.has(c.body) ? 'on' : ''}`, onclick: () => toggleAdjust(c.body) }, app.adjust.has(c.body) ? 'Done' : 'Adjust') : null));
  // A picked camera that goes to program is let go, in either mode: in Mixer mode the keys go back to
  // the camera on preview.
  if (app.selected === c.body && onPgm) {
    app.selected = null;
    section.classList.remove('selected');
    toast(`${c.body} went to program: ${app.keyMode === 'mixer' ? 'the keys are back on the camera on preview' : 'pick another camera'}`, true);
  }
  if (isLocked(c)) {
    if (app.selected === c.body) app.selected = null;
    section.classList.remove('selected');
    for (const b of section.querySelectorAll('.card-actions button:not(.chip):not(.one-shot-btn):not(.lut-btn), .adjust select, .adjust button')) { b.disabled = true; b.title = LIVE_LOCK; }
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

// The top left of the screen says whether the ATEM is connected: CONNECTED in green as soon as a
// switcher answers, wherever it was found.
function atemHeadline(a) {
  const nets = a.searchedText ? ` on ${a.searchedText}` : ' on every network';
  if (a.connected) {
    return {
      cls: 'ok', big: 'CONNECTED',
      sub: `${a.name || 'ATEM'} · ${a.ip}${a.modeLabel && a.modeLabel !== 'unknown' ? ` · ${a.modeLabel}` : ''}`,
      title: a.via === 'demo' ? 'Simulated switcher' : a.via && a.via !== 'Settings' ? `Found by ${a.via}${a.network ? ` on ${a.network}` : ''}` : 'Address from Settings',
    };
  }
  if (!a.enabled) return { cls: 'off', big: 'NO ATEM', sub: 'Automatic search is off. Turn it on, or enter the ATEM address, in Settings > Connections.' };
  if (a.configured) return { cls: 'bad', big: 'ATEM NOT CONNECTED', sub: a.searching ? `Searching${nets}…` : a.trying ? `Trying ${a.trying}…` : `${a.ip ? `Last at ${a.ip}. ` : ''}Retrying and searching every network.` };
  if (a.searching) return { cls: 'wait', big: 'SEARCHING FOR ATEM…', sub: `Looking${nets}` };
  if (a.trying) return { cls: 'wait', big: 'CONNECTING TO ATEM…', sub: `Trying ${a.trying}` };
  if (a.notFound) return { cls: 'bad', big: 'NO ATEM FOUND', sub: `Searched${nets}. Searching again automatically. Check the switcher is on and on the same network as this computer (its factory address is 192.168.10.240).` };
  return { cls: 'wait', big: 'SEARCHING FOR ATEM…', sub: '' };
}

// The camera checks, beside the ATEM status: how many red and yellow findings, and which.
const CHECKS_TIP = 'Red means a check failed: a camera not answering, two cameras on one IP or the wrong body on an IP, the wrong model, '
  + 'SDI output not matching the profile (Constellation needs 3840x2160), a colour gamma, colour bars on, no recordable SD card, Digital IS or '
  + 'Tele-converter on, ISO above the Base ISO, the ATEM in a different format from the profile, or no camera assigned to any label. '
  + 'Yellow is a warning. Spare cameras are not counted. Click to open the Checks tab.';
function findings(r, status) {
  const by = new Map();
  const add = (check, who) => { if (!by.has(check)) by.set(check, []); if (who) by.get(check).push(who); };
  for (const g of r.global) if (g.status === status) add(g.check, '');
  for (const l of r.labels) for (const x of l.results) if (x.status === status) add(x.check, l.body);
  if (status === 'yellow') for (const m of r.matching) add(`${m.name} differs`, '');
  for (const s of r.spares) for (const x of s.results) if (x.status === status) add(x.check, s.body);
  // Cameras not answering and no cameras at all first: they are the usual reason, and the quickest
  // to explain. Then the check that hits the most cameras.
  const first = ['No cameras', 'Connection'];
  const rank = ([check, who]) => (first.includes(check) ? -100 + first.indexOf(check) : -who.length);
  return [...by].sort((a, b) => rank(a) - rank(b)).map(([check, who]) => `${check}${who.length ? ` (${who.join(', ')})` : ''}`);
}
function checksSummary(r) {
  const all = r.reds ? findings(r, 'red') : r.yellows ? findings(r, 'yellow') : [];
  const what = all.length > 3 ? [...all.slice(0, 3), `and ${all.length - 3} more`] : all;
  const count = r.reds || r.yellows ? `${r.reds ? `${ICON.red} ${r.reds} red` : ''}${r.reds && r.yellows ? '  ' : ''}${r.yellows ? `${ICON.yellow} ${r.yellows} yellow` : ''}` : `${ICON.green} All passed`;
  return h('button', { class: `checks-sum ${r.verdict}`, id: 'checks-sum', title: `${all.length ? `${all.join('\n')}\n\n` : ''}${CHECKS_TIP}`, onclick: () => { app.tab = 'checks'; renderTabs(); refreshView(); } },
    h('span', { class: 'ck-title' }, 'Camera checks'), h('span', { class: 'ck-count' }, count),
    what.length ? h('span', { class: 'ck-what' }, what.join(' · ')) : null);
}

// The ATEM status, the camera checks and the show-wide findings, shown above both tabs.
function banner(r) {
  const a = atemHeadline(app.atem || {});
  const liveText = r.live?.enabled ? `Live ${r.live.connected}/${r.live.total} cameras · ` : '';
  return [
    h('div', { class: 'status-bar' },
      h('div', { class: `atem-status ${a.cls}`, title: a.title || '' },
        h('span', { class: 'big', id: 'atem-status' }, a.big),
        h('span', { class: 'sub' }, a.sub)),
      checksSummary(r),
      h('span', { class: 'spacer' }),
      h('span', { class: 'meta' }, `${r.switcherName} · ${r.profile} (${r.profileLabel}) · ${liveText}updated ${new Date(r.time).toLocaleTimeString()}`)),
    r.global.filter((g) => g.status !== 'green').length ? h('div', { class: 'global' }, r.global.filter((g) => g.status !== 'green').map(row)) : '',
  ];
}

function renderDashboard() {
  const r = app.result;
  if (!r) { show(0, h('div', { class: 'verdict pending' }, h('span', { class: 'big' }, 'Reading cameras…'))); return; }
  if (rebuildBlocked()) return;

  const top = scrollNow();
  const unassigned = r.labels.every((l) => !l.body);
  show(top,
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
    : `Sends Gamma ${first.defaults.gamma}, Shutter ${first.defaults.shutter}, ND 0, Tele-converter OFF and Digital IS OFF to every reachable camera. SDI output ${first.defaults.sdi} (to match the switcher) is sent to a camera that takes its resolution over the network, except one on program; any other is listed, to be set in its menu. White balance is not touched. This changes the cameras straight away, so do it between shows.`);

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
  if (!r) { show(0, h('div', { class: 'verdict pending' }, h('span', { class: 'big' }, 'Reading cameras…'))); return; }
  if (rebuildBlocked()) return;
  const top = scrollNow();
  show(top,
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
  show(scrollNow(), h('table', {},
    h('thead', {}, h('tr', {}, ['Body', 'IP', 'Status', 'Label', 'Model', 'Firmware', 'Lens', 'MAC', 'Last seen', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.flatMap((b) => [
      h('tr', {},
        h('td', {}, h('strong', {}, b.id)), h('td', { class: 'mono' }, b.ip),
        h('td', {}, h('span', { class: `on-dot ${b.online === null ? '' : b.online ? 'on' : 'off'}` }), b.online === null ? 'Not read yet' : b.online ? 'Online' : `Offline (${b.error})`),
        h('td', {}, b.label || 'Spare'), h('td', {}, b.model), h('td', {}, b.firmware), h('td', {}, b.lens),
        h('td', { class: 'mono' }, b.mac), h('td', {}, when(b.lastSeen)),
        h('td', {},
          b.online ? h('button', { class: 'small', title: 'Saves every setting this camera reports to a text file in the reports folder, to send when a setting needs adding to ShotReady', onclick: async () => { const p = await act(() => call('saveSettingsList', b.id)); if (p) toast(`Saved ${p}`); } }, 'Save settings list') : '',
          ' ',
          b.learnedMac ? h('button', { class: 'small', title: 'Use after replacing this body, or if the MAC was learned under the wrong name', onclick: async () => { await act(() => call('forgetMac', b.id)); renderBodies(); } }, 'Forget MAC') : '')),
      ...b.issues.map((i) => h('tr', {}, h('td', {}), h('td', { colSpan: 9 }, row({ ...i, body: b.id })))),
    ]))));
}

// ---------- label sheet ----------
async function renderSheet() {
  const rows = await act(() => call('sheet'));
  if (!rows || app.tab !== 'sheet') return;
  show(scrollNow(),
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
  show(scrollNow(),
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
  show(scrollNow(),
    h('div', { class: 'toolbar' }, h('span', { class: 'empty' }, 'Swaps, camera check changes, the ATEM found or lost, lens changes and bodies dropping out. Newest first.'), h('span', { class: 'spacer' }),
      h('button', { onclick: () => call('openReports') }, 'Open saved reports')),
    h('table', {}, h('tbody', {}, [...rows].reverse().map((e) => h('tr', {},
      h('td', { class: 'mono' }, new Date(e.time).toLocaleString()), h('td', { class: `lvl-${e.level}` }, e.text))))));
}

// ---------- settings ----------
// ---------- phone view ----------
// A read-only page of the pictures and essentials for a phone on the same network. It acts at once,
// apart from the Save button below it.
const mobileBox = { el: null };
function paintMobile(st) {
  const box = mobileBox.el;
  if (!box || !box.isConnected || !st) return;
  const port = h('input', { type: 'number', min: 1024, max: 65535, value: st.port, 'aria-label': 'Phone view port', class: 'port' });
  const set = async (on) => { const r = await act(() => call('mobileSet', { on, port: Number(port.value) })); if (r) paintMobile(r); };
  const lan = st.urls.filter((u) => u.qr);
  const local = st.urls.find((u) => !u.qr);
  const copy = (url) => navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => toast(url));
  box.replaceChildren(...[
    h('div', { class: 'vo-row' },
      h('button', { class: st.running ? 'on-btn' : 'primary', onclick: () => set(!st.running) }, st.running ? 'Phone view on' : 'Turn phone view on'),
      h('label', {}, 'Port ', port),
      st.running ? h('button', { class: 'small', onclick: () => set(true) }, 'Use this port') : null,
      st.running ? h('span', { class: 'tag-ok' }, st.viewers ? `${st.viewers} phone${st.viewers === 1 ? '' : 's'} watching` : 'No phone watching') : h('span', { class: 'empty' }, 'Off')),
    st.error ? h('p', { class: 'err' }, `Could not start: ${st.error}`) : null,
    st.running && !lan.length ? h('p', { class: 'warn-text' }, 'This computer is on no network a phone could reach. Connect it to the Wi-Fi or network the phone is on.') : null,
    st.running ? h('div', { class: 'phone-urls' }, lan.map((u) => h('div', { class: 'phone-url' },
      h('img', { src: u.qr, alt: `QR code for ${u.url}`, width: 132, height: 132 }),
      h('div', {}, h('div', { class: 'empty' }, u.name), h('div', { class: 'mono sel' }, u.url),
        h('button', { class: 'small', onclick: () => copy(u.url) }, 'Copy link'))))) : null,
    st.running && local ? h('p', { class: 'hint' }, 'On this computer: ', h('span', { class: 'mono sel' }, local.url)) : null,
    st.running ? h('div', { class: 'vo-row' }, h('button', { class: 'small', title: 'Phones with the old link stop working and need the new one', onclick: async () => { const r = await act(() => call('mobileNewKey')); if (r) { paintMobile(r); toast('New link made: phones need the new one'); } } }, 'New link')) : null,
    h('p', { class: 'hint' }, 'Scan the code with the phone\'s camera, or type the link into its browser. The phone must be on the same network as this computer (the same Wi-Fi, or Tailscale or ZeroTier). It shows each camera\'s picture, tally and essentials, live, and can change nothing. The link carries a key: anyone with it can watch, so make a new link to cut off old ones. The first time, Windows may ask whether ShotReady may use the network: allow it on private networks. Each phone adds the pictures it shows to this computer\'s work; Data saver on the phone sends fewer frames.'),
  ].filter(Boolean));
}

async function renderSettings() {
  const s = await act(() => call('settings'));
  if (!s || app.tab !== 'settings') return;
  mobileBox.el = h('div');
  const phone = act(() => call('mobileStatus'));
  const text = (props) => h('input', { type: 'text', ...props });
  const pass = h('input', { type: 'password', placeholder: s.auth.hasPass ? 'Saved. Leave blank to keep it' : '', autocomplete: 'off' });
  const f = {
    user: text({ value: s.auth.user, autocomplete: 'off' }),
    atem: text({ value: s.atem?.ip || '', placeholder: 'Blank: found automatically' }),
    atemSearch: h('input', { type: 'checkbox', checked: s.atem?.search !== false }),
    tallyAtem: h('input', { type: 'checkbox', checked: s.tallyFromAtem !== false }),
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

  // The ATEM input the laptop's video goes into. It is not a camera: no tally, no label.
  const laptopInput = h('input', { type: 'number', min: 0, value: s.laptopVideo?.atemInput || '', placeholder: 'None', 'aria-label': 'Laptop video ATEM input' });
  const useAtemLabels = async () => {
    const inputs = await act(() => call('atemInputs'));
    if (!inputs) { toast('The ATEM is not connected', true); return; }
    let n = 0;
    const laptop = Number(laptopInput.value) || 0;
    locs.forEach((l, i) => {
      const id = Number(l.input.value) || i + 1;
      if (id === laptop) return; // the laptop's video is not a camera
      if (inputs[id]) { l.input.value = id; l.label.value = inputs[id]; n++; }
    });
    toast(`Filled ${n} labels from the ATEM. Press Save to keep them.`);
  };
  // Searches every network now and lists each switcher that answered, with a button to use it.
  const found = h('div', { class: 'atem-found' });
  const searchAtem = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Searching…';
    found.replaceChildren(h('span', { class: 'hint' }, 'Asking every network adapter (Bonjour), and knocking on the ATEM control port at each address…'));
    const r = await act(() => call('atemSearch'));
    btn.disabled = false;
    btn.textContent = 'Search now';
    if (!r) { found.replaceChildren(); return; }
    found.replaceChildren(
      h('p', { class: 'hint' }, `Searched: ${r.searched || 'every network'}.`),
      r.found.length
        ? h('table', {}, h('tbody', {}, r.found.map((a) => h('tr', {},
          h('td', {}, h('strong', {}, a.name || 'ATEM')), h('td', { class: 'mono' }, a.ip), h('td', {}, `${a.via}${a.network ? ` · ${a.network}` : ''}`),
          h('td', {}, a.ip === r.connectedIp ? h('span', { class: 'tag-ok' }, 'Connected')
            : h('button', { class: 'small', onclick: () => { f.atem.value = a.ip; toast(`ATEM address set to ${a.ip}. Press Save to keep it.`); } }, 'Use this one'))))))
        : h('p', { class: 'err' }, 'No ATEM answered. Check it is switched on and on the same network as this computer. Its factory address is 192.168.10.240: the computer needs an address on that network (192.168.10.x) to reach it.'));
  };
  // Monitoring LUTs: one per Log gamma, loaded from a .cube file.
  const lutRows = h('tbody');
  const paintLuts = (view) => {
    app.luts = view;
    lutRows.replaceChildren(...view.gammas.map((g) => {
      const l = view.luts[g];
      const pick = async () => {
        const [input, output] = [...lutRows.querySelectorAll(`select[data-gamma="${g}"]`)].map((x) => x.value);
        const v = await act(() => call('lutRange', g, input, output));
        if (v) paintLuts(v);
      };
      const range = (which) => h('select', { 'data-gamma': g, 'aria-label': `LUT ${which} for ${g}`, disabled: !l, onchange: pick },
        h('option', { value: 'legal', selected: l?.[which] === 'legal' }, 'Legal (video levels)'),
        h('option', { value: 'full', selected: l?.[which] !== 'legal' }, 'Full'));
      return h('tr', {},
        h('td', { class: 'mono' }, g),
        h('td', {}, l ? `${l.name} (${l.size}-point)` : h('span', { class: 'empty' }, 'None')),
        h('td', {}, range('input')), h('td', {}, range('output')),
        h('td', {},
          h('button', { class: 'small', onclick: async () => { const v = await act(() => call('lutLoad', g)); if (v) { paintLuts(v); toast(`LUT for ${g} loaded`); } } }, l ? 'Replace…' : 'Load .cube…'),
          l ? h('button', { class: 'small', onclick: async () => { const v = await act(() => call('lutClear', g)); if (v) paintLuts(v); } }, 'Remove') : ''));
    }));
  };
  paintLuts(await act(() => call('luts')) || app.luts);
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    const payload = {
      auth: { user: f.user.value, pass: pass.value },
      atem: { ip: f.atem.value, search: f.atemSearch.checked },
      laptopVideo: { atemInput: laptopInput.value },
      pollSeconds: Number(f.poll.value),
      autoRefresh: f.auto.checked,
      tallyFromAtem: f.tallyAtem.checked,
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
  show(scrollNow(), h('div', { class: 'form' },
    h('div', { class: 'section' }, h('h2', {}, 'Labels'),
      h('table', {},
        h('thead', {}, h('tr', {}, ['ATEM label', 'ATEM input', 'Required model', 'Usual lens'].map((t) => h('th', {}, t)))),
        h('tbody', {}, locs.map((l) => h('tr', {}, h('td', {}, l.label), h('td', {}, l.input), h('td', {}, l.model), h('td', {}, l.lens))))),
      h('p', { class: 'hint' }, 'Use your exact ATEM names. Renaming keeps the body, reference and workload on that row. "Required model" takes text such as C80. '),
      h('div', { class: 'laptop-row' }, h('strong', {}, 'Laptop video'), h('span', { class: 'empty' }, 'not a camera, ATEM input'), laptopInput,
        h('span', { class: 'hint' }, 'The input this computer\'s video output goes into. No camera\'s tally follows it, and no tally is shown for it.')),
      h('button', { onclick: useAtemLabels }, 'Fill labels from the ATEM')),
    h('div', { class: 'section' }, h('h2', {}, 'Connections'),
      h('div', { class: 'fields' },
        field('ATEM IP address', f.atem), field('Camera user name', f.user), field('Camera password', pass),
        field('Safety check every (seconds)', f.poll), tick('Live updates', f.auto), tick('Find the ATEM automatically', f.atemSearch), tick('Tally lamps follow the ATEM', f.tallyAtem)),
      h('p', { class: 'hint' }, 'With the address blank, or not answering, ShotReady searches every network this computer is on, Ethernet and Wi-Fi alike, and the cameras\' networks, and connects to the ATEM it finds. It keeps searching until one answers.'),
      h('div', { class: 'toolbar' }, h('button', { onclick: searchAtem }, 'Search now')), found),
    h('div', { class: 'section' }, h('h2', {}, 'Phone view'), mobileBox.el),
    h('div', { class: 'section' }, h('h2', {}, 'Monitoring LUTs'),
      h('p', { class: 'hint' }, 'A LUT for each Log gamma, shown over the pictures in ShotReady only: nothing is sent to the cameras, and the waveform still reads the Log picture. Turn it on for a camera with the LUT button on its card; each camera uses the LUT for the gamma it is set to. The graphics card applies it to every frame.'),
      h('table', { class: 'luts' },
        h('thead', {}, h('tr', {}, ['Gamma', 'LUT', 'LUT input', 'LUT output', ''].map((t) => h('th', {}, t)))),
        lutRows),
      h('p', { class: 'hint' }, 'The camera\'s preview picture carries video levels. Set LUT input and output to what the LUT was made for: a file name with _FF_ (full in, full out) or _LL_ (legal in, legal out) sets them on loading. If blacks look grey or crushed, the input is the wrong one.')),
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
  paintMobile(await phone);
}

// ---------- video out ----------
// Plays a video to the HDMI display through the inverse LUT, or sends a screen live through a LUT
// picked for it (the Screen source). The tab is rebuilt when something
// about the set-up changes; while a clip plays only the time and the play button are updated, so
// dragging the position bar is not interrupted.
const vo = {};
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const voKey = (s) => JSON.stringify([s.displays.map((d) => [d.id, d.width, d.height, d.hz]), s.target?.id, s.chosen, s.on, s.open, s.lut, s.file, s.error, s.warning, s.settings, s.lutMissing, s.outputNote, s.cued, s.baked, s.queue.map((q) => [q.id, q.state, q.error]), s.source, s.screen?.id, s.screenChosen, s.overlay, s.screenLut, s.screenLuts, s.screenLutMissing, s.shortcut]);
// What a queued clip's LUT comes from: applied live, or already in a pre-processed copy.
function queueState(q) {
  switch (q.state) {
    case 'waiting': return 'Waiting to pre-process';
    case 'working': return `Pre-processing ${Math.round(q.progress * 100)}%${q.speed ? ` · ${q.speed.toFixed(1)}× real time` : ''}`;
    case 'done': return `Pre-processed ✓${q.info ? ` (${q.info.speed.toFixed(1)}× real time, ${q.info.encode === 'software' ? 'in software' : 'on the graphics chip'})` : ''}`;
    case 'stale': return 'Pre-processed with an older LUT: LUT applied live';
    case 'failed': return `Not pre-processed: ${q.error}. LUT applied live`;
    default: return q.mp4 ? 'LUT applied live' : 'LUT applied live (pre-processing takes MP4 files)';
  }
}
const DISPLAY_AUDIO = /hdmi|displayport|display audio|nvidia high definition|amd high definition|intel\(r\) display/i;

async function audioOutputs() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, label: d.label }));
  } catch { return []; }
}

function paintVideoOut(s) {
  if (!vo.play) return;
  for (const q of s.queue) { const cell = document.querySelector(`[data-q="${q.id}"]`); if (cell) cell.textContent = queueState(q); }
  // While the screen is sent, the player stays where the clip was.
  const clip = s.source !== 'screen';
  vo.play.textContent = s.playing && clip ? '❚❚ Pause' : '▶ Play';
  if (!clip) return paintLive(s);
  vo.time.textContent = s.file ? `${clock(s.position)} / ${clock(s.duration)}` : '';
  if (!vo.dragging) { vo.seek.max = String(s.duration || 0); vo.seek.value = String(s.position || 0); }
  vo.seek.disabled = !s.file || !s.duration;
  paintLive(s);
}

function paintLive(s) {
  vo.live.textContent = s.playing ? (s.source === 'screen' ? 'SENDING THE SCREEN' : 'PLAYING') : s.open ? (s.source === 'screen' ? 'OUTPUT ON · starting' : 'OUTPUT ON · black') : '';
  vo.live.className = `vo-live${s.playing ? ' on' : ''}`;
}

async function renderVideoOut() {
  const [s, cfg, outs] = await Promise.all([act(() => call('playoutStatus')), act(() => call('settings')), audioOutputs()]);
  if (!s || app.tab !== 'videoout') return;
  app.playout = s;
  vo.key = voKey(s);
  const send = (cmd, arg) => act(() => call('playout', cmd, arg));
  const t = s.target;
  const screenOut = s.source === 'screen';
  // The main display can take the screen (covered by its own picture through the LUT), never clips.
  const choices = s.displays.filter((d) => screenOut || !d.primary || d.id === t?.id);
  const describe = (d) => `${d.label}${d.internal ? ' (built-in)' : ''} · ${d.width}×${d.height}${d.hz ? ` ${d.hz} Hz` : ''}${d.primary ? ' · main display' : ''}`;
  const isChosen = (want, d) => want?.id === d.id || want?.label === d.label;
  const displaySel = h('select', { 'aria-label': 'Output display', onchange: (e) => { const d = s.displays.find((x) => String(x.id) === e.target.value); send('display', d ? { id: d.id, label: d.label } : null); } },
    h('option', { value: '', selected: !s.chosen }, screenOut ? 'First display other than this one, or this one if it is the only one' : 'First display other than this one'),
    choices.map((d) => h('option', { value: String(d.id), selected: isChosen(s.chosen, d) }, describe(d))));
  const chosenMain = !screenOut && s.chosen && s.displays.find((d) => isChosen(s.chosen, d))?.primary;
  const outputState = !t ? h('span', { class: 'err' }, chosenMain ? `${s.chosen.label} is the main display: clips cannot play out on it. Pick the HDMI display, or send the screen instead.` : s.chosen ? `${s.chosen.label} is not connected` : 'No second display: plug the HDMI output in. It shows here as soon as Windows sees it.')
    : h('span', { class: 'tag-ok' }, `Output display: ${describe(t)}`);
  const sourceSel = h('select', { 'aria-label': 'What goes out', onchange: (e) => send('source', e.target.value) },
    h('option', { value: 'clips', selected: !screenOut }, 'Videos from the queue'),
    h('option', { value: 'screen', selected: screenOut }, 'A screen, live, through a LUT'));
  const lutRange = (which) => h('select', { 'aria-label': `Video out LUT ${which}`, disabled: !s.lut, onchange: () => act(() => call('playoutLutRange', vo.lutIn.value, vo.lutOut.value)) },
    h('option', { value: 'full', selected: s.lut?.[which] !== 'legal' }, 'Full'), h('option', { value: 'legal', selected: s.lut?.[which] === 'legal' }, 'Legal (video levels)'));
  vo.lutIn = lutRange('input');
  vo.lutOut = lutRange('output');
  const apply = h('input', { type: 'checkbox', checked: s.settings.applyLut !== false, onchange: (e) => send('applyLut', e.target.checked) });
  // Play is never held back: a missing LUT is said, and the video goes out as it is.
  vo.play = h('button', { class: 'primary', disabled: !s.file, onclick: async () => {
    const r = await send(app.playout?.playing && app.playout.source !== 'screen' ? 'pause' : 'play');
    if (r?.playing === false && r.lutMissing) toast('Playing without a LUT: the video goes out as it is, in colour. Load the inverse LUT, or untick Apply LUT if that is what you want.', true);
  } }, '▶ Play');
  vo.time = h('span', { class: 'mono' });
  vo.live = h('span', { class: 'vo-live' });
  vo.dragging = false;
  vo.seek = h('input', { type: 'range', min: 0, step: 0.04, class: 'vo-seek', 'aria-label': 'Position',
    oninput: () => { vo.dragging = true; vo.time.textContent = `${clock(Number(vo.seek.value))} / ${clock(app.playout?.duration || 0)}`; },
    onchange: () => { vo.dragging = false; send('seek', Number(vo.seek.value)); } });
  const loop = h('input', { type: 'checkbox', checked: !!s.settings.loop, onchange: (e) => send('loop', e.target.checked) });
  const named = outs.filter((o) => o.label);
  const audioSel = h('select', { 'aria-label': 'Audio output', onchange: (e) => { const o = outs.find((x) => x.id === e.target.value); send('audio', o ? { id: o.id, label: o.label } : null); } },
    h('option', { value: '', selected: !s.settings.audio }, 'Automatic: the first output that is not HDMI'),
    named.map((o) => h('option', { value: o.id, selected: s.settings.audio?.id === o.id || s.settings.audio?.label === o.label }, `${o.label}${DISPLAY_AUDIO.test(o.label) ? ' (display audio)' : ''}`)));
  const volume = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.settings.volume ?? 1, 'aria-label': 'Volume', onchange: (e) => send('volume', Number(e.target.value)) });
  const laptop = cfg?.laptopVideo?.atemInput;

  show(scrollNow(), h('div', { class: 'form' },
    h('div', { class: 'section' }, h('h2', {}, 'Output'),
      h('div', { class: 'vo-row' }, h('label', {}, 'Send ', sourceSel)),
      h('div', { class: 'vo-row' }, displaySel,
        h('button', { class: s.on ? 'on-btn' : '', disabled: !t && !s.on, onclick: () => send('on', !s.on) }, s.on ? 'Output on' : 'Output off'), vo.live),
      h('p', {}, outputState),
      s.warning ? h('p', { class: 'warn-text' }, s.warning) : null,
      h('p', { class: 'hint' }, `${screenOut ? 'The output display shows the screen picked below, through its LUT.' : 'The output display shows only the video, full screen, with no cursor; black when nothing plays.'} ${laptop ? `It goes into ATEM input ${laptop} (Laptop video, Settings > Labels): no tally is shown or sent for it.` : 'Set the switcher input it goes into as Laptop video in Settings > Labels, so no camera\'s tally follows that input.'}`)),
    screenOut ? screenSection(s, send, describe, isChosen) : null,
    h('div', { class: 'section' }, h('h2', {}, 'Inverse LUT'),
      h('div', { class: 'vo-row' },
        s.lut ? h('strong', {}, `${s.lut.name} (${s.lut.size}-point)`) : h('span', { class: s.lutMissing ? 'err' : 'empty' }, s.lutMissing ? 'None loaded: the video goes out as it is, in colour' : 'None loaded'),
        h('button', { onclick: () => act(() => call('playoutLutLoad')) }, s.lut ? 'Replace…' : 'Load .cube…'),
        s.lut ? h('button', { onclick: () => act(() => call('playoutLutClear')) }, 'Remove') : null),
      h('div', { class: 'vo-row' }, h('label', {}, 'LUT input ', vo.lutIn), h('label', {}, 'LUT output ', vo.lutOut), h('label', { class: 'check' }, apply, ' Apply LUT')),
      s.outputNote ? h('p', { class: 'warn-text' }, s.outputNote) : null,
      h('p', { class: 'hint' }, 'Every frame goes through this LUT on the graphics card, so the clip goes out as flat as the cameras. Set input and output to what the LUT was made for (a LUT exported from Resolve is usually full and full). Untick Apply LUT to send a video as it is, for example to an LED wall. Nothing here stops the output: a missing LUT is only warned about.')),
    h('div', { class: 'section' }, h('h2', {}, 'Queue'),
      h('div', { class: 'vo-row' },
        h('button', { onclick: () => act(() => call('playoutOpen')) }, 'Add videos…'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s.settings.autoNext, onchange: (e) => send('autoNext', e.target.checked) }), ' Next clip plays automatically'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s.settings.preAll, onchange: (e) => send('preAll', e.target.checked) }), ' Pre-process the queue in the background')),
      s.queue.length ? h('table', { class: 'vo-queue' }, h('tbody', {}, s.queue.map((q, i) => h('tr', { class: q.id === s.cued ? 'cued' : '' },
        h('td', { class: 'num' }, q.id === s.cued ? '▶' : String(i + 1)),
        h('td', { title: q.file }, h('strong', {}, q.name)),
        h('td', { 'data-q': q.id, class: q.state === 'failed' ? 'warn-text' : q.state === 'done' ? 'tag-ok' : 'empty' }, queueState(q)),
        h('td', { class: 'q-actions' },
          h('button', { class: 'small', disabled: q.id === s.cued, onclick: () => send('cue', q.id) }, q.id === s.cued ? 'In the player' : 'Put in the player'),
          q.state === 'working' || q.state === 'waiting'
            ? h('button', { class: 'small', onclick: () => send('cancelPre', q.id) }, 'Cancel')
            : q.state === 'done' ? null
              : h('button', { class: 'small', disabled: !q.mp4 || !s.lut, title: !s.lut ? 'Load the inverse LUT first' : !q.mp4 ? 'Pre-processing takes MP4 files (H.264 or HEVC)' : 'Make a copy with the LUT in every frame, on the graphics chip, while you carry on', onclick: () => send('preprocess', q.id) }, 'Pre-process'),
          h('button', { class: 'small', disabled: !i, title: 'Up', onclick: () => send('move', { id: q.id, dir: -1 }) }, '↑'),
          h('button', { class: 'small', disabled: i === s.queue.length - 1, title: 'Down', onclick: () => send('move', { id: q.id, dir: 1 }) }, '↓'),
          h('button', { class: 'small', title: 'Remove from the queue', onclick: () => send('remove', q.id) }, '✕')))))) : h('p', { class: 'empty' }, 'No videos yet: Add videos… puts them here, in the order they play.'),
      h('div', { class: 'vo-row' },
        h('button', { class: 'small', onclick: () => act(() => call('playoutFolder')) }, 'Open pre-processed folder'),
        s.queue.some((q) => q.state === 'done' || q.state === 'stale') ? h('button', { class: 'small', onclick: () => send('clearPre') }, 'Delete pre-processed copies') : null),
      h('p', { class: 'hint' }, 'Pre-processing makes a copy of a clip with the LUT already in every frame, faster than real time: the graphics chip decodes, applies the LUT and encodes, in a background process of its own, so this window and the output never wait for it. While a clip plays out it slows down to leave the graphics chip to the output. A pre-processed copy is played only when it was made with the LUT loaded now; otherwise the LUT is applied live, which also works.')),
    h('div', { class: 'section' }, h('h2', {}, 'Player'),
      h('div', { class: 'vo-row' },
        s.file ? h('strong', { title: s.file }, s.name) : h('span', { class: 'empty' }, 'Nothing in the player'),
        s.file ? h('span', { class: 'empty' }, s.baked ? '· playing the pre-processed copy' : s.settings.applyLut === false ? '· as it is, no LUT' : '· LUT applied live') : null),
      h('div', { class: 'vo-row' }, vo.play,
        h('button', { disabled: !s.file, onclick: () => send('stop') }, '■ Stop (black)'),
        h('button', { disabled: !s.file, onclick: async () => { await send('seek', 0); await send('play'); } }, '⟲ From the start'),
        h('button', { disabled: !s.file || s.queue[s.queue.length - 1]?.id === s.cued, onclick: () => send('next') }, '⏭ Next'),
        h('label', { class: 'check' }, loop, ' Loop'), vo.time),
      vo.seek,
      s.error && !screenOut ? h('p', { class: 'err' }, s.error) : null,
      screenOut ? h('p', { class: 'hint' }, 'The screen is being sent: Play sends the clip in the player instead.') : null,
      h('p', { class: 'hint' }, 'MP4 (H.264 or HEVC) and WebM play. ProRes, DNxHR and MXF do not: convert those to MP4 first. The picture is scaled to the output display, keeping its shape.')),
    h('div', { class: 'section' }, h('h2', {}, 'Audio'),
      h('div', { class: 'vo-row' }, audioSel, h('label', {}, 'Volume ', volume)),
      h('p', { class: 'hint' }, named.length ? 'Sound goes to the output picked here, not over HDMI.' : 'The computer does not name its audio outputs here, so the sound goes to its default output. Make the audio jack the default in Windows (Settings > System > Sound) if HDMI is.'))));
  paintVideoOut(s);
}

// The Screen source: which display goes out, and the LUT it goes through.
function screenSection(s, send, describe, isChosen) {
  const src = s.screen, t = s.target, luts = s.screenLuts || {}, choice = s.screenLut?.choice || 'video';
  const screenSel = h('select', { 'aria-label': 'Screen to send', onchange: (e) => { const d = s.displays.find((x) => String(x.id) === e.target.value); send('screen', d ? { id: d.id, label: d.label } : null); } },
    h('option', { value: '', selected: !s.screenChosen }, 'The main display'),
    s.displays.map((d) => h('option', { value: String(d.id), selected: isChosen(s.screenChosen, d) }, describe(d))));
  const named = (l) => (l ? ` (${l.name})` : ': none loaded');
  const gammas = Object.entries(luts.gammas || {});
  const lutSel = h('select', { 'aria-label': 'Screen LUT', onchange: (e) => send('screenLut', e.target.value) },
    h('option', { value: 'video', selected: choice === 'video' }, `The inverse LUT, as for clips${named(luts.video)}`),
    gammas.map(([g, l]) => h('option', { value: `gamma:${g}`, selected: choice === `gamma:${g}` }, `The ${g} monitoring LUT (${l.name})`)),
    choice.startsWith('gamma:') && !luts.gammas?.[choice.slice(6)] ? h('option', { value: choice, selected: true }, `The ${choice.slice(6)} monitoring LUT: no longer loaded`) : null,
    h('option', { value: 'own', selected: choice === 'own' }, `A LUT of its own${named(luts.own)}`),
    h('option', { value: 'none', selected: choice === 'none' }, 'None: the screen as it is'));
  const own = luts.own;
  const range = (which) => h('select', { 'aria-label': `Screen LUT ${which}`, disabled: !own, onchange: () => act(() => call('screenLutRange', vo.sIn.value, vo.sOut.value)) },
    h('option', { value: 'full', selected: own?.[which] !== 'legal' }, 'Full'), h('option', { value: 'legal', selected: own?.[which] === 'legal' }, 'Legal (video levels)'));
  vo.sIn = range('input');
  vo.sOut = range('output');
  const where = !src ? h('p', { class: 'err' }, s.screenChosen ? `${s.screenChosen.label} is not connected: nothing goes out` : 'No display to send')
    : !t ? h('p', { class: 'empty' }, 'Pick the output display above.')
      : s.overlay ? h('p', { class: 'tag-ok' }, `${src.label} shows itself through the LUT, and that is what goes out${src.primary ? ': with a single display this is the one you work on, and its picture follows you live' : ''}. Clicks and typing go through to the apps under it.`)
        : h('p', { class: 'tag-ok' }, `${src.label} goes out on ${t.label} through the LUT, live.`);
  return h('div', { class: 'section' }, h('h2', {}, 'Screen'),
    h('div', { class: 'vo-row' }, h('label', {}, 'Screen to send ', screenSel), h('label', {}, 'LUT ', lutSel)),
    where,
    choice === 'own' ? h('div', { class: 'vo-row' },
      own ? h('strong', {}, `${own.name} (${own.size}-point)`) : h('span', { class: 'err' }, 'None loaded'),
      h('button', { onclick: () => act(() => call('screenLutLoad')) }, own ? 'Replace…' : 'Load .cube…'),
      own ? h('button', { onclick: () => act(() => call('screenLutClear')) }, 'Remove') : null,
      h('label', {}, 'LUT input ', vo.sIn), h('label', {}, 'LUT output ', vo.sOut)) : null,
    s.screenLutMissing ? h('p', { class: 'err' }, 'That LUT is not loaded: the screen goes out as it is, in colour.') : null,
    s.error ? h('p', { class: 'err' }, s.error) : null,
    s.outputNote ? h('p', { class: 'warn-text' }, s.outputNote) : null,
    h('p', { class: 'hint' }, `Every frame of the screen goes through the LUT on the graphics card, as a clip does, cursor included. Pick the same display as the output (with one display, that is the only choice) and ShotReady covers it with its own picture through the LUT, so what you see is what goes out; the window is kept out of the capture, which needs Windows 10 version 2004 or later. ${s.shortcut ? `${s.shortcut} turns the screen output off from any app.` : 'Another app holds Ctrl+Shift+F12, so turn the screen output off here.'} The inverse LUT and monitoring LUTs keep their input and output ranges from where they are loaded.`));
}

// ---------- live stream ----------
const st = {};
const streamLive = (s) => s?.state === 'live' || s?.state === 'reconnecting';
const stKey = (s) => JSON.stringify([s.state, s.error, s.notes, s.info, s.settings, !!s.test, s.test?.file]);
const hms = (t) => `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

async function mediaInputs() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const list = (kind) => all.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label }));
    return { videos: list('videoinput'), audios: list('audioinput') };
  } catch { return { videos: [], audios: [] }; }
}

function stopPreview() {
  st.preview?.getTracks().forEach((t) => t.stop());
  st.preview = null;
  st.previewKey = null;
}

// The picture from the chosen video device, asked for in the stream's own size and rate so that
// looking at it never changes what the device sends to the stream.
async function startPreview(video, device, s) {
  const key = JSON.stringify([device?.id || '', s.settings.height, s.settings.fps]);
  if (st.preview && st.previewKey === key) { video.srcObject = st.preview; return; }
  stopPreview();
  st.previewKey = key;
  try {
    const [width, height] = s.settings.height === 720 ? [1280, 720] : [1920, 1080];
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...(device ? { deviceId: { exact: device.id } } : {}), width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: s.settings.fps } }, audio: false });
    if (st.previewKey !== key || app.tab !== 'stream') { stream.getTracks().forEach((t) => t.stop()); return; }
    st.preview = stream;
    video.srcObject = stream;
  } catch (e) {
    st.previewKey = null;
    if (st.previewNote) st.previewNote.textContent = e.name === 'NotReadableError' ? 'The picture cannot be shown: the device is in use by another program.' : `The picture cannot be shown (${e.message}).`;
  }
}

// Rebuilds the tab when something other than the running numbers changed, but never under a
// dropdown that is open or a box that is being typed in: it waits for that to end.
function streamChanged() {
  if (app.tab !== 'stream' || !app.stream) return;
  if (stKey(app.stream) === st.key) { paintStream(app.stream); return; }
  const typing = document.activeElement?.tagName === 'INPUT' && $('view').contains(document.activeElement);
  if (typing || rebuildBlocked()) { paintStream(app.stream); clearTimeout(st.retry); st.retry = setTimeout(streamChanged, 400); return; }
  renderStream();
}

function paintStream(s) {
  if (!st.go) return;
  const live = streamLive(s);
  st.state.textContent = s.state === 'live' ? `LIVE  ${hms(s.seconds)}` : s.state === 'reconnecting' ? `RECONNECTING  ${hms(s.seconds)}` : s.state === 'starting' ? 'CONNECTING…' : 'OFF';
  st.state.className = `vo-live${s.state === 'live' ? ' on' : s.state === 'off' ? '' : ' warn-text'}`;
  st.stats.textContent = s.state === 'off' ? '' : `${(s.stats.kbps / 1000).toFixed(1)} Mbps  ·  ${s.stats.fps} fps  ·  ${s.stats.dropped + s.stats.skipped} left out${s.stats.behind > 1 ? `  ·  ${s.stats.behind} s behind: the upload is too slow for this bitrate` : ''}`;
  st.stats.className = `mono${s.stats.behind > 1 ? ' warn-text' : ''}`;
  if (st.test && s.test) st.test.textContent = testText(s.test, live || s.state === 'starting');
}
const testText = (t, running) => `${running ? 'Arriving' : 'The test received'}: ${t.frames} pictures (${t.seconds.toFixed(1)} s${t.width ? `, ${t.width}×${t.height}` : ''}), sound ${t.sound ? `yes (${t.audioFrames} blocks)` : 'NONE'}, ${t.megabytes.toFixed(1)} MB.`;

async function renderStream() {
  const [s, inputs, luts] = await Promise.all([act(() => call('streamStatus')), mediaInputs(), act(() => call('luts'))]);
  if (!s || app.tab !== 'stream') return;
  app.stream = s;
  st.key = stKey(s);
  const cfg = s.settings, busy = s.state !== 'off';
  const set = async (patch) => { const r = await act(() => call('stream', 'set', patch)); if (r) { app.stream = r; renderStream(); } };
  const cam = inputs.videos.find((d) => d.id === cfg.video?.id) || inputs.videos.find((d) => d.label && d.label === cfg.video?.label) || null;
  const videoSel = h('select', { 'aria-label': 'Video device', disabled: busy, onchange: (e) => { const d = inputs.videos.find((x) => x.id === e.target.value); set({ video: d || null }); } },
    h('option', { value: '', selected: !cfg.video }, inputs.videos.length ? 'The first video device' : 'No video device found'),
    inputs.videos.map((d) => h('option', { value: d.id, selected: d === cam }, d.label || 'Video device')),
    cfg.video && !cam ? h('option', { value: '?', selected: true }, `${cfg.video.label || 'Saved device'} (not connected)`) : null);
  const mic = cfg.audio.mode === 'device' ? inputs.audios.find((d) => d.id === cfg.audio.id) || inputs.audios.find((d) => d.label && d.label === cfg.audio.label) : null;
  const audioSel = h('select', { 'aria-label': 'Stream sound', disabled: busy, onchange: (e) => { const v = e.target.value; const d = inputs.audios.find((x) => x.id === v); set({ audio: v === 'same' || v === 'none' ? { mode: v } : { mode: 'device', id: d.id, label: d.label } }); } },
    h('option', { value: 'same', selected: cfg.audio.mode === 'same' }, 'The video device\'s own sound'),
    inputs.audios.map((d) => h('option', { value: d.id, selected: d === mic }, d.label || 'Audio input')),
    cfg.audio.mode === 'device' && !mic ? h('option', { value: '?', selected: true }, `${cfg.audio.label || 'Saved input'} (not connected)`) : null,
    h('option', { value: 'none', selected: cfg.audio.mode === 'none' }, 'No sound'));
  const loaded = Object.entries(luts?.luts || {});
  const lutSel = h('select', { 'aria-label': 'Stream colour', disabled: busy, onchange: (e) => set({ lut: e.target.value || null }) },
    h('option', { value: '', selected: !cfg.lut }, 'As it is'),
    loaded.map(([gamma, l]) => h('option', { value: gamma, selected: cfg.lut === gamma }, `Through the ${gamma} LUT (${l.name})`)),
    cfg.lut && !luts?.luts?.[cfg.lut] ? h('option', { value: cfg.lut, selected: true }, `${cfg.lut} LUT (no longer loaded)`) : null);
  const preview = h('video', { class: 'st-preview', muted: true, autoplay: true, playsInline: true });
  preview.muted = true;
  st.previewNote = h('p', { class: 'hint' });

  const dest = cfg.destination, d = cfg.destinations[dest];
  const url = h('input', { type: 'text', class: 'st-url', 'aria-label': 'Server address', value: d.url, placeholder: 'rtmps://server/app', disabled: busy, spellcheck: false, onchange: (e) => set({ url: e.target.value, dest }) });
  const key = h('input', { type: 'password', class: 'st-key', 'aria-label': 'Stream key', placeholder: d.hasKey ? 'Saved. Type a new one to replace it' : 'Paste the stream key', disabled: busy, autocomplete: 'off', spellcheck: false });
  const saveKey = async () => {
    const r = await act(() => call('stream', 'key', { dest, key: key.value }));
    if (!r) return;
    if (r.keyNote) toast(r.keyNote, true); else toast(key.value ? 'Stream key saved' : 'Stream key forgotten');
    app.stream = r;
    renderStream();
  };
  const HELP = {
    youtube: 'In YouTube Studio choose Create > Go live > Stream, and copy the Stream key into the box above. The address is YouTube\'s own; change it only if Studio shows a different Stream URL. A channel that has never streamed has to switch live streaming on first, which takes up to 24 hours.',
    zoom: 'Zoom takes a stream only into a Webinar or a Zoom Events session, not a regular meeting, and only over rtmps://, up to 1080p at 30 fps. Turn on the incoming livestream (RTMP) for the webinar in Zoom and copy its Stream URL and Stream key here: the stream then appears in the webinar as a panelist. For a regular meeting nothing needs to be streamed: in Zoom, choose the same video device as the camera, or Share Screen > Advanced > Content from 2nd Camera.',
    custom: 'Any RTMP or RTMPS server: Facebook Live, Vimeo, Twitch, or a venue\'s own. Paste its server address and stream key.',
    test: 'Runs the whole chain on this computer and sends nothing anywhere: the video device, the encoder, the sound and the sending. It says what arrived, and keeps it as a file that VLC plays, so the picture and sound can be checked before a show.',
  };
  const rate = (v) => h('option', { value: String(v), selected: cfg.fps === v }, `${v} fps`);
  const mbps = [3, 4, 5, 6, 8, 9, 10, 12, 15];
  st.go = h('button', { class: busy ? 'on-btn st-go' : 'primary st-go', onclick: async () => {
    const r = await act(() => call('stream', app.stream?.state === 'off' ? 'start' : 'stop'));
    if (r) { app.stream = r; renderTabs(); renderStream(); if (r.error) toast(r.error, true); }
  } }, busy ? '■ Stop stream' : dest === 'test' ? '● Start test' : '● Go live');
  st.state = h('span', { class: 'vo-live' });
  st.stats = h('span', { class: 'mono' });
  st.test = s.test ? h('span', {}) : null;
  const zoomLimit = dest === 'zoom' && cfg.fps > 30;

  show(scrollNow(), h('div', { class: 'form' },
    h('div', { class: 'section' }, h('h2', {}, 'Source'),
      h('div', { class: 'st-source' },
        h('div', {},
          h('div', { class: 'vo-row' }, h('label', {}, 'Video ', videoSel)),
          h('div', { class: 'vo-row' }, h('label', {}, 'Sound ', audioSel)),
          h('div', { class: 'vo-row' }, h('label', {}, 'Colour ', lutSel)),
          !inputs.videos.length ? h('p', { class: 'err' }, 'No video device: plug in the switcher\'s USB output or a capture box. It shows here as soon as Windows sees it.') : null,
          st.previewNote),
        inputs.videos.length ? preview : null),
      h('p', { class: 'hint' }, 'The stream is whatever this video device shows, so it has to carry the program picture: the switcher\'s USB (webcam) output, or a capture box on a program SDI or HDMI output. The switcher\'s network connection carries no pictures. Colour: a LUT loaded in Settings > Monitoring LUTs can be put on the stream, for a program picture that is still Log.')),
    h('div', { class: 'section' }, h('h2', {}, 'Destination'),
      h('div', { class: 'vo-row' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Destination' },
        Object.entries(cfg.destinations).map(([id, x]) => h('button', { class: id === dest ? 'on' : '', disabled: busy, onclick: () => set({ destination: id }) }, x.name)))),
      dest === 'test' ? null : h('div', { class: 'vo-row' }, h('label', {}, 'Server address ', url)),
      dest === 'test' ? null : h('div', { class: 'vo-row' }, h('label', {}, 'Stream key ', key),
        h('button', { disabled: busy, onclick: saveKey }, 'Save key'),
        d.hasKey ? h('span', { class: 'tag-ok' }, 'Key saved') : h('span', { class: dest === 'custom' ? 'empty' : 'err' }, dest === 'custom' ? 'No key (some servers need none)' : 'No key yet'),
        d.hasKey ? h('button', { class: 'small', disabled: busy, onclick: () => { key.value = ''; saveKey(); } }, 'Forget') : null),
      h('p', { class: 'hint' }, HELP[dest]),
      dest === 'test' ? null : h('p', { class: 'hint' }, 'The stream key is kept encrypted on this computer and is never shown again. Anyone who has it can stream to your channel.')),
    h('div', { class: 'section' }, h('h2', {}, 'Quality'),
      h('div', { class: 'vo-row' },
        h('label', {}, 'Size ', h('select', { 'aria-label': 'Stream size', disabled: busy, onchange: (e) => set({ height: Number(e.target.value) }) },
          h('option', { value: '1080', selected: cfg.height === 1080 }, '1080p (1920×1080)'), h('option', { value: '720', selected: cfg.height === 720 }, '720p (1280×720)'))),
        h('label', {}, 'Frame rate ', h('select', { 'aria-label': 'Stream frame rate', disabled: busy, onchange: (e) => set({ fps: Number(e.target.value) }) }, [25, 30, 50, 60].map(rate))),
        h('label', {}, 'Bitrate ', h('select', { 'aria-label': 'Stream bitrate', disabled: busy, onchange: (e) => set({ mbps: Number(e.target.value) }) },
          h('option', { value: '0', selected: cfg.autoMbps }, `Automatic (${cfg.suggested} Mbps)`),
          mbps.map((m) => h('option', { value: String(m), selected: !cfg.autoMbps && cfg.mbps === m }, `${m} Mbps`))))),
      zoomLimit ? h('p', { class: 'warn-text' }, 'Zoom takes at most 30 frames a second: choose 25 or 30.') : null,
      h('p', { class: 'hint' }, `Use the show's frame rate. The upload speed of the internet connection should be at least twice the bitrate (${(cfg.mbps * 2).toFixed(0)} Mbps here), on a cable rather than Wi-Fi if there is one. Sound is sent as AAC at 160 kbps. A 4K program is scaled down to this size.`)),
    h('div', { class: 'section' }, h('h2', {}, dest === 'test' ? 'Test' : 'Live'),
      h('div', { class: 'vo-row' }, st.go, st.state, st.stats),
      s.error ? h('p', { class: 'err' }, busy ? s.error : `The stream stopped: ${s.error}`) : null,
      s.notes.map((n) => h('p', { class: 'warn-text' }, n)),
      s.info && busy ? h('p', { class: 'hint' }, `${s.info.source.width}×${s.info.source.height} from the video device${s.info.lut ? ', through the LUT' : ''}. Encoded ${s.info.encoder === 'software' ? 'in software (this computer\'s graphics chip has no H.264 encoder that could be used)' : 'on the graphics chip'}. Sound: ${s.info.sound || 'none'}.`) : null,
      s.test ? h('p', { class: s.test.frames && !busy ? 'tag-ok' : '' }, st.test, s.test.file && !busy ? h('button', { class: 'small st-show', onclick: () => act(() => call('streamShowTest')) }, 'Show the file') : null) : null,
      h('p', { class: 'hint' }, 'One click starts and one click stops. If the internet drops, ShotReady keeps connecting again by itself until the stream is stopped. When the upload is too slow, pictures are left out rather than letting the stream fall behind; the count is shown above. Encoding runs in a background process and thread of its own, on the graphics chip where it can, so the cameras\' pictures and this window do not wait for it. Closing ShotReady ends the stream.'))));
  paintStream(s);
  if (inputs.videos.length) startPreview(preview, cam, s); else stopPreview();
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
  Object.assign(app, { luts: init.luts || app.luts, lutOn: { ...init.luts?.on }, profiles: init.profiles, profile: init.profile, switcher: init.switcher, bodies: init.bodies, atem: init.atem, result: init.result, waves: { ...init.waves }, feedBase: init.feed, focus: { ...init.focus }, order: init.cardOrder || [], keyMode: init.keyMode || 'mixer' });
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) { closeModal(); e.stopImmediatePropagation(); } });
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
    paintLevel(body);
  });
  api.on('feedstat', ({ body, fps }) => {
    const f = app.feeds[body];
    if (!f || (!f.connected && !f.lut)) return;
    f.fps.textContent = fps ? `${f.lut ? 'LUT · ' : ''}${fps} fps` : 'no frames';
    f.fps.classList.toggle('bad', !fps);
  });
  document.addEventListener('visibilitychange', syncFeeds);
  api.on('atem', (a) => { app.atem = a; refreshLive(); });
  api.on('mobile', (s) => paintMobile(s));
  api.on('playout', (s) => {
    app.playout = s;
    if (app.tab !== 'videoout') return;
    if (voKey(s) !== vo.key) renderVideoOut(); else paintVideoOut(s);
  });
  api.on('stream', (s) => {
    const was = streamLive(app.stream);
    app.stream = s;
    if (was !== streamLive(s)) renderTabs();
    streamChanged();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { st.key = null; streamChanged(); });
  call('streamStatus').then((s) => { app.stream = s; }).catch(() => {});
  api.on('log', () => { if (app.tab === 'log') renderLog(); });

  await runBusy(() => call('check', { report: false }));
}
start();
