# WU-05 Implementation Report

## Objective

Deliver safe redacted report formats and the initial Typer CLI for project initialization, capture,
analysis, reporting, HAR export, and passive rule listing.

## Files created

- `websec_observer/reporting/__init__.py`
- `websec_observer/reporting/models.py`
- `websec_observer/reporting/loader.py`
- `websec_observer/reporting/serializers.py`
- `websec_observer/reporting/har.py`
- `websec_observer/cli/__init__.py`
- `websec_observer/cli/main.py`
- `tests/unit/test_reporting.py`
- `tests/unit/test_cli.py`
- `docs/work-units/WU-05_REPORT.md`

## Files modified

- `pyproject.toml`: added Typer runtime dependency and `websec` console entry point.
- `websec_observer/analysis/rules/token_url.py`: ensures redaction marker is present in evidence.

## Architectural decisions

- Reporting reads immutable `ReportData` loaded through repositories; presenters do not access
  Playwright or issue network requests.
- HTML is self-contained, escapes captured values, uses an offline CSP, and includes no remote
  assets or scripts.
- JSON/Markdown/HAR are generated only from already-redacted persisted observations. HAR emits a
  bounded HAR 1.2-shaped log and preserves redaction/truncation semantics from capture.
- Reports explicitly state passive limitations and include scope, session metadata, summaries,
  hosts, endpoints, requests, findings, evidence, remediation and confidence.
- CLI `run` creates a scoped local SQLite session, delegates browser work to
  `CaptureSessionService`, and never calls Playwright directly.

## Code implemented

- `ReportData` aggregation for hosts, endpoints, API count, status counts and finding summaries.
- Async report loader for project/session/transaction/finding data.
- HTML, JSON, Markdown and redacted HAR renderers.
- Typer commands:
  - `websec init`
  - `websec run --config ... [--url ...] [--headed] --output ...`
  - `websec analyze DATABASE SESSION_ID`
  - `websec report DATABASE SESSION_ID --format html|json|markdown`
  - `websec export DATABASE SESSION_ID --format har`
  - `websec rules`

## Tests and results

```text
python -m pytest -p no:cacheprovider
77 passed in 4.14s

python -m websec_observer.cli.main --help
passed; all six commands listed

python -m websec_observer.cli.main rules
passed; six built-in passive rules listed
```

Typer 0.27.1 was installed to execute the CLI smoke checks.

## Remaining limitations

- CLI `run` performs a navigation then stops; interactive journey orchestration and action timeline
  belong to advanced capture/UI work.
- Report artifact atomic-write/path-containment and retention policy hardening are deferred to
  WU-12; the CLI output path is explicit and does not overwrite via `init`.
- HTML styling is intentionally minimal until the UI work unit.
- HAR is a safe best-effort export; full browser timing/cache/cookie extensions belong to WU-06.
- Ruff/MyPy remain pending from the earlier installation timeout.

## Completion condition

WU-05 is complete: all four report formats render from persisted redacted data, HTML escapes
captured content, CLI help/rule listing work, capture/analyze/report command paths are wired through
application/storage services, and all 77 regression tests pass.
