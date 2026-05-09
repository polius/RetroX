"""Mapping between system folders / file extensions and EmulatorJS cores.

Reads emulator definitions from the database. Falls back to hardcoded defaults
only if the DB is not yet initialized.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

# PSX BIN/CUE deduplication: prefer these extensions when both are present.
PREFERRED_EXTENSIONS: dict[str, tuple[str, ...]] = {
    "psx": ("cue", "chd", "pbp", "iso", "bin"),
}


@dataclass(frozen=True)
class EmulatorFlags:
    core: str
    fast_forward_enabled: bool
    rewind_enabled: bool


def _load_maps(db: Session) -> tuple[dict[str, EmulatorFlags], dict[str, frozenset[str]]]:
    """Build system→flags and system→extensions maps from the emulators table."""
    from ..models import Emulator

    system_flags: dict[str, EmulatorFlags] = {}
    system_extensions: dict[str, frozenset[str]] = {}
    for emu in db.query(Emulator).all():
        system_flags[emu.system] = EmulatorFlags(
            core=emu.core,
            fast_forward_enabled=bool(emu.fast_forward_enabled),
            rewind_enabled=bool(emu.rewind_enabled),
        )
        exts = frozenset(e.strip().lower() for e in emu.extensions.split(",") if e.strip())
        system_extensions[emu.system] = exts
    return system_flags, system_extensions


def is_rom(extensions_map: dict[str, frozenset[str]], system: str, filename: str) -> bool:
    name = filename
    # Strip .gz wrapper so "tetris.gb.gz" is recognised as a .gb ROM
    if name.lower().endswith(".gz"):
        name = name[:-3]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext in extensions_map.get(system, frozenset())
