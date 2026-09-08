# ADR 0003 — Aviator Analytics: entry-only Aviator capability

## Status
Accepted.

## Context
Aviator Analytics was originally specified as fully passive: it observes WebSocket
frames and never originates protocol traffic (`ANALYTICS_ORIGINATED_PROTOCOL_SEND=0`).

A real, evidence-audited defect broke that promise's usefulness: on the owned/authorized
site the browser stays alive but the website silently returns from the Aviator game to the
lobby while non-Aviator traffic keeps flowing. Analytics correctly *detected* this
(`AVIATOR_CONTEXT_LOST`) but could not return to the game, so collection stopped until the
user manually re-entered.

Navigation evidence (captured DB: `network_requests`, `ws_events`) proved:

- Lobby and Aviator share the **same** single-page SPA URL (`v.hitclub.*`); there is **no**
  Aviator deep-link, no stable SPA route, no document navigation into the game.
- Aviator is entered via an in-canvas (Cocos/WebGL) interaction, after which the **website
  itself** emits `["6","MiniGame","aviatorPlugin",{"cmd":100000}]` over its persistent
  WebSocket. A real context-loss episode showed the same open socket going Aviator-silent
  for ~15 min, then a second website-originated `cmd100000` restoring fresh Aviator traffic.

Therefore browser-navigation-only auto-reentry is not viable, and a DOM/coordinate click on a
WebGL canvas is not a stable seam. The only reliable recovery is to emit the same enter frame.

## Decision
Analytics gains exactly **one** narrowly scoped protocol capability: **Aviator ENTRY /
RE-ENTRY only** — it may emit the fixed `cmd100000` enter frame for bounded context recovery,
and nothing else.

The old absolute invariant `ANALYTICS_ORIGINATED_PROTOCOL_SEND=0` is replaced by:

> Analytics is passive for game observation and wagering behavior. Its only permitted
> protocol-originated action is the fixed Aviator ENTRY `cmd100000` used for bounded context
> recovery.

Explicit capability matrix:

| Capability | Analytics |
|---|---|
| Aviator ENTER (`cmd100000`, fixed frame) | **allowed** (recovery only) |
| BET (`cmd100002`) | none |
| CASHOUT (`cmd100003`) | none |
| arbitrary cmd / arbitrary payload / replay | none |
| AutoRunner / AutoSequence / JackpotGate / betting harness | none |

## Enforcement (architectural, not cosmetic)
- **Sealed transport** — `desktop/analytics/entry-only-transport.cjs`. `sendEntry(ctx)` takes
  **no** payload/cmd/JSON argument. The enter frame is a baked literal in the injected page
  hook (`__avEnterAviator()`, a zero-argument fixed-frame sender). It deliberately does **not**
  install Control's generic `__wsoSendFrame(url, data)` relay.
- **Semantic gate** — `desktop/analytics/analytics-aviator-entry.cjs`. `requestEntry()` takes no
  payload; knows nothing about BET/CASHOUT/round strategy/threshold/LƯỢT/AutoRunner. Enforces
  SEND != ENTERED: only **fresh** authoritative SERVER Aviator evidence *after* the attempt
  boundary (correct recovery generation) confirms.
- **Coordinator** — `desktop/analytics/analytics-context-recovery.cjs` reuses the SAME proven pure
  `AviatorContextTracker` as Control (two distinct freshness signals, VERIFY-before-ACT, bounded
  re-entry, then escalate). No reload, no protocol replay, no wager path.
- **No renderer capability** — the preload/IPC surface exposes read-only state only; there is no
  `sendEntry`/`sendProtocol`/`wsSend` channel. Recovery is automatic and main-process owned.
- **Provenance** — Analytics' own enter frame is tagged `ANALYTICS_ENTRY_RECOVERY` in
  `raw_protocol_events.origin`, never mislabelled as a `WEBSITE` action. It is a SEND `cmd100000`
  and is not round-authoritative, so report/statistics populations are unaffected.

A raw CDP debugger is inherently omnipotent; the boundary enforced here is that **no
Analytics-reachable API constructs or forwards anything but this one fixed frame**. This is
covered by `tests/js/analytics-entry-only-capability.test.mjs` and the updated A10 boundary scan.

## Consequences
- Analytics can now auto-recover Aviator context without user re-entry, preserving passive
  collection semantics and DB/history.
- The word "fully passive" must always be qualified with the entry-only exception (see the
  capability matrix). Any future generic sender is a boundary violation and must fail the tests.
