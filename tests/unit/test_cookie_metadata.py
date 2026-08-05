from websec_observer.capture.network_listener import NetworkListener


def test_response_cookie_parser_discards_values_but_keeps_security_attributes() -> None:
    cookies = NetworkListener._response_cookie_metadata(
        [
            {
                "name": "Set-Cookie",
                "value": (
                    "session_id=raw-cookie-secret; Path=/; Secure; HttpOnly; SameSite=Lax; "
                    "Max-Age=3600"
                ),
            },
            {"name": "Content-Type", "value": "text/plain"},
        ]
    )
    serialized = repr(cookies)
    assert "raw-cookie-secret" not in serialized
    assert cookies == {
        "session_id": {
            "path": "/",
            "secure": True,
            "httponly": True,
            "samesite": "Lax",
            "max-age": "3600",
        }
    }


def test_request_cookie_parser_keeps_names_only() -> None:
    cookies = NetworkListener._request_cookie_metadata(
        {"cookie": "session_id=raw-secret; theme=dark"}
    )
    assert cookies == {"session_id": {"present": True}, "theme": {"present": True}}
    assert "raw-secret" not in repr(cookies)
