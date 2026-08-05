import pytest

from websec_observer.common.scope import (
    CanonicalScopePolicy,
    HostPattern,
    InvalidScopePattern,
    canonicalize_host,
    canonicalize_url,
)
from websec_observer.domain.enums import ScopeDisposition


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("EXAMPLE.COM.", "example.com"),
        ("bücher.example", "xn--bcher-kva.example"),
        ("2001:0db8::1", "2001:db8::1"),
        ("127.0.0.1", "127.0.0.1"),
    ],
)
def test_canonicalize_host(raw: str, expected: str) -> None:
    assert canonicalize_host(raw) == expected


@pytest.mark.parametrize("raw", ["", "example.com/path", "user@example.com", "bad_host"])
def test_invalid_hosts_are_rejected(raw: str) -> None:
    with pytest.raises(InvalidScopePattern):
        canonicalize_host(raw)


def test_exact_host_does_not_include_subdomains() -> None:
    pattern = HostPattern.parse("example.com")
    assert pattern.matches("example.com")
    assert not pattern.matches("api.example.com")


def test_wildcard_only_includes_subdomains_not_apex_or_suffix_attack() -> None:
    pattern = HostPattern.parse("*.example.com")
    assert pattern.matches("api.example.com")
    assert pattern.matches("deep.api.example.com")
    assert not pattern.matches("example.com")
    assert not pattern.matches("evil-example.com")


@pytest.mark.parametrize("raw", ["*example.com", "api.*.example.com", "*.127.0.0.1"])
def test_ambiguous_wildcards_are_rejected(raw: str) -> None:
    with pytest.raises(InvalidScopePattern):
        HostPattern.parse(raw)


def test_denied_host_wins_over_allowed_wildcard() -> None:
    policy = CanonicalScopePolicy(("*.example.com",), ("admin.example.com",))
    assert policy.evaluate_url("https://api.example.com/v1") is ScopeDisposition.ALLOW_FULL
    assert policy.evaluate_url("https://admin.example.com/") is ScopeDisposition.DENY


def test_out_of_scope_is_metadata_only_and_malformed_is_denied() -> None:
    policy = CanonicalScopePolicy(("example.com",))
    assert (
        policy.evaluate_url("https://analytics.third-party.test/a")
        is ScopeDisposition.ALLOW_METADATA_ONLY
    )
    assert policy.evaluate_url("javascript:alert(1)") is ScopeDisposition.DENY
    assert policy.evaluate_url("https://user:pass@example.com/") is ScopeDisposition.DENY
    assert policy.evaluate_url("//example.com/relative") is ScopeDisposition.DENY


def test_url_canonicalization_removes_fragment_and_default_port() -> None:
    result = canonicalize_url("HTTPS://EXAMPLE.COM.:443/path?q=1#secret")
    assert result.value == "https://example.com/path?q=1"
    assert result.host == "example.com"
    assert result.port is None


def test_custom_port_is_preserved() -> None:
    assert canonicalize_url("https://example.com:8443").value == "https://example.com:8443/"
