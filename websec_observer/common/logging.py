import json
import logging
from datetime import UTC, datetime
from typing import Any

from websec_observer.common.redaction import SensitiveDataRedactor


class JsonFormatter(logging.Formatter):
    _safe_keys = frozenset({"session_id", "project_id", "event", "status", "count", "rule_id"})

    def __init__(self, redactor: SensitiveDataRedactor | None = None) -> None:
        super().__init__()
        self._redactor = redactor or SensitiveDataRedactor()

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": self._redactor.redact(record.getMessage()),
        }
        for key in self._safe_keys:
            if hasattr(record, key):
                payload[key] = self._redactor.redact(getattr(record, key))
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
