"""Library scan safety: metadata.json can't reach outside the game folder,
and one malformed entry can't take the whole scan down."""
import json
import os
import shutil

import pytest

from app.config import settings
from app.services.library import library


@pytest.fixture()
def psx_dir():
    d = settings.roms_dir / "psx"
    d.mkdir(parents=True, exist_ok=True)
    created: list = []
    yield d, created
    for p in created:
        if p.is_dir():
            os.chmod(p, 0o755)
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)
    library.scan()


def _folder(psx, created, name, metadata=None, raw=None, files=("disc.iso",)):
    folder = psx / name
    folder.mkdir()
    created.append(folder)
    for f in files:
        (folder / f).write_bytes(b"ISO")
    if raw is not None:
        (folder / "metadata.json").write_bytes(raw)
    elif metadata is not None:
        (folder / "metadata.json").write_text(json.dumps(metadata))
    return folder


def test_metadata_disks_cannot_escape_game_folder(admin_client, psx_dir):
    psx, created = psx_dir
    _folder(psx, created, "Escape", {"disks": ["../../../retrox.db", "/etc/hosts", "disc.iso"]})
    library.scan()
    game = next(g for g in library.index.games.values() if g.name == "Escape")
    assert [d.name for d in game.disks] == ["disc.iso"]
    # Only one disk is exposed; disk 2 (what used to be the DB) is gone.
    assert admin_client.get(f"/api/games/{game.id}/rom?disk=2").status_code == 404


def test_metadata_with_only_escaping_disks_is_skipped(psx_dir):
    psx, created = psx_dir
    _folder(psx, created, "OnlyEscape", {"disks": ["../../../retrox.db"]})
    library.scan()
    assert not any(g.name == "OnlyEscape" for g in library.index.games.values())


@pytest.mark.parametrize("raw", [
    b"[]",
    json.dumps({"disks": [1, None, {"a": 1}]}).encode(),
    json.dumps({"name": 42}).encode(),
    '{"name": "Utf16"}'.encode("utf-16"),
    b"\xff\xfe\x00garbage",
])
def test_malformed_metadata_does_not_abort_scan(psx_dir, raw):
    psx, created = psx_dir
    _folder(psx, created, "Broken", raw=raw)
    _folder(psx, created, "Healthy")
    library.scan()  # must not raise
    names = {g.name for g in library.index.games.values()}
    assert "Healthy" in names


def test_unreadable_folder_does_not_abort_scan(psx_dir):
    if os.geteuid() == 0:
        pytest.skip("root ignores directory permissions")
    psx, created = psx_dir
    locked = _folder(psx, created, "Locked")
    _folder(psx, created, "Healthy2")
    os.chmod(locked, 0)
    library.scan()  # must not raise
    assert "Healthy2" in {g.name for g in library.index.games.values()}


@pytest.fixture()
def gb_files():
    d = settings.roms_dir / "gb"
    d.mkdir(parents=True, exist_ok=True)
    created: list = []
    yield d, created
    for p in created:
        p.unlink(missing_ok=True)
    library.scan()


def test_colliding_ids_keep_every_game(gb_files):
    gb, created = gb_files
    for name in ("ポケモン.gb", "ゼルダ.gb", "Pokemon Red (USA).gb", "Pokemon Red [USA].gb"):
        (gb / name).write_bytes(b"ROM")
        created.append(gb / name)
    library.scan()
    names = {g.name: g.id for g in library.index.games.values() if g.system == "gb"}
    for stem in ("ポケモン", "ゼルダ", "Pokemon Red (USA)", "Pokemon Red [USA]"):
        assert stem in names, f"{stem} was dropped"
    # The entry that used to win the collision (last in sorted order) keeps
    # the plain ID, so its existing saves still line up.
    assert names["Pokemon Red [USA]"] == "gb:pokemon-red-usa"
    assert names["Pokemon Red (USA)"].startswith("gb:pokemon-red-usa-")
    assert names[sorted(["ポケモン", "ゼルダ"])[-1]] == "gb:untitled"
    # IDs are stable across rescans.
    library.scan()
    again = {g.name: g.id for g in library.index.games.values() if g.system == "gb"}
    assert again == names


def test_colliding_ids_stay_put_when_files_come_and_go(gb_files):
    """Once assigned, an ID sticks to its file: adding or removing another
    file with the same slug must not move saves between games."""
    gb, created = gb_files
    (settings.data_dir / ".game-ids.json").unlink(missing_ok=True)  # earlier tests record claims too
    def add(name):
        (gb / name).write_bytes(b"ROM")
        created.append(gb / name)
    def ids():
        games = library.index.games.values()
        return {g.name: g.id for g in games if g.system == "gb" and g.id.startswith("gb:untitled")}

    add("ゼルダ.gb")                       # alone: plain id
    library.scan()
    assert ids() == {"ゼルダ": "gb:untitled"}
    add("ポケモン.gb")                     # sorts after ゼルダ
    library.scan()
    first = ids()
    assert first["ゼルダ"] == "gb:untitled", "the existing game must keep its id"
    assert first["ポケモン"].startswith("gb:untitled-")
    (gb / "ゼルダ.gb").unlink()             # the plain-id holder goes away
    library.scan()
    assert ids() == {"ポケモン": first["ポケモン"]}, "the remaining game keeps its suffixed id"
    add("ゼルダ.gb")                       # and comes back
    library.scan()
    assert ids() == first


def test_bom_metadata_keeps_its_previous_meaning(psx_dir):
    """metadata.json with a UTF-8 BOM was ignored before; honouring it now
    would silently change the game's id on upgrade."""
    psx, created = psx_dir
    _folder(psx, created, "Bom Folder", raw=b"\xef\xbb\xbf" + json.dumps({"name": "Other Name"}).encode())
    library.scan()
    assert any(g.name == "Bom Folder" for g in library.index.games.values())
