from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from email.utils import formatdate
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..deps import current_user, get_db
from ..models import SaveSlot, User
from ..models.schemas import SlotListResponse, SlotSummary
from ..services.library import library
from ..services.saves import (
    MAX_SLOT,
    StagedFile,
    is_valid_slot,
    remove_slot_files,
    slot_save_path,
    slot_state_path,
)

router = APIRouter(prefix="/api/games/{game_id}/saves", tags=["saves"])


def _ensure_game_exists(game_id: str) -> None:
    if library.index.get(game_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")


def _slot_summary(row: SaveSlot, user: User, game_id: str) -> SlotSummary:
    return SlotSummary(
        slot=row.slot,
        name=row.name,
        updated_at=row.updated_at,
        has_save=slot_save_path(user.username, game_id, row.slot).exists(),
        has_state=slot_state_path(user.username, game_id, row.slot).exists(),
        generation=row.generation,
    )


@router.get("", response_model=SlotListResponse)
def list_slots(
    game_id: str,
    response: Response,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> SlotListResponse:
    # Same rationale as /api/games/{id}: slots carry per-slot
    # `generation` and `updated_at` watermarks used for optimistic
    # concurrency; serving a stale cached list would let the client
    # send an outdated X-Slot-Generation on its next PUT.
    response.headers["Cache-Control"] = "no-cache"

    _ensure_game_exists(game_id)
    rows = (
        db.query(SaveSlot)
        .filter(SaveSlot.user_id == user.id, SaveSlot.game_id == game_id)
        .order_by(SaveSlot.slot)
        .all()
    )
    return SlotListResponse(slots=[_slot_summary(r, user, game_id) for r in rows])


def _read_capped(upload: UploadFile, label: str) -> bytes:
    """Read the entire upload into memory, refusing anything past the
    configured ceiling. Done in chunks so a malicious client can't OOM
    the worker by claiming a small Content-Length but streaming forever.
    """
    cap = settings.max_save_bytes
    chunks: list[bytes] = []
    received = 0
    # Sync handler: read from the underlying SpooledTemporaryFile so the
    # blocking I/O stays on FastAPI's threadpool, not the event loop.
    f = upload.file
    while True:
        chunk = f.read(64 * 1024)
        if not chunk:
            break
        received += len(chunk)
        if received > cap:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"{label} exceeds {cap // (1024 * 1024)} MB limit.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.put("/{slot}", response_model=SlotSummary)
def upsert_slot(
    game_id: str,
    slot: int,
    save: UploadFile | None = File(default=None),
    state: UploadFile | None = File(default=None),
    name: str | None = Form(default=None),
    x_slot_generation: str | None = Header(default=None, alias="X-Slot-Generation"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> SlotSummary:
    _ensure_game_exists(game_id)
    if not is_valid_slot(slot):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Slot must be 1..{MAX_SLOT}.")
    if save is None and state is None and name is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one of save/state/name is required.")

    # Read uploads into memory before touching the DB or the filesystem.
    # If they're oversize we'd rather find out now than half-way through
    # a transaction.
    save_bytes: bytes | None = None
    if save is not None:
        save_bytes = _read_capped(save, "Save")
    state_bytes: bytes | None = None
    if state is not None:
        state_bytes = _read_capped(state, "State")

    row = (
        db.query(SaveSlot)
        .filter(
            SaveSlot.user_id == user.id,
            SaveSlot.game_id == game_id,
            SaveSlot.slot == slot,
        )
        .one_or_none()
    )

    # Pre-validate the X-Slot-Generation header (cheap, doesn't touch DB).
    # The atomic concurrency check happens below at the UPDATE itself.
    client_generation: int | None = None
    if x_slot_generation is not None:
        try:
            client_generation = int(x_slot_generation)
        except ValueError:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "X-Slot-Generation must be an integer.",
            ) from None
        if row is not None and client_generation != row.generation:
            # Fast-path 409: we already know the SELECT-ed generation
            # doesn't match. Avoids staging files we'd just discard.
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Slot was updated by another session.",
            )

    # Stage uploads to temp files in the destination dir, but don't
    # swap them into place yet. If the DB commit fails we'll roll the
    # staged files back, leaving the disk and DB consistent.
    staged: list[StagedFile] = []
    try:
        if save_bytes is not None:
            s = StagedFile(slot_save_path(user.username, game_id, slot))
            s.stage(save_bytes)
            staged.append(s)
        if state_bytes is not None:
            s = StagedFile(slot_state_path(user.username, game_id, slot))
            s.stage(state_bytes)
            staged.append(s)

        now = datetime.now(tz=UTC)
        if row is None:
            # New slot: rely on the (user_id, game_id, slot) unique
            # constraint to serialize concurrent inserts. The loser's
            # commit raises and is treated as a 409.
            row = SaveSlot(
                user_id=user.id, game_id=game_id, slot=slot,
                name=(name or None), updated_at=now, generation=1,
            )
            db.add(row)
            try:
                db.commit()
            except IntegrityError as e:
                # Unique-constraint loser → another writer raced us in.
                db.rollback()
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Slot was updated by another session.",
                ) from e
        else:
            # Atomic conditional UPDATE: the WHERE matches only if the
            # row's generation is still what we last observed. Two
            # concurrent PUTs sharing the same client_generation will
            # both issue this UPDATE; SQLite serializes the writes, the
            # first one bumps the generation, the second matches zero
            # rows. rowcount==0 ⇒ we lost the race ⇒ 409.
            expected_generation = (
                client_generation if client_generation is not None else row.generation
            )
            new_generation = (row.generation or 0) + 1
            values: dict = {
                "generation": new_generation,
                "updated_at": now,
            }
            if name is not None:
                values["name"] = name or None
            result = db.execute(
                update(SaveSlot)
                .where(
                    SaveSlot.id == row.id,
                    SaveSlot.generation == expected_generation,
                )
                .values(**values),
            )
            if result.rowcount == 0:
                db.rollback()
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Slot was updated by another session.",
                )
            db.commit()

        # DB commit succeeded — now swap staged temp files into place.
        for s in staged:
            s.commit()
    except BaseException:
        for s in staged:
            s.rollback()
        raise

    db.refresh(row)
    return _slot_summary(row, user, game_id)


def _file_validators(p: Path) -> tuple[str, str]:
    """Compute strong validators for a file (etag, last-modified) using
    the same formula Starlette's FileResponse uses for its own ETag, so
    a 304 response and a 200 FileResponse advertise matching values.
    Without matching values, the browser would fall back to a full
    re-download on the next request even when nothing changed."""
    s = p.stat()
    base = f"{s.st_mtime}-{s.st_size}".encode()
    etag = f'"{hashlib.md5(base, usedforsecurity=False).hexdigest()}"'
    last_modified = formatdate(s.st_mtime, usegmt=True)
    return etag, last_modified


def _save_file_or_304(request: Request, p: Path) -> Response:
    """Serve a save/state file with proper revalidation semantics.

    `Cache-Control: no-cache` instructs the browser to send a conditional
    GET on every request rather than serve a stale heuristically-fresh
    copy from its HTTP cache (the original cross-device-sync bug: a save
    uploaded on device A would not be visible on device B until B's
    heuristic-freshness window expired).

    When the client's `If-None-Match` matches the file's current ETag,
    we return 304 with no body. Starlette's FileResponse alone does not
    implement this conditional handling; we add it here so the
    revalidation round-trip costs a few hundred bytes when nothing
    changed instead of re-downloading the entire save body.
    """
    etag, last_modified = _file_validators(p)
    headers = {
        "Cache-Control": "no-cache",
        "ETag": etag,
        "Last-Modified": last_modified,
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return FileResponse(p, media_type="application/octet-stream", headers=headers)


@router.get("/{slot}/save")
def get_slot_save(
    game_id: str,
    slot: int,
    request: Request,
    user: User = Depends(current_user),
) -> Response:
    _ensure_game_exists(game_id)
    if not is_valid_slot(slot):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Slot must be 1..{MAX_SLOT}.")
    p = slot_save_path(user.username, game_id, slot)
    if not p.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Save file not found.")
    return _save_file_or_304(request, p)


@router.get("/{slot}/state")
def get_slot_state(
    game_id: str,
    slot: int,
    request: Request,
    user: User = Depends(current_user),
) -> Response:
    _ensure_game_exists(game_id)
    if not is_valid_slot(slot):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Slot must be 1..{MAX_SLOT}.")
    p = slot_state_path(user.username, game_id, slot)
    if not p.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Save state not found.")
    return _save_file_or_304(request, p)


@router.delete("/{slot}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def delete_slot(
    game_id: str,
    slot: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    if not is_valid_slot(slot):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Slot must be 1..{MAX_SLOT}.")
    remove_slot_files(user.username, game_id, slot)
    db.query(SaveSlot).filter(
        SaveSlot.user_id == user.id,
        SaveSlot.game_id == game_id,
        SaveSlot.slot == slot,
    ).delete()
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
