"""Phone-as-controller pairing & live input channel.

Architecture
------------
The /play page (the "host") and the user's phone (the "pad") both open
WebSockets to this router. A small in-memory `Room` ferries pad input
messages to the host, which calls EmulatorJS's `simulateInput()` on the
running emulator.

Pairing flow (mirrors /api/auth/qr/* in shape, but simpler — there is no
"approve" step because both endpoints are the same already-authenticated
user):

  1. Host  POST /api/controller/start
            → { token, code, expires_in, pair_url }
     The DB row is created with host_user_id = current user. `token` is
     a long opaque secret only the host learns; `code` is the short
     human-readable string shown in the UI / encoded in the QR.

  2. Host  WS /api/controller/host?token=<token>
     Authenticates via the cookie + matches the row's host_user_id.
     Becomes the room's host. There is at most one host per room — a
     duplicate connection closes the previous one (page refresh case).

  3. Pad   GET /api/controller/lookup/{code}  (cookie-authed)
            → { code }   (mainly a "does this code exist + same user?"
                         probe; the real auth is on the WS upgrade)

  4. Pad   WS /api/controller/pad?code=<code>
     Cookie-authed; rejected unless the user matches host_user_id.

The room lives in-memory only. When the host disconnects we kick all
pads and delete the DB row. When a pad disconnects we replay button-up
for any buttons it was holding so a dropped Wi-Fi connection doesn't
leave Mario running off a cliff.

Wire protocol
-------------
JSON messages, both directions. Compact keys keep payloads small enough
to fit in a single TCP segment:

  pad → host:
    { "t": "d", "b": <int 0..11> }   button down (libretro slot index)
    { "t": "u", "b": <int 0..11> }   button up
    { "t": "ax", "x": <-1..1>, "y": <-1..1> }   left analog (optional)

  host → pad:
    { "t": "hello", "system": "<gb|gbc|gba|psx|n64|...>" }
    { "t": "end" }    host is closing the room

  server → host (no client message triggers these — pure server signals):
    { "t": "pad-state", "count": <int> }   pad list changed

We deliberately whitelist `b` to the 12 face/d-pad/shoulder slots
(`GAME_INPUT_TO_EJS_SLOT` on the frontend). L2/R2 are owned by the host
for fast-forward / rewind and are NOT exposed to the pad.

The same-origin middleware in main.py only fires on POST/PUT/PATCH/
DELETE, so we re-check the WS upgrade origin manually below.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketState

from ..db import SessionLocal
from ..deps import current_user, get_db
from ..limiter import limiter
from ..models import ControllerSession, User, UserSession
from ..models.schemas import ControllerLookupResponse, ControllerStartResponse
from ..security import decode_token_full

log = logging.getLogger("retrox.controller")

router = APIRouter(prefix="/api/controller", tags=["controller"])

# Pairing window. After this elapses without a host WS connecting the
# row is GC'd. The same value is shown in the phone UI ("Code expires in
# 3:00") and used to wake unpaired hosts up to refresh.
PAIRING_TTL_SECONDS = 180

# 6-char human code over a confusable-free alphabet (no 0/O/1/I). 30 bits
# of entropy is enough only because the lookup endpoint is rate-limited
# AND the actual auth check (matching cookie's user to host_user_id)
# happens on every request — guessing the code by itself grants nothing.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6

# Opaque host-only secret. 64 random bytes → 86-char URL-safe string.
# The host WS upgrade requires both the token AND the same user as
# host_user_id; the token alone never grants control.
TOKEN_BYTES = 64

# Whitelist of libretro slot indices we accept from a pad. Mirrors
# `GAME_INPUT_TO_EJS_SLOT` in frontend/js/play.js. Anything outside this
# set causes us to drop the connection — there is no reason to be lenient.
ALLOWED_BUTTONS: frozenset[int] = frozenset(range(12))

# Per-pad inbound message ceiling. This is a defense against a hostile
# or malformed client trying to amplify load — NOT a throttle on
# gameplay. We pick a value far above what any real human could ever
# generate so legitimate input never hits it.
#
# Order-of-magnitude budget for normal play:
#   - frantic button-mash:   ~10 presses/s × 2 (down+up)            =  20 msg/s
#   - + d-pad slide-through: ~6 transitions/s × 2 (release+press)   =  12 msg/s
#   - + multi-touch face:    × 3 simultaneous fingers                = ~96 msg/s
#   - + future analog stick: pointermove at 60 Hz                    = +60 msg/s
# Worst-case real-user total: ~160 msg/s.
#
# 800 leaves a 5× buffer so a competitive Tetris speedrun won't drop a
# connection mid-game. A hostile client trying to flood is still bound;
# 800/s × 100 bytes/msg = 80 KB/s/pad is well within what the host loop
# can shovel without affecting frame timing.
PAD_MSG_PER_SEC = 800


def _now() -> datetime:
    return datetime.now(tz=UTC)


def _aware(dt: datetime) -> datetime:
    """SQLite drops tzinfo on read; treat naive datetimes as UTC."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def _purge_expired(db: Session) -> None:
    db.query(ControllerSession).filter(
        ControllerSession.expires_at < _now().replace(tzinfo=None),
    ).delete()
    db.commit()


# ---------------------------------------------------------------------
# In-memory room registry
#
# Lives in this module's globals; one `Room` per active pairing code.
# Single-process by design — the surrounding app is single-process
# (uvicorn worker count is 1; see entrypoint.sh) and adding a Redis
# backplane just for this would be massive overkill.
# ---------------------------------------------------------------------


class Room:
    """The live state of one paired (host, pads...) session.

    `held_per_pad` tracks which buttons each pad currently has down so
    we can synthesize button-up messages on disconnect. Without this,
    a Wi-Fi blip mid-press would leave the emulator with stuck inputs.
    """

    __slots__ = ("code", "host_user_id", "host", "pads", "held_per_pad", "layout")

    def __init__(self, code: str, host_user_id: int) -> None:
        self.code = code
        self.host_user_id = host_user_id
        self.host: WebSocket | None = None
        self.pads: list[WebSocket] = []
        self.held_per_pad: dict[int, set[int]] = {}
        # Last layout payload broadcast by the host. Cached so a pad
        # joining after the host's initial broadcast still gets the
        # right button set without needing a re-broadcast handshake.
        self.layout: dict | None = None

    async def send_to_host(self, message: dict) -> None:
        ws = self.host
        if ws is None or ws.client_state != WebSocketState.CONNECTED:
            return
        with suppress(Exception):
            await ws.send_text(json.dumps(message))

    async def send_to_pad(self, ws: WebSocket, message: dict) -> None:
        if ws.client_state != WebSocketState.CONNECTED:
            return
        with suppress(Exception):
            await ws.send_text(json.dumps(message))

    async def broadcast_pad_state(self) -> None:
        """Tell the host the current pad count.

        Called whenever the pad list changes so the host UI can flip
        from "Waiting for phone…" to "Connected" (and back) without
        waiting for the first input event to arrive — which is what
        used to happen when status was inferred from inbound messages.
        """
        await self.send_to_host({"t": "pad-state", "count": len(self.pads)})


# code → Room. Mutated only from the WS handlers, which run on the same
# asyncio loop, so no lock is needed.
_rooms: dict[str, Room] = {}


def _get_or_create_room(code: str, host_user_id: int) -> Room:
    room = _rooms.get(code)
    if room is None:
        room = Room(code=code, host_user_id=host_user_id)
        _rooms[code] = room
    return room


def _remove_room(code: str) -> None:
    _rooms.pop(code, None)


# ---------------------------------------------------------------------
# REST: pairing handshake
# ---------------------------------------------------------------------


@router.post("/start", response_model=ControllerStartResponse)
@limiter.limit("10/minute")
def controller_start(
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> ControllerStartResponse:
    _purge_expired(db)
    token = secrets.token_urlsafe(TOKEN_BYTES)
    code = _generate_code()
    # Avoid the (vanishingly small) chance of a code collision against a
    # currently-live row. Tries until clean — the table is tiny and TTL'd.
    while db.query(ControllerSession).filter(ControllerSession.code == code).first() is not None:
        code = _generate_code()
    now = _now()
    session = ControllerSession(
        token=token,
        code=code,
        host_user_id=user.id,
        created_at=now,
        expires_at=now + timedelta(seconds=PAIRING_TTL_SECONDS),
    )
    db.add(session)
    db.commit()
    return ControllerStartResponse(
        token=token,
        code=code,
        expires_in=PAIRING_TTL_SECONDS,
        pair_url=f"/pair?code={code}",
    )


@router.get("/lookup/{code}", response_model=ControllerLookupResponse)
@limiter.limit("30/minute")
def controller_lookup(
    request: Request,
    code: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> ControllerLookupResponse:
    """Phone-side probe: does this code exist and belong to me?

    Returns 404 when the code is unknown / expired / belongs to a
    different user. We deliberately don't distinguish between those
    cases — a different user's code is a "doesn't exist" from the
    perspective of this caller.
    """
    code = code.upper()
    session = db.query(ControllerSession).filter(ControllerSession.code == code).first()
    if (
        session is None
        or _aware(session.expires_at) < _now()
        or session.host_user_id != user.id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Code not found or expired.")
    return ControllerLookupResponse(code=session.code)


# ---------------------------------------------------------------------
# WebSocket: shared helpers
# ---------------------------------------------------------------------


def _origin_ok(websocket: WebSocket) -> bool:
    """Same-origin check for WS upgrades.

    The HTTP middleware in main.py only fires on state-changing HTTP
    methods, so for WebSockets we re-implement the cross-origin defense
    locally. Without this, a malicious page on another origin could
    drive a victim's session as a controller pad (cookies still ride
    along on cross-site WS upgrades under SameSite=Lax).

    Stricter than the HTTP middleware: we accept ONLY `same-origin`
    here, not `none`. Browsers always send `same-origin` for legitimate
    same-origin WebSocket upgrades; `none` means the request was
    user-initiated (typed URL etc.) which is the wrong semantic for a
    WS endpoint and is also the value a non-browser client would forge
    to bypass an origin gate. The Origin/Host fallback below catches
    older clients that don't send Sec-Fetch-* at all.
    """
    headers = websocket.headers
    sec_fetch_site = headers.get("sec-fetch-site")
    if sec_fetch_site == "same-origin":
        return True
    if sec_fetch_site is not None:
        # Header was sent (so this is a browser) and it's not
        # same-origin — definitively cross-origin, reject.
        return False
    origin = headers.get("origin") or headers.get("referer")
    host = headers.get("host")
    if not origin or not host:
        return False
    origin_netloc = urlparse(origin).netloc.lower()
    return bool(origin_netloc) and origin_netloc == host.lower()


def _ws_user(websocket: WebSocket, db: Session) -> User | None:
    """Resolve the user from the access cookie on the WS upgrade.

    Mirrors deps.current_user but stays a regular function so it can be
    called inside the WS handler without raising HTTPException (which
    isn't meaningful at this point in the WS lifecycle).
    """
    access_token = websocket.cookies.get("access_token")
    if not access_token:
        return None
    payload = decode_token_full(access_token, expected_kind="access")
    if payload is None:
        return None
    sub = payload.get("sub")
    sid = payload.get("sid")
    if not isinstance(sid, str):
        return None
    try:
        user_id = int(sub) if sub is not None else None
    except (TypeError, ValueError):
        return None
    if user_id is None:
        return None
    user = db.get(User, user_id)
    if user is None:
        return None
    sess = db.query(UserSession).filter(UserSession.sid == sid).first()
    if sess is None or sess.user_id != user.id or sess.revoked_at is not None:
        return None
    return user


async def _close(websocket: WebSocket, code: int, reason: str = "") -> None:
    """Best-effort close that ignores already-disconnected sockets."""
    with suppress(Exception):
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.close(code=code, reason=reason)


# ---------------------------------------------------------------------
# WebSocket: host
# ---------------------------------------------------------------------


@router.websocket("/host")
async def controller_host_ws(websocket: WebSocket) -> None:
    # We always accept() FIRST before any rejection. Close codes sent
    # before accept() arrive at the browser as 1006 ("abnormal closure")
    # regardless of the value we passed — the WS handshake never
    # completed, so there's no close frame channel for the code to ride
    # on. Accepting first costs one extra round-trip on the rejection
    # path but means the client can distinguish 4404 (wrong code) from
    # 4403 (wrong origin) etc., which is what the phone-side UX needs.
    await websocket.accept()

    # DB session is opened manually (rather than via Depends(get_db))
    # because some FastAPI/Starlette combinations don't drive yield-based
    # generator dependencies through to the WS lifecycle reliably.
    # Manual lifetime is unambiguous and matches what our long-lived WS
    # actually needs.
    db = SessionLocal()
    try:
        if not _origin_ok(websocket):
            log.info("host WS rejected: bad origin")
            await websocket.close(code=4403, reason="forbidden origin")
            return

        token = websocket.query_params.get("token") or ""
        if not token:
            log.info("host WS rejected: missing token")
            await websocket.close(code=4400, reason="missing token")
            return

        user = _ws_user(websocket, db)
        if user is None:
            log.info("host WS rejected: unauthenticated")
            await websocket.close(code=4401, reason="unauthenticated")
            return

        session = db.query(ControllerSession).filter(ControllerSession.token == token).first()
        if session is None:
            log.info("host WS rejected: unknown token")
            await websocket.close(code=4404, reason="unknown session")
            return
        if _aware(session.expires_at) < _now():
            log.info("host WS rejected: expired token")
            await websocket.close(code=4404, reason="expired session")
            return
        if session.host_user_id != user.id:
            log.info("host WS rejected: token user mismatch")
            await websocket.close(code=4404, reason="unknown session")
            return

        code = session.code
        log.info("host WS accepted: code=%s user=%d", code, user.id)
        room = _get_or_create_room(code, user.id)

        # If a stale host WS is still attached (page reload during the
        # same paired session), evict it so the new one can take over.
        if room.host is not None and room.host is not websocket:
            await _close(room.host, code=4000, reason="superseded")
        room.host = websocket

        # Send the current pad-state immediately so the modal reflects
        # any pads that were already connected (e.g. on host reload mid
        # session). For a fresh pairing this is just `count: 0`.
        await room.broadcast_pad_state()

        try:
            # Host→server messages are meta-only ("layout"). We still
            # have to read so the close frame is observed promptly.
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("t") == "layout":
                    payload = {"t": "hello", "system": str(msg.get("system") or "")}
                    room.layout = payload
                    for pad in list(room.pads):
                        await room.send_to_pad(pad, payload)
                # Anything else: tolerate silently. Keeps the host→server
                # vocabulary forward-extensible.
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            log.warning("host WS error: %s", exc)
        finally:
            # Tell every pad the room is done, then drop them. Without
            # this, navigating away from /play would leave the phone UI
            # frozen on the now-disconnected controller.
            if room.host is websocket:
                room.host = None
            for pad in list(room.pads):
                with suppress(Exception):
                    await pad.send_text(json.dumps({"t": "end"}))
                await _close(pad, code=1000, reason="host left")
            room.pads.clear()
            room.held_per_pad.clear()
            _remove_room(code)
            # Once the host is gone the pairing is over. A fresh pair
            # requires a fresh /start.
            with suppress(Exception):
                db.query(ControllerSession).filter(ControllerSession.token == token).delete()
                db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------
# WebSocket: pad
# ---------------------------------------------------------------------


def _validate_pad_message(msg: dict) -> dict | None:
    """Return a normalized message or None if it should be dropped."""
    t = msg.get("t")
    if t in {"d", "u"}:
        b = msg.get("b")
        if not isinstance(b, int) or b not in ALLOWED_BUTTONS:
            return None
        return {"t": t, "b": b}
    if t == "ax":
        x = msg.get("x")
        y = msg.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            return None
        # Clamp on the server side — the host trusts these values to
        # call simulateInput directly, so don't let a malformed pad pass
        # through 1e9 and crash the emulator's audio resampler.
        x = max(-1.0, min(1.0, float(x)))
        y = max(-1.0, min(1.0, float(y)))
        return {"t": "ax", "x": x, "y": y}
    return None


@router.websocket("/pad")
async def controller_pad_ws(websocket: WebSocket) -> None:
    # Accept first so the client receives our specific 4xxx close codes
    # (otherwise rejections look like generic 1006 abnormal closure).
    await websocket.accept()

    db = SessionLocal()
    try:
        if not _origin_ok(websocket):
            log.info("pad WS rejected: bad origin")
            await websocket.close(code=4403, reason="forbidden origin")
            return

        code = (websocket.query_params.get("code") or "").upper()
        if not code:
            log.info("pad WS rejected: missing code")
            await websocket.close(code=4400, reason="missing code")
            return

        user = _ws_user(websocket, db)
        if user is None:
            log.info("pad WS rejected: unauthenticated")
            await websocket.close(code=4401, reason="unauthenticated")
            return

        session = db.query(ControllerSession).filter(ControllerSession.code == code).first()
        if (
            session is None
            or _aware(session.expires_at) < _now()
            or session.host_user_id != user.id
        ):
            log.info("pad WS rejected: unknown/expired/foreign code=%s", code)
            await websocket.close(code=4404, reason="unknown session")
            return

        room = _rooms.get(code)
        if room is None or room.host is None:
            # Pad reached us before the host opened the room. The phone
            # UI prompts the user to open /play first.
            log.info("pad WS rejected: host not ready code=%s", code)
            await websocket.close(code=4409, reason="host not ready")
            return

        log.info("pad WS accepted: code=%s user=%d", code, user.id)
        room.pads.append(websocket)
        held: set[int] = set()
        room.held_per_pad[id(websocket)] = held

        # At-most-one-pad-per-session policy. A second connection from
        # the same user supersedes the first — most often the user just
        # picked up a different phone, and "the latest takes over"
        # matches the kiosk-style mental model. Allowing N pads in
        # parallel produces last-press-wins races on shared buttons
        # (every pad sends to player 0) and is worse than no support.
        # True 2-player would need explicit slot allocation in the URL
        # plus a UI for choosing it; out of scope for v1.
        for old in list(room.pads):
            if old is websocket:
                continue
            log.info("pad WS evicted (superseded): code=%s", code)
            # Release any buttons the evicted pad was holding so the
            # game doesn't see a stuck input from a phantom controller.
            old_held = room.held_per_pad.pop(id(old), set())
            for b in old_held:
                await room.send_to_host({"t": "u", "b": b})
            with suppress(ValueError):
                room.pads.remove(old)
            # 4001 = "superseded" so the old pad's UI can show a
            # specific message instead of a generic "connection lost".
            await _close(old, code=4001, reason="superseded by another phone")

        await room.broadcast_pad_state()

        # Greet the pad with the cached layout (set by the host's most
        # recent "layout" message). If the host hasn't broadcast one yet,
        # fall back to a neutral hello; the next layout broadcast will
        # reach this pad through the normal room.send_to_pad fanout.
        await room.send_to_pad(websocket, room.layout or {"t": "hello", "system": ""})

        # Token-bucket-ish rate limit: count messages per second window.
        # A single misbehaving pad can't drown the host's event loop.
        bucket = 0
        bucket_started_at = asyncio.get_running_loop().time()

        try:
            while True:
                raw = await websocket.receive_text()

                now_t = asyncio.get_running_loop().time()
                if now_t - bucket_started_at >= 1.0:
                    bucket = 0
                    bucket_started_at = now_t
                bucket += 1
                if bucket > PAD_MSG_PER_SEC:
                    await _close(websocket, code=4429, reason="rate limit")
                    return

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                normalized = _validate_pad_message(msg)
                if normalized is None:
                    continue

                # Track held buttons so we can release them on disconnect.
                if normalized["t"] == "d":
                    held.add(normalized["b"])
                elif normalized["t"] == "u":
                    held.discard(normalized["b"])

                await room.send_to_host(normalized)
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            log.warning("pad WS error: %s", exc)
        finally:
            # Synthesize button-ups for anything still held when the WS
            # closes. Otherwise a dropped Wi-Fi connection leaves Mario
            # walking off a cliff in perpetuity.
            if room.host is not None:
                for b in held:
                    await room.send_to_host({"t": "u", "b": b})
            with suppress(ValueError):
                room.pads.remove(websocket)
            room.held_per_pad.pop(id(websocket), None)
            # Tell the host the count went down so its UI flips back to
            # "Waiting for phone…" (or stays "Connected" with the new
            # count if other pads are still attached).
            await room.broadcast_pad_state()
            await _close(websocket, code=1000)
    finally:
        db.close()
