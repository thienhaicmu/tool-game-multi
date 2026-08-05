from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from websec_observer.domain.models import CapturedTransaction
from websec_observer.storage.sqlite.batching import AsyncBatchWriter, BatchWriterStats
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork


class TransactionIngestionService:
    """Persists already-scoped and already-redacted transactions in bounded batches."""

    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession],
        *,
        batch_size: int = 100,
        flush_interval: float = 0.25,
        queue_size: int = 2_000,
    ) -> None:
        self._factory = factory
        self._writer = AsyncBatchWriter(
            self._persist,
            batch_size=batch_size,
            flush_interval=flush_interval,
            queue_size=queue_size,
        )

    async def start(self) -> None:
        await self._writer.start()

    async def submit(self, transaction: CapturedTransaction) -> None:
        await self._writer.put(transaction)

    async def stop(self) -> BatchWriterStats:
        return await self._writer.stop()

    async def _persist(self, transactions: Sequence[CapturedTransaction]) -> None:
        async with SqliteUnitOfWork(self._factory) as uow:
            await uow.transactions.add_many(transactions)
            await uow.commit()
