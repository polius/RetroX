"""Filesystem-backed ROM library.

The mounted volume at ``/data/roms`` is the source of truth. The scanner walks
the tree and produces an in-memory index keyed by ``<system>:<slug>``. Game
deletion happens via filesystem operations; metadata.json overrides display
name and disk order.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path

from ..config import settings
from ..db import SessionLocal
from . import cores
from .slugs import ensure_meta_for_index

log = logging.getLogger("retrox.library")

COVER_EXTENSIONS = ("jpg", "jpeg", "png", "webp")
SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(value: str) -> str:
    slug = SLUG_RE.sub("-", value.lower()).strip("-")
    return slug or "untitled"


@dataclass(frozen=True)
class Game:
    id: str
    name: str
    system: str
    core: str
    folder: Path | None  # None for bare ROM file at system root
    disks: tuple[Path, ...]
    cover_path: Path | None  # None → fall back to admin-uploaded or default
    custom_cover: bool = False  # True when cover came from /data/covers/<id>.*
    # Per-emulator runtime flags (denormalized from the Emulator row at
    # scan time so the in-memory index is self-contained).
    fast_forward_enabled: bool = True
    rewind_enabled: bool = False
    # First time the scanner ever saw this game, persisted in GameMeta.
    # Stable across `cp` / restore-from-backup / volume migration —
    # filesystem mtime was not, which broke the "Recently Added" sort
    # for anyone who did either of those things.
    added_at: datetime | None = None

    @property
    def disk_names(self) -> list[str]:
        return [d.name for d in self.disks]


@dataclass
class LibraryIndex:
    games: dict[str, Game] = field(default_factory=dict)
    scanned_at: datetime | None = None

    def get(self, game_id: str) -> Game | None:
        return self.games.get(game_id)

    def search(self, query: str | None) -> list[Game]:
        items = list(self.games.values())
        if query:
            q = query.lower()
            items = [g for g in items if q in g.name.lower()]
        items.sort(key=lambda g: (g.system, g.name.lower()))
        return items


class Library:
    def __init__(self) -> None:
        self._index = LibraryIndex()
        self._lock = threading.Lock()

    @property
    def index(self) -> LibraryIndex:
        return self._index

    # ---------- bootstrap / scanning ----------

    @staticmethod
    def bootstrap_skeleton() -> None:
        """Create the canonical /data folder layout if it doesn't exist."""
        for path in (settings.roms_dir, settings.covers_dir, settings.saves_dir, settings.cores_dir):
            path.mkdir(parents=True, exist_ok=True)
        # Create system dirs for all DB-registered emulators
        with SessionLocal() as db:
            system_flags, _ = cores._load_maps(db)
        for system in system_flags:
            (settings.roms_dir / system).mkdir(parents=True, exist_ok=True)

    def scan(self) -> int:
        """Synchronous full rescan. Returns the number of games indexed."""
        with SessionLocal() as db:
            system_flags, system_extensions = cores._load_maps(db)

        new_index: dict[str, Game] = {}
        roms_root = settings.roms_dir
        if not roms_root.exists():
            self.bootstrap_skeleton()

        for system_dir in sorted(roms_root.iterdir()):
            if not system_dir.is_dir():
                continue
            system = system_dir.name
            if system not in system_flags:
                continue
            flags = system_flags[system]
            for entry in sorted(system_dir.iterdir()):
                game = self._build_game(system, flags, system_extensions, entry)
                if game is not None:
                    new_index[game.id] = game

        # Persist slug + first-seen timestamp, then materialize a final
        # index whose Game.added_at reflects what's stored, not what's
        # on the filesystem.
        created_at_map = ensure_meta_for_index(new_index)
        stamped: dict[str, Game] = {
            gid: replace(g, added_at=created_at_map.get(gid))
            for gid, g in new_index.items()
        }

        with self._lock:
            self._index = LibraryIndex(games=stamped, scanned_at=datetime.now(tz=UTC))

        log.info("Library scan: %d games indexed", len(stamped))
        return len(stamped)

    # ---------- internal builders ----------

    def _build_game(
        self, system: str, flags: cores.EmulatorFlags,
        ext_map: dict[str, frozenset[str]], entry: Path,
    ) -> Game | None:
        if entry.name.startswith("."):
            return None
        if entry.is_file():
            return self._build_bare_game(system, flags, ext_map, entry)
        if entry.is_dir():
            return self._build_folder_game(system, flags, ext_map, entry)
        return None

    def _build_bare_game(
        self, system: str, flags: cores.EmulatorFlags,
        ext_map: dict[str, frozenset[str]], file: Path,
    ) -> Game | None:
        if not cores.is_rom(ext_map, system, file.name):
            return None
        display_name = file.stem
        game_id = f"{system}:{slugify(display_name)}"
        cover, custom = self._cover_for(game_id, None)
        return Game(
            id=game_id, name=display_name, system=system, core=flags.core,
            folder=None, disks=(file,), cover_path=cover, custom_cover=custom,
            fast_forward_enabled=flags.fast_forward_enabled,
            rewind_enabled=flags.rewind_enabled,
        )

    def _build_folder_game(
        self, system: str, flags: cores.EmulatorFlags,
        ext_map: dict[str, frozenset[str]], folder: Path,
    ) -> Game | None:
        meta = self._read_metadata(folder)

        disks: list[Path]
        meta_disks = meta.get("disks") if isinstance(meta.get("disks"), list) else None
        if meta_disks:
            disks = [folder / name for name in meta_disks if (folder / name).is_file()]
        else:
            candidates = sorted(
                p for p in folder.iterdir()
                if p.is_file() and cores.is_rom(ext_map, system, p.name)
            )
            disks = self._filter_preferred(system, candidates)

        if not disks:
            return None

        display_name = meta.get("name") if isinstance(meta.get("name"), str) else folder.name
        game_id = f"{system}:{slugify(display_name)}"
        cover, custom = self._cover_for(game_id, folder)

        return Game(
            id=game_id, name=display_name, system=system, core=flags.core,
            folder=folder, disks=tuple(disks), cover_path=cover, custom_cover=custom,
            fast_forward_enabled=flags.fast_forward_enabled,
            rewind_enabled=flags.rewind_enabled,
        )

    @staticmethod
    def _read_metadata(folder: Path) -> dict:
        path = folder / "metadata.json"
        if not path.is_file():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            log.warning("Invalid metadata.json in %s", folder)
            return {}

    @staticmethod
    def _filter_preferred(system: str, candidates: list[Path]) -> list[Path]:
        preferred = cores.PREFERRED_EXTENSIONS.get(system)
        if not preferred or len(candidates) <= 1:
            return candidates

        by_stem: dict[str, list[Path]] = {}
        for c in candidates:
            by_stem.setdefault(c.stem, []).append(c)

        chosen: list[Path] = []
        for files in by_stem.values():
            files.sort(key=lambda p: preferred.index(p.suffix.lower().lstrip("."))
                      if p.suffix.lower().lstrip(".") in preferred else 99)
            chosen.append(files[0])
        chosen.sort()
        return chosen

    @staticmethod
    def _cover_for(game_id: str, folder: Path | None) -> tuple[Path | None, bool]:
        if folder is not None:
            for ext in COVER_EXTENSIONS:
                p = folder / f"cover.{ext}"
                if p.is_file():
                    return p, False
        slug = game_id.replace(":", "__")
        for ext in COVER_EXTENSIONS:
            p = settings.covers_dir / f"{slug}.{ext}"
            if p.is_file():
                return p, True
        return None, False

    # ---------- mutations ----------

    @staticmethod
    def custom_cover_path(game_id: str, ext: str) -> Path:
        slug = game_id.replace(":", "__")
        return settings.covers_dir / f"{slug}.{ext.lower()}"

    @staticmethod
    def remove_custom_cover(game_id: str) -> bool:
        removed = False
        slug = game_id.replace(":", "__")
        for ext in COVER_EXTENSIONS:
            p = settings.covers_dir / f"{slug}.{ext}"
            if p.exists():
                p.unlink(missing_ok=True)
                removed = True
        return removed

    def delete_game_files(self, game: Game) -> None:
        if game.folder is not None:
            _rmtree(game.folder)
        else:
            for disk in game.disks:
                disk.unlink(missing_ok=True)
        self.remove_custom_cover(game.id)


def _rmtree(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
        return
    if not path.exists():
        return
    for child in path.iterdir():
        _rmtree(child)
    path.rmdir()


library = Library()
