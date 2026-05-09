from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _now() -> datetime:
    return datetime.now(tz=UTC)


class Collection(Base):
    __tablename__ = "collections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class CollectionGame(Base):
    __tablename__ = "collection_games"
    __table_args__ = (
        UniqueConstraint("collection_id", "game_id", name="uq_collection_game"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    collection_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("collections.id", ondelete="CASCADE"), nullable=False, index=True
    )
    game_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
