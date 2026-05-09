import json
import re
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..deps import current_user, get_db
from ..limiter import limiter
from ..models import User, UserPreference, UserSession
from ..models.schemas import (
    ChangePasswordRequest,
    PreferencePayload,
    ProfileStatItem,
    RevokeOthersResponse,
    SessionItem,
    TwoFactorDisableRequest,
)
from ..security import (
    decode_token_full,
    hash_password,
    new_totp_secret,
    totp_uri,
    verify_password,
    verify_totp,
)
from ..services import recovery as recovery_service

# Pending TOTP enrollment lives on the User row for 5 minutes. Storing it
# server-side avoids leaking the secret in a JWT setup_token (signed but
# not encrypted — anyone capturing it could base64-decode the secret).
_PENDING_2FA_TTL_SECONDS = 5 * 60


class _TwoFactorSetupResponse(BaseModel):
    secret: str
    otpauth_uri: str


class _TwoFactorEnableRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=6)


def _aware(dt: datetime) -> datetime:
    """SQLite drops tzinfo on read; treat naive datetimes as UTC."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _revoke_other_sessions(db: Session, user_id: int, keep_sid: str | None) -> int:
    """Revoke every active session for `user_id` except the one with `keep_sid`.
    Returns the number of rows revoked. Caller is responsible for db.commit()
    when batching with other writes."""
    q = db.query(UserSession).filter(
        UserSession.user_id == user_id, UserSession.revoked_at.is_(None),
    )
    if keep_sid is not None:
        q = q.filter(UserSession.sid != keep_sid)
    rows = q.all()
    now = datetime.now(tz=UTC)
    for r in rows:
        r.revoked_at = now
    return len(rows)

router = APIRouter(prefix="/api/profile", tags=["profile"])


# Whitelist of preference keys we accept. Keeps the surface area small even
# though storage is opaque JSON.
_PREF_KEYS = {"theme", "tv_mode", "reduce_motion", "keyboard_bindings"}
_PREF_THEMES = {"coral", "phosphor", "sunset", "ocean", "monochrome"}

# Keyboard rebinding actions. Values are KeyboardEvent.code strings
# (e.g. "Space", "Backspace", "KeyZ") so rebinds are layout-independent.
# An action absent from the dict means "use the hardcoded default" —
# that's how the Reset button is implemented (sends an empty object,
# which clears any previously stored override).
#
# Two groups, intentionally living in the same dict so a single PUT
# round-trips both and the frontend can detect cross-group conflicts:
#   - RetroX shortcuts: intercepted around the emulator (save state, etc.).
#   - Game inputs: re-applied to EmulatorJS's defaultControllers at boot,
#     so the user's bindings are the source of truth across devices.
#     Player 1 only — multi-player rebinds aren't surfaced in the UI.
_KEYBOARD_ACTIONS = {
    # RetroX shortcuts
    "fast_forward", "rewind", "save_state", "load_state", "exit_game",
    # Game inputs (player 1)
    "game_up", "game_down", "game_left", "game_right",
    "game_a", "game_b", "game_x", "game_y",
    "game_l1", "game_r1",
    "game_start", "game_select",
}


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
@limiter.limit("5/minute")
def change_password(
    request: Request,
    payload: ChangePasswordRequest,
    access_token: str | None = Cookie(default=None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    if not verify_password(payload.current_password, user.password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect.")
    user.password = hash_password(payload.new_password)
    # Defence-in-depth: a successful password change invalidates every
    # other active session for this user. The calling browser is kept
    # signed in so the user doesn't get bounced to /login mid-flow.
    _revoke_other_sessions(db, user.id, _current_sid(access_token))
    recovery_service.clear(user.username)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/2fa/setup", response_model=_TwoFactorSetupResponse)
def setup_2fa(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> _TwoFactorSetupResponse:
    if user.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Two-factor is already enabled.")
    secret = new_totp_secret()
    user.pending_2fa_secret = secret
    user.pending_2fa_expires_at = datetime.now(tz=UTC) + timedelta(seconds=_PENDING_2FA_TTL_SECONDS)
    db.commit()
    return _TwoFactorSetupResponse(
        secret=secret,
        otpauth_uri=totp_uri(secret, user.username),
    )


@router.post("/2fa/enable", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
@limiter.limit("10/minute")
def enable_2fa(
    request: Request,
    payload: _TwoFactorEnableRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    if user.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Two-factor is already enabled.")
    pending = user.pending_2fa_secret
    expires = user.pending_2fa_expires_at
    if not pending or expires is None or _aware(expires) < datetime.now(tz=UTC):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "setup expired, please restart 2FA enrollment",
        )
    if not verify_totp(pending, payload.code, user, db):
        # Don't clear pending on failure — let the user retry within the window.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid code.")
    user.totp_secret = pending
    user.pending_2fa_secret = None
    user.pending_2fa_expires_at = None
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/2fa/disable", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
@limiter.limit("5/minute")
def disable_2fa(
    request: Request,
    payload: TwoFactorDisableRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    if not user.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Two-factor is not enabled.")
    if not verify_password(payload.password, user.password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password is incorrect.")
    if not verify_totp(user.totp_secret, payload.code, user, db):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid code.")
    user.totp_secret = None
    user.pending_2fa_secret = None
    user.pending_2fa_expires_at = None
    # Clear last_step too so re-enrollment with a fresh secret isn't tripped
    # up by a stale step counter from the previous secret.
    user.totp_last_step = None
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---- Preferences (theme accent, TV mode toggle, etc.) ----

def _load_prefs(db: Session, user_id: int) -> dict:
    row = db.query(UserPreference).filter(UserPreference.user_id == user_id).first()
    if row is None:
        return {}
    try:
        return json.loads(row.data) or {}
    except (ValueError, TypeError):
        return {}


def _save_prefs(db: Session, user_id: int, data: dict) -> None:
    row = db.query(UserPreference).filter(UserPreference.user_id == user_id).first()
    payload = json.dumps(data)
    if row is None:
        db.add(UserPreference(user_id=user_id, data=payload))
    else:
        row.data = payload
    db.commit()


def _sanitize_keyboard_bindings(value: object) -> dict | None:
    """Coerce a keyboard_bindings payload into a clean dict[str, str].

    Drops anything not in the action whitelist, anything whose value
    isn't a non-empty string, and trims length so the JSON column can't
    be abused as free-form storage. Returns None on a totally invalid
    payload so the caller can fall through to the existing value.
    """
    if not isinstance(value, dict):
        return None
    out: dict[str, str] = {}
    for action in _KEYBOARD_ACTIONS:
        if action not in value:
            continue
        v = value[action]
        if not isinstance(v, str):
            continue
        v = v.strip()
        # Single printable, "Space"/"Enter" etc., or "F1"-"F24". 32 chars
        # is well past anything legitimate; reject longer to keep the
        # JSON document small.
        if not v or len(v) > 32:
            continue
        out[action] = v
    return out


def _sanitize_prefs(data: dict) -> dict:
    out: dict = {}
    for key in _PREF_KEYS:
        if key not in data:
            continue
        value = data[key]
        if key == "theme":
            if isinstance(value, str) and value in _PREF_THEMES:
                out["theme"] = value
        elif key in ("tv_mode", "reduce_motion"):
            if isinstance(value, bool):
                out[key] = value
        elif key == "keyboard_bindings":
            cleaned = _sanitize_keyboard_bindings(value)
            if cleaned is not None:
                out["keyboard_bindings"] = cleaned
    return out


@router.get("/preferences")
def get_preferences(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    return _load_prefs(db, user.id)


@router.put("/preferences")
def put_preferences(
    payload: PreferencePayload,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    sanitized = _sanitize_prefs(payload.data or {})
    current = _load_prefs(db, user.id)
    current.update(sanitized)
    _save_prefs(db, user.id, current)
    return current


@router.get("/saves")
def get_my_saves(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Slots belonging to the current user. Slots whose game has been
    removed from the library are skipped — the UI links from each row
    to /game/<slug>, so listing dead games would just produce broken
    links. Matches the behaviour of /profile/stats."""
    from ..models import GameMeta, SaveSlot
    from ..services.library import library

    slots = db.query(SaveSlot).filter(SaveSlot.user_id == user.id).order_by(SaveSlot.game_id, SaveSlot.slot).all()
    index = library.index
    game_ids = list({s.game_id for s in slots})
    names: dict[str, str] = {}
    slug_map: dict[str, str] = {}
    for meta in db.query(GameMeta).filter(GameMeta.game_id.in_(game_ids)).all():
        if meta.display_name:
            names[meta.game_id] = meta.display_name
        if meta.slug:
            slug_map[meta.game_id] = meta.slug
    result = []
    for s in slots:
        game = index.games.get(s.game_id)
        if game is None:
            continue
        result.append({
            "id": s.id,
            "game_id": s.game_id,
            "slug": slug_map.get(s.game_id, s.game_id),
            "game_name": names.get(s.game_id, game.name),
            "system": game.system,
            "slot": s.slot,
            "name": s.name,
            "updated_at": s.updated_at.isoformat() if s.updated_at else None,
        })
    return result


# ---- Playtime stats ----

@router.get("/stats", response_model=list[ProfileStatItem])
def get_my_stats(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[ProfileStatItem]:
    """Per-game playtime totals for the current user, most-played first.

    Games that no longer exist in the library are skipped — keeping the
    list grounded in things the user can actually click through to.
    """
    from ..models import GameMeta, GamePlayStat
    from ..services.library import library

    rows = (
        db.query(GamePlayStat)
        .filter(GamePlayStat.user_id == user.id)
        .order_by(GamePlayStat.playtime_seconds.desc())
        .all()
    )
    if not rows:
        return []

    game_ids = [r.game_id for r in rows]
    names: dict[str, str] = {}
    slug_map: dict[str, str] = {}
    for meta in db.query(GameMeta).filter(GameMeta.game_id.in_(game_ids)).all():
        if meta.display_name:
            names[meta.game_id] = meta.display_name
        if meta.slug:
            slug_map[meta.game_id] = meta.slug

    out: list[ProfileStatItem] = []
    for r in rows:
        game = library.index.get(r.game_id)
        if game is None:
            continue
        out.append(ProfileStatItem(
            game_id=r.game_id,
            slug=slug_map.get(r.game_id, r.game_id),
            game_name=names.get(r.game_id, game.name),
            system=game.system,
            has_cover=game.cover_path is not None,
            playtime_seconds=r.playtime_seconds,
            last_played_at=r.last_played_at,
        ))
    return out


@router.delete("/stats/{game_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def clear_my_stat(
    game_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    from ..models import GamePlayStat

    db.query(GamePlayStat).filter(
        GamePlayStat.user_id == user.id,
        GamePlayStat.game_id == game_id,
    ).delete()
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---- Sessions (open browsers / devices) ----
#
# Backed by the UserSession row created at login. The refresh cookie
# carries the row's `sid` claim, which is how we know which row in the
# list is "this device" and how revocation actually invalidates a
# specific browser without affecting others.


# Lightweight UA → friendly label. Deliberately small and offline:
# the goal is "good-enough name for the user to recognize their own
# devices", not exhaustive UA classification. Order matters — the
# first match wins, so put more-specific tokens before the family
# they roll up to (eg "Edge" before "Chrome").
_BROWSERS = (
    ("Edg/", "Edge"),
    ("OPR/", "Opera"),
    ("Firefox/", "Firefox"),
    ("Chrome/", "Chrome"),
    ("Safari/", "Safari"),  # last: Chrome and Edge also report this token
)
_OSES = (
    (re.compile(r"iPhone"), "iPhone"),
    (re.compile(r"iPad"), "iPad"),
    (re.compile(r"Android"), "Android"),
    (re.compile(r"Windows NT"), "Windows"),
    (re.compile(r"Mac OS X|Macintosh"), "macOS"),
    (re.compile(r"X11.*Linux|CrOS"), "Linux"),
)


def _label_for_ua(ua: str | None) -> str:
    if not ua:
        return "Unknown device"
    browser = next((name for token, name in _BROWSERS if token in ua), None)
    os_name = next((name for pat, name in _OSES if pat.search(ua)), None)
    if browser and os_name:
        return f"{browser} on {os_name}"
    return browser or os_name or "Unknown device"


def _current_sid(access_token: str | None) -> str | None:
    """Resolve the calling browser's session id from its access cookie.

    We read from the access cookie (not the refresh cookie) because
    the refresh cookie is path-scoped to /api/auth and therefore is
    NOT sent on /api/profile/* requests. Both cookies carry the same
    `sid` claim, set at login and rotated on every /refresh.

    Returns None when the cookie is absent, malformed, or predates
    session tracking — the caller treats those as "no current session"
    rather than failing the request.
    """
    if not access_token:
        return None
    payload = decode_token_full(access_token, expected_kind="access")
    if payload is None:
        return None
    sid = payload.get("sid")
    return sid if isinstance(sid, str) else None


@router.get("/sessions", response_model=list[SessionItem])
def list_sessions(
    access_token: str | None = Cookie(default=None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[SessionItem]:
    """Active (non-revoked) sessions for the current user, newest first.

    The current browser's session is flagged with `is_current=True`
    so the UI can show a "This device" badge and warn before allowing
    self-revocation.
    """
    current_sid = _current_sid(access_token)
    rows = (
        db.query(UserSession)
        .filter(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
        .order_by(UserSession.last_seen_at.desc())
        .all()
    )
    return [
        SessionItem(
            id=r.id,
            label=_label_for_ua(r.user_agent),
            user_agent=r.user_agent,
            ip_address=r.ip_address,
            created_at=r.created_at,
            last_seen_at=r.last_seen_at,
            is_current=(r.sid == current_sid),
        )
        for r in rows
    ]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def revoke_session(
    session_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Revoke a single session by id. Idempotent: revoking a session
    that's already revoked still returns 204.

    Effective immediately on the next request from the affected
    browser — `current_user` validates the session row by `sid` on
    every authenticated request, so no further API call from the
    revoked browser will succeed.

    Revoking the *current* session is allowed; the calling browser
    will get 401 on its very next request and the SPA will bounce to
    login. We deliberately don't clear cookies in the response here
    because the UI layer warns the user before issuing this request
    and the 401-driven redirect is the correct UX exit.
    """
    sess = (
        db.query(UserSession)
        .filter(UserSession.id == session_id, UserSession.user_id == user.id)
        .first()
    )
    if sess is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found.")
    if sess.revoked_at is None:
        sess.revoked_at = datetime.now(tz=UTC)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sessions/revoke-others", response_model=RevokeOthersResponse)
def revoke_other_sessions(
    access_token: str | None = Cookie(default=None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> RevokeOthersResponse:
    """Revoke every session for the current user except this one.

    Useful as a panic button after a password change or suspected
    compromise. If the calling browser has no identifiable session
    (eg an old cookie predating session tracking), all sessions are
    revoked.
    """
    revoked = _revoke_other_sessions(db, user.id, _current_sid(access_token))
    if revoked:
        db.commit()
    return RevokeOthersResponse(revoked=revoked)
