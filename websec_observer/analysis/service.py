from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from websec_observer.analysis.analyzer import PassiveAnalyzer
from websec_observer.analysis.rules import default_registry
from websec_observer.domain.models import Finding
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork


class SessionAnalysisService:
    """Loads redacted observations and persists deterministic passive findings."""

    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession],
        analyzer: PassiveAnalyzer | None = None,
    ) -> None:
        self._factory = factory
        self._analyzer = analyzer or PassiveAnalyzer(engine=None)

    async def analyze(
        self,
        session_id: UUID,
        *,
        enabled_rule_ids: frozenset[str] | None = None,
    ) -> Sequence[Finding]:
        async with SqliteUnitOfWork(self._factory) as uow:
            transactions = await uow.transactions.list_for_session(session_id)
            findings = self._analyzer.analyze(
                session_id, transactions, enabled_rule_ids=enabled_rule_ids
            )
            await uow.findings.add_many(findings)
            await uow.commit()
            return findings
