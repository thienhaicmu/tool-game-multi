from __future__ import annotations

import re
import json

from websec_observer.analysis.evidence import bounded_evidence
from websec_observer.analysis.types import AnalysisContext, TransactionView
from websec_observer.domain.enums import Confidence, Severity
from websec_observer.domain.models import FindingDraft

_PATTERNS = (
    (re.compile(r"(?i)\b(password|passwd)\b\s*['\"]?\s*[:=]"), "password"),
    (re.compile(r"(?i)\b(access[_-]?token|refresh[_-]?token|api[_-]?key)\b\s*['\"]?\s*[:=]"), "token_or_key"),
    (re.compile(r"-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----"), "private_key"),
    (re.compile(r"(?i)(stack trace|traceback|sql syntax|internal server error)"), "error_detail"),
)


class SensitiveResponseRule:
    rule_id = "exposure.sensitive_response_data"
    title = "Sensitive data pattern observed in response body"
    category = "sensitive_data"
    default_severity = Severity.MEDIUM
    version = "1"

    def analyze(self, transaction: TransactionView, context: AnalysisContext) -> tuple[FindingDraft, ...]:
        response = transaction.response
        if not response or not response.body or response.body_encoding != "utf-8":
            return ()
        try:
            text = response.body.decode("utf-8", errors="replace")
        except Exception:
            return ()
        categories = [label for pattern, label in _PATTERNS if pattern.search(text)]
        if not categories:
            return ()
        severity = Severity.HIGH if any(item in {"token_or_key", "private_key"} for item in categories) else Severity.MEDIUM
        locations: list[str] = []
        try:
            decoded = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            decoded = None

        def walk(value: object, path: str = "$") -> None:
            if isinstance(value, dict):
                for key, item in value.items():
                    item_path = f"{path}.{key}"
                    if any(token in str(key).lower() for token in ("password", "token", "api_key", "secret")):
                        locations.append(item_path)
                    walk(item, item_path)
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    walk(item, f"{path}[{index}]")

        walk(decoded)
        return (
            FindingDraft(
                rule_id=self.rule_id,
                title=self.title,
                category=self.category,
                severity=severity,
                confidence=Confidence.HIGH,
                affected_url=transaction.request.url,
                description="The response body contains a sensitive-data or detailed-error pattern.",
                remediation="Remove secrets and unnecessary internal/error data from responses; return a minimal schema.",
                evidence=bounded_evidence(
                    data_categories=categories,
                    locations=locations,
                    preview="[REDACTED]",
                ),
                false_positive_notes="Pattern matching can flag documentation or intentionally masked values; inspect only in the authorized environment.",
            ),
        )
