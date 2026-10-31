"""GET /api/games sorts the whole result set (not just one page) and
reports every system present, so chips and "Recently Added" work for
libraries larger than one page."""
import time

import pytest

from app.config import settings
from app.db import SessionLocal
from app.models import GameMeta
from app.services.library import library


@pytest.fixture()
def sort_roms():
    created = []
    for system, name in [("gb", "Bravo"), ("gb", "Delta"), ("gbc", "Alpha"), ("gbc", "Charlie")]:
        d = settings.roms_dir / system
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"Sorttest {name}.{system}"
        p.write_bytes(b"ROM")
        created.append(p)
        library.scan()  # one scan per file → distinct, increasing added_at
        time.sleep(0.01)
    yield created
    for p in created:
        p.unlink(missing_ok=True)
    library.scan()


def _names(client, **params):
    res = client.get("/api/games", params={"q": "sorttest", **params})
    assert res.status_code == 200, res.text
    return res.json()


def _all_pages(client, **params):
    out, page = [], 1
    while True:
        body = _names(client, page=page, page_size=1, **params)
        out += [g["name"] for g in body["items"]]
        if page * 1 >= body["total"]:
            return out
        page += 1


def test_name_sort_spans_pages_and_uses_display_names(admin_client, sort_roms):
    with SessionLocal() as db:
        meta = db.query(GameMeta).filter(GameMeta.game_id == "gb:sorttest-delta").one()
        meta.display_name = "Sorttest Aardvark"
        db.commit()
    try:
        assert _all_pages(admin_client, sort="name") == [
            "Sorttest Aardvark", "Sorttest Alpha", "Sorttest Bravo", "Sorttest Charlie",
        ]
    finally:
        with SessionLocal() as db:
            db.query(GameMeta).filter(GameMeta.game_id == "gb:sorttest-delta").one().display_name = None
            db.commit()


def test_recently_added_sort_spans_pages(admin_client, sort_roms):
    assert _all_pages(admin_client, sort="recent") == [
        "Sorttest Charlie", "Sorttest Alpha", "Sorttest Delta", "Sorttest Bravo",
    ]


def test_system_sort(admin_client, sort_roms):
    assert _all_pages(admin_client, sort="system") == [
        "Sorttest Bravo", "Sorttest Delta", "Sorttest Alpha", "Sorttest Charlie",
    ]


def test_systems_cover_the_whole_result_not_one_page(admin_client, sort_roms):
    body = _names(admin_client, page=1, page_size=1, sort="name")
    assert len(body["items"]) == 1
    assert body["systems"] == ["gb", "gbc"]
    # A system filter still reports the systems of the unfiltered set,
    # so the chip row stays complete while one chip is active.
    body = _names(admin_client, page=1, page_size=1, system="gb")
    assert body["systems"] == ["gb", "gbc"]
    assert body["total"] == 2


def test_default_sort_is_unchanged(admin_client, sort_roms):
    # No sort param → previous behaviour (system, then name).
    assert _all_pages(admin_client) == _all_pages(admin_client, sort="system")
