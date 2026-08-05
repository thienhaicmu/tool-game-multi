from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol, Sequence
from uuid import UUID

from websec_observer.domain.enums import Confidence, Severity
from websec_observer.domain.models import CapturedRequest, CapturedResponse, FindingDraft


@dataclass(frozen=True, slots=True)
class TransactionView:
    request: CapturedRequest
    response: CapturedResponse | None


@dataclass(frozen=True, slots=True)
class AnalysisContext:
    session_id: UUID
    base_url: str | None = None
    is_https_session: bool = False
    metadata: Mapping[str, Any] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.metadata is None:
            object.__setattr__(self, "metadata", {})


class PassiveRule(Protocol):
    rule_id: str
    title: str
    category: str
    default_severity: Severity
    version: str

    def analyze(
        self, transaction: TransactionView, context: AnalysisContext
    ) -> Sequence[FindingDraft]: ...
