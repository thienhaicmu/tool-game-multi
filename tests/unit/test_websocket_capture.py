from datetime import UTC, datetime
from uuid import uuid4

import pytest

from websec_observer.capture.websocket_listener import WebSocketListener
from websec_observer.common.redaction import SensitiveDataRedactor
from websec_observer.common.scope import CanonicalScopePolicy
from websec_observer.domain.models import WebSocketConnection, WebSocketFrame


@pytest.mark.asyncio
async def test_websocket_listener_redacts_and_bounds_frames_without_sending() -> None:
    connections: list[WebSocketConnection] = []
    frames: list[WebSocketFrame] = []

    async def save_connection(item: WebSocketConnection) -> None:
        connections.append(item)

    async def save_frames(items: tuple[WebSocketFrame, ...]) -> None:
        frames.extend(items)

    listener = WebSocketListener(
        uuid4(), CanonicalScopePolicy(("example.test",)), SensitiveDataRedactor(),
        save_connection, save_frames, max_frame_bytes=24,
    )

    class FakeSocket:
        url = "wss://example.test/socket"

    socket = FakeSocket()
    listener._connections[id(socket)] = uuid4()  # type: ignore[arg-type]
    listener._frame(socket, "received", '{"password":"raw-secret","ok":true}')  # type: ignore[arg-type]
    await listener.drain()
    assert len(frames) == 1
    assert frames[0].direction == "received"
    assert frames[0].payload is not None
    assert b"raw-secret" not in frames[0].payload
    assert frames[0].truncated is True


def test_out_of_scope_socket_is_not_classified_as_full_capture() -> None:
    policy = CanonicalScopePolicy(("example.test",))
    assert policy.evaluate_url("wss://third-party.test/socket").value == "allow_metadata_only"
