from pathlib import Path
from typing import Any, Self
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from websec_observer.common.scope import HostPattern, InvalidScopePattern, canonicalize_url


class ActiveValidationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    enabled: bool = False
    authorized: bool = False
    max_requests_per_rule: int = Field(default=3, ge=1, le=10)
    delay_ms: int = Field(default=1000, ge=250, le=60_000)
    allowed_methods: tuple[str, ...] = ("GET", "OPTIONS", "HEAD")

    @field_validator("allowed_methods")
    @classmethod
    def safe_methods_only(cls, methods: tuple[str, ...]) -> tuple[str, ...]:
        normalized = tuple(dict.fromkeys(method.upper() for method in methods))
        unsafe = set(normalized) - {"GET", "HEAD", "OPTIONS"}
        if unsafe:
            raise ValueError(f"mutating or unsupported methods are forbidden: {sorted(unsafe)}")
        if not normalized:
            raise ValueError("at least one safe method is required")
        return normalized

    @model_validator(mode="after")
    def require_explicit_authorization(self) -> Self:
        if self.enabled and not self.authorized:
            raise ValueError("active validation requires authorized=true")
        return self


class ProjectConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str = Field(min_length=1, max_length=200)
    base_url: str
    allowed_hosts: tuple[str, ...] = Field(min_length=1)
    denied_hosts: tuple[str, ...] = ()
    passive_only: bool = True
    active_validation: ActiveValidationConfig = Field(default_factory=ActiveValidationConfig)

    @field_validator("base_url")
    @classmethod
    def valid_base_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        try:
            return canonicalize_url(value).value
        except InvalidScopePattern as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("allowed_hosts", "denied_hosts")
    @classmethod
    def normalize_hosts(cls, hosts: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                f"*.{pattern.host}" if pattern.include_subdomains else pattern.host
                for pattern in (HostPattern.parse(host) for host in hosts)
            )
        )

    @model_validator(mode="after")
    def enforce_mode_boundary(self) -> Self:
        if self.passive_only and self.active_validation.enabled:
            raise ValueError("active validation cannot be enabled while passive_only=true")
        return self


def load_project_config(path: Path) -> ProjectConfig:
    raw: Any = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("configuration root must be a mapping")
    return ProjectConfig.model_validate(raw)
