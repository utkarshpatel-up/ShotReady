// GET with Basic / Digest auth. The XC protocol reads and writes settings with GET requests.
import { createHash, randomBytes } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');

// Pass a signal for a long-lived stream, where a whole-request timeout would cut it off.
export async function httpGet(url, auth, timeoutMs = 4000, signal = null) {
  const opts = () => ({ signal: signal || AbortSignal.timeout(timeoutMs) });
  const res = await fetch(url, opts());
  if (res.status !== 401 || !auth?.user) return res;
  const challenge = res.headers.get('www-authenticate') || '';
  const u = new URL(url);
  const path = u.pathname + u.search;
  if (/^basic/i.test(challenge)) {
    const token = Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
    return fetch(url, { ...opts(), headers: { Authorization: `Basic ${token}` } });
  }
  if (/^digest/i.test(challenge)) {
    const p = {};
    challenge.replace(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g, (_, k, q, b) => { p[k] = q ?? b; });
    const nc = '00000001', cnonce = randomBytes(8).toString('hex');
    const qop = (p.qop || '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : '';
    const ha1 = md5(`${auth.user}:${p.realm}:${auth.pass}`);
    const ha2 = md5(`GET:${path}`);
    const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
    let h = `Digest username="${auth.user}", realm="${p.realm}", nonce="${p.nonce}", uri="${path}", response="${response}"`;
    if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (p.opaque) h += `, opaque="${p.opaque}"`;
    if (p.algorithm) h += `, algorithm=${p.algorithm}`;
    return fetch(url, { ...opts(), headers: { Authorization: h } });
  }
  return res;
}
