// Always-on-top strip: a few essential values per camera. Camera text goes in through
// textContent only.
const api = window.shotready;
const WORDS = { ready: 'READY', warnings: 'WARNINGS', 'not-ready': 'NOT READY' };

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
    value('lensIS', 'Lens IS', e.lensIS, isOn(e.lensIS)),
    value('digitalIS', 'Dig IS', e.digitalIS, isOn(e.digitalIS)),
  );
  const wfm = value('wfm', 'WFM', fmtWave(waves[l.body]));
  wfm.dataset.wfm = l.body;
  wfm.title = WFM_TITLE;
  vals.append(wfm);
  c.append(vals);
  return c;
}

function render(r) {
  if (!r) return;
  const v = document.getElementById('verdict');
  v.className = `verdict ${r.verdict}`;
  v.replaceChildren(document.createTextNode(WORDS[r.verdict]), el('small', '', r.profile));
  v.title = `${r.reds} red, ${r.yellows} yellow. Click to open ShotReady.`;
  document.getElementById('cells').replaceChildren(...r.labels.filter((l) => l.body).map(cell));
}

document.getElementById('bar-close').onclick = () => api.call('setBar', false);
document.getElementById('verdict').onclick = () => api.call('showMain');
api.on('result', render);
// Levels change constantly, so only their text is touched, not the whole strip.
api.on('wave', ({ body, wave }) => {
  if (wave) waves[body] = wave; else delete waves[body];
  for (const v of document.querySelectorAll('[data-wfm]')) if (v.dataset.wfm === body) v.lastChild.nodeValue = fmtWave(wave);
});
api.call('init').then((init) => { waves = { ...init.waves }; render(init.result); });
