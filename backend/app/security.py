from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
import pyotp

from .config import settings

ALGO = "HS256"

# bcrypt's input is silently truncated past 72 bytes; reject explicitly.
_BCRYPT_MAX_BYTES = 72


def hash_password(password: str) -> str:
    if len(password.encode("utf-8")) > _BCRYPT_MAX_BYTES:
        raise ValueError("password too long")
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("ascii")


def verify_password(password: str, hashed: str) -> bool:
    if len(password.encode("utf-8")) > _BCRYPT_MAX_BYTES:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("ascii"))
    except (ValueError, TypeError):
        return False


def issue_access_token(user_id: int, sid: str | None = None) -> tuple[str, datetime]:
    """Short-lived bearer used by every authenticated request.

    `sid` is the UserSession identifier; included as a JWT claim so
    endpoints that care about the calling session (eg
    /api/profile/sessions, which needs to mark the current row) can
    resolve it without an extra cookie lookup. `current_user` itself
    deliberately ignores sid to keep auth a zero-DB-roundtrip path.
    """
    expires = datetime.now(tz=UTC) + timedelta(minutes=settings.access_token_minutes)
    payload: dict = {"sub": str(user_id), "kind": "access", "exp": int(expires.timestamp())}
    if sid is not None:
        payload["sid"] = sid
    token = jwt.encode(payload, settings.resolve_secret_key(), algorithm=ALGO)
    return token, expires


def issue_refresh_token(user_id: int, sid: str | None = None) -> tuple[str, datetime]:
    """Long-lived "you're still signed in" token. Used only by /refresh.

    `sid` ties this cookie to a UserSession row, which lets /refresh
    enforce server-side revocation: clearing `revoked_at` on the row
    invalidates every browser carrying this refresh cookie.
    """
    expires = datetime.now(tz=UTC) + timedelta(days=settings.refresh_token_days)
    payload: dict = {"sub": str(user_id), "kind": "refresh", "exp": int(expires.timestamp())}
    if sid is not None:
        payload["sid"] = sid
    token = jwt.encode(payload, settings.resolve_secret_key(), algorithm=ALGO)
    return token, expires


def issue_pre2fa_token(user_id: int) -> tuple[str, datetime]:
    expires = datetime.now(tz=UTC) + timedelta(seconds=settings.pre2fa_seconds)
    payload = {"sub": str(user_id), "kind": "pre2fa", "exp": int(expires.timestamp())}
    token = jwt.encode(payload, settings.resolve_secret_key(), algorithm=ALGO)
    return token, expires


def decode_token(token: str, expected_kind: str) -> int | None:
    """Return just the user_id (the legacy single-purpose helper).

    Kept as-is for the hot path: `current_user` validates the access
    cookie on every request and only needs the user_id. Endpoints that
    also want the `sid` claim should call `decode_token_full`.
    """
    payload = decode_token_full(token, expected_kind)
    if payload is None:
        return None
    sub = payload.get("sub")
    if sub is None:
        return None
    try:
        return int(sub)
    except (TypeError, ValueError):
        return None


def decode_token_full(token: str, expected_kind: str) -> dict | None:
    """Decode and return the full claims dict (or None on any failure).

    Use this when you need claims beyond the subject — currently `sid`
    for session bookkeeping. Returns the validated payload only if
    signature, expiry, and `kind` all match.
    """
    try:
        payload = jwt.decode(token, settings.resolve_secret_key(), algorithms=[ALGO])
    except jwt.PyJWTError:
        return None
    if payload.get("kind") != expected_kind:
        return None
    return payload


def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, username: str) -> str:
    return pyotp.totp.TOTP(secret).provisioning_uri(name=username, issuer_name="RetroX")


_TOTP_PERIOD = 30
_TOTP_WINDOW = 1


def verify_totp(secret: str, code: str, user, db) -> bool:  # noqa: ANN001
    """Verify a TOTP code, rejecting replays of an already-consumed step.

    Mirrors pyotp's `verify(..., valid_window=1)` matching (current step
    plus +/- one) but additionally records the matched step on the User
    row and refuses to accept a step less-than-or-equal to the last seen.
    Caller controls the transaction boundary (we only flush).
    """
    if not secret or not code or not code.isdigit():
        return False
    totp = pyotp.TOTP(secret)
    now = datetime.now(tz=UTC).timestamp()
    current_step = int(now // _TOTP_PERIOD)
    last_step = user.totp_last_step
    for offset in range(-_TOTP_WINDOW, _TOTP_WINDOW + 1):
        step = current_step + offset
        expected = totp.at(step * _TOTP_PERIOD)
        if secrets.compare_digest(expected, code):
            if last_step is not None and step <= last_step:
                return False
            user.totp_last_step = step
            db.flush()
            return True
    return False


def secure_token() -> str:
    return secrets.token_urlsafe(32)
