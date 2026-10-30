"""CUE sheet support.

EmulatorJS downloads exactly one URL per disc, so serving a bare ``.cue``
leaves the core without the ``.bin`` tracks it references. A ``.cue`` disc
is therefore served as an uncompressed (STORED) zip holding the sheet plus
its tracks; EmulatorJS unpacks archives and picks the cue itself.

The zip is streamed straight from the source files. Its size is known up
front, and each file's CRC-32 is computed once and cached by (path, size,
mtime), so later plays of the same disc cost a single read.
"""
from __future__ import annotations

import re
import struct
import threading
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

_FILE_RE = re.compile(r'^\s*FILE\s+(?:"([^"]+)"|(\S+))', re.IGNORECASE | re.MULTILINE)
_CHUNK = 1024 * 1024
_ZIP_LIMIT = 0xFFFFFFFF  # no ZIP64; PSX discs are well below 4 GiB

_crc_cache: dict[tuple[str, int, int], int] = {}
_crc_lock = threading.Lock()


def referenced_files(cue: Path) -> list[tuple[str, Path]]:
    """``(name as written in the cue, file on disk)`` for every track file.

    Only files inside the cue's folder count. A name that differs only in
    case still matches, since sheets are often written on Windows.
    """
    try:
        text = cue.read_bytes().decode("latin-1")
    except OSError:
        return []
    folder = cue.parent
    by_lower: dict[str, Path] | None = None
    out: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for m in _FILE_RE.finditer(text):
        raw = (m.group(1) or m.group(2)).replace("\\", "/")
        rel = PurePosixPath(raw)
        if rel.is_absolute() or ".." in rel.parts or not rel.parts or raw in seen:
            continue
        path = folder.joinpath(*rel.parts)
        if not path.is_file():
            if by_lower is None:
                by_lower = {p.name.lower(): p for p in folder.iterdir() if p.is_file()}
            path = by_lower.get(raw.lower()) if len(rel.parts) == 1 else None
            if path is None:
                continue
        seen.add(raw)
        out.append((raw, path))
    return out


def _crc32(path: Path, size: int, mtime_ns: int) -> int:
    key = (str(path), size, mtime_ns)
    with _crc_lock:
        if key in _crc_cache:
            return _crc_cache[key]
    crc = 0
    with path.open("rb") as f:
        while chunk := f.read(_CHUNK):
            crc = zlib.crc32(chunk, crc)
    with _crc_lock:
        _crc_cache[key] = crc
    return crc


@dataclass(frozen=True)
class _Member:
    name: bytes
    path: Path
    size: int
    crc: int
    offset: int


@dataclass(frozen=True)
class CueBundle:
    members: tuple[_Member, ...]
    size: int
    etag: str

    def iter_bytes(self) -> Iterator[bytes]:
        for m in self.members:
            yield _local_header(m)
            with m.path.open("rb") as f:
                while chunk := f.read(_CHUNK):
                    yield chunk
        central = b"".join(_central_header(m) for m in self.members)
        cd_offset = self.members[-1].offset + _local_len(self.members[-1]) + self.members[-1].size
        yield central
        yield struct.pack(
            "<IHHHHIIH", 0x06054B50, 0, 0, len(self.members), len(self.members),
            len(central), cd_offset, 0,
        )


def bundle(cue: Path) -> CueBundle | None:
    """Plan the zip for ``cue``; None when it would exceed the zip limit."""
    files = [(cue.name, cue), *referenced_files(cue)]
    members: list[_Member] = []
    offset = 0
    tags: list[str] = []
    for name, path in files:
        st = path.stat()
        m = _Member(name.encode("utf-8"), path, st.st_size, _crc32(path, st.st_size, st.st_mtime_ns), offset)
        members.append(m)
        offset += _local_len(m) + m.size
        tags.append(f"{st.st_size:x}-{st.st_mtime_ns:x}")
    central = sum(46 + len(m.name) for m in members)
    total = offset + central + 22
    if total > _ZIP_LIMIT:
        return None
    etag = '"cue-' + zlib.crc32("|".join(tags).encode()).to_bytes(4, "big").hex() + f'-{total:x}"'
    return CueBundle(tuple(members), total, etag)


# Fixed DOS timestamp (1980-01-01): keeps the bytes, and so the ETag,
# stable for unchanged files. Bit 11 marks names as UTF-8.
_FLAGS = 0x0800
_DOS_TIME, _DOS_DATE = 0, (0 << 9) | (1 << 5) | 1


def _local_len(m: _Member) -> int:
    return 30 + len(m.name)


def _local_header(m: _Member) -> bytes:
    return struct.pack(
        "<IHHHHHIIIHH", 0x04034B50, 20, _FLAGS, 0, _DOS_TIME, _DOS_DATE,
        m.crc, m.size, m.size, len(m.name), 0,
    ) + m.name


def _central_header(m: _Member) -> bytes:
    return struct.pack(
        "<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, _FLAGS, 0, _DOS_TIME, _DOS_DATE,
        m.crc, m.size, m.size, len(m.name), 0, 0, 0, 0, 0, m.offset,
    ) + m.name
