"""Save uploads: an empty file must never replace real progress, and a
device holding a version number for a slot that was deleted elsewhere
must not silently recreate it."""
from tests.conftest import SAME_ORIGIN


def _put(client, gid, slot, *, save=None, state=None, gen=None):
    files = {}
    if save is not None:
        files["save"] = ("save.bin", save)
    if state is not None:
        files["state"] = ("state.bin", state)
    headers = dict(SAME_ORIGIN)
    if gen is not None:
        headers["X-Slot-Generation"] = str(gen)
    return client.put(f"/api/games/{gid}/saves/{slot}", files=files, headers=headers)


def _delete(client, gid, slot):
    return client.delete(f"/api/games/{gid}/saves/{slot}", headers=SAME_ORIGIN)


def test_empty_save_is_rejected_and_progress_kept(admin_client, seeded_roms):
    gid = seeded_roms["plain_id"]
    _delete(admin_client, gid, 2)
    first = _put(admin_client, gid, 2, save=b"PROGRESS")
    assert first.status_code == 200, first.text
    gen = first.json()["generation"]

    res = _put(admin_client, gid, 2, save=b"", gen=gen)
    assert res.status_code == 400
    assert admin_client.get(f"/api/games/{gid}/saves/2/save").content == b"PROGRESS"


def test_empty_state_is_rejected(admin_client, seeded_roms):
    gid = seeded_roms["plain_id"]
    res = _put(admin_client, gid, 3, state=b"")
    assert res.status_code == 400


def test_stale_device_cannot_resurrect_a_deleted_slot(admin_client, seeded_roms):
    gid = seeded_roms["plain_id"]
    _delete(admin_client, gid, 4)
    created = _put(admin_client, gid, 4, save=b"A")
    gen = created.json()["generation"]
    assert _delete(admin_client, gid, 4).status_code == 204

    # The other device still believes the slot is at `gen`.
    res = _put(admin_client, gid, 4, save=b"STALE", gen=gen)
    assert res.status_code == 409
    listed = admin_client.get(f"/api/games/{gid}/saves").json()
    assert all(s["slot"] != 4 for s in listed.get("slots", listed if isinstance(listed, list) else []))

    # An explicit overwrite (no version header, e.g. "Use my version") still works.
    assert _put(admin_client, gid, 4, save=b"MINE").status_code == 200


def test_first_upload_to_a_new_slot_still_works(admin_client, seeded_roms):
    gid = seeded_roms["plain_id"]
    _delete(admin_client, gid, 5)
    res = _put(admin_client, gid, 5, save=b"NEW")
    assert res.status_code == 200 and res.json()["generation"] == 1
    res = _put(admin_client, gid, 5, save=b"NEWER", gen=1)
    assert res.status_code == 200 and res.json()["generation"] == 2
