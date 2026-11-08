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
const fmtRuntime = (ms) => { const m = Math.floor(ms / 60000); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };

const app = { tab: 'dashboard', profile: '4K25', switcher: 'constellation', profiles: {}, bodies: [], result: null, atem: {}, busy: false, keepOpen: new Set(), feeds: {}, focus: {}, feedBase: [] };

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
const cardsOf = (r) => app.bodies.map((b) => r.labels.find((l) => l.body === b.id) || r.spares.find((x) => x.body === b.id)).filter(Boolean);

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
  const wrap = h('div', { class: 'feed', role: 'img', 'aria-label': `Live view of ${body}` }, img, box, chip, fps, none);
  f = app.feeds[body] = { wrap, img, box, chip, fps, none, connected: false };
  img.addEventListener('error', () => {
    if (!f.connected) return;
    f.connected = false;
    setTimeout(() => connectFeed(body), 1000);
  });
  return f;
}

// Pictures are only fetched while a camera's card is actually on screen.
function connectFeed(body) {
  const f = app.feeds[body];
  if (!f || !app.feedBase) return;
  // No connection for a camera that is not answering. Each connection is one of the browser's few.
  // A short drop does not disconnect the picture: only 15 seconds of the camera not answering does.
  const online = !!cardOf(body)?.online;
  if (online) f.lastOnline = Date.now();
  const keep = f.connected && Date.now() - (f.lastOnline || 0) < 15000;
  const want = app.tab === 'dashboard' && document.visibilityState === 'visible' && (online || keep);
  if (want && !f.connected) {
    const bases = app.feedBase;
    const base = bases[Math.max(0, app.bodies.findIndex((b) => b.id === body)) % bases.length];
    f.img.src = `${base}/${encodeURIComponent(body)}.mjpeg?${Date.now()}`;
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
    const mode = c?.summary?.lensFocus === 'af' ? 'AF' : c?.summary?.lensFocus === 'mf' ? 'MF' : '';
    text = `${mode ? `${mode} · ` : ''}no focus data`;
  }
  f.chip.textContent = text;
  f.chip.className = `fchip ${kind}`;
  f.chip.hidden = !text;
  f.chip.title = focus?.guide ? `Focus guide level ${focus.level} of 2 (2 is sharp), off by ${focus.angle} (0 is sharp)` : 'The camera reports no focus guide in this mode';
}

// A slot that cannot record is shown as No SD Card. The camera only says recordable or not, so
// this also covers a full, locked or unformatted card. Red and bold when neither slot can
// record; plain light text when the other slot is fine, so it does not distract.
function slot(m, other) {
  if (m.status === '?') return h('dd', {}, '—');
  if (m.status !== 'unrecordable') return h('dd', {}, `${m.minutes} min`);
  return h('dd', { class: `nocard ${other.status === 'unrecordable' ? 'bad' : 'soft'}`, title: 'This slot cannot record: no card, or the card is full, locked or not formatted' }, 'No SD Card');
}
const DETECT = { off: 'OFF', ppl_catch: 'ON', ppl_only: 'People only', anml_only: 'Animals only', anml_catch: 'Animals' };
const DETECT_TIP = { off: 'Subject detection off', ppl_catch: 'People priority', ppl_only: 'People only', anml_only: 'Animals only', anml_catch: 'Animals priority' };

function card(c) {
  const s = c.summary;
  const all = [...c.results, ...(c.checks || [])];
  const reds = all.filter((r) => r.status === 'red').length;
  const yellows = all.filter((r) => r.status === 'yellow').length;
  const tally = c.tally;
  const onPgm = tally?.program?.length, onPvw = tally?.preview?.length;
  const feed = feedEl(c.body);

  const section = h('section', { class: `card ${c.spare ? 'spare' : cardColor(c)} ${c.online ? '' : 'offline'}`, 'data-body': c.body, 'data-tally': onPgm ? 'pgm' : onPvw ? 'pvw' : '' },
    h('div', { class: 'card-head' },
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
      h('dt', {}, 'ISO'), h('dd', {}, s.iso, h('span', { class: 'nd' }, `  ·  ND ${s.nd}`)),
      h('dt', {}, 'WB'), h('dd', {}, s.wbMode === 'kelvin' ? `${s.wbKelvin} K` : s.wbMode),
      h('dt', {}, 'Focus'), h('dd', { title: 'The AF / MF switch on the lens' }, s.lensFocus === 'af' ? 'AF' : s.lensFocus === 'mf' ? 'MF' : '—'),
      h('dt', {}, 'Card A'), slot(s.media[0], s.media[1]),
      h('dt', {}, 'Card B'), slot(s.media[1], s.media[0]),
      h('dt', {}, 'People Priority'), h('dd', { title: DETECT_TIP[s.detect] || s.detect }, DETECT[s.detect] || s.detect || '—'),
      h('dt', {}, 'Continuous AF'), h('dd', { title: 'From the camera focus mode: auto is Continuous AF on, manual is off' }, s.focusMode === 'auto' ? 'ON' : s.focusMode === 'manual' ? 'OFF' : '—'),
      h('dt', { title: 'Peak and average level, calculated from the camera preview frame' }, 'WFM'), h('dd', { 'data-wfm': c.body }, fmtWave(app.waves[c.body]))) : null,
    c.spare ? h('div', { class: 'spare-note' }, c.online ? 'Spare: not counted in the verdict until it has a label.' : 'Spare and offline.') : null,
    h('button', { class: `chip ${reds ? 'red' : yellows ? 'yellow' : 'green'}`, onclick: () => openChecks(c.body) },
      reds || yellows ? `${reds ? `${ICON.red} ${reds} red` : ''}${reds && yellows ? '  ' : ''}${yellows ? `${ICON.yellow} ${yellows} yellow` : ''}  ·  see Checks` : `${ICON.green} All checks passed`));
  paintFeed(c.body);
  connectFeed(c.body);
  return section;
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
  const atemText = atem.connected ? `ATEM ${atem.modeLabel}` : atem.configured ? 'ATEM not connected' : 'No ATEM set';
  return [
    h('div', { class: `verdict ${r.verdict}` },
      h('span', { class: 'big', id: 'verdict' }, VERDICT[r.verdict]),
      h('span', { class: 'sub' }, `${r.switcherName} · ${r.profile} (${r.profileLabel}) · ${r.reds} red · ${r.yellows} yellow`),
      h('span', { class: 'spacer' }),
      h('span', { class: 'sub' }, `${liveText}${atemText} · updated ${new Date(r.time).toLocaleTimeString()}`)),
    r.global.filter((g) => g.status !== 'green').length ? h('div', { class: 'global' }, r.global.filter((g) => g.status !== 'green').map(row)) : '',
  ];
}

function renderDashboard() {
  const r = app.result;
  const view = $('view');
  if (!r) { view.replaceChildren(h('div', { class: 'verdict pending' }, h('span', { class: 'big' }, 'Reading cameras…'))); return; }
  if (rebuildBlocked()) return;

  const unassigned = r.labels.every((l) => !l.body);
  const empty = r.labels.filter((l) => !l.body).map((l) => l.label);
  view.replaceChildren(
    ...banner(r),
    unassigned ? h('div', { class: 'setup' }, 'No bodies are assigned yet.',
      h('button', { class: 'primary', onclick: () => runBusy(() => call('assignInOrder')) }, 'Assign in order'),
      h('span', { class: 'empty' }, 'First body gets the first label, and so on. Change any card afterwards.')) : '',
    empty.length && !unassigned ? h('div', { class: 'global' }, row({ status: 'yellow', check: 'No body', detail: `${empty.join(', ')} ${empty.length > 1 ? 'have' : 'has'} no camera` })) : '',
    h('div', { class: 'grid' }, cardsOf(r).map(card)),
  );
}

// ---------- checks ----------
function checkPanel(c) {
  const order = { red: 0, yellow: 1, info: 2, green: 3 };
  const all = [...c.results, ...(c.checks || [])].map((r) => ({ ...r, label: c.label, body: c.body })).sort((a, b) => order[a.status] - order[b.status]);
  const toConfirm = all.filter((r) => r.action === 'confirm');
  return h('section', { class: `panel ${c.spare ? 'spare' : cardColor(c)}`, 'data-body': c.body },
    h('div', { class: 'card-head' },
      h('span', { class: 'name' }, c.body),
      h('span', { class: 'sub-line' }, `${c.label || 'Spare'}${c.summary ? ` · ${shortLens(c.summary.lens)}` : ''}`)),
    c.spare ? h('div', { class: 'spare-note' }, 'Spare: not counted in the verdict until it has a label.') : null,
    h('div', { class: 'rows' }, all.map(row)),
    c.online ? h('div', { class: 'card-foot' },
      toConfirm.length > 1 ? h('button', { class: 'small', onclick: () => act(() => call('confirm', c.body, toConfirm.map((r) => r.confirmId))) }, `Confirm all (${toConfirm.length})`) : null,
      c.label ? h('button', { class: 'small', onclick: () => showDiff(c.label) }, c.ref ? `Compare with ${c.ref.fromBody}${c.diffCount ? ` (${c.diffCount})` : ''}` : 'Compare') : null,
      c.label ? h('button', { class: 'small', onclick: () => snapshot(c.label) }, 'Save as reference') : null) : null);
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

// ---------- start ----------
async function start() {
  const init = await call('init');
  Object.assign(app, { profiles: init.profiles, profile: init.profile, switcher: init.switcher, bodies: init.bodies, atem: init.atem, result: init.result, waves: { ...init.waves }, feedBase: init.feed, focus: { ...init.focus } });
  $('demo').hidden = !init.demo;
  $('auto').checked = init.autoRefresh;
  $('auto-text').textContent = 'Live';
  $('foot-right').textContent = `ShotReady ${init.version}`;
  renderTabs();
  renderSwitcher();
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
