import json
from urllib.parse import parse_qsl, urlsplit

import pytest

from websec_observer.common.redaction import (
    REDACTED,
    RedactionLimits,
    SensitiveDataRedactor,
)


def test_nested_sensitive_keys_are_redacted_without_mutating_input() -> None:
    source = {
        "Authorization": "Bearer top-secret",
        "profile": {"password": "hunter2", "display_name": "Ada"},
        "tokens": [{"access_token": "abc"}, {"refresh-token": "def"}],
    }
    safe = SensitiveDataRedactor().redact(source)
    assert safe == {
        "Authorization": REDACTED,
        "profile": {"password": REDACTED, "display_name": "Ada"},
        "tokens": [{"access_token": REDACTED}, {"refresh-token": REDACTED}],
    }
    assert source["Authorization"] == "Bearer top-secret"
    assert source["profile"]["password"] == "hunter2"  # type: ignore[index]


@pytest.mark.parametrize(
    "key",
    [
        "Proxy-Authorization",
        "Cookie",
        "Set-Cookie",
        "X-API-Key",
        "id_token",
        "client_secret",
        "card_number",
        "CVV",
        "otp",
        "session",
        "private_key",
    ],
)
def test_default_sensitive_field_catalog(key: str) -> None:
    assert SensitiveDataRedactor().redact({key: "secret"}) == {key: REDACTED}


def test_url_credentials_are_removed_and_sensitive_query_values_redacted() -> None:
    redactor = SensitiveDataRedactor()
    result = redactor.redact_url(
        "https://alice:password@example.test/callback?access_token=abc&state=visible#fragment"
    )
    assert result == "https://example.test/callback?access_token=%5BREDACTED%5D&state=visible"
    assert "alice" not in result
    assert "password" not in result
    assert "fragment" not in result


def test_duplicate_query_keys_are_preserved_and_redacted() -> None:
    result = SensitiveDataRedactor().redact_url(
        "https://example.test/?token_hint=ok&password=a&password=b"
    )
    assert result.count("password=") == 2
    assert "token_hint=ok" in result
    password_values = [
        value for key, value in parse_qsl(urlsplit(result).query) if key == "password"
    ]
    assert password_values == [REDACTED, REDACTED]


def test_json_string_is_structurally_redacted() -> None:
    result = SensitiveDataRedactor().redact('{"user":"ada","password":"secret"}')
    assert json.loads(result) == {"user": "ada", "password": REDACTED}


def test_bearer_jwt_and_private_key_text_are_redacted() -> None:
    value = (
        "Authorization: Bearer abc.def.ghi and "
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno "
        "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----"
    )
    result = SensitiveDataRedactor().redact(value)
    assert "SECRET" not in result
    assert "eyJhbGci" not in result
    assert result.count(REDACTED) >= 2


def test_binary_is_not_speculatively_decoded() -> None:
    value = b"password=secret\x00\xff"
    result = SensitiveDataRedactor().redact(value)
    assert result is value


def test_hmac_fingerprint_is_stable_but_does_not_contain_secret() -> None:
    redactor = SensitiveDataRedactor(fingerprint_key=b"runtime-only-key")
    first = redactor.fingerprint("same-token")
    assert first == redactor.fingerprint("same-token")
    assert first != redactor.fingerprint("other-token")
    assert "same-token" not in first


def test_fingerprint_requires_runtime_key() -> None:
    with pytest.raises(ValueError, match="not configured"):
        SensitiveDataRedactor().fingerprint("secret")


def test_whitelist_requires_debug_mode_and_cannot_allow_core_credentials() -> None:
    with pytest.raises(ValueError, match="debug mode"):
        SensitiveDataRedactor(whitelist_keys=("diagnostic_secret",))
    with pytest.raises(ValueError, match="cannot be whitelisted"):
        SensitiveDataRedactor(whitelist_keys=("password",), allow_debug_whitelist=True)


def test_non_core_local_debug_whitelist_is_narrow() -> None:
    redactor = SensitiveDataRedactor(
        additional_sensitive_keys=("diagnostic_secret",),
        whitelist_keys=("diagnostic_secret",),
        allow_debug_whitelist=True,
    )
    assert redactor.redact({"diagnostic_secret": "visible", "password": "hidden"}) == {
        "diagnostic_secret": "visible",
        "password": REDACTED,
    }


def test_depth_and_string_limits_fail_closed() -> None:
    redactor = SensitiveDataRedactor(limits=RedactionLimits(max_depth=1, max_string_length=4))
    result = redactor.redact({"outer": {"inner": {"password": "secret"}}, "text": "abcdef"})
    assert result["outer"]["inner"] == "[TRUNCATED:MAX_DEPTH]"  # type: ignore[index]
    assert result["text"] == "abcd[TRUNCATED]"  # type: ignore[index]
