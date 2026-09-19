"""Regression tests for gzipped-ROM Range support (issue #7) and the
save-slot name length cap (issue #11)."""
from tests.conftest import SAME_ORIGIN


def test_gz_rom_supports_range_requests(admin_client, seeded_roms):
    res = admin_client.get(
        f"/api/games/{seeded_roms['gz_id']}/rom",
        headers={**SAME_ORIGIN, "Range": "bytes=0-9"},
    )
    assert res.status_code == 206
    assert res.content == b"ROMDATA123"
    assert res.headers["accept-ranges"] == "bytes"


def test_gz_rom_full_response_is_200(admin_client, seeded_roms):
    res = admin_client.get(f"/api/games/{seeded_roms['gz_id']}/rom", headers=SAME_ORIGIN)
    assert res.status_code == 200
    assert res.content == b"ROMDATA1234567890"


def test_gz_rom_reuses_decompressed_cache(admin_client, seeded_roms):
    from app.config import settings

    admin_client.get(f"/api/games/{seeded_roms['gz_id']}/rom", headers=SAME_ORIGIN)
    cached = list(settings.rom_cache_dir.glob("*.rom"))
    assert len(cached) == 1

    # A second request (e.g. a Range seek) must reuse the same cache entry.
    admin_client.get(
        f"/api/games/{seeded_roms['gz_id']}/rom",
        headers={**SAME_ORIGIN, "Range": "bytes=4-"},
    )
    assert list(settings.rom_cache_dir.glob("*.rom")) == cached


def test_plain_rom_still_streams_with_range(admin_client, seeded_roms):
    res = admin_client.get(
        f"/api/games/{seeded_roms['plain_id']}/rom",
        headers={**SAME_ORIGIN, "Range": "bytes=0-4"},
    )
    assert res.status_code == 206
    assert res.content == b"PLAIN"


def test_slot_name_over_cap_rejected(admin_client, seeded_roms):
    res = admin_client.put(
        f"/api/games/{seeded_roms['plain_id']}/saves/1",
        data={"name": "x" * 500},
        headers=SAME_ORIGIN,
    )
    assert res.status_code == 422


def test_slot_name_within_cap_accepted(admin_client, seeded_roms):
    res = admin_client.put(
        f"/api/games/{seeded_roms['plain_id']}/saves/1",
        data={"name": "before final boss"},
        headers=SAME_ORIGIN,
    )
    assert res.status_code == 200
    assert res.json()["name"] == "before final boss"
