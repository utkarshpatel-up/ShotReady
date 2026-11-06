// Simulated camera bodies for demo mode and tests. Key names come from the v0.2
// prototype. Values are representative, not a copy of a real camera's dump.
import { createServer } from 'node:http';

export function goodCamera(over = {}) {
  const base = {
    's.hardware': 'EOS C80', 's.firmware': '1.0.7.1', 's.hardware.address': '00:00:85:00:00:01',
    'c.1.lens.name': 'RF70-200mm F2.8 L IS USM Z',
    'f.output1.videoinfo': '3840x2160:25000:P',
    'c.1.gamma': 'clog2_cgamut', 'c.1.gamma.list': 'clog2_cgamut,clog3_cgamut,clog3_bt2020,clog3_bt709,pq_bt2020,hlg_bt2020,widedr_bt709,standard_bt709,canon709_bt709',
    'c.1.lookfile': 'off', 'monitoring.output1.viewassist': 'off', 'c.1.colorbar': 'off',
    'c.1.wb': 'kelvin', 'c.1.wb.kelvin': '5600', 'c.1.wb.kelvin.min': '2000', 'c.1.wb.kelvin.max': '15000',
    'c.1.me.iso': '800', 'c.1.me.iso.list': '160,200,400,800,1600,3200,6400,12800,25600',
    'c.1.me.shutter': '50', 'c.1.me.shutter.mode': 'speed', 'c.1.nd.filter': '2',
    'sim.sensor': 'full', 'c.1.eis': 'off', 'c.1.me.baseiso': '3200', 'c.1.zoom.mode': 'off', 'c.1.zoom.mag': '150', 'sim.lensis': 'off', 'c.1.me.diaphragm': '280',
    'c.1.knee': 'on', 'c.1.knee.slope': '0', 'c.1.blacklevel': '0',
    'f.tally': 'on', 'f.tally.mode': 'program', 'f.rec.format.media1': 'xfavc',
    'f.rec.media1.status': 'recordable', 'f.rec.media1.remainingtime': '180', 'f.rec.media1.videoinfo': '3840x2160:25000:P',
    'f.rec.media2.status': 'recordable', 'f.rec.media2.remainingtime': '180', 'f.rec.media2.videoinfo': '3840x2160:25000:P',
    'f.timecode.frame': 'ndf', 's.power.percent': '',
    'b.power': '0', 'b.lens': '0', 'b.fan': '0', 'b.temperature': '0',
  };
  return { ...base, ...over };
}

// The simulator reports every mandatory setting so demos and tests cover the read path.
export const SIM_MANDATORY = { sensor: ['sim.sensor'], digitalIS: ['c.1.eis'], baseIso: ['c.1.me.baseiso'], teleConverter: ['c.1.zoom.mode'], lensIS: ['sim.lensis'] };

export const toInfoText = (info) => Object.entries(info).map(([k, v]) => `${k}:=${v}`).join('\n') + '\n';

export const labelName = (i) => `Cam-${String(i + 1).padStart(2, '0')}`;
const mac = (n) => `00:00:85:00:00:${String(n).padStart(2, '0')}`;

// One believable show: mostly fine, with each kind of finding appearing once.
export function demoBodies() {
  return [
    { id: 'C80-1', info: goodCamera({ 's.hardware.address': mac(1) }) },
    { id: 'C80-2', info: goodCamera({ 's.hardware.address': mac(2), 'c.1.lens.name': 'RF24-70mm F2 L IS USM', 'sim.sensor': 's35', 'c.1.me.diaphragm': '200' }) },
    { id: 'C80-3', info: goodCamera({ 's.hardware.address': mac(3), 'c.1.gamma': 'canon709_bt709', 'c.1.lens.name': 'RF24-105mm F4 L IS USM' }) },
    { id: 'C80-4', info: goodCamera({ 's.hardware.address': mac(4), 'f.rec.media1.status': 'unrecordable', 'f.rec.media1.remainingtime': '0', 'f.rec.media2.status': 'unrecordable', 'f.rec.media2.remainingtime': '0', 'f.timecode.frame': 'df' }) },
    { id: 'C80-5', info: goodCamera({ 's.hardware.address': mac(5), 'c.1.wb.kelvin': '4300', 'c.1.me.iso': '6400', 'c.1.me.diaphragm': '400' }) },
    { id: 'C80-6', info: goodCamera({ 's.hardware.address': mac(6), 'f.rec.media1.remainingtime': '35', 'f.rec.media2.remainingtime': '0', 's.firmware': '1.0.6.0', 'c.1.eis': 'on' }) },
    { id: 'C80-7', offline: true, info: goodCamera({ 's.hardware.address': mac(7) }) },
    { id: 'C50-8', info: goodCamera({ 's.hardware': 'EOS C50', 's.firmware': '1.0.2.1', 's.hardware.address': mac(8), 'c.1.lens.name': 'RF28-70mm F2 L USM', 'f.tally': 'off', 'c.1.zoom.mode': 'mag', 'c.1.zoom.mag': '200', 'sim.lensis': 'on', 'c.1.gamma.list': 'clog2_cgamut,clog3_cgamut,canon709_bt709' }) },
  ];
}

function writePart(res, items) {
  const body = `timestamp=1.000\nrealtime=1.000\n${toInfoText(items)}`;
  res.write(`--boundary\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}\r\n`);
}

// Starts one HTTP server per body on 127.0.0.1. A body can flip between two infos
// (duplicate IP) or be taken offline at runtime.
export async function startSimulator(bodies, infoPath = '/-wvhttp-01-/info.cgi') {
  const servers = [];
  const live = {};
  for (const b of bodies) {
    const entry = {
      ...b, requests: 0, methods: [], subs: new Set(),
      // Changes settings the way an operator would, and pushes them to open streams.
      update(items) {
        entry.info = { ...entry.info, ...items };
        for (const res of entry.subs) writePart(res, items);
      },
      dropStreams() { for (const res of entry.subs) res.destroy(); entry.subs.clear(); },
    };
    live[b.id] = entry;
    const srv = createServer((req, res) => {
      entry.requests++;
      entry.methods.push(req.method);
      if (entry.offline) { req.socket.destroy(); return; }
      const [path, query] = req.url.split('?');
      if (path === infoPath.replace(/info\.cgi$/, 'image.cgi') && entry.frame) {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'livescope-status': '0' });
        res.end(entry.frame);
        return;
      }
      if (path !== infoPath) { res.writeHead(404); res.end(); return; }
      if (entry.requireAuth && req.headers.authorization !== entry.requireAuth) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="cam"' }); res.end(); return;
      }
      if (/type=stream/.test(query || '')) {
        if (entry.noStream) { res.writeHead(200, { 'content-type': 'text/plain', 'livescope-status': '507' }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace;boundary=boundary', 'livescope-status': '0' });
        entry.subs.add(res);
        res.on('close', () => entry.subs.delete(res));
        writePart(res, entry.info);
        return;
      }
      const info = entry.flip && entry.requests % 2 === 0 ? entry.flip : entry.info;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(toInfoText(info));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    entry.ip = `127.0.0.1:${srv.address().port}`;
    servers.push(srv);
  }
  return {
    bodies: live,
    config: (extra = {}) => ({
      infoPath,
      auth: { user: '', pass: '' },
      standards: { approvedFirmware: { 'EOS C80': ['1.0.7.1'] }, mandatory: SIM_MANDATORY },
      bodies: bodies.map((b) => ({ id: b.id, model: b.info['s.hardware'], ip: live[b.id].ip })),
      locations: bodies.map((_, i) => ({ label: labelName(i), atemInput: i + 1 })),
      ...extra,
    }),
    close: () => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))),
  };
}
