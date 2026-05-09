from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _now() -> datetime:
    return datetime.now(tz=UTC)


class ControllerSession(Base):
    """Cross-device controller pairing handshake.

    Lifecycle:
      1. /play (the "host") calls POST /api/controller/start. A row is
         created with (token, code, host_user_id) — host_user_id is set
         immediately because the host is already authenticated. The host
         then opens the WebSocket /api/controller/host?token=<token>.
      2. The user opens /pair?code=<code> on their phone (already signed
         in as the same user). The phone connects to
         /api/controller/pad?code=<code>.
      3. Once both sides are connected the room is "live" — pad messages
         are forwarded to the host which calls EJS simulateInput().

    The row is short-lived: it exists only to bootstrap the pairing.
    Once the host's WS closes the row is deleted and any pad WSs are
    kicked. There is deliberately no "approve" step (unlike QR login):
    cookie auth proves both endpoints belong to the same user, which is
    the only authorization the input channel needs.
    """

    __tablename__ = "controller_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Opaque host-only secret. The host receives it from /start and uses
    # it to authenticate the WS upgrade. Never shown to the user. The
    # cookie still has to match host_user_id — the token alone doesn't
    # grant anything.
    token: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    # Short human-readable code shown in the UI / encoded in the QR.
    # Lookup-only; cannot be used to drive the host WS.
    code: Mapped[str] = mapped_column(String(8), unique=True, nullable=False, index=True)
    host_user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
