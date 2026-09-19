"""Regression tests for collection rename validation (issue #9)."""
from tests.conftest import SAME_ORIGIN


def _create(client, name):
    return client.post("/api/collections", json={"name": name}, headers=SAME_ORIGIN)


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
