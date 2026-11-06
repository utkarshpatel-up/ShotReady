// ShotReady verification engine. Pure functions, no I/O: ported from the v0.2
// prototype (shotready-check.mjs) so the same rules drive the desktop app.

export const PROFILES = {
  '4K25': { label: '2160p25', output: '3840x2160:25000:P', atemMode: 'P4KHDp25' },
  'HD25': { label: '1080p25', output: '1920x1080:25000:P', atemMode: 'P1080p25' },
};

const FLAT_GAMMA = ['clog2_cgamut', 'clog3_cgamut', 'clog3_bt2020', 'clog3_bt709'];
// The list first shipped in cameras.json, from before flat became the standard.
export const OLD_DEFAULT_GAMMA = ['standard_bt709', 'canon709_bt709', 'widedr_bt709'];

export const DEFAULT_STANDARDS = {
  // Team standard: the recorder always gets a flat picture, never a colour one.
  allowedGamma: FLAT_GAMMA,
  shutterSpeed: 50,
  requireTally: true,
  requireRecording: true,
  minRecordMinutes: 60,
  approvedFirmware: {},
  consistencyKeys: ['gamma', 'wbMode', 'wbKelvin', 'iso', 'shutter', 'output', 'recCodec'],
  // Camera key names for the mandatory settings. An empty list, or a key this camera does not
  // report, means the operator confirms the setting by hand: it never passes on a guess.
  // c.1.eis and c.1.me.baseiso were read from a real C80 (firmware 1.0.6.1). c.1.is is the same
  // setting on older models. Not yet read from a C50.
  mandatory: {
    sensor: [],
    digitalIS: ['c.1.eis', 'c.1.is'],
    baseIso: ['c.1.me.baseiso'],
    teleConverter: ['c.1.zoom.mode'], // XC spec: 'mag' means digital teleconverter
    lensIS: [],
  },
};

// Settings that belong to the LABEL (picture look), taken from the earlier camera.
// Body-specific things (IP, MAC, lens, cards, iris) are never included.
const COPY_PREFIXES = [
  'c.1.capturemode', 'c.1.gamma', 'c.1.hlgcolor', 'c.1.over100', 'c.1.lookfile',
  'c.1.wb', 'c.1.me.iso', 'c.1.me.isogain', 'c.1.me.gain', 'c.1.me.shutter', 'c.1.nd',
  'c.1.knee', 'c.1.blackgamma', 'c.1.blacklevel', 'c.1.colormatrix', 'c.1.colorcorrection',
  'c.1.skindetail', 'c.1.lowkeysaturation', 'c.1.ac', 'c.1.nr',
  'f.tally.mode', 'f.timecode.run', 'f.rec.format',
];
const isMetaKey = (k) => /\.(list|min|max)$/.test(k) || /\.action/.test(k);
const isCopyKey = (k) => !isMetaKey(k) && COPY_PREFIXES.some((p) => k === p || k.startsWith(p + '.'));

export function parseInfo(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let i = line.indexOf(':='), sep = 2;
    if (i < 0) { i = line.indexOf('='); sep = 1; }
    if (i < 0) continue;
    out[line.slice(0, i)] = line.slice(i + sep);
  }
  return out;
}

export function summarize(info) {
  return {
    model: info['s.hardware'] || '?',
    firmware: info['s.firmware'] || '?',
    mac: info['s.hardware.address'] || '?',
    lens: info['c.1.lens.name'] || '(no lens reported)',
    output: info['f.output1.videoinfo'] || '',
    gamma: info['c.1.gamma'] || '?',
    lookfile: info['c.1.lookfile'] || 'off',
    colorbar: info['c.1.colorbar'] || 'off',
    wbMode: info['c.1.wb'] || '?',
    wbKelvin: info['c.1.wb.kelvin'] || '?',
    iso: info['c.1.me.iso'] || '?',
    shutter: info['c.1.me.shutter'] || '?',
    shutterMode: info['c.1.me.shutter.mode'] || '?',
    nd: info['c.1.nd.filter'] || '?',
    tally: info['f.tally'] || '?',
    recCodec: info['f.rec.format.media1'] || '?',
    media: [1, 2].map((n) => ({
      slot: n,
      status: info[`f.rec.media${n}.status`] || '?',
      minutes: Number(info[`f.rec.media${n}.remainingtime`] || 0),
      videoinfo: info[`f.rec.media${n}.videoinfo`] || '',
    })),
    health: ['power', 'lens', 'fan', 'temperature'].map((k) => [k, info[`b.${k}`] ?? '0']),
    powerPercent: info['s.power.percent'] || '',
  };
}

export const fmtVideo = (v) => {
  if (!v) return '(none)';
  const [res, rate, scan] = v.split(':');
  return `${res} ${Number(rate) / 1000}${(scan || '').toLowerCase()}`;
};
export const shortLens = (l) => l.replace(/\s+(L|IS|USM|Z|STM|PZ)\b/g, '').replace(/\s+/g, ' ').trim();

export function checkCamera(s, loc, profile, std) {
  const r = [];
  const add = (status, check, detail) => r.push({ status, check, detail });

  const approved = std.approvedFirmware?.[s.model];
  if (approved && !approved.includes(s.firmware)) add('yellow', 'Firmware', `${s.firmware} (approved: ${approved.join(', ')})`);

  if (loc?.requiredModel && !s.model.includes(loc.requiredModel)) add('red', 'Model', `${s.model} — label needs ${loc.requiredModel}`);
  if (loc?.expectedLens && !s.lens.toLowerCase().includes(loc.expectedLens.toLowerCase())) {
    add('yellow', 'Lens', `${s.lens} — label usually uses "${loc.expectedLens}"`);
  } else if (s.lens === '(no lens reported)') add('yellow', 'Lens', 'Camera reports no lens. Check one is attached');
  else add('green', 'Lens', s.lens);

  // profile.sdi is set when the switcher dictates the SDI format regardless of the profile.
  const wantSdi = profile.sdi || profile.output;
  const wantText = profile.sdi ? `${fmtVideo(profile.sdi)} (${profile.sdiWhy})` : profile.label;
  if (!s.output) add('red', 'SDI output', 'Output 1 reports no video');
  else if (s.output !== wantSdi) add('red', 'SDI output', `${fmtVideo(s.output)} but ${profile.sdi ? `${profile.sdiWhy} needs ${fmtVideo(profile.sdi)}` : `profile is ${profile.label}`}`);
  else add('green', 'SDI output', `${fmtVideo(s.output)} matches ${wantText}`);

  if (std.allowedGamma.includes(s.gamma)) add('green', 'Gamma', `${s.gamma} (flat)`);
  else if (/^clog/.test(s.gamma)) add('red', 'Gamma', `${s.gamma} is not in the allowed gamma list`);
  else add('red', 'Gamma', `${s.gamma} sends a colour picture to the recorder. It must be flat (Canon Log)`);
  if (s.lookfile === 'on') add('yellow', 'Look file', 'LUT loaded — confirm all cameras use the same one');
  if (s.colorbar === 'on') add('red', 'Color bars', 'Bars are ON');

  if (s.shutterMode !== 'speed') add('yellow', 'Shutter', `Mode "${s.shutterMode}" (standard: speed 1/${std.shutterSpeed})`);
  else if (Number(s.shutter) !== Number(std.shutterSpeed)) add('yellow', 'Shutter', `1/${s.shutter} (standard 1/${std.shutterSpeed})`);
  else add('green', 'Shutter', `1/${s.shutter}`);
  add('info', 'Exposure', `ISO ${s.iso} · ND ${s.nd} · WB ${s.wbMode}${s.wbMode === 'kelvin' ? ' ' + s.wbKelvin + 'K' : ''}`);

  if (std.requireTally && s.tally !== 'on') add('yellow', 'Tally', `Tally is ${s.tally}`);
  else add('green', 'Tally', `Tally ${s.tally}`);

  if (std.requireRecording) {
    const ready = s.media.filter((m) => m.status !== 'unrecordable' && m.status !== '?');
    if (!ready.length) add('red', 'Recording media', 'No recordable card in either slot');
    else {
      const best = Math.max(...ready.map((m) => m.minutes));
      if (best < std.minRecordMinutes) add('yellow', 'Recording media', `Only ${best} min left (need ${std.minRecordMinutes})`);
      else add('green', 'Recording media', `${best} min available`);
    }
    const mm = s.media.find((m) => m.videoinfo && m.videoinfo !== profile.output);
    if (mm) add('yellow', 'Recording format', `Slot ${mm.slot} records ${fmtVideo(mm.videoinfo)}`);
  }

  const bad = s.health.filter(([, v]) => v !== '0' && v !== '');
  if (bad.length) add('red', 'Hardware warning', bad.map(([k, v]) => `${k}=${v}`).join(', '));
  else add('green', 'Hardware', 'No warnings');
  if (s.powerPercent && Number(s.powerPercent) < 30) add('yellow', 'Battery', `${s.powerPercent}%`);
  return r;
}

// Cameras report modes such as on1 and on2. The team only needs to know ON or OFF.
const onOff = (v) => (/^off$/i.test(v) ? 'OFF' : 'ON');
const OFF = { want: (v) => /^off$/i.test(v), wantText: 'OFF', show: onOff };
const MANDATORY = [
  { id: 'sensor', check: 'Sensor mode', ask: 'Check it is Full, never Super 35', want: (v) => /^(full|ff)/i.test(v), wantText: 'Full' },
  { id: 'digitalIS', check: 'Digital IS', ask: 'Check it is OFF', ...OFF },
  { id: 'teleConverter', check: 'Tele-converter', ask: 'Check it is OFF', ...OFF, describe: (info) => `ON at ${Number(info['c.1.zoom.mag']) / 100}x` },
  { id: 'lensIS', check: 'Lens stabilization', ask: 'Check it is OFF', ...OFF },
];
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const baseIsoOf = (info, keys) => {
  const key = (keys.baseIso || []).find((k) => k in info);
  return Number(key ? info[key].match(/\d{3,}/)?.[0] : NaN);
};

// Mandatory settings on every camera. A value the camera reports decides the row. Anything it
// does not report stays yellow until an operator confirms it, for this lens, today.
export function mandatoryChecks(info, s, std, confirmed = {}, now = Date.now()) {
  const keys = { ...DEFAULT_STANDARDS.mandatory, ...std.mandatory };
  const rows = [];
  const manual = (id, check, ask) => {
    const c = confirmed[id];
    if (c && c.lens === s.lens && sameDay(c.at, now)) {
      rows.push({ status: 'green', check, detail: `Confirmed by operator at ${new Date(c.at).toLocaleTimeString()}, not read from camera` });
    } else {
      rows.push({ status: 'yellow', check, detail: ask, action: 'confirm', confirmId: id });
    }
  };
  for (const m of MANDATORY) {
    const read = (keys[m.id] || []).filter((k) => k in info);
    if (!read.length) { manual(m.id, m.check, `Camera does not report this. ${m.ask}`); continue; }
    const bad = read.filter((k) => !m.want(info[k]));
    if (bad.length) rows.push({ status: 'red', check: m.check, detail: `${m.describe ? m.describe(info) : (m.show ? m.show(info[bad[0]]) : info[bad[0]])} (must be ${m.wantText})` });
    else rows.push({ status: 'green', check: m.check, detail: m.show ? m.show(info[read[0]]) : info[read[0]] });
  }

  const base = baseIsoOf(info, keys);
  const iso = Number(s.iso);
  if (base > 0 && iso > 0) {
    if (iso > base) rows.push({ status: 'red', check: 'Base ISO range', detail: `ISO ${iso} exceeds Base ISO ${base}: grainy picture, lost sharpness` });
    else rows.push({ status: 'green', check: 'Base ISO range', detail: `ISO ${iso} within Base ISO ${base}` });
  } else {
    manual('baseIso', 'Base ISO range', `Cannot compare from the camera. Check ISO ${s.iso} is not above the Base ISO range`);
  }
  // Physical: no camera setting can report this.
  manual('lensFilter', 'Lens filter', 'Check no filter is causing a focus or sharpness issue');
  return rows;
}

// The few values shown on the always-on-top bar. null means the camera did not report it.
export function essentials(info, s, std) {
  const keys = { ...DEFAULT_STANDARDS.mandatory, ...std.mandatory };
  const pick = (id) => {
    const read = (keys[id] || []).filter((k) => k in info);
    if (!read.length) return null;
    return onOff(info[read.find((k) => !/^off$/i.test(info[k])) || read[0]]);
  };
  // Blank when no lens is attached. c.1.me.diaphragm is in hundredths: 280 means F2.8.
  const raw = ['c.1.me.fno', 'c.1.ae.fno', 'c.1.me.diaphragm', 'c.1.ae.diaphragm'].map((k) => info[k]).find((v) => v);
  const n = Number(raw);
  const base = baseIsoOf(info, keys);
  return {
    wb: s.wbMode === 'kelvin' ? `${s.wbKelvin}K` : s.wbMode,
    iso: s.iso,
    isoOver: base > 0 && Number(s.iso) > base,
    shutter: s.shutterMode === 'speed' ? `1/${s.shutter}` : s.shutterMode,
    shutterBad: s.shutterMode !== 'speed' || Number(s.shutter) !== Number({ ...DEFAULT_STANDARDS, ...std }.shutterSpeed),
    aperture: !raw ? null : n >= 100 ? `F${n / 100}` : n > 0 ? `F${n}` : raw,
    lensIS: pick('lensIS'),
    digitalIS: pick('digitalIS'),
  };
}

export function extractCopySettings(info) {
  const o = {};
  for (const [k, v] of Object.entries(info)) if (isCopyKey(k)) o[k] = v;
  return o;
}

// Does this body accept the value? Uses the camera's own .list/.min/.max entries.
export function validateOnBody(key, value, info) {
  const list = info[`${key}.list`];
  if (list !== undefined) return list.split(',').includes(value);
  const min = info[`${key}.min`], max = info[`${key}.max`];
  if (min !== undefined && max !== undefined && value !== '') {
    const n = Number(value);
    return !Number.isNaN(n) && n >= Number(min) && n <= Number(max);
  }
  return key in info;
}

export function diffAgainstRef(ref, info) {
  const rows = [];
  for (const [k, refVal] of Object.entries(ref.settings)) {
    // A reference saved earlier may hold a setting that is no longer compared.
    if (!isCopyKey(k)) continue;
    const cur = info[k];
    if (cur === refVal) continue;
    rows.push({ key: k, current: cur ?? '(not on this body)', earlier: refVal, copyable: validateOnBody(k, refVal, info) });
  }
  return rows;
}

// Identity checks: learned/registered MAC, registry model, unacknowledged lens change, duplicate IP.
export function bodyIdentity(rb, known = {}) {
  const out = [];
  if (rb.error) {
    out.push({ status: 'red', check: 'Connection', detail: `${rb.body.ip} not answering (${rb.error})` });
    return out;
  }
  const s = rb.summary;
  if (rb.dupMacs) out.push({ status: 'red', check: 'Duplicate IP', detail: `Two cameras answer on ${rb.body.ip} (MACs ${rb.dupMacs.join(', ')})` });
  const regMac = rb.body.mac || known.mac;
  if (regMac && regMac !== s.mac) out.push({ status: 'red', check: 'Wrong body on IP', detail: `${rb.body.ip} answers as MAC ${s.mac}, ${rb.body.id} is ${regMac}. Was an IP changed?` });
  if (rb.body.model && !s.model.includes(rb.body.model.replace(/^EOS\s*/i, ''))) out.push({ status: 'red', check: 'Model', detail: `Registry says ${rb.body.model}, camera says ${s.model}` });
  if (known.lastLens && known.lastLens !== s.lens) out.push({ status: 'yellow', check: 'Lens changed', detail: `${shortLens(known.lastLens)} → ${shortLens(s.lens)}`, action: 'acceptLens' });
  return out;
}

const MATCH_NAMES = { gamma: 'Gamma', wbMode: 'WB mode', wbKelvin: 'WB Kelvin', iso: 'ISO', shutter: 'Shutter', output: 'Output format', recCodec: 'Rec codec' };

// Cross-camera matching. live = [{ label, summary }]
export function matchCameras(live, keys) {
  const rows = [];
  for (const key of keys) {
    // Kelvin only means something on cameras actually in Kelvin mode.
    const pool = key === 'wbKelvin' ? live.filter((x) => x.summary.wbMode === 'kelvin') : live;
    if (new Set(pool.map((x) => x.summary[key])).size > 1) {
      rows.push({
        key, name: MATCH_NAMES[key] || key,
        detail: pool.map((x) => `${x.label}: ${key === 'output' ? fmtVideo(x.summary[key]) : x.summary[key]}`).join(' · '),
      });
    }
  }
  return rows;
}

export const verdictOf = (reds, yellows) => (reds ? 'not-ready' : yellows ? 'warnings' : 'ready');
