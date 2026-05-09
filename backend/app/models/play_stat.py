from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _now() -> datetime:
    return datetime.now(tz=UTC)


class GamePlayStat(Base):
    """Per-(user, game) playtime accumulator.

    Updated by the in-emulator heartbeat, so it reflects real time spent
    playing rather than save-state activity. There's intentionally no
    foreign key to a Game row — games are file-system indexed, not stored
    relationally — so `game_id` is just the library ID string.
    """

    __tablename__ = "game_play_stats"
    __table_args__ = (
        UniqueConstraint("user_id", "game_id", name="uq_play_stat_user_game"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    game_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    playtime_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_played_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )
