from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _now() -> datetime:
    return datetime.now(tz=UTC)


class SaveSlot(Base):
    __tablename__ = "save_slots"
    __table_args__ = (
        UniqueConstraint("user_id", "game_id", "slot", name="uq_save_slot"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    game_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    slot: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    # Monotonic per-slot counter used as the optimistic-concurrency token
    # for the auto-persistor. Wall-clock timestamps were susceptible to
    # device clock skew; an integer the server controls isn't.
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
