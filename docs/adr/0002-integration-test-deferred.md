# ADR-0002: Defer Playwright environment blocker

## Status

Accepted temporarily

The local Playwright integration test is deferred while the workstation's
Chromium launch hangs under both Python 3.13 and 3.14. Unit, migration,
redaction, scope, storage and replay tests remain required and continue to run.

Product work that does not require launching Playwright may proceed. The
integration gate must be rerun in CI or a clean browser environment before a
release is marked production-ready.
