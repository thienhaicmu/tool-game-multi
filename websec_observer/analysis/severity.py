from websec_observer.domain.enums import Confidence, Severity


def normalize_assessment(
    severity: Severity, confidence: Confidence, *, indirect_signal: bool
) -> tuple[Severity, Confidence]:
    if indirect_signal and confidence is Confidence.CONFIRMED:
        confidence = Confidence.HIGH
    if severity is Severity.CRITICAL and indirect_signal:
        severity = Severity.HIGH
    return severity, confidence
