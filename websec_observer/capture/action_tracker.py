from __future__ import annotations

from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from playwright.async_api import Page

from websec_observer.common.redaction import SensitiveDataRedactor
from websec_observer.domain.models import UserAction


class ActionTracker:
    """Observes intent metadata without collecting input values or credentials."""

    def __init__(self, session_id: UUID, redactor: SensitiveDataRedactor | None = None) -> None:
        self._session_id = session_id
        self._redactor = redactor or SensitiveDataRedactor()
        self._actions: deque[UserAction] = deque(maxlen=10_000)

    @property
    def actions(self) -> tuple[UserAction, ...]:
        return tuple(self._actions)

    def nearest(self, timestamp: datetime, before: float = 2.0, after: float = 8.0) -> UUID | None:
        candidates = [
            action for action in self._actions
            if timestamp - timedelta(seconds=before) <= action.timestamp <= timestamp + timedelta(seconds=after)
        ]
        if not candidates:
            return None
        return min(candidates, key=lambda action: abs((action.timestamp - timestamp).total_seconds())).id

    def attach_page(self, page: Page) -> None:
        async def binding(_source: Any, payload: dict[str, Any]) -> None:
            self.record(
                str(payload.get("action_type", "button_action")),
                page.url,
                payload.get("selector"),
                payload.get("description"),
            )

        async def setup() -> None:
            try:
                await page.expose_binding("__websec_record_action", binding)
            except Exception:
                # A page can be attached twice during popup/redirect setup.
                # The binding is already installed in that case.
                return
            await page.add_init_script(
            """(() => {
              const send = (action_type, event) => {
                const target = event && event.target;
                const selector = target && target.tagName ? target.tagName.toLowerCase() : null;
                const description = target && target.getAttribute ? target.getAttribute('aria-label') || target.textContent?.slice(0, 120) : null;
                window.__websec_record_action({action_type, selector, description});
              };
              document.addEventListener('click', e => send('click', e), true);
              document.addEventListener('submit', e => send('form_submit', e), true);
              const originalPush = history.pushState;
              history.pushState = function(...args) { const result = originalPush.apply(this, args); window.__websec_record_action({action_type:'route_change', selector:null, description:location.href}); return result; };
              window.addEventListener('popstate', () => window.__websec_record_action({action_type:'route_change', selector:null, description:location.href}));
            })();"""
            )
        import asyncio
        asyncio.create_task(setup())
        page.on("framenavigated", lambda frame: self.record("page_navigation", frame.url, None, None) if frame == page.main_frame else None)

    def record(self, action_type: str, page_url: str, selector: object, description: object) -> UserAction:
        action = UserAction(
            id=uuid4(),
            session_id=self._session_id,
            action_type=action_type[:40],
            page_url=self._redactor.redact_url(page_url)[:4_000],
            selector=str(selector)[:500] if selector else None,
            description=str(description)[:500] if description else None,
            timestamp=datetime.now(UTC),
        )
        self._actions.append(action)
        return action
