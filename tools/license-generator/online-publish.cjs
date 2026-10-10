'use strict';

// ONLINE REVOKE — publish (user 2026-10-10: "tham khảo tool gen key của meta-game, dùng chung repo của meta-game").
// Same mechanism as Meta Game Key (D:\meta-game apps/key-manager github.cjs + git-token.cjs): the GitHub Contents API on
// the seller's PUBLIC repo thienhaicmu/meta-game-status, with the GitHub token git already stores on this machine (Git
// Credential Manager) — nothing to type, never logged. Phỏm QA + Aviator Control read its raw URL
// (desktop/licensing/online-denylist.config.json) every 30 min; listed → locked.
//
// OWN FILE in that repo (tool-game-multi-status.json): Meta Game Key rebuilds status.json from ITS key list on every
// sync, so entries written there by this generator would be wiped. Shape = what online-denylist.cjs reads:
//   { v: 1, updatedAt, revoked: { <licenseId>: "lý do" } }
// Merge, never wipe: start from what is online, add every key revoked here, drop only a key RESTORED here (status
// ACTIVE in this store). A key deleted from this store, or revoked from another machine, stays revoked.

const { spawnSync } = require('node:child_process');

const TARGET = Object.freeze({ repo: 'thienhaicmu/meta-game-status', branch: 'main', path: 'tool-game-multi-status.json' });
const API = 'https://api.github.com';
const TIMEOUT_MS = 15000;

const rawUrl = ({ repo, branch, path }) => `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
const contentsUrl = ({ repo, path }) => `${API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

function gitHubToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  const m = r.status === 0 ? /^password=(.+)$/m.exec(r.stdout || '') : null;
  return m ? m[1].trim() : '';
}

function explain(status, what) {
  if (status === 401) return 'Token GitHub sai hoặc đã hết hạn.';
  if (status === 403) return `Token không có quyền ${what} (cần Contents: Read and write trên repo meta-game-status).`;
  if (status === 404) return 'Không thấy repo meta-game-status — máy này đã đăng nhập GitHub (git) đúng tài khoản chưa?';
  if (status === 409 || status === 422) return 'GitHub từ chối ghi (file vừa đổi ở nơi khác) — bấm Đăng lại.';
  return `GitHub trả lỗi ${status}.`;
}

function createGitHub({ fetchImpl, token, target = TARGET }) {
  if (!token) throw new Error('Máy này chưa đăng nhập GitHub (git credential) — không đăng được danh sách khóa.');
  async function request(url, { method = 'GET', body } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url + (method === 'GET' ? `?ref=${encodeURIComponent(target.branch)}` : ''), {
        method, signal: ctl.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'WVPT-License-Generator', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, ok: res.ok, json };
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? 'GitHub không phản hồi (quá 15 giây).' : `Không kết nối được GitHub: ${(e && e.message) || e}`);
    } finally { clearTimeout(timer); }
  }
  async function read() {
    const r = await request(contentsUrl(target));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(explain(r.status, 'đọc file'));
    let content = null;
    try { content = JSON.parse(Buffer.from(r.json.content || '', 'base64').toString('utf8')); } catch { /* unreadable → rebuilt */ }
    return { sha: r.json.sha, content };
  }
  async function write(obj, { sha, message }) {
    const r = await request(contentsUrl(target), { method: 'PUT',
      body: { message, branch: target.branch, content: Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8').toString('base64'), ...(sha ? { sha } : {}) } });
    if (!r.ok) throw new Error(explain(r.status, 'ghi file'));
  }
  return { read, write };
}

// PURE: the next file from what is online + this store's keys
function mergeRevoked(remoteRevoked, keys) {
  const out = { ...((remoteRevoked && typeof remoteRevoked === 'object' && !Array.isArray(remoteRevoked)) ? remoteRevoked : {}) };
  if (Array.isArray(remoteRevoked)) for (const id of remoteRevoked) out[id] = '';
  for (const k of keys || []) {
    if (!k || !k.licenseId) continue;
    if (k.status === 'REVOKED') out[k.licenseId] = String(k.revokeReason || '').slice(0, 120);
    else if ((k.status || 'ACTIVE') === 'ACTIVE' && k.restoredAt) delete out[k.licenseId];
  }
  return Object.fromEntries(Object.keys(out).sort().map((id) => [id, out[id]]));
}

// read → merge → write when it changed (retried once when another machine wrote in between)
async function publishRevoked({ keys, fetchImpl, token = gitHubToken(), now = () => new Date(), target = TARGET }) {
  const gh = createGitHub({ fetchImpl, token, target });
  for (let i = 1; ; i++) {
    const remote = await gh.read();
    const before = (remote && remote.content && remote.content.revoked) || {};
    const revoked = mergeRevoked(before, keys);
    const count = Object.keys(revoked).length;
    if (remote && JSON.stringify(mergeRevoked(before, [])) === JSON.stringify(revoked)) return { ok: true, published: false, count, url: rawUrl(target) };
    try {
      await gh.write({ v: 1, updatedAt: now().toISOString(), revoked }, { sha: remote && remote.sha, message: `revoked: ${count} key (WVPT generator)` });
      return { ok: true, published: true, count, url: rawUrl(target) };
    } catch (e) {
      if (i < 2 && /từ chối ghi/.test(e.message)) continue;
      throw e;
    }
  }
}

module.exports = { TARGET, rawUrl, gitHubToken, createGitHub, mergeRevoked, publishRevoked };
