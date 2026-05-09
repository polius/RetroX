from __future__ import annotations

import logging
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import Response
from sqlalchemy import distinct, func
from sqlalchemy.orm import Session

from ..deps import get_db, require_admin
from ..models import (
    CollectionGame,
    Emulator,
    Favorite,
    GameMeta,
    GamePlayStat,
    SaveSlot,
    User,
)
from ..models.schemas import (
    AdminCreateUserRequest,
    AdminLibraryStatus,
    AdminUpdateUserRequest,
    AdminUserSummary,
    CoreInfo,
    EmulatorCreateRequest,
    EmulatorSummary,
    EmulatorUpdateRequest,
)
from ..security import hash_password
from ..services import recovery as recovery_service
from ..services.library import library
from ..services.saves import remove_game_saves_all_users, remove_user_saves
from ..services.slugs import regenerate_slug

log = logging.getLogger("retrox")

router = APIRouter(prefix="/api/admin", tags=["admin"])

ALLOWED_COVER_EXTS = {"jpg", "jpeg", "png", "webp"}

# Magic-byte signatures for the formats we accept. Filename extension
# alone is unreliable (a renamed `.jpg` could be anything); this catches
# mismatches at upload time so we never serve a file with the wrong
# Content-Type later.
_COVER_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"RIFF", "webp"),  # WEBP also has "WEBP" at offset 8 — checked below
)


def _sniff_cover_format(data: bytes) -> str | None:
    """Return the canonical extension a cover's bytes claim to be, or None."""
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WEBP":
        return "webp"
    return None


# ---------- Users ----------

@router.get("/users", response_model=list[AdminUserSummary])
def list_users(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[AdminUserSummary]:
    rows = db.query(User).order_by(User.username).all()
    return [
        AdminUserSummary(
            id=r.id, username=r.username, is_admin=r.is_admin,
            two_factor_enabled=bool(r.totp_secret),
            created_at=r.created_at, last_login=r.last_login,
        )
        for r in rows
    ]


@router.post("/users", response_model=AdminUserSummary, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: AdminCreateUserRequest,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUserSummary:
    if db.query(User).filter(User.username == payload.username).first() is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Username already exists.")
    user = User(
        username=payload.username,
        password=hash_password(payload.password),
        is_admin=payload.is_admin,
        created_at=datetime.now(tz=UTC),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return AdminUserSummary(
        id=user.id, username=user.username, is_admin=user.is_admin,
        two_factor_enabled=False,
        created_at=user.created_at, last_login=user.last_login,
    )


@router.patch("/users/{user_id}", response_model=AdminUserSummary)
def update_user(
    user_id: int,
    payload: AdminUpdateUserRequest,
    actor: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUserSummary:
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")

    # Track whether we performed an FS rename so we can undo it if a
    # later step fails. We do the FS rename FIRST, then commit the DB:
    # this way, if the DB commit somehow fails (disk full, etc.), we
    # can put the saves directory back. The reverse ordering — commit
    # then rename — would leave the DB pointing at a username whose
    # on-disk saves are still under the old name.
    fs_renamed_from: Path | None = None
    fs_renamed_to: Path | None = None
    recovery_renamed: tuple[Path, Path] | None = None

    if payload.username is not None and payload.username != target.username:
        if db.query(User).filter(User.username == payload.username).first() is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Username already exists.")
        from ..config import settings as cfg
        old_dir = cfg.saves_dir / target.username
        new_dir = cfg.saves_dir / payload.username
        # Reject up-front if the destination directory already exists.
        # This is the bug we're fixing: previously the rename was
        # silently skipped and the DB row was repointed at someone
        # else's saves directory.
        if new_dir.exists():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "A saves directory with that name already exists. "
                "Move or remove it before renaming.",
            )
        if old_dir.exists():
            try:
                old_dir.rename(new_dir)
            except OSError as e:
                log.error(
                    "Failed to rename saves dir %s -> %s: %s",
                    old_dir, new_dir, e,
                )
                raise HTTPException(
                    status.HTTP_500_INTERNAL_SERVER_ERROR,
                    "Could not rename the user's saves directory.",
                ) from e
            fs_renamed_from, fs_renamed_to = old_dir, new_dir
        # Carry any pending password-recovery file to the new username
        # so an in-flight recovery isn't silently invalidated by an
        # admin rename. Same rollback contract as the saves dir.
        try:
            recovery_renamed = recovery_service.rename(target.username, payload.username)
        except OSError as e:
            log.error("Failed to rename recovery file for %s -> %s: %s",
                      target.username, payload.username, e)
            if fs_renamed_from is not None and fs_renamed_to is not None:
                try:
                    fs_renamed_to.rename(fs_renamed_from)
                except OSError:
                    log.exception(
                        "CRITICAL: failed to undo saves-dir rename %s -> %s "
                        "after recovery rename failed; manual recovery required.",
                        fs_renamed_to, fs_renamed_from,
                    )
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Could not rename the user's recovery file.",
            ) from e
        target.username = payload.username

    if payload.password is not None:
        target.password = hash_password(payload.password)

    if payload.is_admin is not None and payload.is_admin != target.is_admin:
        if not payload.is_admin and target.id == actor.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot demote yourself.")
        if not payload.is_admin and _last_admin(db, exclude_id=target.id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one admin must remain.")
        target.is_admin = payload.is_admin

    if payload.disable_2fa:
        # Match the user-side /profile/2fa/disable cleanup so a fresh
        # re-enrolment isn't tripped up by stale per-secret state.
        target.totp_secret = None
        target.pending_2fa_secret = None
        target.pending_2fa_expires_at = None
        target.totp_last_step = None

    try:
        db.commit()
    except Exception:
        # DB commit failed after we renamed FS state — undo every
        # rename so the DB and FS stay in sync. If even THAT fails
        # we log loudly; manual recovery is then operator's job.
        if fs_renamed_from is not None and fs_renamed_to is not None:
            try:
                fs_renamed_to.rename(fs_renamed_from)
            except OSError:
                log.exception(
                    "CRITICAL: failed to undo saves-dir rename %s -> %s "
                    "after DB commit error; manual recovery required.",
                    fs_renamed_to, fs_renamed_from,
                )
        if recovery_renamed is not None:
            old_path, new_path = recovery_renamed
            try:
                new_path.rename(old_path)
            except OSError:
                log.exception(
                    "CRITICAL: failed to undo recovery-file rename %s -> %s "
                    "after DB commit error; manual recovery required.",
                    new_path, old_path,
                )
        raise
    db.refresh(target)
    return AdminUserSummary(
        id=target.id, username=target.username, is_admin=target.is_admin,
        two_factor_enabled=bool(target.totp_secret),
        created_at=target.created_at, last_login=target.last_login,
    )


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def delete_user(
    user_id: int,
    actor: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    if target.id == actor.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot delete yourself.")
    if target.is_admin and _last_admin(db, exclude_id=target.id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one admin must remain.")

    username = target.username
    # Remove on-disk saves BEFORE deleting the DB row. If the rmtree
    # fails we abort and the operator can retry — versus the previous
    # ordering, which would orphan the files under a username that a
    # later /api/admin/users POST could re-create and inherit.
    try:
        remove_user_saves(username)
    except OSError as e:
        log.error("Failed to remove saves dir for user %s: %s", username, e)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Could not remove the user's saves directory; retry or fix permissions.",
        ) from e
    db.delete(target)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _last_admin(db: Session, exclude_id: int) -> bool:
    return (
        db.query(User)
        .filter(User.is_admin.is_(True), User.id != exclude_id)
        .count()
        == 0
    )


# ---------- Library ----------

@router.get("/library", response_model=AdminLibraryStatus)
def library_status(_: User = Depends(require_admin)) -> AdminLibraryStatus:
    idx = library.index
    return AdminLibraryStatus(indexed=len(idx.games), scanned_at=idx.scanned_at)


# Module-level guard so a slow rescan can't pile up behind itself; if a
# second admin clicks "Rescan" mid-scan we 409 instead of queueing a
# duplicate that would just thrash the disk.
_scan_lock = threading.Lock()
_scan_started_at: float | None = None
# A scan that's been "running" longer than this is treated as wedged
# (NFS stall, infinite loop) so a fresh admin click can recover.
SCAN_STALE_AFTER = 30 * 60


def _run_scan_safely() -> None:
    """Background entry point for /library/scan. Always clears the
    in-progress flag, even on failure, so a crashed scan doesn't wedge
    the endpoint into permanent-409 territory."""
    global _scan_started_at
    try:
        library.scan()
    except Exception:
        log.exception("Library scan failed")
    finally:
        with _scan_lock:
            _scan_started_at = None


@router.post("/library/scan", response_model=AdminLibraryStatus)
def trigger_scan(
    background_tasks: BackgroundTasks,
    _: User = Depends(require_admin),
) -> AdminLibraryStatus:
    global _scan_started_at
    with _scan_lock:
        now = time.monotonic()
        if _scan_started_at is None:
            _scan_started_at = now
        elif now - _scan_started_at > SCAN_STALE_AFTER:
            log.warning("previous scan exceeded stale threshold; allowing new scan")
            _scan_started_at = now
        else:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "library scan already in progress",
            )
    background_tasks.add_task(_run_scan_safely)
    # Return the existing index snapshot — the frontend re-fetches
    # /admin/library after the rescan to pick up new counts.
    idx = library.index
    return AdminLibraryStatus(indexed=len(idx.games), scanned_at=idx.scanned_at)


@router.post("/games/{game_id}/cover", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def upload_cover(
    game_id: str,
    file: UploadFile = File(...),
    _: User = Depends(require_admin),
) -> Response:
    game = library.index.get(game_id)
    if game is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")
    # Cap covers at 5 MB. A 4K JPEG is well under 1 MB; anything bigger
    # is either pathological or accidental.
    data = await file.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "Cover must be 5 MB or smaller.",
        )
    # Validate the bytes themselves rather than trust the filename.
    # A renamed `.jpg` containing PNG bytes would otherwise be served
    # later with the wrong Content-Type.
    sniffed = _sniff_cover_format(data)
    if sniffed is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Cover must be one of: {', '.join(sorted(ALLOWED_COVER_EXTS))}.",
        )
    # Replace any prior custom cover (different extension)
    library.remove_custom_cover(game_id)
    target = library.custom_cover_path(game_id, sniffed)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    library.scan()  # refresh cover_path on the in-memory index
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/games/{game_id}/cover", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def delete_cover(
    game_id: str,
    _: User = Depends(require_admin),
) -> Response:
    if library.index.get(game_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")
    library.remove_custom_cover(game_id)
    library.scan()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/games/{game_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def delete_game(
    game_id: str,
    confirm: str | None = Header(default=None, alias="X-Confirm-Delete"),
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    game = library.index.get(game_id)
    if game is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")
    if confirm != game_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Missing or incorrect X-Confirm-Delete header.",
        )

    library.delete_game_files(game)
    remove_game_saves_all_users(game_id)
    # Cascade: every per-game record we own follows the ROM. Without
    # this, orphan rows accumulate forever and (worse) GameMeta keeps
    # the slug, which can clash on a future rescan.
    db.query(SaveSlot).filter(SaveSlot.game_id == game_id).delete()
    db.query(Favorite).filter(Favorite.game_id == game_id).delete()
    db.query(GamePlayStat).filter(GamePlayStat.game_id == game_id).delete()
    db.query(CollectionGame).filter(CollectionGame.game_id == game_id).delete()
    db.query(GameMeta).filter(GameMeta.game_id == game_id).delete()
    db.commit()
    library.scan()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/games", response_model=list[dict])
def list_games_admin(
    q: str | None = Query(default=None, max_length=128),
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[dict]:
    """Listing for the admin Library tab; includes save counts per game."""
    games = library.index.search(q)
    counts: dict[str, dict[str, int]] = {}
    names: dict[str, str] = {}
    descriptions: dict[str, str] = {}
    release_dates: dict[str, str] = {}
    if games:
        game_ids = [g.id for g in games]
        # Single GROUP BY query replaces the prior in-Python aggregation.
        rows = (
            db.query(
                SaveSlot.game_id,
                func.count(SaveSlot.id).label("slot_count"),
                func.count(distinct(SaveSlot.user_id)).label("user_count"),
            )
            .filter(SaveSlot.game_id.in_(game_ids))
            .group_by(SaveSlot.game_id)
            .all()
        )
        for r in rows:
            counts[r.game_id] = {"slots": r.slot_count, "users": r.user_count}
        for meta in db.query(GameMeta).filter(GameMeta.game_id.in_(game_ids)).all():
            if meta.display_name:
                names[meta.game_id] = meta.display_name
            if meta.description:
                descriptions[meta.game_id] = meta.description
            if meta.release_date:
                release_dates[meta.game_id] = meta.release_date

    out: list[dict] = []
    for g in games:
        c = counts.get(g.id, {"slots": 0, "users": 0})
        out.append({
            "id": g.id,
            "name": names.get(g.id, g.name),
            "file_name": g.name,
            "system": g.system,
            "disks": len(g.disks),
            "has_cover": g.cover_path is not None,
            "custom_cover": g.custom_cover,
            "description": descriptions.get(g.id, ""),
            "release_date": release_dates.get(g.id, ""),
            "slot_count": c["slots"],
            "user_count": c["users"],
        })
    return out


@router.patch("/games/{game_id}/name", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def update_game_meta(
    game_id: str,
    payload: dict,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    game = library.index.get(game_id)
    if game is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")
    name = (payload.get("name") or "").strip() or None
    description = payload.get("description")
    if isinstance(description, str):
        description = description.strip() or None

    meta = db.query(GameMeta).filter(GameMeta.game_id == game_id).first()
    if meta is None:
        meta = GameMeta(game_id=game_id)
        db.add(meta)
    if "name" in payload:
        meta.display_name = name
        # Regenerate slug from new display name (or original game name)
        display = name or game.name
        meta.slug = regenerate_slug(db, game_id, display, game.system)
    if "description" in payload:
        meta.description = description
    if "release_date" in payload:
        rd = payload.get("release_date")
        meta.release_date = rd.strip() if isinstance(rd, str) and rd.strip() else None
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------- Emulators ----------

def _emu_to_summary(emu: Emulator) -> EmulatorSummary:
    return EmulatorSummary(
        id=emu.id, name=emu.name, system=emu.system,
        extensions=emu.extensions, core=emu.core,
        fast_forward_enabled=bool(emu.fast_forward_enabled),
        rewind_enabled=bool(emu.rewind_enabled),
    )


@router.get("/emulators", response_model=list[EmulatorSummary])
def list_emulators(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[EmulatorSummary]:
    rows = db.query(Emulator).order_by(Emulator.name).all()
    return [_emu_to_summary(r) for r in rows]


@router.post("/emulators", response_model=EmulatorSummary, status_code=status.HTTP_201_CREATED)
def create_emulator(
    payload: EmulatorCreateRequest,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> EmulatorSummary:
    if db.query(Emulator).filter(Emulator.system == payload.system).first():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "System folder already in use.")
    # Rewind requires fast-forward (it shares the L2 binding). Reject the
    # impossible combination at the boundary rather than silently coercing.
    if payload.rewind_enabled and not payload.fast_forward_enabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rewind requires fast forward to be enabled.")
    emu = Emulator(
        name=payload.name, system=payload.system,
        extensions=payload.extensions, core=payload.core,
        fast_forward_enabled=payload.fast_forward_enabled,
        rewind_enabled=payload.rewind_enabled,
    )
    db.add(emu)
    db.commit()
    db.refresh(emu)
    library.scan()  # refresh denormalized flags on Game objects
    return _emu_to_summary(emu)


@router.patch("/emulators/{emulator_id}", response_model=EmulatorSummary)
def update_emulator(
    emulator_id: int,
    payload: EmulatorUpdateRequest,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> EmulatorSummary:
    emu = db.get(Emulator, emulator_id)
    if emu is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Emulator not found.")
    if payload.name is not None:
        emu.name = payload.name
    if payload.extensions is not None:
        emu.extensions = payload.extensions
    if payload.core is not None:
        emu.core = payload.core
    if payload.fast_forward_enabled is not None:
        emu.fast_forward_enabled = payload.fast_forward_enabled
    if payload.rewind_enabled is not None:
        emu.rewind_enabled = payload.rewind_enabled
    if emu.rewind_enabled and not emu.fast_forward_enabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rewind requires fast forward to be enabled.")
    db.commit()
    db.refresh(emu)
    library.scan()  # refresh denormalized flags on Game objects
    return _emu_to_summary(emu)


@router.delete("/emulators/{emulator_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def delete_emulator(
    emulator_id: int,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    emu = db.get(Emulator, emulator_id)
    if emu is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Emulator not found.")
    db.delete(emu)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------- Cores ----------

# Suffixes for the four EmulatorJS core variants. Listed longest-first so
# greedy matching strips the right one — otherwise "-wasm" would consume
# from "-legacy-wasm" before the legacy stripper got a turn (this was a
# real bug in the previous implementation: gambatte-legacy-wasm.data
# resolved to base name "gambatte-legacy" and showed up as a separate
# core in the dropdown).
_CORE_VARIANT_SUFFIXES: tuple[tuple[str, str], ...] = (
    ("-thread-legacy-wasm", "thread-legacy"),
    ("-thread-wasm",        "thread"),
    ("-legacy-wasm",        "legacy"),
    ("-wasm",               "modern"),
)

# Stable ordering for the variants list returned to the client.
_VARIANT_ORDER: tuple[str, ...] = ("modern", "legacy", "thread", "thread-legacy")


def _split_core_filename(stem: str) -> tuple[str, str] | None:
    """Returns (base_name, variant) or None if the stem doesn't match any
    known EmulatorJS core variant suffix (in which case we ignore the file
    rather than guess at it)."""
    for suffix, variant in _CORE_VARIANT_SUFFIXES:
        if stem.endswith(suffix) and len(stem) > len(suffix):
            return stem[: -len(suffix)], variant
    return None


@router.get("/cores", response_model=list[CoreInfo])
def list_cores(_: User = Depends(require_admin)) -> list[CoreInfo]:
    """List available cores in /data/cores/, grouped by base name with
    the installed variants of each. The browser picks the right variant
    at runtime; admins shouldn't have to think about the suffix."""
    from ..config import settings as cfg

    base_to_variants: dict[str, set[str]] = {}
    cores_dir = cfg.cores_dir
    if cores_dir.is_dir():
        for f in cores_dir.iterdir():
            if not (f.is_file() and f.suffix == ".data"):
                continue
            parsed = _split_core_filename(f.stem)
            if parsed is None:
                continue
            base, variant = parsed
            base_to_variants.setdefault(base, set()).add(variant)

    return [
        CoreInfo(name=name, variants=[v for v in _VARIANT_ORDER if v in variants])
        for name, variants in sorted(base_to_variants.items())
    ]


# ---------- Saves ----------

@router.get("/saves")
def list_all_saves(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    from ..services import saves as svc

    slots = db.query(SaveSlot).order_by(SaveSlot.updated_at.desc()).all()
    users_map = {u.id: u.username for u in db.query(User).all()}
    out = []
    for s in slots:
        username = users_map.get(s.user_id, "deleted")
        out.append({
            "id": s.id,
            "username": username,
            "game_id": s.game_id,
            "slot": s.slot,
            "name": s.name,
            "updated_at": s.updated_at.isoformat() if s.updated_at else None,
            # Surface file presence so the admin UI can disable the
            # corresponding "Download state" / "Download save" actions
            # when the artifact doesn't exist on disk (orphaned slot,
            # core that never produced a state, etc).
            "has_state": svc.slot_state_path(username, s.game_id, s.slot).is_file(),
            "has_save": svc.slot_save_path(username, s.game_id, s.slot).is_file(),
        })
    return out


@router.get("/saves/{save_id}/{file_type}")
def download_save_file(
    save_id: int,
    file_type: str,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    from fastapi.responses import FileResponse as FR

    from ..services import saves as svc

    slot = db.get(SaveSlot, save_id)
    if not slot:
        raise HTTPException(404, "Save not found.")
    user = db.get(User, slot.user_id)
    username = user.username if user else "deleted"

    if file_type == "state":
        path = svc.slot_state_path(username, slot.game_id, slot.slot)
    elif file_type == "save":
        path = svc.slot_save_path(username, slot.game_id, slot.slot)
    else:
        raise HTTPException(400, "Type must be 'state' or 'save'.")

    if not path.is_file():
        raise HTTPException(404, f"No {file_type} file for this slot.")
    return FR(path, media_type="application/octet-stream")


@router.delete("/saves/{save_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_save(
    save_id: int,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    from ..services import saves as svc

    slot = db.get(SaveSlot, save_id)
    if not slot:
        raise HTTPException(404, "Save not found.")
    user = db.get(User, slot.user_id)
    username = user.username if user else "deleted"
    svc.remove_slot_files(username, slot.game_id, slot.slot)
    db.delete(slot)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
