from __future__ import annotations

from collections.abc import Iterator

from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import User, UserSession
from .security import decode_token_full


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def current_user(
    access_token: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the current user from the access cookie and enforce that
    the originating UserSession is still active.

    Validating the session row on every authenticated request is what
    makes "Revoke" in Profile > Security take effect immediately. The
    alternative — checking only the JWT signature and trusting the
    short access-token TTL as a "soft revocation window" — leaves a
    revoked browser able to use the app for up to that TTL, which is
    indistinguishable from "the button didn't work" from the user's
    perspective.

    The cost is one indexed lookup per authenticated request. The
    `UserSession.sid` column has a unique index; in WAL-mode SQLite
    that's sub-millisecond and dwarfed by any real request work.

    Tokens issued before session tracking shipped have no `sid` claim;
    we reject them so the user is forced through a fresh login that
    creates a proper session row.
    """
    if not access_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated.")
    payload = decode_token_full(access_token, expected_kind="access")
    if payload is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired.")
    sub = payload.get("sub")
    sid = payload.get("sid")
    try:
        user_id = int(sub) if sub is not None else None
    except (TypeError, ValueError):
        user_id = None
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired.")
    if not isinstance(sid, str):
        # Legacy cookie predating session tracking — force re-login so
        # the browser ends up with a sid-bearing token and a session row.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired.")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User no longer exists.")
    sess = db.query(UserSession).filter(UserSession.sid == sid).first()
    if sess is None or sess.user_id != user.id or sess.revoked_at is not None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session revoked.")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required.")
    return user
