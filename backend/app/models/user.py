from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _now() -> datetime:
    return datetime.now(tz=UTC)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    password: Mapped[str] = mapped_column(String(255), nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    totp_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Last consumed TOTP step (unix_seconds // 30) — persisted so replay
    # protection survives across uvicorn workers and process restarts.
    totp_last_step: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Server-held pending 2FA secret during enrollment; cleared on enable.
    pending_2fa_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    pending_2fa_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
