from types import MappingProxyType

import pytest

from websec_observer.domain.enums import Confidence, Severity
from websec_observer.domain.models import FindingDraft


def test_finding_evidence_is_defensively_copied_and_immutable() -> None:
    source = {"header": "Content-Security-Policy"}
    finding = FindingDraft(
        rule_id="headers.csp.missing",
        title="Missing CSP",
        category="security_headers",
        severity=Severity.LOW,
        confidence=Confidence.HIGH,
        affected_url="https://example.test/",
        description="The observed document response did not include CSP.",
        remediation="Define an application-specific CSP.",
        evidence=source,
    )
    source["header"] = "changed"
    assert isinstance(finding.evidence, MappingProxyType)
    assert finding.evidence["header"] == "Content-Security-Policy"
    with pytest.raises(TypeError):
        finding.evidence["new"] = "value"  # type: ignore[index]
