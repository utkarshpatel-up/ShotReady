// Finds ATEM switchers on every network this computer is on, wired or Wi-Fi, in two ways at once:
//
// - Bonjour (mDNS). ATEM software announces the switcher as a _blackmagic._tcp service whose class
//   is AtemSwitcher. The question is asked on each network adapter separately, so a switcher on the
//   Wi-Fi is found as well as one on the Ethernet.
// - A knock on the ATEM control port. Every ATEM answers the opening packet of its control protocol
//   (UDP 9910), so each address on each local network, on each camera's network and at Blackmagic's
//   factory address is sent that one packet. This finds switchers that do not announce themselves.
//   A switcher that answers holds the unused session for a few seconds and then drops it.
//
// Read only: nothing is ever changed on a switcher.
import dgram from 'node:dgram';
import os from 'node:os';
import { isIPv4 } from 'node:net';

export const ATEM_PORT = 9910;
export const ATEM_FACTORY_IP = '192.168.10.240';
// The opening packet of the ATEM control protocol, the same one atem-connection sends.
const HELLO = Buffer.from([0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const MDNS = { address: '224.0.0.251', port: 5353 };
const SERVICE = '_blackmagic._tcp.local';
// Up to a /22 (1022 addresses) a whole network is knocked on. A bigger one gets the /24 around this
// computer's own address, so one search never floods a large network.
const WIDEST = 22;

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const toInt = (ip) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
const toIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
const bareIp = (host) => String(host || '').trim().replace(/:\d+$/, '');

// The computer's IPv4 networks: Ethernet, Wi-Fi, USB adapters, anything with an address.
export function localNetworks(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || !isIPv4(a.address)) continue;
      const prefix = a.cidr ? Number(a.cidr.split('/')[1]) : toInt(a.netmask || '255.255.255.0').toString(2).replace(/0/g, '').length;
      out.push({ name, address: a.address, prefix });
    }
  }
  return out;
}

const networkText = (n) => `${n.name} ${n.address}/${n.prefix}`;
// What a search covers, in words: each adapter, and the cameras' networks that are not on one.
export function describeNetworks(nets, subnetsOf = []) {
  const local = nets.length ? nets.map(networkText).join(', ') : 'no network adapter (is a cable plugged in, or the Wi-Fi on?)';
  const onAdapter = (ip) => nets.some((n) => Math.floor(toInt(n.address) / 2 ** (32 - Math.max(n.prefix, 24))) === Math.floor(toInt(ip) / 256));
  const cams = [...new Set(subnetsOf.map(bareIp).filter((ip) => isIPv4(ip) && !ip.startsWith('127.') && !onAdapter(ip)).map((ip) => `${ip.split('.').slice(0, 3).join('.')}.x`))];
  return `${local}${cams.length ? `, and the cameras' network ${cams.join(', ')}` : ''}`;
}

// The addresses to knock on, the likeliest first: the addresses given, Blackmagic's factory address,
// then whole networks. Link-local networks (169.254.x.x, a computer with no address handed out) are
// left out: a switcher is never on one.
export function sweepTargets(networks, { subnetsOf = [], hosts = [] } = {}) {
  const set = new Set();
  for (const ip of [...hosts, ATEM_FACTORY_IP].map(bareIp)) if (isIPv4(ip)) set.add(ip);
  const range = (ip, prefix) => {
    const p = prefix < WIDEST ? 24 : prefix;
    if (!isIPv4(ip) || p > 30 || ip.startsWith('169.254.') || ip.startsWith('127.')) return;
    const size = 2 ** (32 - p);
    const base = Math.floor(toInt(ip) / size) * size;
    for (let i = 1; i < size - 1; i++) set.add(toIp(base + i));
  };
  for (const ip of subnetsOf) range(bareIp(ip), 24);
  for (const n of networks) range(n.address, n.prefix);
  for (const n of networks) set.delete(n.address);
  return [...set];
}

// An ATEM's answer to the opening packet: from the control port, the length it says it has, and
// the new-session flag set.
export function isAtemReply(msg, rinfo) {
  if (rinfo?.port !== ATEM_PORT || msg.length < 12) return false;
  return (msg.readUInt16BE(0) & 0x07ff) === msg.length && ((msg[0] >> 3) & 0x02) !== 0;
}

// ---------- a little DNS, just enough for one mDNS question and its answer ----------
const encodeName = (name) => Buffer.concat([
  ...name.split('.').filter(Boolean).map((label) => { const b = Buffer.from(label); return Buffer.concat([Buffer.from([b.length]), b]); }),
  Buffer.from([0]),
]);

// A PTR question for the Blackmagic service, asking for the answer to come straight back.
export function mdnsQuery(name = SERVICE) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // PTR
  tail.writeUInt16BE(0x8001, 2); // class IN, unicast answer wanted
  return Buffer.concat([head, encodeName(name), tail]);
}

function readName(buf, start) {
  const labels = [];
  let off = start, end = -1;
  for (let hops = 0; hops < 64; hops++) {
    const len = buf[off];
    if (len === undefined) throw new Error('name runs past the packet');
    if (len === 0) { off += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = off + 2;
      off = buf.readUInt16BE(off) & 0x3fff;
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.'), end: end < 0 ? off : end };
}

// The records of a DNS message: PTR, SRV, TXT and A, which is all an mDNS answer needs.
export function parseDns(buf) {
  if (buf.length < 12) return [];
  const questions = buf.readUInt16BE(4);
  const count = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < questions; i++) off = readName(buf, off).end + 4;
  const out = [];
  for (let i = 0; i < count && off < buf.length; i++) {
    const { name, end } = readName(buf, off);
    const type = buf.readUInt16BE(end);
    const len = buf.readUInt16BE(end + 8);
    const at = end + 10;
    if (at + len > buf.length) break;
    const r = { name, type };
    if (type === 12) r.ptr = readName(buf, at).name;
    else if (type === 33) { r.port = buf.readUInt16BE(at + 4); r.target = readName(buf, at + 6).name; }
    else if (type === 1 && len === 4) r.a = [...buf.subarray(at, at + 4)].join('.');
    else if (type === 16) {
      r.txt = {};
      for (let p = at; p < at + len;) {
        const s = buf.toString('utf8', p + 1, p + 1 + buf[p]);
        const eq = s.indexOf('=');
        if (eq > 0) r.txt[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
        p += 1 + buf[p];
      }
    }
    out.push(r);
    off = at + len;
  }
  return out;
}

// The ATEMs in one mDNS answer. Other Blackmagic gear (HyperDeck, Web Presenter, cameras) shares the
// service name, so only a class or name with ATEM in it counts. With no address record in the
// answer, the address it came from is used.
export function atemsInAnswer(records, from) {
  const same = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
  const out = [];
  const instances = new Set(records.filter((r) => r.type === 12 && same(r.name, SERVICE)).map((r) => r.ptr));
  for (const r of records) if ((r.type === 16 || r.type === 33) && r.name.toLowerCase().endsWith(`.${SERVICE}`)) instances.add(r.name);
  for (const inst of instances) {
    const txt = records.find((r) => r.type === 16 && same(r.name, inst))?.txt || {};
    const srv = records.find((r) => r.type === 33 && same(r.name, inst));
    const a = srv && records.find((r) => r.type === 1 && same(r.name, srv.target))?.a;
    const name = txt.name || inst.slice(0, -(SERVICE.length + 1));
    if (!/atem/i.test(`${txt.class || ''} ${name}`)) continue;
    out.push({ ip: a || from, name, via: 'Bonjour' });
  }
  return out;
}

function openSocket(address) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { try { s.close(); } catch { /* already closed */ } resolve(null); });
    s.bind(address ? { address, port: 0 } : { port: 0 }, () => {
      s.removeAllListeners('error');
      s.on('error', () => {}); // an unreachable address is expected during a sweep
      resolve(s);
    });
  });
}

/**
 * Searches every network for ATEM switchers. Resolves after waitMs with what answered.
 * @param hints.subnetsOf  addresses whose /24 is knocked on too (the cameras' addresses)
 * @param hints.hosts      single addresses to knock on (the last ATEM address, for example)
 * @returns { networks, found: [{ ip, name, via, network }] }
 */
export async function findAtems({ hints = {}, waitMs = 2500, networks = localNetworks() } = {}) {
  const found = new Map();
  const networkOf = (ip) => networks.find((n) => Math.floor(toInt(n.address) / 2 ** (32 - n.prefix)) === Math.floor(toInt(ip) / 2 ** (32 - n.prefix)))?.name || '';
  const add = (atem) => {
    const had = found.get(atem.ip);
    found.set(atem.ip, {
      ip: atem.ip,
      name: had?.name || atem.name || '',
      via: had && had.via !== atem.via ? `${had.via} and ${atem.via}` : atem.via,
      network: had?.network || atem.network || networkOf(atem.ip),
    });
  };
  const sockets = [];
  const asked = [];
  const query = mdnsQuery();
  try {
    // Bonjour, asked on each adapter, and asked twice, as one packet on Wi-Fi can go missing.
    for (const n of networks) {
      const s = await openSocket(n.address);
      if (!s) continue;
      sockets.push(s);
      asked.push(s);
      s.on('message', (msg, rinfo) => {
        try { for (const a of atemsInAnswer(parseDns(msg), rinfo.address)) add({ ...a, network: n.name }); } catch { /* not an answer we can read */ }
      });
      try { s.setMulticastInterface(n.address); s.setMulticastTTL(255); } catch { /* the default interface is used */ }
      s.send(query, MDNS.port, MDNS.address, () => {});
    }
    // The knock on the control port. The operating system sends each one out of the adapter that
    // reaches that address. A knock on an address where nothing answers waits for the network to
    // give up on it, and holds its socket's send buffer meanwhile, so the knocks are spread over
    // sockets of 64: an empty stretch of addresses cannot hold up the rest.
    const reply = (msg, rinfo) => { if (isAtemReply(msg, rinfo)) add({ ip: rinfo.address, via: 'control port' }); };
    const targets = sweepTargets(networks, hints);
    for (let i = 0; i < targets.length; i += 64) {
      const knock = await openSocket(null);
      if (!knock) break;
      sockets.push(knock);
      knock.on('message', reply);
      for (const ip of targets.slice(i, i + 64)) knock.send(HELLO, ATEM_PORT, ip, () => {});
      await sleep(5);
    }
    await sleep(Math.min(700, waitMs));
    for (const s of asked) s.send(query, MDNS.port, MDNS.address, () => {});
    await sleep(Math.max(0, waitMs - 700));
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* already closed */ } }
  }
  // Switchers that announced their name first.
  return { networks, found: [...found.values()].sort((a, b) => Number(!!b.name) - Number(!!a.name)) };
}
