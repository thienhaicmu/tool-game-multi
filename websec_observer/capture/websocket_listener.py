from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from playwright.async_api import Page, WebSocket

from websec_observer.common.redaction import SensitiveDataRedactor
from websec_observer.common.scope import CanonicalScopePolicy
from websec_observer.domain.enums import ScopeDisposition
from websec_observer.domain.models import WebSocketConnection, WebSocketFrame


class WebSocketListener:
    """Passive WebSocket observer; it never sends frames or modifies the socket."""

    def __init__(
        self,
        session_id: UUID,
        scope_policy: CanonicalScopePolicy,
        redactor: SensitiveDataRedactor,
        submit_connection: Any,
        submit_frames: Any,
        *,
        max_frame_bytes: int = 1_048_576,
    ) -> None:
        self._session_id = session_id
        self._scope = scope_policy
        self._redactor = redactor
        self._submit_connection = submit_connection
        self._submit_frames = submit_frames
        self._max_frame_bytes = max_frame_bytes
        self._tasks: set[asyncio.Task[None]] = set()
        self._connections: dict[int, UUID] = {}

    def attach_page(self, page: Page) -> None:
        page.on("websocket", self._on_websocket)

    async def drain(self) -> None:
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=False)

    def _schedule(self, coroutine: Any) -> None:
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _on_websocket(self, websocket: WebSocket) -> None:
        disposition = self._scope.evaluate_url(websocket.url)
        if disposition is ScopeDisposition.DENY:
            return
        connection_id = uuid4()
        self._connections[id(websocket)] = connection_id
        self._schedule(
            self._submit_connection(
                WebSocketConnection(
                    id=connection_id,
                    session_id=self._session_id,
                    url=websocket.url if disposition is ScopeDisposition.ALLOW_FULL else websocket.url.split("/", 3)[0] + "//" + websocket.url.split("/", 3)[2] + "/",
                    opened_at=datetime.now(UTC),
                    scope_disposition=disposition,
                )
            )
        )
        websocket.on("framesent", lambda payload: self._frame(websocket, "sent", payload))
        websocket.on("framereceived", lambda payload: self._frame(websocket, "received", payload))
        websocket.on("close", lambda: self._closed(websocket))

    def _frame(self, websocket: WebSocket, direction: str, payload: Any) -> None:
        connection_id = self._connections.get(id(websocket))
        if connection_id is None:
            return
        raw = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
        truncated = len(raw) > self._max_frame_bytes
        bounded = raw[: self._max_frame_bytes]
        if isinstance(payload, str):
            safe = self._redactor.redact(bounded.decode("utf-8", errors="replace")).encode("utf-8")
            bounded = safe[: self._max_frame_bytes]
            truncated = truncated or len(safe) > self._max_frame_bytes
        self._schedule(
            self._submit_frames(
                (
                    WebSocketFrame(
                        id=uuid4(),
                        connection_id=connection_id,
                        direction=direction,
                        timestamp=datetime.now(UTC),
                        opcode=1 if isinstance(payload, str) else 2,
                        payload=bounded,
                        payload_encoding="utf-8" if isinstance(payload, str) else "binary",
                        size=len(raw),
                        truncated=truncated,
                    ),
                )
            )
        )

    def _closed(self, websocket: WebSocket) -> None:
        self._connections.pop(id(websocket), None)
