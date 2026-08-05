# WU-03 Implementation Report

## Objective

Implement MVP Chromium capture for document, Fetch, and XHR traffic with session lifecycle,
request/response timing and redirect links, strict scope enforcement, pre-persistence redaction,
bounded body handling, queue backpressure, batching, and graceful shutdown.

## Files created

- `websec_observer/capture/__init__.py`
- `websec_observer/capture/browser_controller.py`
- `websec_observer/capture/network_listener.py`
- `websec_observer/capture/ingestion.py`
- `websec_observer/capture/session_service.py`
- `tests/unit/test_capture_limits.py`
- `tests/integration/test_playwright_capture.py`
- `docs/work-units/WU-03_REPORT.md`

## Files modified

- `pyproject.toml`
- `websec_observer/domain/models.py`
- `websec_observer/storage/repositories.py`
- `websec_observer/storage/sqlite/repositories.py`
- `websec_observer/storage/sqlite/unit_of_work.py`

## Architectural decisions

- Playwright async API is the sole capture source for WU-03. CDP remains behind the future adapter
  boundary and is not introduced without an observed Playwright data gap.
- Scope is evaluated before headers or bodies are read. `DENY` events are discarded;
  `ALLOW_METADATA_ONLY` events persist only origin-level metadata with no path, query, headers, or
  body.
- Redaction occurs before DTO submission to the bounded ingestion queue. Storage receives only
  scoped and redacted domain transactions.
- Binary bodies are not persisted by default because safe semantic redaction cannot be guaranteed.
  Text bodies are decoded as UTF-8 conservatively, redacted, and bounded again after redaction.
- Request and response body caps are independent and fail closed. Unavailable/undecodable bodies
  are represented without blocking or leaking exception contents.
- Redirect hops are separate requests linked by the preceding request UUID.
- Browser control contains no finding logic; ingestion contains no analysis logic; storage contains
  no Playwright types.
- Capture session lifecycle is owned by an application service and persisted as `STARTING`,
  `RUNNING`, `STOPPING`, and `COMPLETED` or `FAILED`.

## Code implemented

- Headless/headed Chromium launch, optional persistent profile, imported/exported storage state,
  optional proxy, TLS verification on by default, and idempotent resource cleanup.
- Playwright context listeners for request, request-finished, and request-failed events.
- Capture DTOs for requests, responses, and complete transactions.
- Method, canonical/redacted URL, host/path/query, redacted headers, bounded body, resource type,
  response status/headers/body, duration, remote IP, redirect relationship, truncation, and decode
  metadata.
- Transaction repository batching with parent requests flushed before response rows.
- Session orchestration connecting browser, listener, ingestion, database, status transitions,
  browser version, and user agent.

## Tests added

- Binary body non-persistence, zero limits, redaction and post-redaction body cap.
- End-to-end local loopback Chromium journey containing a redirect, document, POST Fetch, and an
  out-of-scope image request.
- Verification that request method, response, redirect link, query, Authorization redaction,
  password/token sentinels, metadata-only scope behavior, lifecycle timestamps/status, queue
  accounting, and database persistence are correct.

## Test commands and results

```text
python -m pytest -p no:cacheprovider
62 passed in 4.88s

python -m compileall -q websec_observer tests migrations
passed

python -m pytest -p no:cacheprovider tests/integration/test_playwright_capture.py -q
1 passed in 29.81s (final redirect-chain variant)
```

The Playwright integration must run outside the restricted sandbox because Windows named-pipe
creation for the Playwright subprocess is blocked inside it. The browser contacted only the test's
loopback HTTP server.

## Remaining limitations

- Automated headed-mode smoke testing is not performed in this headless task runner; the same
  controller sets `headless=False` for operator use. Final MVP acceptance still requires an
  interactive headed smoke test.
- Playwright materializes `response.body()` before the application can truncate it. Persistence is
  bounded, but streaming/decompression protections and CDP metadata require later capture/hardening
  work.
- Cookies are protected through complete `Cookie`/`Set-Cookie` header redaction; structured cookie
  attribute capture belongs to the cookie-analysis work unit.
- WebSocket, action correlation, SPA routes, iframe/popup/download/TLS events, tracing/video/HAR,
  and service-worker visibility belong to WU-06.
- Capture counters are returned by the ingestion service; persistence of detailed drop/truncation
  counters into session rows will be expanded during advanced capture/hardening.
- Ruff/MyPy remain unavailable after the previously approved installation attempt timed out.

## Completion condition

WU-03 is functionally complete: local Chromium captures and persists redacted in-scope document and
Fetch traffic, records responses/timing/redirects, retains only minimal third-party metadata,
enforces body limits, transitions session state, applies bounded backpressure/batching, and drains
cleanly. The headed interactive smoke test remains an explicit final MVP gate rather than an
unverified claim.
