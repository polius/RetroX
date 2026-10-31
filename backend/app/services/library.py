"""Filesystem-backed ROM library.

The mounted volume at ``/data/roms`` is the source of truth. The scanner walks
the tree and produces an in-memory index keyed by ``<system>:<slug>``. Game
deletion happens via filesystem operations; metadata.json overrides display
name and disk order.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from ..config import settings
from ..db import SessionLocal
from . import cores, cue
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

    def search(
        self, query: str | None, extra_names: dict[str, tuple[str, str]] | None = None,
    ) -> list[Game]:
        """Filter by query against the filesystem name, plus the optional
        per-game (display_name, slug) metadata the DB layer knows about."""
        items = list(self.games.values())
        if query:
            q = query.lower()
            meta = extra_names or {}
            items = [
                g for g in items
                if q in g.name.lower()
                or q in meta.get(g.id, ("", ""))[0].lower()
                or q in meta.get(g.id, ("", ""))[1].lower()
            ]
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

        claims = self._load_id_claims()
        claims_before = dict(claims)
        data_ids: tuple[set[str], set[str]] | None = None  # loaded on first need

        for system_dir in sorted(roms_root.iterdir()):
            if not system_dir.is_dir():
                continue
            system = system_dir.name
            if system not in system_flags:
                continue
            flags = system_flags[system]
            try:
                entries = sorted(system_dir.iterdir())
            except OSError as e:
                log.warning("Skipping %s: can't list it (%s)", system_dir, e)
                continue
            skip = self._bare_files_to_skip(system, system_extensions, entries)
            if skip and data_ids is None:
                data_ids = self._ids_with_user_data()
            for entry in entries:
                if entry in skip:
                    continue
                # One unreadable folder or malformed metadata.json must not
                # take the whole library down (at boot that would crash-loop
                # the container), so each entry is indexed independently.
                try:
                    game = self._build_game(system, flags, system_extensions, entry)
                except Exception as e:  # noqa: BLE001
                    log.warning("Skipping %s: couldn't index it (%s)", entry, e)
                    continue
                if game is None:
                    continue
                if data_ids is not None and entry.suffix.lower() == ".cue" and entry.is_file():
                    self._adopt_track_id(game, entry, system, flags, system_extensions,
                                         roms_root, claims, data_ids)
                self._add_resolving_collision(new_index, game, roms_root, claims)

        if claims != claims_before:
            self._save_id_claims(claims)

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

    # Game IDs come from file/folder names, so two entries can slug to the
    # same ID (every non-Latin title becomes "untitled"; "(USA)" and "[USA]"
    # collide). Saves, playtime, favourites and covers hang off the ID, so
    # once an entry has been through a collision its ID is recorded here,
    # keyed by its path under roms/, and reused on every later scan: adding
    # or removing another same-named file must not move saves between games.
    @staticmethod
    def _claims_path() -> Path:
        return settings.data_dir / ".game-ids.json"

    def _load_id_claims(self) -> dict[str, str]:
        try:
            data = json.loads(self._claims_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)} \
            if isinstance(data, dict) else {}

    def _save_id_claims(self, claims: dict[str, str]) -> None:
        path = self._claims_path()
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(claims, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")
            tmp.replace(path)
        except OSError as e:
            log.warning("Couldn't record game IDs in %s: %s", path, e)

    @staticmethod
    def _ids_with_user_data() -> tuple[set[str], set[str]]:
        """(game IDs with save slots, game IDs with any per-user data)."""
        from ..models.collection import CollectionGame
        from ..models.favorite import Favorite
        from ..models.play_stat import GamePlayStat
        from ..models.slot import SaveSlot

        with SessionLocal() as db:
            saves = {gid for (gid,) in db.query(SaveSlot.game_id).distinct()}
            anything = set(saves)
            for model in (GamePlayStat, Favorite, CollectionGame):
                anything.update(gid for (gid,) in db.query(model.game_id).distinct())
        return saves, anything

    def _adopt_track_id(
        self, game: Game, cue_file: Path, system: str, flags: cores.EmulatorFlags,
        ext_map: dict[str, frozenset[str]], roms_root: Path,
        claims: dict[str, str], data_ids: tuple[set[str], set[str]],
    ) -> None:
        """Carry user data over from older versions for a loose multi-track disc.

        Before .cue support, ``Game.cue`` + ``Game (Track 1).bin`` + ... in a
        system folder were separate games, and the playable one was Track 1
        (the raw .cue couldn't load). Its tracks are now part of the .cue
        game, so without this the saves, playtime and favourites on the old
        track ID would vanish from the UI. The .cue takes over that ID when
        its own ID holds nothing more important; the claim makes it stick.
        """
        rel = str(cue_file.relative_to(roms_root))
        if rel in claims:
            return
        saves, anything = data_ids
        if game.id in saves:
            return
        for _, track in cue.referenced_files(cue_file):
            if track.parent != cue_file.parent:
                continue  # only loose files next to the .cue were games of their own
            old = self._build_game(system, flags, ext_map, track)
            if old is None or old.id == game.id:
                continue
            if old.id in saves or (old.id in anything and game.id not in anything):
                claims[rel] = old.id
                log.info("%s keeps the ID %s from its track %s, which holds user data",
                         rel, old.id, track.name)
                return

    def _with_id(self, game: Game, game_id: str) -> Game:
        cover, custom = self._cover_for(game_id, game.folder)
        return replace(game, id=game_id, cover_path=cover, custom_cover=custom)

    def _add_resolving_collision(
        self, index: dict[str, Game], game: Game, roms_root: Path, claims: dict[str, str],
    ) -> None:
        """Insert ``game``, keeping both games on an ID clash.

        Before this, the later entry silently replaced the earlier one. On
        a first clash the later entry keeps the plain ID (it's the one that
        was visible, so its saves still line up) and the other gets a
        path-derived suffix. Both are then recorded in ``claims``.
        """
        def rel(g: Game) -> str:
            return str((g.folder or g.disks[0]).relative_to(roms_root))

        claimed = claims.get(rel(game))
        if claimed and claimed != game.id:
            game = self._with_id(game, claimed)

        prev = index.get(game.id)
        if prev is None:
            index[game.id] = game
            return

        # The entry that has held this ID before keeps it: a recorded claim
        # first, then whoever held it in the last scan. With neither (first
        # scan after boot/upgrade) the later entry wins, which is what the
        # old last-one-wins indexing showed, so its saves still line up.
        if claims.get(rel(game)) == game.id:
            keep, move = game, prev
        elif claims.get(rel(prev)) == game.id:
            keep, move = prev, game
        else:
            last = self._index.games.get(game.id)
            keep, move = (prev, game) if last is not None and rel(last) == rel(prev) else (game, prev)
        digest = hashlib.sha1(rel(move).encode()).hexdigest()[:6]
        moved = self._with_id(move, f"{game.id}-{digest}")
        index[keep.id] = keep
        index[moved.id] = moved
        claims[rel(keep)] = keep.id
        claims[rel(moved)] = moved.id
        log.warning(
            "Game ID %s is used by both %s and %s; indexing %s as %s",
            game.id, rel(keep), rel(move), rel(move), moved.id,
        )

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
            disks = [folder / name for name in meta_disks if self._is_inside(name) and (folder / name).is_file()]
        else:
            candidates = sorted(
                p for p in folder.iterdir()
                if p.is_file() and cores.is_rom(ext_map, system, p.name)
            )
            tracks = self._cue_tracks(candidates)
            disks = self._filter_preferred(system, [p for p in candidates if p not in tracks])

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
    def _cue_tracks(files: list[Path]) -> set[Path]:
        """Files referenced by a .cue among ``files``: they're part of that
        disc (served with it), not discs of their own."""
        tracks: set[Path] = set()
        for f in files:
            if f.suffix.lower() == ".cue":
                tracks.update(path for _, path in cue.referenced_files(f))
        return tracks

    def _bare_files_to_skip(
        self, system: str, ext_map: dict[str, frozenset[str]], entries: list[Path],
    ) -> set[Path]:
        """Loose files at the system root that belong to another entry: tracks
        of a .cue, or a same-named alternative (Game.bin next to Game.cue)."""
        try:
            files = [e for e in entries if not e.name.startswith(".") and e.is_file()
                     and cores.is_rom(ext_map, system, e.name)]
        except OSError:
            return set()
        tracks = self._cue_tracks(files)
        rest = [f for f in files if f not in tracks]
        return tracks | (set(rest) - set(self._filter_preferred(system, rest)))

    @staticmethod
    def _is_inside(name: object) -> bool:
        """A metadata.json disk entry must name a file inside the game folder.

        Without this, ``"../../../retrox.db"`` would be served as a ROM.
        """
        if not isinstance(name, str) or not name:
            return False
        p = PurePosixPath(name)
        return not p.is_absolute() and ".." not in p.parts

    @staticmethod
    def _read_metadata(folder: Path) -> dict:
        path = folder / "metadata.json"
        if not path.is_file():
            return {}
        try:
            # UTF-8 only, as before: a file this rejects (BOM, UTF-16) was
            # always ignored, and honouring it now would change game IDs.
            # ValueError covers both bad JSON and bad encoding.
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            log.warning("Invalid metadata.json in %s", folder)
            return {}
        if not isinstance(data, dict):
            log.warning("Ignoring metadata.json in %s: expected a JSON object", folder)
            return {}
        return data

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
