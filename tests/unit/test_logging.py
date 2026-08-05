import json
import logging

from websec_observer.common.logging import JsonFormatter


def test_structured_log_redacts_message_and_safe_context() -> None:
    record = logging.LogRecord(
        name="websec.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="request=%s",
        args=({"Authorization": "Bearer raw-secret", "password": "hunter2"},),
        exc_info=None,
    )
    record.event = {"access_token": "raw-token", "kind": "capture"}
    encoded = JsonFormatter().format(record)
    payload = json.loads(encoded)
    assert "raw-secret" not in encoded
    assert "hunter2" not in encoded
    assert "raw-token" not in encoded
    assert "[REDACTED]" in encoded
    assert payload["event"]["kind"] == "capture"
