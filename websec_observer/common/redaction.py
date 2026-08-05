from __future__ import annotations

import hashlib
import hmac
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

REDACTED = "[REDACTED]"

_DEFAULT_KEYS = frozenset(
    {
        "authorization",
        "proxyauthorization",
        "cookie",
        "setcookie",
        "xapikey",
        "accesstoken",
        "refreshtoken",
        "idtoken",
        "password",
        "passwd",
        "secret",
        "clientsecret",
        "cardnumber",
        "cvv",
        "otp",
        "session",
        "privatekey",
    }
)
_NEVER_WHITELIST = frozenset(
    {
        "authorization",
        "proxyauthorization",
        "cookie",
        "setcookie",
        "password",
        "passwd",
        "cardnumber",
        "cvv",
        "privatekey",
    }
)
_KEY_NORMALIZER = re.compile(r"[^a-z0-9]")
_BEARER = re.compile(r"(?i)\b(bearer|basic)\s+[a-z0-9._~+/=-]+")
_JWT = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])")
_PRIVATE_KEY = re.compile(
    r"-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----.*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----",
    re.DOTALL,
)
_SENSITIVE_ASSIGNMENT = re.compile(
    r"(?i)(['\"]?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|"
    r"x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|"
    r"client[-_]?secret|card[-_]?number|cvv|otp|session|private[-_]?key)['\"]?\s*[:=]\s*)"
    r"(?:['\"][^'\"]*['\"]|[^\s,;&}]+)"
)


def normalize_key(value: object) -> str:
    return _KEY_NORMALIZER.sub("", str(value).lower())


@dataclass(frozen=True, slots=True)
class RedactionLimits:
    max_depth: int = 12
    max_items: int = 10_000
    max_string_length: int = 1_000_000

    def __post_init__(self) -> None:
        if self.max_depth < 1 or self.max_items < 1 or self.max_string_length < 1:
            raise ValueError("redaction limits must be positive")


class SensitiveDataRedactor:
    """Returns redacted copies and never mutates caller-owned values."""

    def __init__(
        self,
        *,
        additional_sensitive_keys: Sequence[str] = (),
        whitelist_keys: Sequence[str] = (),
        allow_debug_whitelist: bool = False,
        fingerprint_key: bytes | None = None,
        limits: RedactionLimits | None = None,
    ) -> None:
        sensitive = _DEFAULT_KEYS | {normalize_key(key) for key in additional_sensitive_keys}
        requested = {normalize_key(key) for key in whitelist_keys}
        if requested and not allow_debug_whitelist:
            raise ValueError("whitelist_keys require explicit local debug mode")
        forbidden = requested & _NEVER_WHITELIST
        if forbidden:
            raise ValueError(f"core credential fields cannot be whitelisted: {sorted(forbidden)}")
        self._sensitive = sensitive - requested
        self._fingerprint_key = fingerprint_key
        self._limits = limits or RedactionLimits()
        self._items_seen = 0

    def redact(self, value: object) -> object:
        self._items_seen = 0
        return self._walk(value, depth=0)

    def fingerprint(self, secret: str | bytes) -> str:
        if self._fingerprint_key is None:
            raise ValueError("fingerprint_key is not configured")
        raw = secret.encode("utf-8") if isinstance(secret, str) else secret
        digest = hmac.new(self._fingerprint_key, raw, hashlib.sha256).hexdigest()[:16]
        return f"[REDACTED:sha256:{digest}]"

    def redact_url(self, value: str) -> str:
        try:
            parsed = urlsplit(value)
        except ValueError:
            return self._redact_text(value)
        if not parsed.scheme or not parsed.netloc:
            return self._redact_text(value)
        pairs = [
            (key, REDACTED if normalize_key(key) in self._sensitive else self._redact_text(item))
            for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        ]
        hostname = parsed.hostname or ""
        if parsed.username is not None or parsed.password is not None:
            host = f"[{hostname}]" if ":" in hostname else hostname
            netloc = host if parsed.port is None else f"{host}:{parsed.port}"
        else:
            netloc = parsed.netloc
        return urlunsplit((parsed.scheme, netloc, parsed.path, urlencode(pairs, doseq=True), ""))

    def _walk(self, value: object, depth: int) -> object:
        if depth > self._limits.max_depth:
            return "[TRUNCATED:MAX_DEPTH]"
        self._items_seen += 1
        if self._items_seen > self._limits.max_items:
            return "[TRUNCATED:MAX_ITEMS]"
        if isinstance(value, Mapping):
            return {
                key: REDACTED if normalize_key(key) in self._sensitive else self._walk(item, depth + 1)
                for key, item in value.items()
            }
        if isinstance(value, tuple):
            return tuple(self._walk(item, depth + 1) for item in value)
        if isinstance(value, list):
            return [self._walk(item, depth + 1) for item in value]
        if isinstance(value, str):
            return self._redact_string(value, depth)
        if isinstance(value, bytes):
            return value
        return value

    def _redact_string(self, value: str, depth: int) -> str:
        bounded = value[: self._limits.max_string_length]
        suffix = "[TRUNCATED]" if len(value) > len(bounded) else ""
        stripped = bounded.lstrip()
        if stripped.startswith(("{", "[")):
            try:
                decoded: Any = json.loads(bounded)
            except (json.JSONDecodeError, RecursionError):
                pass
            else:
                return json.dumps(self._walk(decoded, depth + 1), ensure_ascii=False) + suffix
        if "://" in bounded:
            redacted_url = self.redact_url(bounded)
            if redacted_url != bounded:
                return redacted_url + suffix
        return self._redact_text(bounded) + suffix

    def _redact_text(self, value: str) -> str:
        value = _SENSITIVE_ASSIGNMENT.sub(lambda match: f"{match.group(1)}{REDACTED}", value)
        value = _PRIVATE_KEY.sub(REDACTED, value)
        value = _BEARER.sub(REDACTED, value)
        return _JWT.sub(REDACTED, value)
