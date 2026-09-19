"""Unit tests for pure-logic helpers (slugify) and admin download headers."""
from app.services.library import slugify
from tests.conftest import SAME_ORIGIN


def test_slugify_basic():
    assert slugify("Hello World!") == "hello-world"


def test_slugify_strips_and_lowercases():
    assert slugify("  Super Mario 64 (USA)  ") == "super-mario-64-usa"


def test_slugify_falls_back_to_untitled():
    assert slugify("★") == "untitled"


def test_admin_save_download_has_content_disposition(admin_client, seeded_roms):
    gid = seeded_roms["plain_id"]
    created = admin_client.put(
        f"/api/games/{gid}/saves/1",
        files={"save": ("slot1.sav", b"SAVEBYTES", "application/octet-stream")},
        data={"name": "backup"},
        headers=SAME_ORIGIN,
    )
    assert created.status_code == 200

    # Slot summaries don't carry the DB id; look it up via the admin list.
    rows = admin_client.get("/api/admin/saves", headers=SAME_ORIGIN).json()
    save_id = next(r["id"] for r in rows if r["game_id"] == gid and r["slot"] == 1)

    res = admin_client.get(f"/api/admin/saves/{save_id}/save", headers=SAME_ORIGIN)
    assert res.status_code == 200
    disposition = res.headers["content-disposition"]
    assert 'filename="gb_alpha-game_slot1.save"' in disposition
    assert res.content == b"SAVEBYTES"
