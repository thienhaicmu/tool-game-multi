from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from websec_observer.analysis.analyzer import Analyzer
from websec_observer.analysis.rule_engine import AnalysisContext, RuleRegistry
from websec_observer.analysis.rules import default_registry
from websec_observer.analysis.rules.cookie_security import CookieSecurityRule
from websec_observer.analysis.rules.security_headers import SecurityHeadersRule
from websec_observer.analysis.rules.sensitive_data import SensitiveResponseRule
from websec_observer.analysis.rules.token_url import TokenInUrlRule
from websec_observer.analysis.rules.transport_security import TransportSecurityRule
from websec_observer.domain.enums import Confidence, ScopeDisposition, Severity
from websec_observer.domain.models import CapturedRequest, CapturedResponse, CapturedTransaction


def transaction(
    *,
    session_id: UUID | None = None,
    scheme: str = "https",
    resource_type: str = "document",
    url: str = "https://example.test/",
    query: dict[str, str] | None = None,
    response_headers: dict[str, str] | None = None,
    response_cookies: dict[str, dict[str, object]] | None = None,
    response_body: bytes | None = None,
) -> CapturedTransaction:
    session_id = session_id or uuid4()
    request_id = uuid4()
    request = CapturedRequest(
        id=request_id,
        session_id=session_id,
        browser_request_id=str(uuid4()),
        timestamp=datetime.now(UTC),
        resource_type=resource_type,
        method="GET",
        url=url,
        scheme=scheme,
        host="example.test",
        port=None,
        path="/",
        query=query or {},
        headers={},
        cookies={},
        body=None,
        body_encoding=None,
        initiator={},
        redirect_from_id=None,
        size=None,
        scope_disposition=ScopeDisposition.ALLOW_FULL,
    )
    response = CapturedResponse(
        request_id=request_id,
        timestamp=datetime.now(UTC),
        status=200,
        status_text="OK",
        headers=response_headers or {},
        cookies=response_cookies or {},
        content_type="application/json" if response_body else "text/html",
        body=response_body,
        body_encoding="utf-8" if response_body else None,
        size=len(response_body) if response_body else None,
        duration_ms=12.0,
        remote_ip="127.0.0.1",
        protocol="h2",
        from_cache=False,
    )
    return CapturedTransaction(request, response)


def context(item: CapturedTransaction) -> AnalysisContext:
    return AnalysisContext(item.request.session_id)


def test_security_headers_rule_reports_contextual_missing_headers() -> None:
    item = transaction(response_headers={"x-content-type-options": "nosniff"})
    findings = SecurityHeadersRule().analyze(item, context(item))
    assert len(findings) == 1
    assert findings[0].severity is Severity.MEDIUM
    assert findings[0].confidence is Confidence.HIGH
    assert "Content-Security-Policy" in findings[0].evidence["missing_headers"]


def test_security_headers_rule_has_negative_case() -> None:
    item = transaction(
        response_headers={
            "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "permissions-policy": "geolocation=()",
        }
    )
    assert SecurityHeadersRule().analyze(item, context(item)) == ()


def test_cookie_rule_uses_attributes_without_value() -> None:
    item = transaction(response_cookies={"session_id": {"path": "/"}})
    finding = CookieSecurityRule().analyze(item, context(item))[0]
    assert finding.evidence["cookie_name"] == "session_id"
    assert finding.evidence["missing_attributes"] == ["Secure", "HttpOnly", "SameSite"]
    assert "value" not in finding.evidence


def test_cookie_rule_ignores_secure_session_cookie_and_non_session_cookie() -> None:
    item = transaction(
        response_cookies={
            "session_id": {"secure": True, "httponly": True, "samesite": "Lax"},
            "theme": {},
        }
    )
    assert CookieSecurityRule().analyze(item, context(item)) == ()


def test_token_url_is_directly_observed_high_confirmed() -> None:
    item = transaction(
        url="https://example.test/callback?access_token=%5BREDACTED%5D",
        query={"access_token": "[REDACTED]"},
    )
    finding = TokenInUrlRule().analyze(item, context(item))[0]
    assert finding.severity is Severity.HIGH
    assert finding.confidence is Confidence.CONFIRMED
    assert "%5BREDACTED%5D" in finding.evidence["redacted_url"]


def test_sensitive_response_records_locations_not_values() -> None:
    item = transaction(
        response_body=b'{"user":"Ada","access_token":"[REDACTED]","nested":{"password":"[REDACTED]"}}'
    )
    finding = SensitiveResponseRule().analyze(item, context(item))[0]
    assert finding.evidence["locations"] == ["$.access_token", "$.nested.password"]
    assert "Ada" not in repr(finding.evidence)


def test_transport_rule_severity_depends_on_api_context() -> None:
    document = transaction(scheme="http", url="http://example.test/")
    api = transaction(
        scheme="http", resource_type="fetch", url="http://example.test/api"
    )
    assert TransportSecurityRule().analyze(document, context(document))[0].severity is Severity.LOW
    assert TransportSecurityRule().analyze(api, context(api))[0].severity is Severity.MEDIUM


def test_analyzer_is_deterministic_deduplicates_and_preserves_confirmed() -> None:
    session_id = uuid4()
    item = transaction(
        session_id=session_id,
        query={"access_token": "[REDACTED]"},
        url="https://example.test/?access_token=%5BREDACTED%5D",
    )
    analyzer = Analyzer(RuleRegistry((TokenInUrlRule(),)))
    first = analyzer.analyze(session_id, (item, item))
    second = analyzer.analyze(session_id, (item,))
    assert len(first) == 1
    assert [(f.rule_id, f.evidence) for f in first] == [
        (f.rule_id, f.evidence) for f in second
    ]
    assert first[0].confidence is Confidence.CONFIRMED


def test_analyzer_rejects_cross_session_transaction() -> None:
    item = transaction()
    with pytest.raises(ValueError, match="another session"):
        Analyzer(default_registry()).analyze(uuid4(), (item,))


def test_registry_rejects_duplicates_and_unknown_enablement() -> None:
    registry = RuleRegistry((TokenInUrlRule(),))
    with pytest.raises(ValueError, match="duplicate"):
        registry.register(TokenInUrlRule())
    with pytest.raises(ValueError, match="unknown"):
        registry.enabled(frozenset({"missing.rule"}))
