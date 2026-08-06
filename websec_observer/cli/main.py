from __future__ import annotations

import asyncio
import json
from pathlib import Path
from uuid import UUID

import typer

from websec_observer.analysis.service import SessionAnalysisService
from websec_observer.capture.browser_controller import BrowserOptions
from websec_observer.capture.journal_importer import import_journal
from websec_observer.capture.session_service import CaptureSessionService
from websec_observer.config import ProjectConfig, load_project_config
from websec_observer.domain.models import TestProject, TestSession
from websec_observer.reporting.har import render_har
from websec_observer.reporting.loader import load_report_data
from websec_observer.reporting.serializers import render_html, render_json, render_markdown
from websec_observer.storage.sqlite.database import create_database_engine, create_session_factory
from websec_observer.storage.sqlite.orm import Base
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork

app = typer.Typer(help="Authorized-use passive Web Security Observatory")


def _factory(path: Path):
    engine = create_database_engine(f"sqlite+aiosqlite:///{path.resolve().as_posix()}")
    return engine, create_session_factory(engine)


@app.command()
def init(config_path: Path = typer.Argument(Path("config.yaml"))) -> None:
    """Create a safe passive-only project configuration template."""
    if config_path.exists():
        raise typer.BadParameter(f"refusing to overwrite existing file: {config_path}")
    config_path.write_text(
        "name: Authorized staging assessment\n"
        "base_url: https://staging.example.com/\n"
        "allowed_hosts:\n  - staging.example.com\n  - api-staging.example.com\n"
        "denied_hosts:\n  - payments.example-third-party.com\n"
        "passive_only: true\nactive_validation:\n  enabled: false\n  authorized: false\n",
        encoding="utf-8",
    )
    typer.echo(str(config_path.resolve()))


@app.command()
def run(
    config: Path = typer.Option(Path("config.yaml"), "--config"),
    url: str | None = typer.Option(None, "--url"),
    database: Path = typer.Option(Path("session.db"), "--output"),
    headed: bool = typer.Option(False, "--headed"),
) -> None:
    """Capture a scoped URL and persist a session database."""
    project_config = load_project_config(config)
    asyncio.run(_run(project_config, url or project_config.base_url, database, headed))


async def _run(project_config: ProjectConfig, url: str, database: Path, headed: bool) -> None:
    engine, factory = _factory(database)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    project = TestProject(
        name=project_config.name,
        base_url=project_config.base_url,
        allowed_hosts=project_config.allowed_hosts,
        denied_hosts=project_config.denied_hosts,
        passive_only=project_config.passive_only,
    )
    session = TestSession(project_id=project.id)
    async with SqliteUnitOfWork(factory) as uow:
        await uow.projects.add(project)
        await uow.sessions.add(session)
        await uow.commit()
    capture = CaptureSessionService(project, session, factory, BrowserOptions(headless=not headed))
    page = await capture.start()
    await page.goto(url)
    stats = await capture.stop()
    await engine.dispose()
    typer.echo(json.dumps({"session_id": str(session.id), "persisted": stats.persisted}))


@app.command()
def analyze(database: Path, session_id: UUID) -> None:
    """Run enabled passive rules for a persisted session."""
    asyncio.run(_analyze(database, session_id))


@app.command("import-journal")
def import_journal_command(journal: Path, database: Path, session_id: UUID) -> None:
    """Import a redacted Electron session journal into SQLite."""
    if not journal.is_file():
        raise typer.BadParameter(f"journal does not exist: {journal}")
    asyncio.run(_import_journal(journal, database, session_id))


async def _import_journal(journal: Path, database: Path, session_id: UUID) -> None:
    engine, factory = _factory(database)
    count = await import_journal(journal, session_id=session_id, factory=factory)
    await engine.dispose()
    typer.echo(json.dumps({"session_id": str(session_id), "imported": count}))


async def _analyze(database: Path, session_id: UUID) -> None:
    engine, factory = _factory(database)
    findings = await SessionAnalysisService(factory).analyze(session_id)
    await engine.dispose()
    typer.echo(json.dumps({"session_id": str(session_id), "findings": len(findings)}))


@app.command()
def report(
    database: Path,
    session_id: UUID,
    format: str = typer.Option("html", "--format"),
    output: Path | None = typer.Option(None, "--output"),
) -> None:
    """Generate HTML, JSON, or Markdown report."""
    asyncio.run(_report(database, session_id, format, output))


async def _report(database: Path, session_id: UUID, format: str, output: Path | None) -> None:
    engine, factory = _factory(database)
    data = await load_report_data(factory, session_id)
    await engine.dispose()
    renderers = {"html": render_html, "json": render_json, "markdown": render_markdown, "md": render_markdown}
    if format not in renderers:
        raise typer.BadParameter("format must be html, json, or markdown")
    content = renderers[format](data)
    if output:
        output.write_text(content, encoding="utf-8")
    else:
        typer.echo(content)


@app.command()
def export(database: Path, session_id: UUID, format: str = typer.Option("har", "--format")) -> None:
    """Export a redacted HAR artifact."""
    if format.lower() != "har":
        raise typer.BadParameter("only har export is supported")
    asyncio.run(_export(database, session_id))


async def _export(database: Path, session_id: UUID) -> None:
    engine, factory = _factory(database)
    data = await load_report_data(factory, session_id)
    await engine.dispose()
    typer.echo(render_har(data))


@app.command("rules")
def rules() -> None:
    """List built-in passive rule IDs."""
    from websec_observer.analysis.rule_engine import default_registry

    for rule in default_registry().list():
        typer.echo(f"{rule.rule_id}\t{rule.title}")


if __name__ == "__main__":
    app()
