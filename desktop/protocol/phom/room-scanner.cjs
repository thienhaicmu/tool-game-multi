'use strict';

const { randomUUID } = require('node:crypto');
const failure = (code) => Object.assign(new Error(code), { code });
// Transport contract: list must return the server-correlated attemptId. A
// transport without a proved correlation mechanism MUST NOT claim this ability.
class RoomScanner {
  constructor({ pool, catalog, transport, timeoutMs = 5000 }) {
    this.pool = pool; this.catalog = catalog; this.transport = transport; this.timeoutMs = timeoutMs; this.active = null;
  }
  async scan({ browserId, betId, requiredSlots = 3, signal, isFailedRid = () => false }) {
    if (this.active) throw failure('FIND_ALREADY_RUNNING');
    if (!this.catalog.get(betId)) throw failure('STAKE_MAPPING_UNVERIFIED');
    if (!this.transport || this.transport.verified !== true || this.transport.correlated !== true) throw failure('TOKEN_SCAN_PROTOCOL_UNVERIFIED');
    if (!Number.isInteger(requiredSlots) || requiredSlots < 1 || requiredSlots > 3) throw failure('INVALID_SLOT_REQUIREMENT');
    const scanId = randomUUID(); this.active = scanId;
    const seen = new Set();
    try {
      while (!signal?.aborted) {
        const key = this.pool.acquire();
        if (!key) return { ok: false, code: 'NO_READY_TOKEN' };
        if (seen.has(key.id)) { this.pool.release(key.id); return { ok: false, code: 'NO_TABLE_FOR_STAKE' }; }
        seen.add(key.id);
        let outcome = 'OK';
        try {
          for (let retry = 0; retry < 2; retry++) {
            const attemptId = randomUUID();
            try {
              const response = await this._request({ scanId, attemptId, browserId, tokenKeyId: key.id, tokenKey: key.value, selectedBetId: betId }, signal);
              if (signal?.aborted || this.active !== scanId) throw failure('ABORTED');
              if (response?.attemptId !== attemptId || response?.scanId !== scanId) throw failure('STALE_RESPONSE');
              if (!Array.isArray(response.candidates)) throw failure('PROTOCOL_SCHEMA');
              outcome = 'OK';
              const valid = response.candidates.filter((c) => c && typeof c.rid === 'string' && c.rid.trim() && c.gameId === 8 && c.betId === betId && c.exists === true && c.playing === false
                && Number.isInteger(c.capacity) && c.capacity > 0 && Number.isInteger(c.playerCount) && c.playerCount >= 0 && c.capacity - c.playerCount >= requiredSlots && !isFailedRid(c.rid));
              valid.sort((a, b) => a.playerCount - b.playerCount || String(a.rid).localeCompare(String(b.rid)));
              if (valid.length) {
                const { rid, betId, gameId, capacity, playerCount, playing, exists, channelId } = valid[0];
                return { ok: true, scanId, attemptId, tokenKeyId: key.id, candidate: { rid, betId, gameId, capacity, playerCount, playing, exists, channelId } };
              }
              break;
            } catch (e) {
              outcome = e.code || 'PROTOCOL_ERROR';
              if (outcome === 'TOKEN_TIMEOUT' && retry === 0) continue;
              if (['ABORTED', 'SOCKET_DROPPED'].includes(outcome)) throw failure(outcome);
              break;
            }
          }
        } finally { this.pool.release(key.id, outcome); }
      }
      throw failure('ABORTED');
    } finally { if (this.active === scanId) this.active = null; }
  }
  _request(context, signal) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController(); let settled = false;
      const finish = (error, response) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        controller.abort(); error ? reject(error) : resolve(response);
      };
      const cancel = () => finish(failure('ABORTED'));
      const timer = setTimeout(() => finish(failure('TOKEN_TIMEOUT')), this.timeoutMs);
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      Promise.resolve().then(() => settled ? null : this.transport.list({ ...context, signal: controller.signal }))
        .then((r) => finish(null, r), (e) => finish(failure(e?.code || 'PROTOCOL_ERROR')));
    });
  }
}
module.exports = { RoomScanner };
