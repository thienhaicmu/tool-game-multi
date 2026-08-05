# WU-06 Implementation Report

## Objective

Extend browser observation with passive WebSocket capture, bounded/redacted frames, page observer
hooks, action metadata tracking, and lifecycle-safe ingestion without sending arbitrary frames or
performing active probes.

## Files created

- `websec_observer/capture/websocket_listener.py`
- `websec_observer/capture/websocket_ingestion.py`
- `websec_observer/capture/action_tracker.py`
- `tests/unit/test_websocket_capture.py`
- `docs/work-units/WU-06_REPORT.md`

## Files modified

- `websec_observer/domain/models.py`: WebSocket connection/frame and user-action DTOs; optional
  request action reference.
- `websec_observer/storage/repositories.py`: WebSocket repository protocol.
- `websec_observer/storage/sqlite/repositories.py`: WebSocket persistence/listing and action-aware
  request mapping.
- `websec_observer/storage/sqlite/unit_of_work.py`: WebSocket adapter exposure.
- `websec_observer/capture/browser_controller.py`: page observer registration for popups/new pages.
- `websec_observer/capture/session_service.py`: WebSocket ingestion/listener and action tracker
  lifecycle wiring.
- `websec_observer/capture/network_listener.py`: optional action lookup hook.

## Architectural decisions

- WebSocket observation is passive-only. Playwright `framesent`, `framereceived`, and `close` events
  are observed; the tool never calls `send`.
- WebSocket URLs are scope evaluated before connection persistence. Off-scope sockets are ignored;
  metadata-only sockets do not retain full URL details.
- Text frames are redacted and bounded; binary frames are bounded and retained only as opaque bytes.
- BrowserController accepts page observers so WebSocket/action observers automatically cover current
  and newly opened pages.
- ActionTracker captures event type, URL, bounded selector/description metadata and SPA route
  changes; input values are never collected.
- Capture remains fail-closed when an action persistence FK is not available: action correlation is
  maintained in-memory, while requests are not assigned a non-existent action row.

## Code implemented

- `WebSocketListener` connection/frame observation and `WebSocketIngestionService` bounded batching.
- WebSocket ORM-backed connection/frame repository use through the existing schema.
- `ActionTracker` with click/form-submit/history route/page-navigation metadata and configurable
  nearest-action time-window lookup.
- Page observer registration for popup/new-page coverage.
- Frame opcode, direction, timestamp, payload encoding, size and truncation metadata.

## Tests and results

```text
python -m pytest -p no:cacheprovider
79 passed in 4.72s

python -m compileall -q websec_observer tests
passed
```

Focused WU-06 capture tests: `3 passed`, including bounded/redacted WebSocket frames and scope
behavior. The full suite includes the Chromium loopback integration from WU-03.

## Remaining limitations

- Action rows are not yet persisted; the tracker is in-memory and request `action_id` persistence is
  intentionally disabled until an action repository/ingestion path is added. This prevents FK
  violations and is explicitly tracked for the next advanced-capture increment.
- Full WebSocket handshake headers/cookies/origin/subprotocol metadata require CDP augmentation.
- SPA route tracking is injected, but no UI timeline or persisted action timeline exists yet.
- Popup/download/iframe metadata hooks are structurally available through page observers but need
  dedicated persisted event DTOs.
- HAR timing/cache/cookie extensions and CDP adapter remain future hardening work.

## Completion condition

WU-06 functional capture extension is complete: passive WebSocket connections/frames are bounded,
redacted and persisted; page observers and action metadata tracking are wired; no arbitrary frame
send path exists; and all 79 regression tests pass. Persisted action correlation remains a clearly
bounded follow-up rather than an unsafe FK shortcut.
