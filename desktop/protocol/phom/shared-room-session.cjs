'use strict';

const { randomUUID } = require('node:crypto');
class SharedRoomSession {
  constructor({ expectedBrowsers, now = Date.now }) {
    if (!Array.isArray(expectedBrowsers) || expectedBrowsers.length !== 3 || new Set(expectedBrowsers).size !== 3) throw new TypeError('EXPECTED_THREE_BROWSERS');
    this.expectedBrowsers = Object.freeze([...expectedBrowsers]); this.now = now;
    this.sessionId = randomUUID(); this.version = 0; this.room = null;
  }
  reserve(candidate, finderBrowserId, tokenKeyId, stake) {
    if (!candidate || !stake || !this.expectedBrowsers.includes(finderBrowserId) || candidate.betId !== stake.id || typeof candidate.rid !== 'string' || !candidate.rid.trim()
      || !Number.isInteger(candidate.capacity) || !Number.isInteger(candidate.playerCount) || candidate.playerCount < 0 || candidate.capacity - candidate.playerCount < 3) throw new TypeError('INVALID_RESERVATION');
    this.room = { sessionId: this.sessionId, version: ++this.version, rid: candidate.rid,
      channelId: candidate.channelId, betId: stake.id, stakeLabel: stake.label, tokenKeyId,
      finderBrowserId, expectedBrowsers: [...this.expectedBrowsers], confirmedBrowsers: [],
      capacity: candidate.capacity, playerCount: candidate.playerCount, status: 'RESERVED', createdAt: this.now(), updatedAt: this.now() };
    return this.snapshot();
  }
  confirm({ browserId, rid, betId, version, ownUidPresent, playerCount }) {
    const r = this.room;
    if (!r || r.version !== version || rid !== r.rid || betId !== r.betId || ownUidPresent !== true || !r.expectedBrowsers.includes(browserId)) return false;
    if (r.status === 'RESERVED' && browserId !== r.finderBrowserId) return false;
    const confirmed = new Set([...r.confirmedBrowsers, browserId]);
    if (!Number.isInteger(playerCount) || playerCount < confirmed.size || playerCount > r.capacity || r.capacity - playerCount < r.expectedBrowsers.length - confirmed.size) return false;
    r.confirmedBrowsers = [...confirmed]; r.playerCount = playerCount;
    r.status = confirmed.size === r.expectedBrowsers.length ? 'IN_SHARED_ROOM' : 'JOINING_SHARED';
    r.updatedAt = this.now(); return true;
  }
  published() { return this.room && this.room.status !== 'RESERVED' ? this.snapshot() : null; }
  clear() { this.version++; this.room = null; }
  snapshot() { return this.room ? JSON.parse(JSON.stringify(this.room)) : null; }
}
module.exports = { SharedRoomSession };
