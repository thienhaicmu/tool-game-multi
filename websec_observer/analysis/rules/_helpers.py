from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import parse_qsl, urlsplit


def headers_lower(headers: Mapping[str, object]) -> dict[str, str]:
    return {str(key).lower(): str(value) for key, value in headers.items()}


def query_keys(url: str) -> set[str]:
    return {key.lower().replace("-", "_") for key, _ in parse_qsl(urlsplit(url).query)}


def is_document(transaction: object) -> bool:
    request = transaction.request  # type: ignore[attr-defined]
    response = transaction.response  # type: ignore[attr-defined]
    return request.resource_type == "document" or bool(
        response and response.content_type and "text/html" in response.content_type.lower()
    )
