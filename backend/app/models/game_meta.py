from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _now() -> datetime:
    return datetime.now(tz=UTC)


class GameMeta(Base):
    __tablename__ = "game_meta"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    game_id: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    release_date: Mapped[str | None] = mapped_column(String(20), nullable=True)
    slug: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True, index=True)
    # Set the first time the scanner sees a game and never updated. File
    # mtime is unreliable as an "added to library" proxy because plain
    # `cp` and backup-restore both rewrite mtime; this field is stable.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
