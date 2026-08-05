from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.mark.asyncio
async def test_upgrade_and_downgrade_initial_migration() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    config = Config(str(Path("alembic.ini").resolve()))
    config.set_main_option("script_location", str(Path("migrations").resolve()))
    async with engine.begin() as connection:
        def upgrade(sync_connection: object) -> set[str]:
            config.attributes["connection"] = sync_connection
            command.upgrade(config, "head")
            return set(inspect(sync_connection).get_table_names())  # type: ignore[arg-type]

        tables = await connection.run_sync(upgrade)
        assert "alembic_version" in tables
        assert "network_requests" in tables

        def downgrade(sync_connection: object) -> set[str]:
            config.attributes["connection"] = sync_connection
            command.downgrade(config, "base")
            return set(inspect(sync_connection).get_table_names())  # type: ignore[arg-type]

        remaining = await connection.run_sync(downgrade)
        assert "network_requests" not in remaining
    await engine.dispose()
