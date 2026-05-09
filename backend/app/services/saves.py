"""Per-user save & save-state files on the mounted volume.

Layout:
    /data/saves/<username>/<system>/<game-slug>/slot{N}.{save,state}

Slots are 1..MAX_SLOT (5). The DB carries metadata (name, updated_at,
generation); the files carry the actual bytes.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from ..config import settings

MAX_SLOT = 5


class StagedFile:
    """Stage uploaded bytes to a temp file in the same directory as the
    final destination, then atomically swap into place when commit() is
    called. Letting the caller commit only after a successful DB
    transaction is what closes the "file on disk, no DB row" hole."""

    def __init__(self, dest: Path) -> None:
        self.dest = dest
        self._tmp_path: Path | None = None

    def stage(self, data: bytes) -> None:
        self.dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            dir=self.dest.parent, prefix=".tmp.", suffix=self.dest.suffix, delete=False,
        ) as tmp:
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
            self._tmp_path = Path(tmp.name)

    def commit(self) -> None:
        if self._tmp_path is None:
            return
        os.replace(self._tmp_path, self.dest)
        self._tmp_path = None

    def rollback(self) -> None:
        if self._tmp_path is not None:
            try:
                self._tmp_path.unlink(missing_ok=True)
            finally:
                self._tmp_path = None


def is_valid_slot(slot: int) -> bool:
    return 1 <= slot <= MAX_SLOT


def _split_game_id(game_id: str) -> tuple[str, str]:
    if ":" not in game_id:
        raise ValueError(f"Invalid game id: {game_id!r}")
    system, slug = game_id.split(":", 1)
    if not system or not slug or "/" in system or "/" in slug or ".." in system or ".." in slug:
        raise ValueError(f"Invalid game id: {game_id!r}")
    return system, slug


def game_dir(username: str, game_id: str) -> Path:
    system, slug = _split_game_id(game_id)
    return settings.saves_dir / username / system / slug


def slot_save_path(username: str, game_id: str, slot: int) -> Path:
    return game_dir(username, game_id) / f"slot{slot}.save"


def slot_state_path(username: str, game_id: str, slot: int) -> Path:
    return game_dir(username, game_id) / f"slot{slot}.state"


def remove_slot_files(username: str, game_id: str, slot: int) -> None:
    slot_save_path(username, game_id, slot).unlink(missing_ok=True)
    slot_state_path(username, game_id, slot).unlink(missing_ok=True)


def remove_user_saves(username: str) -> None:
    """Remove the user's saves directory. Raises OSError on failure so
    callers (admin delete_user) can abort the DB delete and surface a
    retryable error rather than orphan files under a username that
    could later be re-registered."""
    target = settings.saves_dir / username
    if target.exists():
        shutil.rmtree(target)


def remove_game_saves_all_users(game_id: str) -> int:
    """Remove this game's save dir under every user. Returns affected count."""
    system, slug = _split_game_id(game_id)
    if not settings.saves_dir.exists():
        return 0
    affected = 0
    for user_dir in settings.saves_dir.iterdir():
        if not user_dir.is_dir():
            continue
        target = user_dir / system / slug
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
            affected += 1
    return affected
