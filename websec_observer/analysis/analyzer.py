from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Sequence
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from websec_observer.analysis.rule_engine import RuleEngine, default_registry
from websec_observer.analysis.types import AnalysisContext, TransactionView
from websec_observer.domain.models import Finding, FindingDraft
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork


class PassiveAnalyzer:
    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession] | None = None,
        *,
        engine: RuleEngine | None = None,
    ) -> None:
        self._factory = factory
        self._engine = engine or RuleEngine(default_registry())

    def analyze(
        self,
        session_id: UUID,
        transactions: Iterable[TransactionView],
        *,
        context: AnalysisContext | None = None,
        enabled_rule_ids: frozenset[str] | None = None,
    ) -> tuple[Finding, ...]:
        analysis_context = context or AnalysisContext(session_id=session_id)
        drafts: list[FindingDraft] = []
        seen: set[str] = set()
        for transaction in transactions:
            if transaction.request.session_id != session_id:
                raise ValueError("transaction belongs to another session")
            for draft in self._engine.analyze(transaction, analysis_context, enabled_rule_ids):
                fingerprint = _fingerprint(draft)
                if fingerprint in seen:
                    continue
                seen.add(fingerprint)
                drafts.append(draft)
        return tuple(
            Finding(
                session_id=session_id,
                rule_id=draft.rule_id,
                title=draft.title,
                category=draft.category,
                severity=draft.severity,
                confidence=draft.confidence,
                affected_url=draft.affected_url,
                description=draft.description,
                remediation=draft.remediation,
                evidence=draft.evidence,
                references=draft.references,
                false_positive_notes=draft.false_positive_notes,
                safe_reproduction=draft.safe_reproduction,
            )
            for draft in drafts
        )

    async def analyze_and_persist(
        self,
        session_id: UUID,
        transactions: Iterable[TransactionView],
        *,
        context: AnalysisContext | None = None,
    ) -> tuple[Finding, ...]:
        if self._factory is None:
            raise RuntimeError("analyze_and_persist requires a database session factory")
        findings = self.analyze(session_id, transactions, context=context)
        if findings:
            async with SqliteUnitOfWork(self._factory) as uow:
                await uow.findings.add_many(findings)
                await uow.commit()
        return findings


def _fingerprint(draft: FindingDraft) -> str:
    payload = {
        "rule": draft.rule_id,
        "url": draft.affected_url,
        "evidence": draft.evidence,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


class Analyzer(PassiveAnalyzer):
    """Compatibility name for the synchronous passive analyzer API."""

    def __init__(self, registry: object) -> None:
        from websec_observer.analysis.rule_engine import RuleEngine

        super().__init__(engine=RuleEngine(registry))  # type: ignore[arg-type]
