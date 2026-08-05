from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from websec_observer.reporting.models import ReportData
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork


async def load_report_data(
    factory: async_sessionmaker[AsyncSession], session_id: UUID
) -> ReportData:
    async with SqliteUnitOfWork(factory) as uow:
        session = await uow.sessions.get(session_id)
        if session is None:
            raise LookupError(f"session not found: {session_id}")
        project = await uow.projects.get(session.project_id)
        transactions = tuple(await uow.transactions.list_for_session(session_id))
        findings = tuple(await uow.findings.list_for_session(session_id))
        return ReportData(project, session, transactions, findings)
