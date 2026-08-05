from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from websec_observer.storage.sqlite.repositories import (
    SqliteFindingRepository,
    SqliteProjectRepository,
    SqliteSessionRepository,
    SqliteTransactionRepository,
    SqliteWebSocketRepository,
)


class SqliteUnitOfWork:
    def __init__(self, factory: async_sessionmaker[AsyncSession]) -> None:
        self._factory = factory
        self._session: AsyncSession | None = None

    async def __aenter__(self) -> SqliteUnitOfWork:
        if self._session is not None:
            raise RuntimeError("unit of work cannot be re-entered")
        self._session = self._factory()
        self.projects = SqliteProjectRepository(self._session)
        self.sessions = SqliteSessionRepository(self._session)
        self.findings = SqliteFindingRepository(self._session)
        self.transactions = SqliteTransactionRepository(self._session)
        self.websockets = SqliteWebSocketRepository(self._session)
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self._session is None:
            return
        try:
            if exc_type is not None:
                await self._session.rollback()
        finally:
            await self._session.close()
            self._session = None

    async def commit(self) -> None:
        if self._session is None:
            raise RuntimeError("unit of work is not active")
        await self._session.commit()

    async def rollback(self) -> None:
        if self._session is None:
            raise RuntimeError("unit of work is not active")
        await self._session.rollback()
