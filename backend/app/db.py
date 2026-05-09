from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


_engine = create_engine(
    settings.db_url,
    echo=False,
    future=True,
    connect_args={"check_same_thread": False},
)


@event.listens_for(_engine, "connect")
def _enable_sqlite_fk(dbapi_connection, _record):  # noqa: ANN001
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()


SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False, future=True)


def init_db() -> None:
    """Materialize the schema. RetroX ships a single canonical v1 schema
    and deliberately does NOT use a migration framework: every model
    file under `models/` is the source of truth, and `create_all` is
    safe to run on every boot (it only creates missing tables).

    If you need to evolve the schema, write the new shape directly in
    the model and add the column with a sensible default — there is no
    migration history to keep in sync.
    """
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    # Importing here to ensure all models are registered on Base.metadata
    from .models import (  # noqa: F401
        collection,
        controller_session,
        emulator,
        favorite,
        game_meta,
        play_stat,
        preference,
        qr_session,
        slot,
        user,
        user_session,
    )

    # No Alembic by design — this is the trade-off: idempotent ALTERs for
    # columns added after v1 ship. Run inside the same begin() as create_all
    # so a fresh boot and an upgrade boot follow the same code path.
    with _engine.begin() as conn:
        Base.metadata.create_all(conn)
        _ensure_user_columns(conn)


def _ensure_user_columns(conn) -> None:  # noqa: ANN001
    cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)")).fetchall()}
    if "totp_last_step" not in cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN totp_last_step INTEGER"))
    if "pending_2fa_secret" not in cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN pending_2fa_secret TEXT"))
    if "pending_2fa_expires_at" not in cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN pending_2fa_expires_at DATETIME"))


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
