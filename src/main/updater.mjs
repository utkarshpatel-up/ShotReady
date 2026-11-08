// Software update from GitHub. No Electron imports, so it can be exercised on its own.
//
//   installed  Looks at the latest GitHub release, downloads its installer, checks it against the
//              release's SHA-256 file, and hands it back to run. The repository may be private, so a
//              plain web request is tried first and then the GitHub CLI, which already holds the
//              user's login. No token is ever stored in ShotReady.
//   source     Run from a git folder (npm start): fetches, and fast-forwards with git pull.
//   portable   The unzipped copy cannot replace itself: it only reports what is new.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);
const sh = (cmd, args, opts = {}) => run(cmd, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024, ...opts });

// ---------- small pure helpers ----------
const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);

/** Is version a newer than version b? */
export function isNewer(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** "github:owner/name" or a github.com URL, from package.json's repository field. */
export function repoOf(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  const m = r.match(/github(?:\.com)?[:/]([^/\s]+)\/([^/.\s]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The hash for one file in a sha256sum-style list ("<hash> *<file>"). */
export function checksumFor(text, filename) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === filename) return m[1].toLowerCase();
  }
  return null;
}

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

// ---------- checking ----------
export function modeOf(ctx) {
  if (!ctx.packaged) return 'source';
  return existsSync(join(ctx.installDir, 'Uninstall ShotReady.exe')) ? 'installed' : 'portable';
}

export async function checkForUpdate(ctx) {
  const mode = modeOf(ctx);
  try {
    return mode === 'source' ? await checkSource(ctx) : await checkRelease(ctx, mode);
  } catch (e) {
    return { mode, current: ctx.version, error: e.message };
  }
}

async function checkSource(ctx) {
  const git = async (args, ms = 30000) => (await sh('git', args, { cwd: ctx.root, timeout: ms })).stdout.trim();
  if (!existsSync(join(ctx.root, '.git'))) throw new Error('This folder is not a git copy, so it cannot be updated from GitHub.');
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  let upstream;
  try { upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']); } catch { throw new Error(`The branch "${branch}" does not track a GitHub branch.`); }
  try { await git(['fetch', '--quiet', 'origin'], 60000); } catch { throw new Error('Could not reach GitHub. Check the internet connection.'); }
  const [ahead, behind] = (await git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).split(/\s+/).map(Number);
  const dirty = (await git(['status', '--porcelain'])).length > 0;
  let latest = ctx.version;
  try { latest = JSON.parse(await git(['show', `${upstream}:package.json`])).version; } catch { /* keep the current version */ }
  const notes = behind ? (await git(['log', '--pretty=%s', `HEAD..${upstream}`])).split('\n').filter(Boolean).slice(0, 15) : [];
  let reason = null;
  if (behind && dirty) reason = 'There are uncommitted changes in the ShotReady folder. Commit or discard them first.';
  else if (behind && ahead) reason = `This copy has ${ahead} commit(s) that GitHub does not have, so it cannot be fast-forwarded.`;
  return {
    mode: 'source', current: ctx.version, latest, available: behind > 0, canUpdate: behind > 0 && !reason, reason, notes,
    detail: `${branch} follows ${upstream}: ${behind} new commit(s)`,
  };
}

async function latestRelease(ctx) {
  // A public repository answers a plain request.
  try {
    const res = await fetch(`${ctx.apiBase || 'https://api.github.com'}/repos/${ctx.repo}/releases/latest`, {
      headers: { 'User-Agent': 'ShotReady', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { release: await res.json(), via: 'web' };
  } catch { /* offline, or private: try the GitHub CLI below */ }
  try {
    const { stdout } = await sh('gh', ['api', `repos/${ctx.repo}/releases/latest`], { timeout: 15000 });
    return { release: JSON.parse(stdout), via: 'gh' };
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('The repository is private. Install the GitHub CLI (cli.github.com) and sign in with "gh auth login", then try again.');
    throw new Error('Could not reach GitHub, or this PC is not signed in to it. Check the internet connection (and "gh auth status").');
  }
}

async function checkRelease(ctx, mode) {
  const { release, via } = await latestRelease(ctx);
  const latest = String(release.tag_name).replace(/^v/, '');
  const available = isNewer(latest, ctx.version);
  const setup = (release.assets || []).find((a) => /Windows-Setup\.exe$/.test(a.name));
  const notes = String(release.body || '').split('\n').map((l) => l.trim().replace(/^[-*]\s+/, '')).filter((l) => l && !l.startsWith('#')).slice(0, 12);
  let reason = null;
  if (available && mode === 'portable') reason = 'This is the portable copy, which cannot update itself. Download the new zip from the releases page.';
  else if (available && !setup) reason = 'The latest release has no Windows installer attached.';
  return { mode, current: ctx.version, latest, available, canUpdate: available && !reason, reason, notes, via, sizeMB: setup ? Math.round(setup.size / 1048576) : null };
}

// ---------- applying ----------
/**
 * Re-checks (so a stale offer is never applied), then does the update. Returns what the caller
 * must do next: { action: 'relaunch' | 'reinstall' | 'installer', path? }.
 */
export async function applyUpdate(ctx) {
  const info = await checkForUpdate(ctx);
  if (info.error) throw new Error(info.error);
  if (!info.canUpdate) throw new Error(info.reason || 'There is nothing to update.');
  return info.mode === 'source' ? applySource(ctx) : applyInstalled(ctx);
}

async function applySource(ctx) {
  const git = async (args, ms = 120000) => (await sh('git', args, { cwd: ctx.root, timeout: ms })).stdout.trim();
  const before = await git(['rev-parse', 'HEAD']);
  await git(['pull', '--ff-only', '--quiet']);
  const changed = (await git(['diff', '--name-only', before, 'HEAD'])).split('\n');
  // Reinstalling packages replaces the running program's own files, so it happens after it exits.
  return { action: changed.includes('package-lock.json') || changed.includes('package.json') ? 'reinstall' : 'relaunch' };
}

async function applyInstalled(ctx) {
  const { release, via } = await latestRelease(ctx);
  const setup = release.assets.find((a) => /Windows-Setup\.exe$/.test(a.name));
  const sums = release.assets.find((a) => /SHA256\.txt$/.test(a.name));
  if (!sums) throw new Error('The release has no SHA-256 checksum file, so the download cannot be verified.');
  rmSync(ctx.tempDir, { recursive: true, force: true });
  mkdirSync(ctx.tempDir, { recursive: true });
  if (via === 'gh') {
    await sh('gh', ['release', 'download', release.tag_name, '--repo', ctx.repo, '--pattern', setup.name, '--pattern', sums.name, '--dir', ctx.tempDir, '--clobber'], { timeout: 900000 });
  } else {
    for (const a of [setup, sums]) {
      const res = await fetch(a.browser_download_url, { headers: { 'User-Agent': 'ShotReady' }, signal: AbortSignal.timeout(900000) });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
      writeFileSync(join(ctx.tempDir, a.name), Buffer.from(await res.arrayBuffer()));
    }
  }
  const file = join(ctx.tempDir, setup.name);
  const want = checksumFor(await (await import('node:fs/promises')).readFile(join(ctx.tempDir, sums.name), 'utf8'), setup.name);
  if (!want) throw new Error(`The checksum file does not list ${setup.name}.`);
  if (await sha256(file) !== want) {
    rmSync(ctx.tempDir, { recursive: true, force: true });
    throw new Error('The downloaded installer does not match its checksum, so it was deleted and not run.');
  }
  return { action: 'installer', path: file };
}
