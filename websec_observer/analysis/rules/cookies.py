from __future__ import annotations

import re

from websec_observer.analysis.evidence import bounded_evidence
from websec_observer.analysis.rules._helpers import headers_lower
from websec_observer.analysis.types import AnalysisContext, TransactionView
from websec_observer.domain.enums import Confidence, Severity
from websec_observer.domain.models import FindingDraft


_SESSION_NAME = re.compile(r"(?i)(session|sess|sid|auth|token|jwt)")


class CookieSecurityRule:
    rule_id = "cookies.session_attributes"
    title = "Session cookie has weak security attributes"
    category = "cookie_security"
    default_severity = Severity.MEDIUM
    version = "1"

    def analyze(self, transaction: TransactionView, context: AnalysisContext) -> tuple[FindingDraft, ...]:
        if not transaction.response:
            return ()
        cookies = transaction.response.cookies
        if cookies:
            findings: list[FindingDraft] = []
            for cookie_name, attributes in cookies.items():
                if not _SESSION_NAME.search(cookie_name):
                    continue
                missing = [
                    name
                    for name, present in (
                        ("Secure", bool(attributes.get("secure"))),
                        ("HttpOnly", bool(attributes.get("httponly"))),
                        ("SameSite", bool(attributes.get("samesite"))),
                    )
                    if not present
                ]
                if missing:
                    findings.append(
                        FindingDraft(
                            rule_id=self.rule_id,
                            title="Session cookie has weak security attributes",
                            category=self.category,
                            severity=Severity.MEDIUM,
                            confidence=Confidence.HIGH,
                            affected_url=transaction.request.url,
                            description="An observed session-like cookie is missing security attributes.",
                            remediation="Set Secure, HttpOnly, and an explicit SameSite policy as appropriate.",
                            evidence=bounded_evidence(cookie_name=cookie_name, missing_attributes=missing),
                            false_positive_notes="Cookie name classification is heuristic; verify whether it is session-bearing.",
                        )
                    )
            return tuple(findings)
        set_cookie = headers_lower(transaction.response.headers).get("set-cookie")
        if not set_cookie:
            return ()
        findings: list[FindingDraft] = []
        cookie_name = set_cookie.split("=", 1)[0].strip()
        if not _SESSION_NAME.search(cookie_name):
            return ()
        attributes = {part.strip().lower().split("=", 1)[0] for part in set_cookie.split(";")[1:]}
        if "secure" not in attributes and transaction.request.scheme == "https":
            findings.append(self._finding(transaction, "Secure", "Add the Secure attribute to session cookies."))
        if "httponly" not in attributes:
            findings.append(self._finding(transaction, "HttpOnly", "Add HttpOnly to cookies that do not need JavaScript access."))
        if not any(item.startswith("samesite") for item in attributes):
            findings.append(self._finding(transaction, "SameSite", "Set an explicit SameSite policy appropriate to the application."))
        return tuple(findings)

    def _finding(self, transaction: TransactionView, attribute: str, remediation: str) -> FindingDraft:
        return FindingDraft(
            rule_id=f"{self.rule_id}.{attribute.lower()}",
            title=f"Session cookie missing {attribute}",
            category=self.category,
            severity=Severity.MEDIUM if attribute in {"Secure", "HttpOnly"} else Severity.LOW,
            confidence=Confidence.HIGH,
            affected_url=transaction.request.url,
            description=f"An observed session-like cookie did not include {attribute}.",
            remediation=remediation,
            evidence=bounded_evidence(cookie_name="[REDACTED]", missing_attribute=attribute),
            false_positive_notes="Cookie name classification is heuristic; verify whether the cookie is actually session-bearing.",
        )
