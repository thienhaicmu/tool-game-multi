from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit

from websec_observer.domain.enums import ScopeDisposition

_HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_SUPPORTED_SCHEMES = frozenset({"http", "https", "ws", "wss"})


class InvalidScopePattern(ValueError):
    """Raised when a host pattern is ambiguous or unsafe."""


def canonicalize_host(host: str) -> str:
    candidate = host.strip().rstrip(".")
    if not candidate or any(char in candidate for char in "/\\@?#"):
        raise InvalidScopePattern(f"invalid host: {host!r}")
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        try:
            ascii_host = candidate.encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise InvalidScopePattern(f"invalid IDNA host: {host!r}") from exc
        if len(ascii_host) > 253 or any(
            not _HOST_LABEL.fullmatch(label) for label in ascii_host.split(".")
        ):
            raise InvalidScopePattern(f"invalid DNS host: {host!r}")
        return ascii_host
    return ip.compressed.lower()


@dataclass(frozen=True, slots=True)
class HostPattern:
    host: str
    include_subdomains: bool = False

    @classmethod
    def parse(cls, value: str) -> HostPattern:
        raw = value.strip()
        wildcard = raw.startswith("*.")
        if "*" in raw[2:] or (not wildcard and "*" in raw):
            raise InvalidScopePattern(f"wildcard is only allowed as '*.' prefix: {value!r}")
        host = canonicalize_host(raw[2:] if wildcard else raw)
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            if wildcard:
                raise InvalidScopePattern("IP address patterns cannot use wildcards")
        return cls(host=host, include_subdomains=wildcard)

    def matches(self, host: str) -> bool:
        canonical = canonicalize_host(host)
        if self.include_subdomains:
            return canonical != self.host and canonical.endswith(f".{self.host}")
        return canonical == self.host


@dataclass(frozen=True, slots=True)
class CanonicalUrl:
    value: str
    scheme: str
    host: str
    port: int | None


def canonicalize_url(value: str) -> CanonicalUrl:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise InvalidScopePattern(f"malformed URL: {value!r}") from exc
    scheme = parsed.scheme.lower()
    if scheme not in _SUPPORTED_SCHEMES or not parsed.hostname:
        raise InvalidScopePattern(f"unsupported or relative URL: {value!r}")
    if parsed.username is not None or parsed.password is not None:
        raise InvalidScopePattern("URL user-info is forbidden")
    host = canonicalize_host(parsed.hostname)
    default_port = 80 if scheme in {"http", "ws"} else 443
    normalized_port = None if port in {None, default_port} else port
    display_host = f"[{host}]" if ":" in host else host
    netloc = display_host if normalized_port is None else f"{display_host}:{normalized_port}"
    normalized = SplitResult(scheme, netloc, parsed.path or "/", parsed.query, "")
    return CanonicalUrl(
        value=urlunsplit(normalized), scheme=scheme, host=host, port=normalized_port
    )


class CanonicalScopePolicy:
    """Pure host policy shared by capture, analysis, export, and validation boundaries."""

    def __init__(self, allowed_hosts: tuple[str, ...], denied_hosts: tuple[str, ...] = ()) -> None:
        if not allowed_hosts:
            raise InvalidScopePattern("allowed_hosts must not be empty")
        self._allowed = tuple(HostPattern.parse(item) for item in allowed_hosts)
        self._denied = tuple(HostPattern.parse(item) for item in denied_hosts)

    def evaluate_host(self, host: str) -> ScopeDisposition:
        try:
            if any(pattern.matches(host) for pattern in self._denied):
                return ScopeDisposition.DENY
            if any(pattern.matches(host) for pattern in self._allowed):
                return ScopeDisposition.ALLOW_FULL
        except InvalidScopePattern:
            return ScopeDisposition.DENY
        return ScopeDisposition.ALLOW_METADATA_ONLY

    def evaluate_url(self, url: str) -> ScopeDisposition:
        try:
            canonical = canonicalize_url(url)
        except InvalidScopePattern:
            return ScopeDisposition.DENY
        return self.evaluate_host(canonical.host)
