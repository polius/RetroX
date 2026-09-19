"""Regression tests for the typed game-meta PATCH schema (issue #11)."""
from tests.conftest import SAME_ORIGIN


def _patch(client, game_id, payload):
    return client.patch(f"/api/admin/games/{game_id}/name", json=payload, headers=SAME_ORIGIN)


def test_oversized_name_rejected(admin_client, seeded_roms):
    res = _patch(admin_client, seeded_roms["plain_id"], {"name": "x" * 500})
    assert res.status_code == 422


def test_empty_name_clears_display_name(admin_client, seeded_roms):
    # "" is the admin UI's "clear this field" signal, not an error.
    gid = seeded_roms["plain_id"]
    assert _patch(admin_client, gid, {"name": "Temp"}).status_code == 204
    assert _patch(admin_client, gid, {"name": ""}).status_code == 204
    detail = admin_client.get(f"/api/games/{gid}", headers=SAME_ORIGIN).json()
    assert detail["name"] == "Alpha Game"  # falls back to filesystem name


def test_oversized_release_date_rejected(admin_client, seeded_roms):
    res = _patch(admin_client, seeded_roms["plain_id"], {"release_date": "x" * 100})
    assert res.status_code == 422


def test_oversized_description_rejected(admin_client, seeded_roms):
    res = _patch(admin_client, seeded_roms["plain_id"], {"description": "x" * 3000})
    assert res.status_code == 422


def test_valid_meta_update_roundtrip(admin_client, seeded_roms):
    gid = seeded_roms["plain_id"]
    res = _patch(admin_client, gid, {
        "name": "Renamed Game",
        "description": "  A description  ",
        "release_date": "September 07, 2005",
    })
    assert res.status_code == 204

    detail = admin_client.get(f"/api/games/{gid}", headers=SAME_ORIGIN).json()
    assert detail["name"] == "Renamed Game"
    assert detail["description"] == "A description"
    assert detail["release_date"] == "September 07, 2005"


def test_clearing_name_via_null(admin_client, seeded_roms):
    gid = seeded_roms["plain_id"]
    assert _patch(admin_client, gid, {"name": "Temp"}).status_code == 204
    assert _patch(admin_client, gid, {"name": None}).status_code == 204
    detail = admin_client.get(f"/api/games/{gid}", headers=SAME_ORIGIN).json()
    assert detail["name"] == "Alpha Game"  # falls back to filesystem name
