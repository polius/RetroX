"""Regression tests for collection rename validation (issue #9)."""
from tests.conftest import SAME_ORIGIN


def _create(client, name):
    return client.post("/api/collections", json={"name": name}, headers=SAME_ORIGIN)


def _set_games(client, collection_id, game_ids):
    return client.put(f"/api/collections/{collection_id}/games", json={"game_ids": game_ids}, headers=SAME_ORIGIN)


def _rename(client, collection_id, name):
    return client.patch(f"/api/collections/{collection_id}", json={"name": name}, headers=SAME_ORIGIN)


def test_rename_to_duplicate_name_rejected(admin_client):
    first = _create(admin_client, "Mario").json()
    second = _create(admin_client, "Luigi").json()

    res = _rename(admin_client, second["id"], "Mario")
    assert res.status_code == 409

    # Renaming to its own current name is fine (not a duplicate).
    assert _rename(admin_client, first["id"], "Mario").status_code == 200


def test_rename_to_whitespace_only_rejected(admin_client):
    c = _create(admin_client, "Temporary").json()

    res = _rename(admin_client, c["id"], "   ")
    assert res.status_code == 400


def test_rename_to_empty_string_rejected(admin_client):
    res = _rename(admin_client, _create(admin_client, "Another").json()["id"], "")
    assert res.status_code == 422  # schema-level min_length


def test_create_whitespace_only_name_rejected(admin_client):
    res = _create(admin_client, "   ")
    assert res.status_code == 400


def test_rename_still_works(admin_client):
    c = _create(admin_client, "Old Name").json()
    res = _rename(admin_client, c["id"], "  New Name  ")
    assert res.status_code == 200
    assert res.json()["name"] == "New Name"


def test_membership_survives_a_scan_that_misses_the_game(admin_client, seeded_roms):
    """A ROM share that's offline for one scan must not empty collections."""
    from app.services.library import library

    gid = seeded_roms["plain_id"]
    c = _create(admin_client, "Survivors").json()
    assert _set_games(admin_client, c["id"], [gid]).status_code == 204

    # The ROM disappears for a scan (share offline, typo in extensions…).
    hidden = seeded_roms["plain"].with_suffix(".offline")
    seeded_roms["plain"].rename(hidden)
    library.scan()
    listed = {x["id"]: x for x in admin_client.get("/api/collections").json()}
    assert listed[c["id"]]["game_count"] == 0  # stale rows aren't counted
    assert admin_client.get(f"/api/collections/{c['id']}/games").json() == []
    # Editing the collection meanwhile must not drop the hidden member.
    other = seeded_roms["gz_id"]
    assert _set_games(admin_client, c["id"], [other]).status_code == 204

    # It comes back.
    hidden.rename(seeded_roms["plain"])
    library.scan()
    ids = {g["id"] for g in admin_client.get(f"/api/collections/{c['id']}/games").json()}
    assert ids == {gid, other}
    listed = {x["id"]: x for x in admin_client.get("/api/collections").json()}
    assert listed[c["id"]]["game_count"] == 2
