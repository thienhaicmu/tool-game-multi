// WVPT Generator → shared meta-game-status repo (online revoke for Phỏm QA + Aviator Control). Fake GitHub only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeRevoked, publishRevoked, TARGET } = require('../../tools/license-generator/online-publish.cjs');

function fakeGitHub(initial = null) {
  const state = { file: initial ? { sha: 's0', content: initial } : null, writes: [], auth: [] };
  const fetchImpl = async (url, opts = {}) => {
    state.auth.push(opts.headers && opts.headers.Authorization);
    assert.match(url, new RegExp('^https://api\\.github\\.com/repos/' + TARGET.repo + '/contents/' + TARGET.path));
    if ((opts.method || 'GET') === 'GET') {
      if (!state.file) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ sha: state.file.sha, content: Buffer.from(JSON.stringify(state.file.content)).toString('base64') }) };
    }
    const body = JSON.parse(opts.body);
    if (state.file && body.sha !== state.file.sha) return { ok: false, status: 409, json: async () => ({}) };
    const content = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    state.file = { sha: 's' + (state.writes.length + 1), content };
    state.writes.push(content);
    return { ok: true, status: 200, json: async () => ({ content: { sha: state.file.sha } }) };
  };
  return { state, fetchImpl };
}

test('merge never wipes: online entries stay, revoked here are added, only a key RESTORED here is removed', () => {
  const online = { 'OTHER-MACHINE': 'x', 'RESTORED-HERE': 'old', 'DELETED-HERE': 'gone from my list' };
  const keys = [
    { licenseId: 'NEW', status: 'REVOKED', revokeReason: 'nợ tiền' },
    { licenseId: 'RESTORED-HERE', status: 'ACTIVE', restoredAt: '2026-10-10T00:00:00Z' },
    { licenseId: 'NEVER-REVOKED', status: 'ACTIVE' },
  ];
  assert.deepEqual(mergeRevoked(online, keys), { 'DELETED-HERE': 'gone from my list', NEW: 'nợ tiền', 'OTHER-MACHINE': 'x' });
  assert.deepEqual(mergeRevoked(['A', 'B'], []), { A: '', B: '' }); // array form
});

test('publish creates the file when missing, then writes only on a change', async () => {
  const gh = fakeGitHub();
  const keys = [{ licenseId: 'K1', status: 'REVOKED', revokeReason: 'r' }];
  const first = await publishRevoked({ keys, fetchImpl: gh.fetchImpl, token: 't', now: () => new Date('2026-10-10T00:00:00Z') });
  assert.deepEqual({ ok: first.ok, published: first.published, count: first.count }, { ok: true, published: true, count: 1 });
  assert.deepEqual(gh.state.file.content, { v: 1, updatedAt: '2026-10-10T00:00:00.000Z', revoked: { K1: 'r' } });
  const again = await publishRevoked({ keys, fetchImpl: gh.fetchImpl, token: 't' });
  assert.equal(again.published, false);
  assert.equal(gh.state.writes.length, 1);
  assert.ok(gh.state.auth.every((a) => a === 'Bearer t'));
  assert.equal(first.url, 'https://raw.githubusercontent.com/thienhaicmu/meta-game-status/main/tool-game-multi-status.json');
});

test('no GitHub login on this machine → a clear error, nothing sent', async () => {
  const gh = fakeGitHub();
  await assert.rejects(publishRevoked({ keys: [], fetchImpl: gh.fetchImpl, token: '' }), /chưa đăng nhập GitHub/);
  assert.equal(gh.state.auth.length, 0);
});

test('the generator ships the publisher, and revoke / restore publish at once', () => {
  const fs = require('node:fs');
  const builder = JSON.parse(fs.readFileSync(new URL('../../tools/license-generator/electron-builder.json', import.meta.url), 'utf8'));
  assert.ok(builder.files.includes('tools/license-generator/online-publish.cjs'));
  const main = fs.readFileSync(new URL('../../tools/license-generator/ui-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('key-revoke', async[^\n]*online: await publishNow\(\)/);
  assert.match(main, /ipcMain\.handle\('key-restore', async[^\n]*online: await publishNow\(\)/);
  assert.match(main, /ipcMain\.handle\('keys-publish', \(\) => publishNow\(\)\)/);
});
