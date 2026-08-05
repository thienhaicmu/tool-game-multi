from __future__ import annotations

import json
from datetime import UTC, datetime

from websec_observer.reporting.models import ReportData


def render_har(data: ReportData) -> str:
    entries = []
    for item in data.transactions:
        request = item.request
        response = item.response
        entries.append(
            {
                "startedDateTime": request.timestamp.astimezone(UTC).isoformat(),
                "time": response.duration_ms if response and response.duration_ms else 0,
                "request": {
                    "method": request.method,
                    "url": request.url,
                    "httpVersion": response.protocol if response and response.protocol else "HTTP/1.1",
                    "headers": [{"name": str(k), "value": str(v)} for k, v in request.headers.items()],
                    "queryString": [{"name": str(k), "value": str(v)} for k, v in request.query.items()],
                    "postData": {"mimeType": request.body_encoding or "", "text": request.body.decode("utf-8", errors="replace")}
                    if request.body else None,
                },
                "response": {
                    "status": response.status if response else 0,
                    "statusText": response.status_text if response else "",
                    "httpVersion": response.protocol if response and response.protocol else "HTTP/1.1",
                    "headers": [{"name": str(k), "value": str(v)} for k, v in response.headers.items()] if response else [],
                    "content": {"size": response.size or 0, "mimeType": response.content_type or ""}
                    if response else {"size": 0, "mimeType": ""},
                },
                "cache": {}, "timings": {"wait": response.duration_ms if response else 0},
            }
        )
    return json.dumps(
        {"log": {"version": "1.2", "creator": {"name": "websec", "version": "0.1.0"}, "entries": entries}},
        indent=2,
        ensure_ascii=False,
    )
