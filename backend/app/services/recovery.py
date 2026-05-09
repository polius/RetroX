"""Admin-retrievable password recovery.

When a user forgets their password they hit POST /api/auth/recover with a
username. If the username exists, we generate a strong random password,
bcrypt-hash it, and write the resulting record to a per-user JSON file
under /data/recovery/<username>.json (mode 0600). The plaintext is kept
in the file so the operator running the container can retrieve it via
something like `docker exec retrox cat /data/recovery/<u>.json` and
hand it to the user out-of-band — there is intentionally no UI surface
that displays it, so a visitor cannot reset and read someone else's
password from a browser.

On the next successful login, the login handler also tries this file as
a fallback credential. A match promotes the recovery password to the
real password (re-hashed into the users table) and deletes the file —
recovery passwords are single-use.
"""
from __future__ import annotations

import contextlib
import json
import os
import secrets
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

from ..config import settings
from ..security import hash_password, verify_password

# Single-use is the goal, but a stale file shouldn't linger if the user
# never logs in. A week is long enough that the operator has time to
# pass the password along; short enough that an abandoned reset doesn't
# leave a forever-valid backdoor.
RECOVERY_TTL = timedelta(days=7)

# 16 url-safe chars (~96 bits) — strong enough to survive online
# brute-force given the 5/min login rate limit, short enough to type.
_RECOVERY_PASSWORD_BYTES = 12


def _recovery_dir() -> Path:
    return settings.data_dir / "recovery"


def _recovery_path(username: str) -> Path:
    # Username pattern (USERNAME_PATTERN in schemas.py) already excludes
    # path separators and dotfile-style values, but we sanitise once more
    # here as defence in depth — a malformed legacy username must not be
    # able to escape the recovery directory.
    safe = username.lower().replace("/", "").replace("\\", "").lstrip(".")
    if not safe:
        raise ValueError("invalid username")
    return _recovery_dir() / f"{safe}.json"


def _atomic_write(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # 0700 on the directory so other container users (if any) can't list
    # whose recovery is pending.
    with contextlib.suppress(OSError):
        os.chmod(path.parent, 0o700)
    with tempfile.NamedTemporaryFile(
        dir=path.parent, prefix=".tmp.", suffix=".json", delete=False, mode="w",
    ) as tmp:
        tmp.write(data)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, path)


def generate_and_store(username: str) -> str:
    """Mint a fresh recovery password for `username` and persist it.

    Returns the plaintext (caller does not display it; it's logged into
    the recovery file for the operator). Overwrites any prior pending
    recovery for this user.
    """
    plain = secrets.token_urlsafe(_RECOVERY_PASSWORD_BYTES)
    record = {
        "username": username,
        "password": plain,
        "hash": hash_password(plain),
        "created_at": datetime.now(tz=UTC).isoformat(),
    }
    _atomic_write(_recovery_path(username), json.dumps(record, indent=2) + "\n")
    return plain


def _load(username: str) -> dict | None:
    path = _recovery_path(username)
    if not path.exists():
        return None
    try:
        with path.open("r") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def _is_expired(record: dict) -> bool:
    raw = record.get("created_at")
    if not isinstance(raw, str):
        return True
    try:
        created = datetime.fromisoformat(raw)
    except ValueError:
        return True
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    return datetime.now(tz=UTC) - created > RECOVERY_TTL


def consume_if_match(username: str, password: str) -> bool:
    """Try to authenticate `password` against the pending recovery file
    for `username`. On success, delete the file and return True so the
    caller can promote this password to the real one. Expired files are
    cleaned up opportunistically.
    """
    record = _load(username)
    if record is None:
        return False
    path = _recovery_path(username)
    if _is_expired(record):
        with contextlib.suppress(OSError):
            path.unlink()
        return False
    stored_hash = record.get("hash")
    if not isinstance(stored_hash, str) or not verify_password(password, stored_hash):
        return False
    with contextlib.suppress(OSError):
        path.unlink()
    return True


def clear(username: str) -> None:
    """Drop any pending recovery for `username`. Called when the user
    rotates their password through the normal flow."""
    with contextlib.suppress(OSError, ValueError):
        _recovery_path(username).unlink()


def rename(old_username: str, new_username: str) -> tuple[Path, Path] | None:
    """Move a pending recovery file from `old_username` to `new_username`.

    No-op when there is no pending file. Returns `(old_path, new_path)`
    on a successful rename so the caller can roll the move back if a
    later step (eg. the DB commit) fails. Raises OSError if the rename
    itself fails — admins should see the failure rather than silently
    losing the user's pending recovery.
    """
    try:
        src = _recovery_path(old_username)
        dst = _recovery_path(new_username)
    except ValueError:
        return None
    if not src.exists():
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.replace(src, dst)
    return src, dst
