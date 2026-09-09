'use strict';

// ---------------------------------------------------------------------------
// AutoStartIntent — the canonical owner of the AUTO_START_PENDING_ENTRY intent
// (START AUTO RUN from Lobby).
//
// When the user presses START AUTO RUN the run may not yet be in Aviator (it can be
// sitting in Lobby/NewLobby). The start orchestration then invokes the SEALED in-engine
// Aviator entry seam and waits for fresh authoritative SERVER Aviator evidence before it
// starts the AutoRunner. During that window the intent is PENDING: no BET, no CASHOUT,
// no AutoRunner execution has begun.
//
// This tiny owner models exactly two race-critical facts the orchestration cannot express
// with a bare promise await:
//
//   1. CANCELLATION — if the user presses STOP while entry is still pending, the AutoRunner
//      must NOT start later when ACTIVE finally arrives. `begin()` hands the orchestration a
//      token bound to the current cancel generation; `cancel()` (STOP / run close) bumps that
//      generation; `cancelled(token)` lets the orchestration bail out AFTER its async entry
//      wait resolves but BEFORE it starts the runner. This is a monotonic generation guard —
//      a stale (older-generation) completion can never start/resume the runner.
//
//   2. DUPLICATE START — a second START click while entry is already pending must not launch
//      a second entry invocation or a second AutoRunner execution. `inFlight()` lets the IPC
//      handler treat the duplicate as a no-op.
//
// Pure + host-free: no Electron, no timers, no protocol. The wiring layer (main.cjs) owns the
// actuators; this only owns the intent's identity/lifecycle so it is deterministically testable.
// ---------------------------------------------------------------------------

class AutoStartIntent {
  constructor() {
    this._cancelGen = 0;   // bumped by cancel() (STOP / run close) — invalidates outstanding tokens
    this._pending = false; // an entry is currently pending (START pressed, ACTIVE not yet confirmed)
    this._inFlight = false; // a START orchestration is synchronously in progress (duplicate guard)
  }

  // The user pressed START. Marks the intent pending and returns a token bound to the CURRENT
  // cancel generation. The orchestration must re-check `cancelled(token)` after every async
  // entry/jackpot wait and before it starts the AutoRunner.
  begin() { this._pending = true; return this._cancelGen; }

  // Duplicate-START guard for the IPC handler: true from the moment a START orchestration starts
  // until it settles. A second START while true must be a no-op (no second entry / execution).
  markInFlight(v) { this._inFlight = v === true; }
  inFlight() { return this._inFlight === true; }

  // Observability: is a START waiting on Aviator ACTIVE right now?
  pending() { return this._pending === true; }

  // STOP (or run close): cancel any pending START so a later ACTIVE never starts the runner.
  // Bumping the generation invalidates every previously issued token.
  cancel() { this._cancelGen += 1; this._pending = false; }

  // A captured token is still valid iff no cancel() happened since begin().
  cancelled(token) { return token !== this._cancelGen; }

  // The orchestration settled (started, failed, or was cancelled) — clear the pending flag.
  finish() { this._pending = false; }

  snapshot() { return { pending: this._pending, inFlight: this._inFlight, cancelGeneration: this._cancelGen }; }
}

module.exports = { AutoStartIntent };
