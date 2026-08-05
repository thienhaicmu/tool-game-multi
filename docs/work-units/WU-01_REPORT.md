# WU-01 Implementation Report

## Objective

Implement fail-closed URL/host scope enforcement and sensitive-data redaction as standalone,
framework-independent safety services used before capture data can enter queues, storage, logs,
analysis, events, or reports.

## Files created

- `websec_observer/common/scope.py`
- `websec_observer/common/redaction.py`
- `tests/unit/test_scope.py`
- `tests/unit/test_redaction.py`
- `tests/unit/test_logging.py`
- `docs/work-units/WU-01_REPORT.md`

## Files modified

- `websec_observer/config.py`
- `websec_observer/common/logging.py`

## Architectural decisions

- Exact host matching is the default. Subdomains require an explicit `*.` pattern, and a wildcard
  does not include the apex.
- Denied patterns override allowed patterns. Valid third-party hosts produce
  `ALLOW_METADATA_ONLY`; malformed, credential-bearing, relative, or unsupported URLs produce
  `DENY`.
- Hosts are normalized with IDNA and `ipaddress`; suffix string matching is never used without a
  label boundary.
- URL fragments and user-info are removed/rejected at the safety boundary. Default ports are
  normalized.
- Redaction returns defensive copies and operates recursively with depth, item, and string bounds.
- Binary values are not decoded speculatively. Body decoding and binary metadata belong to the
  capture work unit.
- Optional secret equality fingerprints use keyed HMAC-SHA256 with a runtime-only key; plain hashes
  of low-entropy secrets are not supported.
- Debug whitelisting requires explicit opt-in and cannot whitelist core credentials.
- Structured logging applies redaction to both messages and allowlisted context fields.

## Code implemented

- `canonicalize_host`, `canonicalize_url`, `HostPattern`, and `CanonicalScopePolicy`.
- DNS, IDNA, IPv4/IPv6, wildcard, scheme, port, user-info, fragment, and deny-precedence handling.
- Strict configuration integration using the same canonical host/URL implementation.
- `SensitiveDataRedactor` for mappings, sequences, JSON strings, URL query parameters, URL
  credentials, bearer/basic values, JWT-shaped values, private keys, and sensitive assignments.
- Default sensitive field catalog, configurable additions, bounded traversal, safe truncation, and
  HMAC fingerprints.
- Redacted JSON structured log formatting.

## Tests added

- Exact versus wildcard host behavior, suffix attacks, apex behavior, wildcard validation.
- Deny precedence, metadata-only third-party treatment, malformed and credential-bearing URLs.
- DNS case/trailing dot, IDNA, IPv4/IPv6, default/custom ports, and fragment removal.
- Nested and case/format-insensitive field redaction without caller mutation.
- URL credential/query redaction, duplicate query keys, structured JSON, bearer/JWT/private key
  text, binary behavior, fingerprints, whitelist boundaries, traversal limits, and log sentinels.

## Test commands and results

```text
python -m pytest -p no:cacheprovider
50 passed in 0.19s

python -m compileall -q websec_observer tests
passed
```

Ruff and MyPy remain unavailable in the current runtime (`No module named ruff`; `No module named
mypy`). Their configurations are present and must run before a release gate is claimed.

## Remaining limitations

- DNS resolution, private/reserved-address policy, DNS pinning/rebinding defense, redirect
  revalidation, and network request budgets belong to the safe active-validation work unit.
- Capture-layer content encoding, decompression limits, body/frame truncation metadata, and queue
  backpressure are not part of WU-01.
- XML-aware structural redaction is deferred until captured content-type/body handling exists;
  conservative text rules still protect known credentials.
- Redaction is designed for safety, not semantic recovery; conservative matching can intentionally
  over-redact evidence.
- Ruff/MyPy quality gates are pending dependency availability.

## Completion condition

WU-01 is functionally complete: its scope and redaction safety matrix passes, raw sentinel secrets
are absent from structured logs, and configuration uses the same canonicalization rules. Static
tooling gates remain pending and are tracked for the final quality gate.
