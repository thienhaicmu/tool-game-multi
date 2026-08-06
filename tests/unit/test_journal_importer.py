import json
from datetime import UTC, datetime
from uuid import uuid5

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from websec_observer.capture.journal_importer import _EVENT_NAMESPACE, import_journal
from websec_observer.domain.models import TestProject, TestSession
from websec_observer.storage.sqlite.orm import Base, NetworkRequestRow
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork
from websec_observer.storage.sqlite.database import create_session_factory


@pytest.mark.asyncio
async def test_import_journal_persists_request_and_response(tmp_path) -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = create_session_factory(engine)
    project = TestProject(name="Imported", base_url="https://app.local", allowed_hosts=("app.local",))
    session = TestSession(project_id=project.id)
    async with SqliteUnitOfWork(factory) as uow:
        await uow.projects.add(project)
        await uow.sessions.add(session)
        await uow.commit()
    event_id = "42:request"
    journal = tmp_path / "session.jsonl"
    journal.write_text("\n".join([
        json.dumps({"kind":"request","id":event_id,"url":"https://app.local/api?page=2","method":"GET","resourceType":"fetch","scope":"allow_full","timestamp":datetime.now(UTC).isoformat()}),
        json.dumps({"kind":"response","id":event_id,"status":200,"duration":12,"timestamp":datetime.now(UTC).isoformat()}),
    ]), encoding="utf-8")
    assert await import_journal(journal, session_id=session.id, factory=factory) == 1
    async with factory() as db:
        row = await db.get(NetworkRequestRow, str(uuid5(_EVENT_NAMESPACE, event_id)))
        assert row is not None
        assert row.host == "app.local"
    await engine.dispose()
