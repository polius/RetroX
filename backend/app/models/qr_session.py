from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _now() -> datetime:
    return datetime.now(tz=UTC)


class QrLoginSession(Base):
    """Cross-device QR login handshake.

    Lifecycle:
      pending  -> created on the TV ("kiosk") browser, no user yet
      approved -> phone (already logged in) confirmed; user_id is set
      consumed -> kiosk polled and got a session; row should be deleted

    The kiosk polls /api/auth/qr/poll?token=<token>; once approved, the
    poll response sets the session cookie and the row is deleted.
    """

    __tablename__ = "qr_login_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # 64 bytes of entropy → ~86 URL-safe chars. The poll endpoint is
    # unauth'd by design so the token is the only secret; brute-forcing
    # at this width is economically infeasible.
    token: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(6), nullable=False)  # short human-readable code
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
