from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID, uuid4

from playwright.async_api import BrowserContext, Request, Response

from websec_observer.common.redaction import SensitiveDataRedactor
from websec_observer.common.scope import CanonicalScopePolicy, canonicalize_url
from websec_observer.domain.enums import ScopeDisposition
from websec_observer.domain.models import CapturedRequest, CapturedResponse, CapturedTransaction

logger = logging.getLogger(__name__)
_TEXT_TYPES = (
    "application/json",
    "application/graphql",
    "application/javascript",
    "application/x-www-form-urlencoded",
    "application/xml",
    "text/",
)


@dataclass(frozen=True, slots=True)
class CaptureLimits:
    max_request_body_bytes: int = 1_048_576
    max_response_body_bytes: int = 2_097_152

    def __post_init__(self) -> None:
        if self.max_request_body_bytes < 0 or self.max_response_body_bytes < 0:
            raise ValueError("body limits cannot be negative")


@dataclass(slots=True)
class _PendingRequest:
    id: UUID
    browser_id: str
    started_monotonic: float
    timestamp: datetime
    redirect_from_id: UUID | None


class NetworkListener:
    """Converts Playwright events into scoped, redacted transaction DTOs."""

    def __init__(
        self,
        session_id: UUID,
        scope_policy: CanonicalScopePolicy,
        redactor: SensitiveDataRedactor,
        submit: Any,
        *,
        limits: CaptureLimits | None = None,
        capture_resource_types: frozenset[str] | None = None,
        action_lookup: Any = None,
    ) -> None:
        self._session_id = session_id
        self._scope = scope_policy
        self._redactor = redactor
        self._submit = submit
        self._limits = limits or CaptureLimits()
        self._resource_types = capture_resource_types or frozenset({"document", "fetch", "xhr"})
        self._action_lookup = action_lookup
        self._pending: dict[int, _PendingRequest] = {}
        self._request_ids: dict[int, UUID] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._closed = False

    def attach(self, context: BrowserContext) -> None:
        context.on("request", self._on_request)
        context.on("requestfinished", self._on_request_finished)
        context.on("requestfailed", self._on_request_failed)

    async def drain(self) -> None:
        self._closed = True
        if self._tasks:
            tasks = tuple(self._tasks)
            try:
                await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=False), timeout=15)
            except TimeoutError:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    def _schedule(self, coroutine: Any) -> None:
        if self._closed:
            coroutine.close()
            return
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)

    def _task_done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error("capture event failed", extra={"event": "capture_event_failed"})

    def _on_request(self, request: Request) -> None:
        if request.resource_type not in self._resource_types:
            return
        redirected = request.redirected_from
        redirect_id = self._request_ids.get(id(redirected)) if redirected else None
        request_id = uuid4()
        self._request_ids[id(request)] = request_id
        self._pending[id(request)] = _PendingRequest(
            id=request_id,
            browser_id=str(uuid4()),
            started_monotonic=time.monotonic(),
            timestamp=datetime.now(UTC),
            redirect_from_id=redirect_id,
        )

    def _on_request_finished(self, request: Request) -> None:
        if id(request) in self._pending:
            self._schedule(self._finalize(request, failed=False))

    def _on_request_failed(self, request: Request) -> None:
        if id(request) in self._pending:
            self._schedule(self._finalize(request, failed=True))

    async def _finalize(self, request: Request, *, failed: bool) -> None:
        pending = self._pending.pop(id(request), None)
        if pending is None:
            return
        disposition = self._scope.evaluate_url(request.url)
        if disposition is ScopeDisposition.DENY:
            return
        canonical = canonicalize_url(request.url)
        full_capture = disposition is ScopeDisposition.ALLOW_FULL
        raw_headers = await request.all_headers() if full_capture else {}
        safe_headers = self._redactor.redact(raw_headers)
        content_type = str(raw_headers.get("content-type", "")).lower()
        request_body, request_truncated = self._safe_body(
            request.post_data.encode("utf-8") if full_capture and request.post_data else None,
            content_type,
            self._limits.max_request_body_bytes,
        )
        safe_url = self._redactor.redact_url(canonical.value) if full_capture else (
            f"{canonical.scheme}://{canonical.host}/"
        )
        safe_parts = urlsplit(safe_url)
        captured_request = CapturedRequest(
            id=pending.id,
            session_id=self._session_id,
            browser_request_id=pending.browser_id,
            timestamp=pending.timestamp,
            resource_type=request.resource_type,
            method=request.method,
            url=safe_url,
            scheme=canonical.scheme,
            host=canonical.host,
            port=canonical.port,
            path=safe_parts.path if full_capture else "/",
            query=(
                dict(parse_qsl(safe_parts.query, keep_blank_values=True))
                if full_capture
                else {}
            ),
            headers=safe_headers if isinstance(safe_headers, dict) else {},
            cookies=self._request_cookie_metadata(raw_headers),
            body=request_body,
            body_encoding="utf-8" if request_body is not None else None,
            initiator={},
            redirect_from_id=pending.redirect_from_id,
            size=len(request_body) if request_body is not None else None,
            scope_disposition=disposition,
            truncated=request_truncated,
            body_sha256=hashlib.sha256(request_body).hexdigest() if request_body else None,
            action_id=self._action_lookup(pending.timestamp) if self._action_lookup else None,
        )
        captured_response = None
        response = await request.response()
        if not failed and response is not None and full_capture:
            captured_response = await self._capture_response(response, pending, captured_request.id)
        await self._submit(CapturedTransaction(captured_request, captured_response))

    async def _capture_response(
        self, response: Response, pending: _PendingRequest, request_id: UUID
    ) -> CapturedResponse:
        headers = await response.all_headers()
        header_array = await response.headers_array()
        content_type = str(headers.get("content-type", "")).lower()
        raw_body: bytes | None
        decode_error: str | None = None
        try:
            raw_body = await response.body()
        except Exception as exc:
            raw_body = None
            decode_error = type(exc).__name__
        body, truncated = self._safe_body(
            raw_body, content_type, self._limits.max_response_body_bytes
        )
        safe_headers = self._redactor.redact(headers)
        server = await response.server_addr()
        return CapturedResponse(
            request_id=request_id,
            timestamp=datetime.now(UTC),
            status=response.status,
            status_text=response.status_text,
            headers=safe_headers if isinstance(safe_headers, dict) else {},
            cookies=self._response_cookie_metadata(header_array),
            content_type=content_type or None,
            body=body,
            body_encoding="utf-8" if body is not None and self._is_text(content_type) else "binary",
            size=len(body) if body is not None else None,
            duration_ms=(time.monotonic() - pending.started_monotonic) * 1000,
            remote_ip=server.get("ipAddress") if server else None,
            protocol=None,
            from_cache=False,
            truncated=truncated,
            decode_error=decode_error,
        )

    def _safe_body(
        self, body: bytes | None, content_type: str, limit: int
    ) -> tuple[bytes | None, bool]:
        if body is None or limit == 0:
            return None, body is not None
        truncated = len(body) > limit
        bounded = body[:limit]
        if not self._is_text(content_type):
            return None, truncated or bool(body)
        try:
            text = bounded.decode("utf-8")
        except UnicodeDecodeError:
            return None, truncated
        safe = self._redactor.redact(text)
        encoded = str(safe).encode("utf-8")
        if len(encoded) > limit:
            encoded = encoded[:limit].decode("utf-8", errors="ignore").encode("utf-8")
            truncated = True
        return encoded, truncated

    @staticmethod
    def _is_text(content_type: str) -> bool:
        return any(item in content_type for item in _TEXT_TYPES)

    @staticmethod
    def _request_cookie_metadata(headers: dict[str, str]) -> dict[str, dict[str, bool]]:
        raw = headers.get("cookie", "")
        return {
            part.split("=", 1)[0].strip(): {"present": True}
            for part in raw.split(";")
            if "=" in part and part.split("=", 1)[0].strip()
        }

    @staticmethod
    def _response_cookie_metadata(
        headers: list[dict[str, str]],
    ) -> dict[str, dict[str, bool | str]]:
        cookies: dict[str, dict[str, bool | str]] = {}
        for header in headers:
            if header.get("name", "").lower() != "set-cookie":
                continue
            parts = [part.strip() for part in header.get("value", "").split(";")]
            if not parts or "=" not in parts[0]:
                continue
            name = parts[0].split("=", 1)[0].strip()
            if not name:
                continue
            attrs: dict[str, bool | str] = {}
            for part in parts[1:]:
                key, separator, value = part.partition("=")
                normalized = key.strip().lower()
                if normalized in {"secure", "httponly"}:
                    attrs[normalized] = True
                elif separator and normalized in {"samesite", "domain", "path", "max-age"}:
                    attrs[normalized] = value.strip()
            cookies[name] = attrs
        return cookies
