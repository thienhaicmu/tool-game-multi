from __future__ import annotations

from websec_observer.analysis.evidence import bounded_evidence
from websec_observer.analysis.rules._helpers import query_keys
from websec_observer.analysis.types import AnalysisContext, TransactionView
from websec_observer.domain.enums import Confidence, Severity
from websec_observer.domain.models import FindingDraft


_TOKEN_KEYS = {
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "api_key",
    "apikey",
    "client_secret",
}


class TokenInUrlRule:
    rule_id = "auth.token_in_url"
    title = "Authentication token or secret exposed in URL query"
    category = "authentication"
    default_severity = Severity.HIGH
    version = "1"

    def analyze(self, transaction: TransactionView, context: AnalysisContext) -> tuple[FindingDraft, ...]:
        keys = query_keys(transaction.request.url) & _TOKEN_KEYS
        if not keys:
            return ()
        return (
            FindingDraft(
                rule_id=self.rule_id,
                title=self.title,
                category=self.category,
                severity=Severity.HIGH,
                confidence=Confidence.CONFIRMED,
                affected_url=transaction.request.url,
                description="A sensitive token-shaped query parameter was directly observed in a request URL.",
                remediation="Use an Authorization header or a secure HttpOnly session mechanism instead of URL parameters.",
                evidence=bounded_evidence(
                    query_keys=sorted(keys), redacted_url=transaction.request.url, value="[REDACTED]"
                ),
                false_positive_notes="Confirm the parameter carries authentication material; the value is intentionally never retained.",
            ),
        )
