// Always-on-top strip: a few essential values per camera. Camera text goes in through
// textContent only.
const api = window.shotready;
// The left of the strip says whether the ATEM is connected, the same as the main window.
function atemWord(a) {
  if (a?.connected) return ['ok', 'CONNECTED'];
  if (a && !a.enabled) return ['off', 'NO ATEM'];
  if (a?.configured) return ['bad', 'ATEM LOST'];
  if (a?.searching || a?.trying || !a?.notFound) return ['wait', 'SEARCHING'];
  return ['bad', 'NO ATEM'];
}
let atem = null;
let last = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function value(id, name, val, bad) {
  const known = val !== null && val !== undefined;
  const v = el('span', `v${bad ? ' bad' : ''}${known ? '' : ' unknown'}`);
  v.dataset.v = id;
  v.title = known ? `${name}: ${val}` : `${name}: camera does not report this`;
  v.append(el('i', '', name), known ? String(val) : '—');
  return v;
}
const WFM_TITLE = 'Peak and average level, calculated from the camera preview frame. Not the camera\'s own waveform display.';
const fmtWave = (w) => (w ? `${w.peak}% avg ${w.avg}%` : '—');
let waves = {};
const isOn = (v) => v !== null && v !== undefined && !/^off$/i.test(v);

function cell(l) {
  const worst = l.results.some((r) => r.status === 'red') ? 'red' : l.results.some((r) => r.status === 'yellow') ? 'yellow' : 'green';
  const c = el('div', `cell ${worst}`);
  c.dataset.label = l.label;
  const head = el('div', 'head');
  head.append(el('b', '', l.label), el('span', '', l.body));
  if (l.tally?.program?.length) head.append(el('span', 'badge pgm', 'PGM'));
  else if (l.tally?.preview?.length) head.append(el('span', 'badge pvw', 'PVW'));
  c.append(head);
  const e = l.essentials;
  if (!e) { c.append(el('div', 'off', 'Offline')); return c; }
  const vals = el('div', 'vals');
  vals.append(
    value('wb', 'WB', e.wb),
    value('iso', 'ISO', e.iso, e.isoOver),
    value('shutter', 'Shutter', e.shutter, e.shutterBad),
    value('aperture', 'Iris', e.aperture),
    value('digitalIS', 'Dig IS', e.digitalIS, isOn(e.digitalIS)),
  );
  const wfm = value('wfm', 'WFM', fmtWave(waves[l.body]));
  wfm.dataset.wfm = l.body;
  wfm.title = WFM_TITLE;
  vals.append(wfm);
  c.append(vals);
  return c;
}

function renderStatus() {
  const v = document.getElementById('verdict');
  const [cls, word] = atemWord(atem);
  v.className = `verdict ${cls}`;
  const checks = !last ? '' : last.reds || last.yellows ? `${last.reds ? `${last.reds} red` : ''}${last.reds && last.yellows ? ' ' : ''}${last.yellows ? `${last.yellows} yel` : ''}` : 'checks ok';
  v.replaceChildren(document.createTextNode(word), el('small', last?.reds ? 'red' : last?.yellows ? 'yellow' : '', checks));
  v.title = `${atem?.connected ? `ATEM connected: ${atem.name || ''} ${atem.ip}` : 'ATEM not connected'}. Camera checks: ${last ? `${last.reds} red, ${last.yellows} yellow` : 'not run yet'}. Click to open ShotReady.`;
}

function render(r) {
  if (!r) return;
  last = r;
  renderStatus();
  document.getElementById('cells').replaceChildren(...r.labels.filter((l) => l.body).map(cell));
}

document.getElementById('bar-close').onclick = () => api.call('setBar', false);
document.getElementById('verdict').onclick = () => api.call('showMain');
api.on('result', render);
api.on('atem', (a) => { atem = a; renderStatus(); });
// Levels change constantly, so only their text is touched, not the whole strip.
api.on('wave', ({ body, wave }) => {
  if (wave) waves[body] = wave; else delete waves[body];
  for (const v of document.querySelectorAll('[data-wfm]')) if (v.dataset.wfm === body) v.lastChild.nodeValue = fmtWave(wave);
});
api.call('init').then((init) => { waves = { ...init.waves }; atem = init.atem; renderStatus(); render(init.result); });
