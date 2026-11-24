// GET with Basic / Digest auth. The XC protocol reads and writes settings with GET requests.
//
// A camera with a login turns away a request without one (401) and says how to log in. That answer
// is remembered per camera and user, so every later request carries the login straight away: one
// round trip instead of two, which matters for picture frames. If the camera turns a request away
// anyway (a Digest nonce gone stale, a changed password), it is asked again, as the first time.
// Each thread has its own memory of this, as each camera's frames are fetched in a thread of its own.
import { createHash, randomBytes } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const known = new Map(); // "origin|user" -> { scheme: 'basic' } | { scheme: 'digest', p, nc }

function parseChallenge(header) {
  if (/^basic/i.test(header)) return { scheme: 'basic' };
  if (!/^digest/i.test(header)) return null;
  const p = {};
  header.replace(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g, (_, k, q, b) => { p[k] = q ?? b; });
  return { scheme: 'digest', p, nc: 0 };
}

function authorization(entry, auth, path) {
  if (entry.scheme === 'basic') return `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
  const { p } = entry;
  entry.nc += 1;
  const nc = entry.nc.toString(16).padStart(8, '0'), cnonce = randomBytes(8).toString('hex');
  const qop = (p.qop || '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : '';
  const ha1 = md5(`${auth.user}:${p.realm}:${auth.pass}`);
  const ha2 = md5(`GET:${path}`);
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  let h = `Digest username="${auth.user}", realm="${p.realm}", nonce="${p.nonce}", uri="${path}", response="${response}"`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (p.opaque) h += `, opaque="${p.opaque}"`;
  if (p.algorithm) h += `, algorithm=${p.algorithm}`;
  return h;
}

// Pass a signal for a long-lived stream, where a whole-request timeout would cut it off.
export async function httpGet(url, auth, timeoutMs = 4000, signal = null) {
  const opts = (headers) => ({ signal: signal || AbortSignal.timeout(timeoutMs), ...(headers ? { headers } : {}) });
  const u = new URL(url);
  const path = u.pathname + u.search;
  const key = `${u.origin}|${auth?.user || ''}`;
  const entry = auth?.user ? known.get(key) : null;
  let res;
  if (entry) {
    res = await fetch(url, opts({ Authorization: authorization(entry, auth, path) }));
    if (res.status !== 401) return res;
    known.delete(key);
  } else {
    res = await fetch(url, opts());
    if (res.status !== 401 || !auth?.user) return res;
  }
  const fresh = parseChallenge(res.headers.get('www-authenticate') || '');
  if (!fresh) return res;
  res.body?.cancel().catch(() => {});
  known.set(key, fresh);
  const again = await fetch(url, opts({ Authorization: authorization(fresh, auth, path) }));
  if (again.status === 401) known.delete(key); // a wrong login is not remembered
  return again;
}

// For tests: forget every remembered login.
export function forgetLogins() { known.clear(); }
