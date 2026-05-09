from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, Field, PlainSerializer


def _coerce_utc(value: datetime) -> datetime:
    # SQLite drops tzinfo on read; treat any naive datetime as UTC so we
    # never accidentally re-anchor it to the host's local zone.
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _iso_z(value: datetime) -> str:
    return _coerce_utc(value).isoformat().replace("+00:00", "Z")


# All datetime fields exposed by the API must use this type, so the JSON the
# browser sees is unambiguous UTC and `new Date(...)` parses it correctly.
UtcDatetime = Annotated[
    datetime,
    BeforeValidator(_coerce_utc),
    PlainSerializer(_iso_z, return_type=str),
]


# ---- Auth ----

# Allowed character set for new usernames. Lowercase ASCII letters,
# digits, and dots. First and last char must be alphanumeric so the
# value is never `.`, `..`, or anything else with filesystem semantics.
# Existing users with names from the previous, looser pattern keep
# working — only create/rename go through this validator.
USERNAME_PATTERN = r"^[a-z0-9](?:[a-z0-9.]*[a-z0-9])?$"


class LoginRequest(BaseModel):
    username: str
    password: str


class TwoFactorLoginRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=6)


class LoginResponse(BaseModel):
    two_factor_required: bool = False
    username: str | None = None
    is_admin: bool = False


class RecoverPasswordRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)


class RecoverPasswordResponse(BaseModel):
    # Always "ok" regardless of whether the username exists — see
    # routers/auth.py for why this constant response prevents username
    # enumeration over the recovery endpoint.
    status: str = "ok"


class MeResponse(BaseModel):
    username: str
    is_admin: bool
    two_factor_enabled: bool
    version: str = ""


# ---- Profile ----

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)


class TwoFactorSetupResponse(BaseModel):
    secret: str
    otpauth_uri: str


class TwoFactorEnableRequest(BaseModel):
    secret: str
    code: str = Field(..., min_length=6, max_length=6)


class TwoFactorDisableRequest(BaseModel):
    password: str
    code: str = Field(..., min_length=6, max_length=6)


# ---- Sessions ----

class SessionItem(BaseModel):
    """One open browser/device session for the current user."""
    id: int
    # Friendly label parsed from the user-agent (eg "Safari on iPhone").
    # Falls back to "Unknown device" when the UA can't be parsed.
    label: str
    user_agent: str | None = None
    ip_address: str | None = None
    created_at: UtcDatetime
    last_seen_at: UtcDatetime
    # True for the session whose refresh cookie was used to make this
    # request — the UI uses this to show a "This device" badge and to
    # warn before revoking it.
    is_current: bool


class RevokeOthersResponse(BaseModel):
    revoked: int


# ---- Library ----

class GameSummary(BaseModel):
    id: str
    slug: str
    name: str
    system: str
    disks: int
    has_cover: bool
    is_favorite: bool = False
    playtime_seconds: int = 0
    last_played_at: UtcDatetime | None = None
    # Filesystem mtime of the most recently-changed disk file. Used by
    # the "Recently Added" sort in the library UI. Null if the file
    # vanished between scan and serialization.
    added_at: UtcDatetime | None = None


class GameDetail(GameSummary):
    core: str
    fast_forward_enabled: bool
    rewind_enabled: bool
    disk_names: list[str]
    slots: list[SlotSummary]
    description: str | None = None
    release_date: str | None = None


class GameListResponse(BaseModel):
    items: list[GameSummary]
    total: int
    page: int
    page_size: int


# ---- QR cross-device login ----

class QrStartResponse(BaseModel):
    token: str
    code: str
    expires_in: int  # seconds
    approve_url: str  # full path approver should hit, e.g. /qr-approve?code=...


class QrPollResponse(BaseModel):
    status: str  # "pending" | "approved" | "expired"


class QrApproveRequest(BaseModel):
    code: str = Field(..., min_length=4, max_length=8)
    # Fresh-auth gate: re-prompt the approver so a stolen short-lived
    # access cookie can't silently mint a long-lived kiosk session.
    password: str = Field(..., min_length=1)
    totp_code: str | None = Field(default=None, min_length=6, max_length=6)


class QrLookupResponse(BaseModel):
    code: str
    user_agent: str | None = None
    created_at: UtcDatetime


# ---- Controller pairing (phone-as-controller) ----

class ControllerStartResponse(BaseModel):
    token: str        # opaque host-only secret used on the host WS
    code: str         # short human code shown in the UI / QR
    expires_in: int   # seconds until the row is GC'd if no host connects
    pair_url: str     # path the phone should open, e.g. /pair?code=...


class ControllerLookupResponse(BaseModel):
    code: str


# ---- Preferences (free-form JSON) ----

class PreferencePayload(BaseModel):
    data: dict


# ---- Saves ----

class SlotSummary(BaseModel):
    slot: int
    name: str | None
    updated_at: UtcDatetime
    has_state: bool
    has_save: bool
    # Monotonic per-slot counter. Replaces the wall-clock-based
    # X-Slot-Version token so conflict detection isn't sensitive to
    # device clock skew.
    generation: int


class SlotListResponse(BaseModel):
    slots: list[SlotSummary]


# ---- Playtime ----

class PlaytimePingRequest(BaseModel):
    # Bounded so a single ping can't claim a year of playtime; the tracker
    # flushes on a ~60s cadence and on visibility/unload, so anything beyond
    # ~10 minutes is almost certainly the result of a bad client clock.
    seconds: int = Field(..., ge=1, le=600)


class ProfileStatItem(BaseModel):
    game_id: str
    slug: str
    game_name: str
    system: str
    has_cover: bool
    playtime_seconds: int
    last_played_at: UtcDatetime


# ---- Admin ----

class AdminUserSummary(BaseModel):
    id: int
    username: str
    is_admin: bool
    two_factor_enabled: bool
    created_at: UtcDatetime
    last_login: UtcDatetime | None


class AdminCreateUserRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64, pattern=USERNAME_PATTERN)
    password: str = Field(..., min_length=8)
    is_admin: bool = False


class AdminUpdateUserRequest(BaseModel):
    username: str | None = Field(default=None, min_length=1, max_length=64, pattern=USERNAME_PATTERN)
    password: str | None = Field(default=None, min_length=8)
    is_admin: bool | None = None
    disable_2fa: bool | None = None


class AdminLibraryStatus(BaseModel):
    indexed: int
    scanned_at: UtcDatetime | None


# ---- Emulators ----

class EmulatorSummary(BaseModel):
    id: int
    name: str
    system: str
    extensions: str
    core: str
    fast_forward_enabled: bool
    rewind_enabled: bool


class EmulatorCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    system: str = Field(..., min_length=1, max_length=32, pattern=r"^[a-z0-9_]+$")
    extensions: str = Field(..., min_length=1, max_length=255)
    core: str = Field(..., min_length=1, max_length=64)
    fast_forward_enabled: bool = True
    rewind_enabled: bool = False


class EmulatorUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    extensions: str | None = Field(default=None, min_length=1, max_length=255)
    core: str | None = Field(default=None, min_length=1, max_length=64)
    fast_forward_enabled: bool | None = None
    rewind_enabled: bool | None = None


class CoreInfo(BaseModel):
    """One row per base core in /data/cores/, with the variants present.
    A "variant" is one of EmulatorJS's compiled flavours of the same core
    (modern/legacy/thread/thread-legacy). The browser picks one at runtime
    based on its WebGL2 / threading support — admins just need to know
    which flavours exist on disk."""
    name: str
    variants: list[str]


# Forward references resolved by Pydantic v2 automatically.
GameDetail.model_rebuild()
