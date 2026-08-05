from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")
_STOP = object()


@dataclass(frozen=True, slots=True)
class BatchWriterStats:
    accepted: int
    persisted: int
    batches: int
    queue_high_water: int


class AsyncBatchWriter(Generic[T]):
    """Bounded single-consumer batcher; producers receive backpressure when full."""

    def __init__(
        self,
        persist: Callable[[Sequence[T]], Awaitable[None]],
        *,
        batch_size: int = 100,
        flush_interval: float = 0.25,
        queue_size: int = 2_000,
    ) -> None:
        if batch_size < 1 or flush_interval <= 0 or queue_size < batch_size:
            raise ValueError("invalid batching limits")
        self._persist = persist
        self._batch_size = batch_size
        self._flush_interval = flush_interval
        self._queue: asyncio.Queue[T | object] = asyncio.Queue(maxsize=queue_size)
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._accepted = self._persisted = self._batches = self._high_water = 0

    async def start(self) -> None:
        if self._task is not None:
            raise RuntimeError("batch writer already started")
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="sqlite-batch-writer")

    async def put(self, item: T) -> None:
        if self._task is None or self._task.done():
            raise RuntimeError("batch writer is not running")
        await self._queue.put(item)
        self._accepted += 1
        self._high_water = max(self._high_water, self._queue.qsize())

    async def stop(self) -> BatchWriterStats:
        if self._task is None:
            return self.stats
        self._stop.set()
        await self._queue.put(_STOP)
        await self._task
        self._task = None
        return self.stats

    @property
    def stats(self) -> BatchWriterStats:
        return BatchWriterStats(
            accepted=self._accepted,
            persisted=self._persisted,
            batches=self._batches,
            queue_high_water=self._high_water,
        )

    async def _run(self) -> None:
        batch: list[T] = []
        while not self._stop.is_set() or not self._queue.empty():
            try:
                item = await asyncio.wait_for(self._queue.get(), timeout=self._flush_interval)
            except TimeoutError:
                if batch:
                    await self._flush(batch)
                continue
            if item is _STOP:
                self._queue.task_done()
                continue
            batch.append(item)
            self._queue.task_done()
            if len(batch) >= self._batch_size:
                await self._flush(batch)
        if batch:
            await self._flush(batch)

    async def _flush(self, batch: list[T]) -> None:
        await self._persist(tuple(batch))
        self._persisted += len(batch)
        self._batches += 1
        batch.clear()
