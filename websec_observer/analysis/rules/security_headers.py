from __future__ import annotations

from websec_observer.analysis.evidence import bounded_evidence
from websec_observer.analysis.rules._helpers import headers_lower, is_document
from websec_observer.analysis.types import AnalysisContext, TransactionView
from websec_observer.domain.enums import Confidence, Severity
from websec_observer.domain.models import FindingDraft


_HEADERS = (
    ("content-security-policy", "Content-Security-Policy", Severity.LOW),
    ("x-content-type-options", "X-Content-Type-Options", Severity.LOW),
    ("referrer-policy", "Referrer-Policy", Severity.LOW),
    ("permissions-policy", "Permissions-Policy", Severity.LOW),
)


class SecurityHeadersRule:
    rule_id = "headers.document_security_headers"
    title = "Security headers missing from document response"
    category = "security_headers"
    default_severity = Severity.LOW
    version = "1"

    def analyze(self, transaction: TransactionView, context: AnalysisContext) -> tuple[FindingDraft, ...]:
        if not transaction.response or not is_document(transaction):
            return ()
        headers = headers_lower(transaction.response.headers)
        missing = [label for key, label, _severity in _HEADERS if key not in headers]
        if "x-frame-options" not in headers and "frame-ancestors" not in headers.get(
            "content-security-policy", ""
        ):
            missing.append("X-Frame-Options or CSP frame-ancestors")
        if not missing:
            return ()
        severity = Severity.MEDIUM if "Content-Security-Policy" in missing else Severity.LOW
        return (
            FindingDraft(
                rule_id=self.rule_id,
                title="Security headers missing",
                category=self.category,
                severity=severity,
                confidence=Confidence.HIGH,
                affected_url=transaction.request.url,
                description="One or more baseline security headers were not observed.",
                remediation="Configure the missing response headers according to application context.",
                evidence=bounded_evidence(missing_headers=missing),
                false_positive_notes="A missing header is not automatically a critical vulnerability; assess application context.",
            )
            ,
        )
