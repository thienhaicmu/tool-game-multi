# ADR-0001: Desktop application boundary

## Status

Accepted

## Context

The repository contains a Python observatory core (domain, capture, SQLite,
analysis and reporting) and an Electron prototype that currently keeps capture
and replay state in renderer-facing JavaScript maps. These paths must converge
before adding more UI features.

## Decision

Electron is the desktop shell and browser owner. Python remains the application
service and persistence owner. The Electron main process may control Chromium,
but it must publish normalized, redacted capture events through a typed local
contract. Session, request, response, replay and review state are owned by the
application service and persisted in SQLite. The renderer never accesses raw
capture state or browser session internals directly.

The first integration boundary is a local loopback IPC/API adapter. It exposes
commands for project/session lifecycle, capture ingestion, request query,
parameter replacement and replay audit. Browser profiles remain Electron-owned
artifacts referenced by a session, never exported with reports.

## Consequences

- The current in-memory Electron maps are transitional and must be replaced by
  an ingestion adapter.
- UI work is driven by session/request DTOs rather than `webRequest` details.
- Replay becomes auditable and can be implemented by either browser-context or
  controlled HTTP transport without changing the UI contract.
- Offline Python tests can validate scope, redaction, persistence and replay
  policy without launching Electron.

## Migration rule

No new feature may add business state to `ui/desktop.js` or `desktop/main.cjs`.
New state belongs in the application/domain layer and crosses the boundary as
an explicit command or event.
