from datetime import UTC, datetime
from uuid import uuid4

from websec_observer.domain.enums import Confidence, ScopeDisposition, Severity, SessionStatus
from websec_observer.domain.models import CapturedRequest, CapturedResponse, CapturedTransaction, Finding, TestProject, TestSession
from websec_observer.reporting.models import ReportData
from websec_observer.reporting.har import render_har
from websec_observer.reporting.serializers import render_html, render_json, render_markdown


def sample_data() -> ReportData:
    project = TestProject("Demo", "https://example.test/", ("example.test",))
    session = TestSession(project_id=project.id, status=SessionStatus.COMPLETED)
    request_id = uuid4()
    request = CapturedRequest(
        id=request_id, session_id=session.id, browser_request_id="r1", timestamp=datetime.now(UTC),
        resource_type="fetch", method="GET", url="https://example.test/api?q=%5BREDACTED%5D",
        scheme="https", host="example.test", port=None, path="/api", query={"q": "[REDACTED]"},
        headers={"authorization": "[REDACTED]"}, cookies={}, body=None, body_encoding=None,
        initiator={}, redirect_from_id=None, size=None, scope_disposition=ScopeDisposition.ALLOW_FULL,
    )
    response = CapturedResponse(
        request_id=request_id, timestamp=datetime.now(UTC), status=200, status_text="OK",
        headers={"content-type": "application/json"}, cookies={}, content_type="application/json",
        body=b'{"token":"[REDACTED]"}', body_encoding="utf-8", size=23, duration_ms=12,
        remote_ip="127.0.0.1", protocol="h2", from_cache=False,
    )
    finding = Finding(
        session_id=session.id, rule_id="auth.token_in_url", title="Token in URL",
        category="authentication", severity=Severity.HIGH, confidence=Confidence.CONFIRMED,
        affected_url=request.url, description="Observed", remediation="Use a header.",
        evidence={"redacted_url": request.url},
    )
    return ReportData(project, session, (CapturedTransaction(request, response),), (finding,))


def test_all_report_formats_include_summary_and_never_raw_secret() -> None:
    data = sample_data()
    for rendered in (render_html(data), render_json(data), render_markdown(data), render_har(data)):
        assert "example.test" in rendered
        assert "[REDACTED]" in rendered
        assert "raw-secret" not in rendered


def test_html_escapes_captured_markup() -> None:
    data = sample_data()
    request = data.transactions[0].request
    changed = CapturedRequest(
        id=request.id, session_id=request.session_id, browser_request_id=request.browser_request_id,
        timestamp=request.timestamp, resource_type=request.resource_type, method=request.method,
        url="https://example.test/<script>alert(1)</script>", scheme=request.scheme, host=request.host,
        port=request.port, path="/<script>", query=request.query, headers=request.headers,
        cookies=request.cookies, body=request.body, body_encoding=request.body_encoding,
        initiator=request.initiator, redirect_from_id=request.redirect_from_id, size=request.size,
        scope_disposition=request.scope_disposition,
    )
    rendered = render_html(ReportData(data.project, data.session, (CapturedTransaction(changed, None),), ()))
    assert "<script>alert(1)</script>" not in rendered
    assert "&lt;script&gt;" in rendered
