from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from playwright.async_api import (
    Browser,
    BrowserContext,
    Page,
    Playwright,
    ProxySettings,
    async_playwright,
)

from websec_observer.capture.network_listener import NetworkListener


@dataclass(frozen=True, slots=True)
class BrowserOptions:
    headless: bool = True
    persistent_profile: Path | None = None
    storage_state: Path | None = None
    proxy_server: str | None = None
    ignore_https_errors: bool = False


class BrowserController:
    """Owns Playwright resources and delegates observations to capture listeners."""

    def __init__(self, options: BrowserOptions, listener: NetworkListener, page_observers: tuple[object, ...] = ()) -> None:
        self._options = options
        self._listener = listener
        self._page_observers = page_observers
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None

    async def start(self) -> Page:
        if self._context is not None:
            raise RuntimeError("browser controller already started")
        self._playwright = await async_playwright().start()
        proxy: ProxySettings | None = (
            {"server": self._options.proxy_server} if self._options.proxy_server else None
        )
        try:
            if self._options.persistent_profile is not None:
                self._context = await self._playwright.chromium.launch_persistent_context(
                    str(self._options.persistent_profile.resolve()),
                    headless=self._options.headless,
                    proxy=proxy,
                    ignore_https_errors=self._options.ignore_https_errors,
                )
            else:
                self._browser = await self._playwright.chromium.launch(
                    headless=self._options.headless,
                    proxy=proxy,
                )
                self._context = await self._browser.new_context(
                    storage_state=(
                        str(self._options.storage_state.resolve())
                        if self._options.storage_state
                        else None
                    ),
                    ignore_https_errors=self._options.ignore_https_errors,
                )
            self._listener.attach(self._context)
            self._context.on("page", self._on_page)
            page = self._context.pages[0] if self._context.pages else await self._context.new_page()
            self._on_page(page)
            return page
        except BaseException:
            await self.stop()
            raise

    def _on_page(self, page: Page) -> None:
        for observer in self._page_observers:
            attach = getattr(observer, "attach_page", None)
            if attach is not None:
                attach(page)

    async def export_storage_state(self, path: Path) -> None:
        if self._context is None:
            raise RuntimeError("browser controller is not running")
        await self._context.storage_state(path=str(path.resolve()))

    async def stop(self) -> None:
        context, browser, playwright = self._context, self._browser, self._playwright
        self._context = self._browser = self._playwright = None
        if context is not None:
            await context.close()
        await self._listener.drain()
        if browser is not None:
            await browser.close()
        if playwright is not None:
            await playwright.stop()

    async def __aenter__(self) -> BrowserController:
        await self.start()
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        await self.stop()
