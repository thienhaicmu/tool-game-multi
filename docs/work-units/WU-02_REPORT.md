# WU-02 Implementation Report

## Objective

Implement the asynchronous SQLite persistence boundary, complete initial relational schema,
repository/unit-of-work adapters, bounded batch writing, indexes, SQLite safety settings, and a
verified Alembic migration.

## Files created

- `websec_observer/storage/__init__.py`
- `websec_observer/storage/repositories.py`
- `websec_observer/storage/sqlite/__init__.py`
- `websec_observer/storage/sqlite/orm.py`
- `websec_observer/storage/sqlite/database.py`
- `websec_observer/storage/sqlite/repositories.py`
- `websec_observer/storage/sqlite/unit_of_work.py`
- `websec_observer/storage/sqlite/batching.py`
- `alembic.ini`
- `migrations/env.py`
- `migrations/versions/0001_initial_schema.py`
- `migrations/versions/__init__.py`
- `migrations/README.md`
- `tests/unit/test_storage.py`
- `tests/unit/test_batching.py`
- `tests/unit/test_migrations.py`
- `docs/work-units/WU-02_REPORT.md`

## Files modified

- `pyproject.toml`: added SQLAlchemy async, aiosqlite, and Alembic runtime dependencies.
- `websec_observer/domain/models.py`: completed session lifecycle/browser metadata fields.

## Architectural decisions

- Repository protocols remain independent of SQLAlchemy; SQLite adapters map between domain
  dataclasses and ORM rows.
- SQLite uses the async aiosqlite driver, foreign keys, a five-second busy timeout, WAL for
  file-backed databases, parameter hiding, and short explicit units of work.
- ORM relationships are intentionally not exposed to the domain. Project and session repositories
  flush at foreign-key boundaries so insert ordering is explicit.
- Bodies and WebSocket payloads are bounded binary columns with encoding/truncation metadata;
  unbounded capture remains prohibited.
- JSON columns store already-redacted structured evidence and metadata. Storage does not perform or
  depend upon Playwright analysis.
- Batch persistence is single-consumer and bounded. Producers await queue capacity, shutdown wakes
  immediately, drains accepted items, and returns accounting statistics.
- The initial Alembic revision creates all approved WU-02 schema objects and supports downgrade.

## Code implemented

- Tables for projects, sessions, actions, requests/responses, WebSocket connections/frames,
  findings, and validation audits.
- Required foreign keys, uniqueness constraints, cascading behavior, and query indexes.
- Async engine/session factory and transactional context manager.
- Project, session, and finding repositories plus unit of work.
- Generic bounded async batch writer with size/interval flushing, backpressure, graceful stop, and
  accepted/persisted/batch/high-water metrics.
- Alembic online/offline environment with caller-supplied connection support.

## Tests added

- Required table/index inspection.
- Project/session round trip and session state update.
- Transaction rollback on exception.
- Finding/evidence round trip.
- Batch-by-size, final drain, queue backpressure, accounting, and invalid limits.
- Alembic upgrade to head and downgrade to base against an in-memory SQLite connection.

## Test commands and results

```text
python -m pytest -p no:cacheprovider
58 passed in 0.86s

python -m compileall -q websec_observer tests migrations
passed
```

Alembic 1.19.0 was installed and the migration test ran successfully. Installation of Ruff/MyPy was
attempted with approval but timed out after 124 seconds and neither module became available.

## Remaining limitations

- Capture DTOs and high-throughput request/response repository methods are introduced with WU-03,
  when their redacted ingestion contract exists; the schema and generic batch primitive are ready.
- Retention execution is deferred to hardening; current foreign keys enable session-owned deletion.
- SQLite is the approved MVP store and is not intended for horizontally concurrent writers.
- The initial revision is a schema-bootstrap revision tied to the approved WU-02 metadata snapshot;
  future schema changes must use new explicit Alembic revisions and must never edit revision 0001.
- Ruff/MyPy gates remain pending because dependency installation timed out.

## Completion condition

WU-02 functional and migration gates are complete: clean upgrade/downgrade, repository
transactions, indexes, foreign keys, batching, backpressure, and graceful drain are verified. Static
tooling remains a tracked release-gate dependency rather than an ignored failure.
