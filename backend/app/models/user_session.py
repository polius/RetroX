from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _now() -> datetime:
    return datetime.now(tz=UTC)


class UserSession(Base):
    """One row per signed-in browser/device.

    Created at the end of a successful login (password+optional 2FA, or
    QR cross-device approval). The session's `sid` is embedded as a
    JWT claim in both the access and refresh cookies so the server can
    look up the row when needed.

    Lifecycle:
      - `last_seen_at` is bumped every time the refresh cookie is used
        to mint a new access token. Refresh fires on every 401, so
        `last_seen_at` tracks "active in the last access-token TTL".
      - `revoked_at` is set when the user signs out OR clicks "Revoke"
        in Profile > Security. Once non-null, **every subsequent
        request from that browser fails with 401**, including ones
        carrying a still-unexpired access token: `current_user` looks
        up this row by `sid` on every authenticated request and
        rejects when `revoked_at` is non-null. There is no "soft
        revocation window" — clicking Revoke means the next request
        from the victim's browser is rejected.
      - Rows are NOT auto-deleted on revoke — keeping them gives the
        Security page a brief audit trail (the revoked row drops off
        the active list but still exists for forensic purposes).

    Per-request validation cost: one indexed lookup on the unique
    `sid` column. In WAL-mode SQLite that's sub-millisecond, well
    below the cost of any real request work. Worth paying so the
    Revoke button has a literal meaning.
    """

    __tablename__ = "user_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Random 32-byte URL-safe identifier. Embedded in the JWT as `sid`
    # so the server can resolve the row. Distinct from the row's PK so
    # that PK leakage (eg in a join) doesn't reveal session identity.
    sid: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    # Truncated to fit reliably in indexes; UA strings can be enormous.
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Stored as a string so IPv4 and IPv6 share the same column.
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False,
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False,
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
