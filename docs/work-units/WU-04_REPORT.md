# WU-04 Implementation Report

## Objective

Implement the passive MVP analysis engine as deterministic, plugin-style rules over immutable,
redacted transaction views. Persist findings with evidence, severity, confidence, remediation, and
false-positive notes without browser control or active probing.

## Files created

- `websec_observer/analysis/__init__.py`
- `websec_observer/analysis/types.py`
- `websec_observer/analysis/evidence.py`
- `websec_observer/analysis/rule_engine.py`
- `websec_observer/analysis/analyzer.py`
- `websec_observer/analysis/service.py`
- `websec_observer/analysis/rules/__init__.py`
- `websec_observer/analysis/rules/_helpers.py`
- `websec_observer/analysis/rules/transport_security.py`
- `websec_observer/analysis/rules/security_headers.py`
- `websec_observer/analysis/rules/cookies.py`
- `websec_observer/analysis/rules/cookie_security.py`
- `websec_observer/analysis/rules/token_url.py`
- `websec_observer/analysis/rules/sensitive_response.py`
- `websec_observer/analysis/rules/sensitive_data.py`
- `tests/unit/test_analysis.py` (existing rule contract suite completed/validated)
- `docs/work-units/WU-04_REPORT.md`

## Files modified

- `websec_observer/domain/models.py`: finding safe-reproduction field and transaction analysis compatibility.
- `websec_observer/storage/repositories.py`: transaction listing protocol.
- `websec_observer/storage/sqlite/repositories.py`: redacted transaction reconstruction for analysis.

## Architectural decisions

- Rules implement a pure `analyze(transaction, context)` contract. They do not access Playwright,
  SQLAlchemy, network clients, or mutable browser state.
- `RuleRegistry` rejects duplicate IDs and validates explicit enablement. `RuleEngine` isolates rule
  failures and continues other rules.
- Analyzer rejects transactions from a different session, deduplicates findings by stable SHA-256
  fingerprint, and preserves direct-observation confidence semantics.
- Evidence is bounded and stores locations/categories/headers rather than sensitive values.
- Missing headers are contextual Low/Medium signals; they are never Critical by absence alone.
- Token-in-URL is High/Confirmed only because the sensitive query key is directly observed; other
  signals remain conservative.

## Code implemented

Passive MVP rule families:

- Plain HTTP document/API transport and missing HSTS on HTTPS documents.
- Baseline document security headers: CSP, nosniff, Referrer-Policy, Permissions-Policy and frame
  protection, with contextual aggregation.
- Session-like cookie Secure/HttpOnly/SameSite analysis using structured cookie attributes or
  redacted Set-Cookie fallback.
- Authentication token/secret query-key exposure with redacted URL evidence.
- Sensitive response patterns for password/token/key/private-key/error data, including JSON
  locations and redacted previews.

Also implemented:

- Default rule registry and compatibility aliases for rule modules.
- Synchronous analyzer plus async session analysis service that loads stored transactions and
  persists findings.
- Stable finding fingerprints and optional enabled-rule filtering.

## Tests and results

```text
python -m pytest -p no:cacheprovider tests/unit/test_analysis.py -q
10 passed

python -m pytest -p no:cacheprovider
74 passed in 5.00s
```

The full suite includes the WU-03 local Chromium integration and all prior storage, migration,
scope, redaction, capture, batching, and cookie metadata tests.

## Remaining limitations

- CORS, CSRF, authentication lifecycle/JWT metadata, authorization signals, error disclosure,
  cache-control, API design, rate-limit, and WebSocket rules belong to WU-07.
- Rule enable/disable is currently an analyzer/service capability; CLI/API exposure belongs to later
  work units.
- Rule evidence is bounded but final HTML/JSON/Markdown/HAR presentation belongs to WU-05.
- Static Ruff/MyPy gates remain pending because their installation timed out in this runtime.

## Completion condition

WU-04 is complete: plugin-style passive rules execute deterministically over persisted observations,
findings carry evidence/severity/confidence/remediation, cross-session data is rejected, duplicate
findings are suppressed, and all 74 regression tests pass.
