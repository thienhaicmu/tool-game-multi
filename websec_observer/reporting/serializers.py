from __future__ import annotations

import html
import json
from collections import Counter
from datetime import UTC, datetime
from typing import Any

from websec_observer.reporting.models import ReportData


def report_dict(data: ReportData) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "generated_at": datetime.now(UTC).isoformat(),
        "scope": {
            "project": data.project.name if data.project else None,
            "base_url": data.project.base_url if data.project else None,
            "allowed_hosts": list(data.project.allowed_hosts) if data.project else [],
            "denied_hosts": list(data.project.denied_hosts) if data.project else [],
            "passive_only": data.project.passive_only if data.project else True,
        },
        "session": {
            "id": str(data.session.id),
            "status": data.session.status.value,
            "started_at": data.session.started_at.isoformat() if data.session.started_at else None,
            "ended_at": data.session.ended_at.isoformat() if data.session.ended_at else None,
            "browser_version": data.session.browser_version,
            "user_agent": data.session.user_agent,
        },
        "summary": {
            "request_count": len(data.transactions),
            "api_count": data.api_count,
            "finding_count": len(data.findings),
            "host_count": len(data.hosts),
            "hosts": list(data.hosts),
            "endpoints": list(data.endpoints),
            "status_counts": data.status_counts,
            "findings_by_severity": dict(Counter(item.severity.value for item in data.findings)),
            "findings_by_category": dict(Counter(item.category for item in data.findings)),
        },
        "requests": [_request_dict(item) for item in data.transactions],
        "findings": [_finding_dict(item) for item in data.findings],
        "limitations": [
            "Passive observation does not prove exploitability.",
            "Bodies are bounded and sensitive values are redacted before persistence.",
        ],
    }


def render_json(data: ReportData) -> str:
    return json.dumps(report_dict(data), indent=2, ensure_ascii=False, sort_keys=True)


def render_markdown(data: ReportData) -> str:
    summary = report_dict(data)["summary"]
    lines = [
        "# Web Security Observatory Report\n",
        "## Executive summary\n",
        f"- Requests: {summary['request_count']}",
        f"- API requests: {summary['api_count']}",
        f"- Findings: {summary['finding_count']}",
        f"- Hosts: {summary['host_count']}",
        "\n## Scope\n",
        f"- Base URL: {data.project.base_url if data.project else 'unknown'}",
        "\n## Findings\n",
    ]
    for finding in data.findings:
        lines.extend([
            f"### {finding.title}",
            f"- Severity: **{finding.severity.value}**",
            f"- Confidence: **{finding.confidence.value}**",
            f"- URL: `{finding.affected_url}`",
            f"- Evidence: `{json.dumps(dict(finding.evidence), ensure_ascii=False)}` [REDACTED]",
            f"- Remediation: {finding.remediation}",
            "",
        ])
    lines.append("## Limitations\n\nPassive findings require authorized manual confirmation.")
    return "\n".join(lines)


def render_html(data: ReportData) -> str:
    summary = report_dict(data)["summary"]
    findings = "".join(
            "<tr><td>{}</td><td>{}</td><td>{}</td><td><code>{}</code></td><td>{}</td><td><code>{}</code></td></tr>".format(
            html.escape(item.title), html.escape(item.severity.value),
            html.escape(item.confidence.value), html.escape(item.affected_url),
            html.escape(item.remediation), html.escape(json.dumps(dict(item.evidence)) + " [REDACTED]"),
        )
        for item in data.findings
    )
    rows = "".join(
        "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
            html.escape(item.request.method), html.escape(item.request.host),
            html.escape(item.request.path),
            html.escape(str(item.response.status) if item.response else "-"),
            html.escape(item.request.scope_disposition.value),
        )
        for item in data.transactions
    )
    base_url = html.escape(data.project.base_url if data.project else "unknown")
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline">
<title>Web Security Observatory Report</title>
<style>body{{font:16px system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ccc;padding:.4rem;text-align:left}}</style>
</head><body><h1>Web Security Observatory Report</h1>
<h2>Executive summary</h2><p>Requests: {summary['request_count']} · API: {summary['api_count']} · Findings: {summary['finding_count']} · Hosts: {summary['host_count']}</p>
<h2>Scope</h2><p>Base URL: <code>{base_url}</code></p>
<h2>Findings</h2><table><tr><th>Title</th><th>Severity</th><th>Confidence</th><th>URL</th><th>Remediation</th><th>Evidence</th></tr>{findings}</table>
<h2>Requests</h2><table><tr><th>Method</th><th>Host</th><th>Path</th><th>Status</th><th>Scope</th></tr>{rows}</table>
<p>Passive findings require authorized manual confirmation. Evidence and bodies are bounded and redacted.</p>
</body></html>'''


def _request_dict(item: Any) -> dict[str, Any]:
    request, response = item.request, item.response
    return {
        "id": str(request.id), "method": request.method, "url": request.url,
        "host": request.host, "path": request.path, "resource_type": request.resource_type,
        "scope_disposition": request.scope_disposition.value, "headers": dict(request.headers),
        "body": request.body.decode("utf-8", errors="replace") if request.body else None,
        "response": {"status": response.status, "headers": dict(response.headers),
                      "body": response.body.decode("utf-8", errors="replace") if response.body else None,
                      "duration_ms": response.duration_ms} if response else None,
    }


def _finding_dict(item: Any) -> dict[str, Any]:
    return {
        "id": str(item.id), "rule_id": item.rule_id, "title": item.title,
        "category": item.category, "severity": item.severity.value,
        "confidence": item.confidence.value, "affected_url": item.affected_url,
        "description": item.description, "evidence": dict(item.evidence),
        "remediation": item.remediation, "false_positive_notes": item.false_positive_notes,
        "status": item.status.value,
    }
