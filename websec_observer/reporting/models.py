from __future__ import annotations

from dataclasses import dataclass

from websec_observer.domain.models import CapturedTransaction, Finding, TestProject, TestSession


@dataclass(frozen=True, slots=True)
class ReportData:
    project: TestProject | None
    session: TestSession
    transactions: tuple[CapturedTransaction, ...]
    findings: tuple[Finding, ...]

    @property
    def hosts(self) -> tuple[str, ...]:
        return tuple(sorted({item.request.host for item in self.transactions}))

    @property
    def endpoints(self) -> tuple[str, ...]:
        return tuple(sorted({f"{item.request.method} {item.request.path}" for item in self.transactions}))

    @property
    def api_count(self) -> int:
        return sum(item.request.resource_type in {"fetch", "xhr"} for item in self.transactions)

    @property
    def status_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for item in self.transactions:
            if item.response:
                key = str(item.response.status)
                counts[key] = counts.get(key, 0) + 1
        return counts
