from uuid import uuid4

from websec_observer.capture.network_listener import CaptureLimits, NetworkListener
from websec_observer.common.redaction import SensitiveDataRedactor
from websec_observer.common.scope import CanonicalScopePolicy


async def _unused_submit(value: object) -> None:
    raise AssertionError("not called")


def listener(limit: int = 32) -> NetworkListener:
    return NetworkListener(
        uuid4(),
        CanonicalScopePolicy(("example.test",)),
        SensitiveDataRedactor(),
        _unused_submit,
        limits=CaptureLimits(limit, limit),
    )


def test_binary_body_is_not_persisted_by_default() -> None:
    body, truncated = listener()._safe_body(b"\x00secret\xff", "application/octet-stream", 32)
    assert body is None
    assert truncated is True


def test_text_body_is_redacted_and_output_is_bounded() -> None:
    body, truncated = listener(20)._safe_body(
        b'{"password":"very-long-secret"}', "application/json", 20
    )
    assert body is not None
    assert len(body) <= 20
    assert b"very-long-secret" not in body
    assert truncated is True


def test_zero_body_limit_stores_no_body() -> None:
    body, truncated = listener()._safe_body(b"hello", "text/plain", 0)
    assert body is None
    assert truncated is True
