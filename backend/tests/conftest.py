"""Shared pytest fixtures. Point settings at a throwaway data dir BEFORE
any app module import (config reads the environment at import time)."""
import os
import tempfile

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_TEST_DATA_DIR = tempfile.mkdtemp(prefix="retrox-test-data-")

os.environ.setdefault("RETROX_DATA_DIR", _TEST_DATA_DIR)
os.environ.setdefault("RETROX_FRONTEND_DIR", os.path.join(_REPO_ROOT, "frontend"))
os.environ.setdefault("RETROX_EMULATORJS_DIR", os.path.join(_REPO_ROOT, "docker", "emulatorjs"))

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.library import library

# The CSRF-style origin middleware rejects state-changing requests without
# a same-origin signal; TestClient requests carry none by default.
SAME_ORIGIN = {"Origin": "http://testserver"}


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def admin_client(client):
    """Session-scoped client signed in as the bootstrap admin."""
    res = client.post(
        "/api/auth/login",
        json={"username": settings.admin_username, "password": settings.admin_password},
        headers=SAME_ORIGIN,
    )
    assert res.status_code == 200, res.text
    return client


@pytest.fixture()
def seeded_roms():
    """Create two ROMs (one gzipped) and refresh the in-memory index."""
    import gzip

    roms = settings.roms_dir / "gb"
    roms.mkdir(parents=True, exist_ok=True)
    plain = roms / "Alpha Game.gb"
    gz = roms / "Gz Game.gb.gz"
    plain.write_bytes(b"PLAIN ROM CONTENTS 0123456789")
    gz.write_bytes(gzip.compress(b"ROMDATA1234567890"))

    library.scan()

    def _id_for(name: str) -> str:
        matches = [g.id for g in library.index.games.values() if name in g.name]
        assert len(matches) == 1, f"expected exactly one ROM matching {name!r}"
        return matches[0]

    return {
        "plain": plain,
        "gz": gz,
        "plain_id": _id_for("Alpha Game"),
        "gz_id": _id_for("Gz Game"),
    }
