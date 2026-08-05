import asyncio

import pytest

from websec_observer.storage.sqlite.batching import AsyncBatchWriter


@pytest.mark.asyncio
async def test_batch_writer_flushes_by_size_and_on_stop() -> None:
    persisted: list[tuple[int, ...]] = []

    async def persist(items: tuple[int, ...]) -> None:
        persisted.append(items)

    writer = AsyncBatchWriter(persist, batch_size=3, flush_interval=10, queue_size=6)
    await writer.start()
    for item in range(5):
        await writer.put(item)
    stats = await writer.stop()
    assert [item for batch in persisted for item in batch] == list(range(5))
    assert [len(batch) for batch in persisted] == [3, 2]
    assert stats.accepted == stats.persisted == 5
    assert stats.batches == 2
    assert stats.queue_high_water <= 6


@pytest.mark.asyncio
async def test_batch_writer_applies_bounded_queue_backpressure() -> None:
    release = asyncio.Event()

    async def persist(items: tuple[int, ...]) -> None:
        await release.wait()

    writer = AsyncBatchWriter(persist, batch_size=1, flush_interval=10, queue_size=1)
    await writer.start()
    await writer.put(1)
    await asyncio.sleep(0)
    await writer.put(2)
    blocked = asyncio.create_task(writer.put(3))
    await asyncio.sleep(0.01)
    assert not blocked.done()
    release.set()
    await blocked
    stats = await writer.stop()
    assert stats.accepted == stats.persisted == 3


def test_invalid_batch_limits_are_rejected() -> None:
    async def persist(items: tuple[int, ...]) -> None:
        return None

    with pytest.raises(ValueError, match="invalid"):
        AsyncBatchWriter(persist, batch_size=10, queue_size=5)
