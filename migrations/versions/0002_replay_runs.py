"""Persist replay attempts and parameter overrides."""

from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # WU-01's bootstrap migration creates all ORM tables; keep this migration
    # safe for both fresh databases and databases bootstrapped by that path.
    if "replay_runs" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "replay_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("test_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("request_id", sa.String(36), sa.ForeignKey("network_requests.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("overrides", sa.JSON(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("response_status", sa.Integer()),
        sa.Column("response_preview", sa.Text()),
        sa.Column("error", sa.Text()),
    )
    op.create_index("ix_replay_runs_session_started", "replay_runs", ["session_id", "started_at"])


def downgrade() -> None:
    op.drop_index("ix_replay_runs_session_started", table_name="replay_runs")
    op.drop_table("replay_runs")
