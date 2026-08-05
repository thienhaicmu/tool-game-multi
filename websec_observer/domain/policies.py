from typing import Protocol

from websec_observer.domain.enums import ScopeDisposition


class ScopePolicy(Protocol):
    def evaluate_url(self, url: str) -> ScopeDisposition: ...


class Redactor(Protocol):
    def redact(self, value: object) -> object: ...
