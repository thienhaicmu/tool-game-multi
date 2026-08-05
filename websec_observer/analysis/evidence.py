from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def bounded_evidence(**values: Any) -> Mapping[str, Any]:
    """Keep evidence structural and small; values are already redacted at capture."""
    result: dict[str, Any] = {}
    for key, value in values.items():
        if isinstance(value, str):
            result[key] = value[:2_000]
        elif isinstance(value, Mapping):
            result[key] = {
                str(item_key): str(item_value)[:500] for item_key, item_value in list(value.items())[:50]
            }
        elif isinstance(value, (list, tuple)):
            result[key] = [str(item)[:500] for item in list(value)[:50]]
        else:
            result[key] = value
    return result
