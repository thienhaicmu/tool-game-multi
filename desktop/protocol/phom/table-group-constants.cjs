'use strict';

// The table group's shared constants (table-group.cjs and its parts).

const ROLE = Object.freeze({ KEY: 'KEY', READY: 'READY', NOT_READY: 'NOT_READY' });
const PACE_MIN_MS = 800;
const PACE_MAX_MS = 2500;
// A kicked member comes back this long after the kick (the reference tool: ~0.5s). It does NOT wait in the queue:
// the NOT_READY account is kicked every ~10s, and an 8s queued rejoin (live log 2026-10-03 14:19) left it out of the
// table most of the time.
const REJOIN_DELAY_MS = 500;
// THAY ACC — how often (and how long) the group checks whether the replacement browser is in the game yet.
const REPLACE_POLL_MS = 1000;
const REPLACE_WAIT_MS = 120000;
// LOOP GUARD ceilings (2026-10-08) — automatic leave/join the group does by itself (see _budget)
const RESET_MAX_PER_MIN = 3;          // CHƯA SS leave + sit again (stranger / SẴN SÀNG left)
const SEAT_FREE_MAX_PER_MIN = 3;      // B2 — back to a free seat
const SEAT_FREE_BACKOFF_MS = 30000;   // after a refused B2 join
const REGROUP_MAX = 3;                // B4 — TỰ ĐỘNG re-forms the group …
const REGROUP_WINDOW_MS = 5 * 60000;  // … per 5 minutes, then TỰ ĐỘNG switches off
// what an account is busy with, in the words of a "đợi xong" refusal
const ACT_WORD = Object.freeze({ FIND: 'Dò Key', SCAN: 'Tạo (dò bàn KEY)', JOIN: 'vào bàn', REJOIN: 'vào lại bàn', LEAVE: 'rời bàn' });
const CANCELLED = Object.freeze({ ok: false, cancelled: true, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'Đã hủy' } });

module.exports = { ROLE, PACE_MIN_MS, PACE_MAX_MS, REJOIN_DELAY_MS, REPLACE_POLL_MS, REPLACE_WAIT_MS, RESET_MAX_PER_MIN, SEAT_FREE_MAX_PER_MIN, SEAT_FREE_BACKOFF_MS, REGROUP_MAX, REGROUP_WINDOW_MS, ACT_WORD, CANCELLED };
