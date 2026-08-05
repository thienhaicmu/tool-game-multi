from __future__ import annotations

from websec_observer.analysis.evidence import bounded_evidence
from websec_observer.analysis.rules._helpers import headers_lower
from websec_observer.analysis.types import AnalysisContext, PassiveRule, TransactionView
from websec_observer.domain.enums import Confidence, Severity
from websec_observer.domain.models import FindingDraft


class PlaintextTransportRule:
    rule_id = "transport.http_observed"
    title = "Sensitive or API traffic observed over plaintext HTTP"
    category = "transport_security"
    default_severity = Severity.MEDIUM
    version = "1"

    def analyze(self, transaction: TransactionView, context: AnalysisContext) -> tuple[FindingDraft, ...]:
        request = transaction.request
        if request.scheme != "http" or request.resource_type not in {"document", "fetch", "xhr"}:
            return ()
        severity = Severity.MEDIUM if request.resource_type in {"fetch", "xhr"} else Severity.LOW
        return (
            FindingDraft(
                rule_id=self.rule_id,
                title=self.title,
                category=self.category,
                severity=severity,
                confidence=Confidence.CONFIRMED,
                affected_url=request.url,
                description="The browser observed an API or document request over plaintext HTTP.",
                remediation="Serve the application and APIs exclusively over HTTPS and redirect safely.",
                evidence=bounded_evidence(scheme=request.scheme, resource_type=request.resource_type),
                false_positive_notes="Local-only development traffic may be intentional; verify deployment scope.",
            ),
        )


TransportSecurityRule = PlaintextTransportRule


class MissingHstsRule:
    rule_id = "transport.hsts_missing"
    title = "HSTS header not observed on an HTTPS document"
    category = "transport_security"
    default_severity = Severity.LOW
    version = "1"

    def analyze(self, transaction: TransactionView, context: AnalysisContext) -> tuple[FindingDraft, ...]:
        request, response = transaction.request, transaction.response
        if not response or request.scheme != "https" or request.resource_type != "document":
            return ()
        if "strict-transport-security" in headers_lower(response.headers):
            return ()
        return (
            FindingDraft(
                rule_id=self.rule_id,
                title=self.title,
                category=self.category,
                severity=Severity.LOW,
                confidence=Confidence.HIGH,
                affected_url=request.url,
                description="No Strict-Transport-Security header was observed on the HTTPS document.",
                remediation="Configure HSTS with an appropriate max-age after validating HTTPS coverage.",
                evidence=bounded_evidence(missing_header="Strict-Transport-Security"),
                false_positive_notes="Severity depends on deployment coverage, preload intent, and whether subdomains are HTTPS-only.",
            ),
        )
