from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid5

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from websec_observer.domain.enums import ScopeDisposition
from websec_observer.domain.models import CapturedRequest, CapturedResponse, CapturedTransaction
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork

_EVENT_NAMESPACE = UUID("5c1b5e26-2d74-4b17-9f24-5d7d84c33c84")


def _timestamp(value: str | None) -> datetime:
    return datetime.fromisoformat((value or datetime.now(UTC).isoformat()).replace("Z", "+00:00"))


async def import_journal(
    path: Path,
    *,
    session_id: UUID,
    factory: async_sessionmaker[AsyncSession],
) -> int:
    """Import normalized, already-redacted Electron events into SQLite."""
    requests: dict[str, CapturedRequest] = {}
    responses: dict[str, CapturedResponse] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        event = json.loads(raw)
        event_id = str(event.get("id", ""))
        if event.get("kind") == "request" and event_id:
            parts = urlsplit(str(event.get("url", "")))
            request_id = uuid5(_EVENT_NAMESPACE, event_id)
            requests[event_id] = CapturedRequest(
                id=request_id, session_id=session_id, browser_request_id=event_id,
                timestamp=_timestamp(event.get("timestamp")), resource_type=str(event.get("resourceType", "unknown")),
                method=str(event.get("method", "GET")), url=parts.geturl(), scheme=parts.scheme,
                host=parts.hostname or "", port=parts.port, path=parts.path or "/",
                query={key: values for key, values in parse_qs(parts.query, keep_blank_values=True).items()},
                headers=event.get("headers") or {}, cookies={}, body=None, body_encoding=None,
                initiator={}, redirect_from_id=None, size=None,
                scope_disposition=ScopeDisposition.ALLOW_FULL if event.get("scope") == "allow_full" else ScopeDisposition.ALLOW_METADATA_ONLY,
            )
        elif event.get("kind") == "response" and event_id and event_id in requests:
            responses[event_id] = CapturedResponse(
                request_id=requests[event_id].id, timestamp=_timestamp(event.get("timestamp")),
                status=int(event.get("status") or 0), status_text="", headers={}, cookies={},
                content_type=None, body=None, body_encoding=None, size=None,
                duration_ms=float(event["duration"]) if event.get("duration") is not None else None,
                remote_ip=None, protocol=None, from_cache=False,
            )
    transactions = tuple(CapturedTransaction(request=request, response=responses.get(key)) for key, request in requests.items())
    if transactions:
        async with SqliteUnitOfWork(factory) as uow:
            await uow.transactions.add_many(transactions)
            await uow.commit()
    return len(transactions)
