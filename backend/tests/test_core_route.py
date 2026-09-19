"""Regression tests for the /emulatorjs/cores path-traversal fix (issue #1)."""
from app.config import settings
from tests.conftest import SAME_ORIGIN


def test_core_route_serves_real_core(admin_client):
    core = settings.cores_dir / "test-core.data"
    core.write_bytes(b"COREDATABYTES")

    res = admin_client.get("/emulatorjs/cores/test-core.data", headers=SAME_ORIGIN)
    assert res.status_code == 200
    assert res.content == b"COREDATABYTES"


def test_core_route_blocks_traversal_to_sibling_cores_dir(admin_client):
    # A sibling directory whose name starts with "cores" must NOT be readable
    # through /emulatorjs/cores/../<name>/ — the old prefix check allowed it.
    secret = settings.data_dir / "cores-secret"
    secret.mkdir(parents=True, exist_ok=True)
    (secret / "secret.txt").write_text("TOPSECRET")

    res = admin_client.get("/emulatorjs/cores/%2e%2e/cores-secret/secret.txt", headers=SAME_ORIGIN)
    assert res.status_code == 404
    assert b"TOPSECRET" not in res.content


def test_core_route_blocks_traversal_to_other_data_dirs(admin_client):
    outside = settings.covers_dir
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "x.jpg").write_bytes(b"IMG")

    res = admin_client.get("/emulatorjs/cores/../covers/x.jpg", headers=SAME_ORIGIN)
    assert res.status_code == 404


def test_core_route_404_for_missing_file(admin_client):
    res = admin_client.get("/emulatorjs/cores/does-not-exist.data", headers=SAME_ORIGIN)
    assert res.status_code == 404
