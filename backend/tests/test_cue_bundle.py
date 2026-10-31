"""PSX .cue discs: the emulator downloads a single URL, so a .cue must be
served together with the track files it references (as an uncompressed
zip), and those track files must not show up as extra discs or games."""
import io
import shutil
import zipfile

import pytest

from app.config import settings
from app.services.library import library


@pytest.fixture()
def psx():
    d = settings.roms_dir / "psx"
    d.mkdir(parents=True, exist_ok=True)
    created: list = []
    yield d, created
    for p in created:
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)
    library.scan()


def _game(name):
    return next(g for g in library.index.games.values() if g.name == name)


def _unzip(body: bytes) -> dict[str, bytes]:
    zf = zipfile.ZipFile(io.BytesIO(body))
    assert zf.testzip() is None  # every CRC matches
    return {i.filename: zf.read(i) for i in zf.infolist()}


def test_multi_track_folder_is_one_disc_served_with_its_tracks(admin_client, psx):
    d, created = psx
    folder = d / "Multi Track"
    folder.mkdir()
    created.append(folder)
    (folder / "Game (Track 1).bin").write_bytes(b"T1" * 1000)
    (folder / "Game (Track 2).bin").write_bytes(b"T2" * 500)
    cue = (
        'FILE "Game (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n'
        'FILE "Game (Track 2).bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n'
    )
    (folder / "Game.cue").write_text(cue)
    library.scan()

    game = _game("Multi Track")
    assert [p.name for p in game.disks] == ["Game.cue"]

    res = admin_client.get(f"/api/games/{game.id}/rom/Game.cue?disk=1")
    assert res.status_code == 200, res.text
    files = _unzip(res.content)
    assert files == {
        "Game.cue": cue.encode(),
        "Game (Track 1).bin": b"T1" * 1000,
        "Game (Track 2).bin": b"T2" * 500,
    }
    assert int(res.headers["content-length"]) == len(res.content)

    head = admin_client.head(f"/api/games/{game.id}/rom/Game.cue?disk=1")
    assert head.status_code == 200
    assert head.headers["content-length"] == res.headers["content-length"]

    etag = res.headers["etag"]
    again = admin_client.get(f"/api/games/{game.id}/rom/Game.cue?disk=1", headers={"If-None-Match": etag})
    assert again.status_code == 304


def test_multi_disc_folder_keeps_one_entry_per_cue(admin_client, psx):
    d, created = psx
    folder = d / "Two Discs"
    folder.mkdir()
    created.append(folder)
    for n in (1, 2):
        (folder / f"disc{n}.bin").write_bytes(bytes([n]) * 100)
        (folder / f"disc{n}.cue").write_text(f'FILE "disc{n}.bin" BINARY\n  TRACK 01 MODE2/2352\n')
    library.scan()
    game = _game("Two Discs")
    assert [p.name for p in game.disks] == ["disc1.cue", "disc2.cue"]
    files = _unzip(admin_client.get(f"/api/games/{game.id}/rom/disc2.cue?disk=2").content)
    assert files["disc2.bin"] == bytes([2]) * 100 and "disc1.bin" not in files


def test_bare_cue_and_bin_at_system_root_are_one_game(admin_client, psx):
    d, created = psx
    for name, data in [("Loose.bin", b"L" * 64), ("Loose.cue", b'FILE "Loose.bin" BINARY\n  TRACK 01 MODE2/2352\n')]:
        (d / name).write_bytes(data)
        created.append(d / name)
    library.scan()
    loose = [g for g in library.index.games.values() if g.name == "Loose"]
    assert len(loose) == 1
    assert loose[0].disks[0].name == "Loose.cue"
    files = _unzip(admin_client.get(f"/api/games/{loose[0].id}/rom/Loose.cue?disk=1").content)
    assert files["Loose.bin"] == b"L" * 64


def test_cue_cannot_pull_in_files_outside_its_folder(admin_client, psx):
    d, created = psx
    folder = d / "Sneaky"
    folder.mkdir()
    created.append(folder)
    (folder / "disc.bin").write_bytes(b"ok")
    (folder / "disc.cue").write_text(
        'FILE "../../../retrox.db" BINARY\nFILE "/etc/hosts" BINARY\nFILE "disc.bin" BINARY\n'
    )
    library.scan()
    files = _unzip(admin_client.get(f"/api/games/{_game('Sneaky').id}/rom/disc.cue?disk=1").content)
    assert set(files) == {"disc.cue", "disc.bin"}


def test_cue_file_names_match_case_insensitively(admin_client, psx):
    d, created = psx
    folder = d / "Case"
    folder.mkdir()
    created.append(folder)
    (folder / "disc.bin").write_bytes(b"case")
    (folder / "disc.cue").write_text('FILE "DISC.BIN" BINARY\n  TRACK 01 MODE2/2352\n')
    library.scan()
    files = _unzip(admin_client.get(f"/api/games/{_game('Case').id}/rom/disc.cue?disk=1").content)
    # Stored under the name the cue uses, so the core finds it.
    assert files["DISC.BIN"] == b"case"


def test_plain_disc_formats_are_still_served_raw(admin_client, psx):
    d, created = psx
    (d / "Raw.iso").write_bytes(b"ISO" * 10)
    created.append(d / "Raw.iso")
    library.scan()
    res = admin_client.get(f"/api/games/{_game('Raw').id}/rom/Raw.iso?disk=1")
    assert res.status_code == 200 and res.content == b"ISO" * 10


def test_utf8_cue_sheet_with_accented_names(admin_client, psx):
    d, created = psx
    folder = d / "Accents"
    folder.mkdir()
    created.append(folder)
    (folder / "Pokémon (Track 1).bin").write_bytes(b"A" * 100)
    (folder / "Pokémon (Track 2).bin").write_bytes(b"B" * 100)
    (folder / "Pokémon.cue").write_bytes(
        'FILE "Pokémon (Track 1).bin" BINARY\nFILE "Pokémon (Track 2).bin" BINARY\n'.encode())
    library.scan()
    game = _game("Accents")
    assert [p.name for p in game.disks] == ["Pokémon.cue"]
    files = _unzip(admin_client.get(f"/api/games/{game.id}/rom/x.cue?disk=1").content)
    assert files["Pokémon (Track 1).bin"] == b"A" * 100 and files["Pokémon (Track 2).bin"] == b"B" * 100


def test_head_does_not_read_the_tracks(admin_client, psx, monkeypatch):
    """EmulatorJS sends HEAD before GET; sizing the zip must not CRC the disc."""
    from app.services import cue as cue_service
    d, created = psx
    folder = d / "Headcheck"
    folder.mkdir()
    created.append(folder)
    (folder / "disc.bin").write_bytes(b"H" * 1000)
    (folder / "disc.cue").write_text('FILE "disc.bin" BINARY\n')
    library.scan()
    calls = []
    real = cue_service._crc32
    monkeypatch.setattr(cue_service, "_crc32", lambda *a: calls.append(a) or real(*a))
    gid = _game("Headcheck").id
    head = admin_client.head(f"/api/games/{gid}/rom/disc.cue?disk=1")
    assert head.status_code == 200 and calls == []
    get = admin_client.get(f"/api/games/{gid}/rom/disc.cue?disk=1")
    assert int(get.headers["content-length"]) == len(get.content) == int(head.headers["content-length"])
    assert get.headers["etag"] == head.headers["etag"]
    again = admin_client.get(f"/api/games/{gid}/rom/disc.cue?disk=1", headers={"If-None-Match": head.headers["etag"]})
    assert again.status_code == 304
