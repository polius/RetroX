import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from .. import __version__
from ..config import settings
from ..deps import current_user, get_db
from ..limiter import limiter
from ..models import QrLoginSession, User, UserSession
from ..models.schemas import (
    LoginRequest,
    LoginResponse,
    MeResponse,
    QrApproveRequest,
    QrLookupResponse,
    QrPollResponse,
    QrStartResponse,
    RecoverPasswordRequest,
    RecoverPasswordResponse,
    TwoFactorLoginRequest,
)
from ..security import (
    decode_token,
    decode_token_full,
    hash_password,
    issue_access_token,
    issue_pre2fa_token,
    issue_refresh_token,
    verify_password,
    verify_totp,
)
from ..services import recovery as recovery_service

QR_TTL_SECONDS = 180  # how long a QR session is valid
QR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I, easy to read
# Width of the kiosk-side opaque QR token. The poll endpoint is unauth'd
# by design (the kiosk has no session yet), so we make brute-forcing the
# token space economically infeasible: 64 random bytes → 86-char URL-safe
# string, ~512 bits of entropy.
QR_TOKEN_BYTES = 64

# Cookie names. Both are HttpOnly. The access token is what every
# authenticated request carries; the refresh token is sent only to
# /api/auth/refresh (path-scoped) so it never appears on regular
# request headers, narrowing its exposure.
ACCESS_COOKIE = "access_token"
REFRESH_COOKIE = "refresh_token"
PRE2FA_COOKIE = "pre2fa"


# 6 chars over a 32-symbol alphabet (~30 bits) — short enough to type
# comfortably on a phone. Brute-force is bounded by the 30/min rate limit
# on /qr/{code} and the 180s TTL, not by code entropy alone.
QR_CODE_LENGTH = 6


def _generate_qr_code() -> str:
    return "".join(secrets.choice(QR_CODE_ALPHABET) for _ in range(QR_CODE_LENGTH))


def _aware(dt: datetime) -> datetime:
    """SQLite drops tzinfo on read even when declared with timezone=True; treat
    naive datetimes as UTC so comparisons against datetime.now(tz=UTC) work."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _is_https(request: Request) -> bool:
    """Trust X-Forwarded-Proto thanks to --proxy-headers in entrypoint.sh."""
    return request.url.scheme == "https"


def _set_cookie(
    request: Request,
    response: Response,
    name: str,
    value: str,
    max_age: int,
    path: str = "/",
) -> None:
    # Mark Secure only on HTTPS — HTTP-on-LAN deployments would otherwise lose
    # cookies entirely. Secure is dropped silently rather than configured away.
    response.set_cookie(
        key=name,
        value=value,
        max_age=max_age,
        httponly=True,
        secure=_is_https(request),
        samesite="lax",
        path=path,
    )


def _clear_cookie(request: Request, response: Response, name: str, path: str = "/") -> None:
    response.delete_cookie(
        key=name, path=path, httponly=True, samesite="lax", secure=_is_https(request),
    )


def _client_ip(request: Request) -> str | None:
    """Best-effort source IP. Honors X-Forwarded-For (uvicorn is run
    with --proxy-headers in entrypoint.sh, so the leftmost entry is the
    real client behind a reverse proxy). Truncated to fit our column."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        ip = fwd.split(",")[0].strip()
    elif request.client is not None:
        ip = request.client.host
    else:
        return None
    return (ip or None) and ip[:64]


def _create_user_session(user: User, request: Request, db: Session) -> UserSession:
    """Open a fresh session row for a successful login.

    Returns the persisted UserSession; caller embeds its `sid` in the
    JWT cookies via `_issue_session_cookies`.
    """
    sid = secrets.token_urlsafe(32)
    sess = UserSession(
        user_id=user.id,
        sid=sid,
        user_agent=(request.headers.get("user-agent") or "")[:255] or None,
        ip_address=_client_ip(request),
    )
    db.add(sess)
    db.commit()
    db.refresh(sess)
    return sess


def _issue_session_cookies(
    user: User, sid: str, request: Request, response: Response,
) -> None:
    """Set both the short-lived access cookie and the long-lived refresh
    cookie. Both carry the session id (`sid`) so endpoints that need to
    identify "this browser's session" can do so without an extra
    server-side roundtrip. Caller is responsible for committing
    user.last_login."""
    access, _ = issue_access_token(user.id, sid=sid)
    refresh, _ = issue_refresh_token(user.id, sid=sid)
    _set_cookie(
        request, response, ACCESS_COOKIE, access,
        max_age=settings.access_token_minutes * 60,
    )
    # Refresh cookie is path-scoped to /api/auth so it doesn't ride along
    # on every API request (smaller header, smaller blast radius).
    _set_cookie(
        request, response, REFRESH_COOKIE, refresh,
        max_age=settings.refresh_token_days * 86400,
        path="/api/auth",
    )


def _clear_session_cookies(request: Request, response: Response) -> None:
    _clear_cookie(request, response, ACCESS_COOKIE)
    _clear_cookie(request, response, REFRESH_COOKIE, path="/api/auth")
    _clear_cookie(request, response, PRE2FA_COOKIE)
    # Pre-refresh-token deployments stored a single long-lived cookie
    # called "token". Clear it on logout so upgraded users don't keep a
    # phantom cookie sitting in their browser forever (it's harmless —
    # nothing reads it now — but the hygiene matters).
    _clear_cookie(request, response, "token")


@router.post("/login", response_model=LoginResponse)
@limiter.limit("5/minute")
def login(
    request: Request,
    payload: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> LoginResponse:
    user = db.query(User).filter(User.username == payload.username).first()
    if user is None or not verify_password(payload.password, user.password):
        # Recovery fallback: if the user has a pending operator-issued
        # recovery password (see services/recovery.py), accept it once
        # and treat it as a full account reset. The recovery file is
        # deleted by consume_if_match so this is single-use.
        #
        # Recovery is destructive by design: a user who needs the
        # operator-issued password has, by definition, lost their
        # primary credentials. Forcing 2FA on top would re-lock anyone
        # whose authenticator went with the lost device, defeating the
        # whole point of a recovery flow. So we also:
        #   - clear every 2FA field (matches /profile/2fa/disable's
        #     full cleanup so a fresh re-enrolment isn't tripped up by
        #     a stale totp_last_step from the old secret),
        #   - revoke every active session, since the actor going
        #     through recovery has no trusted session to preserve and
        #     any pre-existing session may be on a device they no
        #     longer control.
        # The /login UI documents this destructive semantic on the
        # recovery-success page that shows the docker command.
        if user is None or not recovery_service.consume_if_match(
            payload.username, payload.password,
        ):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid credentials.")
        user.password = hash_password(payload.password)
        user.totp_secret = None
        user.pending_2fa_secret = None
        user.pending_2fa_expires_at = None
        user.totp_last_step = None
        db.query(UserSession).filter(
            UserSession.user_id == user.id, UserSession.revoked_at.is_(None),
        ).update({"revoked_at": datetime.now(tz=UTC)}, synchronize_session=False)
        db.commit()

    if user.totp_secret:
        token, _ = issue_pre2fa_token(user.id)
        _set_cookie(request, response, PRE2FA_COOKIE, token, max_age=settings.pre2fa_seconds)
        return LoginResponse(two_factor_required=True)

    return _finalize_login(user, request, response, db)


@router.post("/login/2fa", response_model=LoginResponse)
@limiter.limit("5/minute")
def login_2fa(
    request: Request,
    payload: TwoFactorLoginRequest,
    response: Response,
    pre2fa: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> LoginResponse:
    if not pre2fa:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No pending two-factor session.")
    user_id = decode_token(pre2fa, expected_kind="pre2fa")
    if user_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Two-factor session expired.")
    user = db.get(User, user_id)
    if user is None or not user.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Two-factor not set up.")
    if not verify_totp(user.totp_secret, payload.code, user, db):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid code.")

    _clear_cookie(request, response, PRE2FA_COOKIE)
    return _finalize_login(user, request, response, db)


@router.post("/recover", response_model=RecoverPasswordResponse)
@limiter.limit("3/hour")
def recover_password(
    request: Request,
    payload: RecoverPasswordRequest,
    db: Session = Depends(get_db),
) -> RecoverPasswordResponse:
    """Issue a single-use recovery password the operator can retrieve.

    Always returns the same payload regardless of whether the username
    exists, so the endpoint can't be used to enumerate accounts. When
    the username does match a user, a fresh random password is bcrypt-
    hashed and written to /data/recovery/<username>.json — the operator
    pulls it out of the container (eg `docker exec`) and hands it to
    the user. The next successful login that uses this password
    promotes it to the real password and deletes the file.
    """
    username = payload.username.strip().lower()
    if username:
        user = db.query(User).filter(User.username == username).first()
        if user is not None:
            recovery_service.generate_and_store(user.username)
    return RecoverPasswordResponse()


@router.post("/refresh", response_model=LoginResponse)
@limiter.limit("30/minute")
def refresh(
    request: Request,
    response: Response,
    refresh_token: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> LoginResponse:
    """Mint a fresh access token from a valid refresh cookie.

    Idempotent: callers can hit this on every 401 without bookkeeping.
    The refresh cookie is rotated too, so a stolen short-lived access
    token alone can't be silently kept alive forever — refresh requires
    the path-scoped HttpOnly refresh cookie which JS cannot read.

    Server-side revocation: the refresh cookie carries the session
    `sid`. We look up the row and reject if it has been revoked or
    deleted. This is what makes "Sign out from another device" work.
    """
    if not refresh_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated.")
    payload = decode_token_full(refresh_token, expected_kind="refresh")
    if payload is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh expired.")
    try:
        user_id = int(payload.get("sub", ""))
    except (TypeError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh expired.") from None
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User no longer exists.")
    sid = payload.get("sid")
    sess: UserSession | None = None
    if isinstance(sid, str):
        sess = db.query(UserSession).filter(UserSession.sid == sid).first()
    if sess is None or sess.user_id != user.id or sess.revoked_at is not None:
        # Either an old cookie predating session tracking, a forged
        # sid, or a revoked session. Treat them all the same.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session revoked.")
    sess.last_seen_at = datetime.now(tz=UTC)
    db.commit()
    _issue_session_cookies(user, sess.sid, request, response)
    return LoginResponse(username=user.username, is_admin=user.is_admin)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def logout(
    request: Request,
    refresh_token: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> Response:
    """Revoke this browser's session row (if any) and clear cookies.

    Best-effort: if the refresh cookie is missing or malformed we
    still clear cookies on the response — logging out should always
    appear to succeed from the user's perspective.
    """
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    if refresh_token:
        payload = decode_token_full(refresh_token, expected_kind="refresh")
        sid = payload.get("sid") if payload else None
        if isinstance(sid, str):
            sess = db.query(UserSession).filter(UserSession.sid == sid).first()
            if sess is not None and sess.revoked_at is None:
                sess.revoked_at = datetime.now(tz=UTC)
                db.commit()
    _clear_session_cookies(request, response)
    return response


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(current_user)) -> MeResponse:
    return MeResponse(
        username=user.username,
        is_admin=user.is_admin,
        two_factor_enabled=bool(user.totp_secret),
        version=__version__,
    )


def _finalize_login(
    user: User, request: Request, response: Response, db: Session,
) -> LoginResponse:
    user.last_login = datetime.now(tz=UTC)
    db.commit()
    sess = _create_user_session(user, request, db)
    _issue_session_cookies(user, sess.sid, request, response)
    return LoginResponse(username=user.username, is_admin=user.is_admin)


# ---------- QR cross-device login ----------
#
# Flow:
#   1. The "kiosk" (TV browser) calls POST /api/auth/qr/start. It receives a
#      one-time token + 6-character human code, and the URL the phone should
#      open. The kiosk renders that URL as a QR.
#   2. The user, already authenticated on their phone, opens the URL. The
#      phone hits GET /api/auth/qr/{code} to display "Sign in TV?" with the
#      requesting user-agent. They confirm via POST /api/auth/qr/approve.
#   3. The kiosk has been polling GET /api/auth/qr/poll?token=... — once the
#      session is approved, this endpoint sets the session cookie for the
#      kiosk and deletes the QR row.

def _purge_expired_qr(db: Session) -> None:
    # Pass a naive UTC value: SQLite stores datetimes naive regardless of tz=True,
    # and SQLAlchemy bind-params would otherwise complain about the mismatch.
    db.query(QrLoginSession).filter(
        QrLoginSession.expires_at < datetime.now(tz=UTC).replace(tzinfo=None),
    ).delete()
    db.commit()


@router.post("/qr/start", response_model=QrStartResponse)
@limiter.limit("10/minute")
def qr_start(
    request: Request,
    db: Session = Depends(get_db),
) -> QrStartResponse:
    _purge_expired_qr(db)
    token = secrets.token_urlsafe(QR_TOKEN_BYTES)
    code = _generate_qr_code()
    # Avoid the (extremely unlikely) collision on the human code.
    while db.query(QrLoginSession).filter(QrLoginSession.code == code).first() is not None:
        code = _generate_qr_code()
    now = datetime.now(tz=UTC)
    session = QrLoginSession(
        token=token,
        code=code,
        status="pending",
        user_id=None,
        created_at=now,
        expires_at=now + timedelta(seconds=QR_TTL_SECONDS),
        user_agent=(request.headers.get("user-agent") or "")[:255] or None,
    )
    db.add(session)
    db.commit()
    return QrStartResponse(
        token=token,
        code=code,
        expires_in=QR_TTL_SECONDS,
        approve_url=f"/link?code={code}",
    )


@router.get("/qr/poll", response_model=QrPollResponse)
@limiter.limit("60/minute")
def qr_poll(
    request: Request,
    token: str,
    response: Response,
    db: Session = Depends(get_db),
) -> QrPollResponse:
    session = db.query(QrLoginSession).filter(QrLoginSession.token == token).first()
    if session is None:
        return QrPollResponse(status="expired")
    if _aware(session.expires_at) < datetime.now(tz=UTC):
        db.delete(session)
        db.commit()
        return QrPollResponse(status="expired")
    if session.status == "approved" and session.user_id is not None:
        user = db.get(User, session.user_id)
        if user is None:
            db.delete(session)
            db.commit()
            return QrPollResponse(status="expired")
        user.last_login = datetime.now(tz=UTC)
        db.delete(session)
        db.commit()
        sess = _create_user_session(user, request, db)
        _issue_session_cookies(user, sess.sid, request, response)
        return QrPollResponse(status="approved")
    return QrPollResponse(status="pending")


@router.get("/qr/{code}", response_model=QrLookupResponse)
@limiter.limit("30/minute")
def qr_lookup(
    request: Request,
    code: str,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
) -> QrLookupResponse:
    code = code.upper()
    session = db.query(QrLoginSession).filter(QrLoginSession.code == code).first()
    if session is None or _aware(session.expires_at) < datetime.now(tz=UTC):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Code not found or expired.")
    if session.status != "pending":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This code has already been used.")
    return QrLookupResponse(
        code=session.code,
        user_agent=session.user_agent,
        created_at=session.created_at,
    )


@router.post("/qr/approve", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
@limiter.limit("10/minute")
def qr_approve(
    request: Request,
    payload: QrApproveRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    code = payload.code.strip().upper()
    session = db.query(QrLoginSession).filter(QrLoginSession.code == code).first()
    if session is None or _aware(session.expires_at) < datetime.now(tz=UTC):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Code not found or expired.")
    if session.status != "pending":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This code has already been used.")
    # Re-auth before granting a long-lived kiosk session — the access cookie
    # alone isn't enough, otherwise its theft escalates to a 30-day session.
    if not verify_password(payload.password, user.password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password is incorrect.")
    if user.totp_secret:
        if not payload.totp_code:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Two-factor code required.")
        if not verify_totp(user.totp_secret, payload.totp_code, user, db):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid two-factor code.")
    session.status = "approved"
    session.user_id = user.id
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
