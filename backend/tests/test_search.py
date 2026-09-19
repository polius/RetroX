"""Regression tests for display-name/slug search (issue #2)."""
import pytest

from tests.conftest import SAME_ORIGIN


def _rename(client, game_id, payload):
    return client.patch(
        f"/api/admin/games/{game_id}/name", json=payload, headers=SAME_ORIGIN,
    )


def test_search_matches_admin_display_name(admin_client, seeded_roms):
    gid = seeded_roms["plain_id"]
    assert _rename(admin_client, gid, {"name": "Super Awesome Game"}).status_code == 204

    res = admin_client.get("/api/games", params={"q": "Super Awesome"}, headers=SAME_ORIGIN)
    assert res.status_code == 200
    body = res.json()
    assert body["total"] == 1
    assert body["items"][0]["name"] == "Super Awesome Game"

    # The original filesystem name still matches too.
    res = admin_client.get("/api/games", params={"q": "Alpha"}, headers=SAME_ORIGIN)
    assert res.json()["total"] == 1


def test_search_matches_slug(admin_client, seeded_roms):
    gid = seeded_roms["gz_id"]
    detail = admin_client.get(f"/api/games/{gid}", headers=SAME_ORIGIN).json()
    # Slugs carry a system suffix ("Gz Game" -> "gz-game-gb"); a partial,
    # case-insensitive query must still hit the slug column.
    partial = detail["slug"].rsplit("-", 1)[0]
    res = admin_client.get("/api/games", params={"q": partial}, headers=SAME_ORIGIN)
    assert res.json()["total"] == 1


def test_admin_library_search_matches_display_name(admin_client, seeded_roms):
    gid = seeded_roms["gz_id"]
    assert _rename(admin_client, gid, {"name": "Zeldalike Adventure"}).status_code == 204

    res = admin_client.get("/api/admin/games", params={"q": "Zeldalike"}, headers=SAME_ORIGIN)
    assert res.status_code == 200
    names = [g["name"] for g in res.json()]
    assert "Zeldalike Adventure" in names


@pytest.fixture(autouse=True)
def _restore_names(admin_client, seeded_roms):
    """Renames in one test must not leak into the others."""
    yield
    for gid in (seeded_roms["plain_id"], seeded_roms["gz_id"]):
        _rename(admin_client, gid, {"name": None})
