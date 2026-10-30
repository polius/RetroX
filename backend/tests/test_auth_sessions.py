"""Session lifecycle: admin credential resets end the user's sessions,
deleted users don't leave recovery passwords behind, and the recorded
session IP can't be spoofed with X-Forwarded-For."""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.limiter import limiter
from app.main import app
from app.services import recovery as recovery_service
from tests.conftest import SAME_ORIGIN

PASSWORD = "correct-horse-1"


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    # Every TestClient shares one fake IP, so /login's 5/minute limit
    # would otherwise trip across tests.
    limiter.reset()


def _new_user(admin_client, is_admin=False) -> tuple[int, str]:
    name = f"u{uuid.uuid4().hex[:8]}"
    res = admin_client.post(
        "/api/admin/users",
        json={"username": name, "password": PASSWORD, "is_admin": is_admin},
        headers=SAME_ORIGIN,
    )
    assert res.status_code == 201, res.text
    return res.json()["id"], name


def _login(username: str, password: str = PASSWORD, headers: dict | None = None) -> TestClient:
    c = TestClient(app)
    res = c.post(
        "/api/auth/login",
        json={"username": username, "password": password},
        headers={**SAME_ORIGIN, **(headers or {})},
    )
    assert res.status_code == 200, res.text
    return c


def test_admin_password_reset_signs_the_user_out(admin_client):
    uid, name = _new_user(admin_client)
    victim = _login(name)
    assert victim.get("/api/auth/me").status_code == 200

    res = admin_client.patch(f"/api/admin/users/{uid}", json={"password": "new-password-9"}, headers=SAME_ORIGIN)
    assert res.status_code == 200, res.text

    assert victim.get("/api/auth/me").status_code == 401
    _login(name, "new-password-9")  # the new password works


def test_admin_disable_2fa_signs_the_user_out(admin_client):
    uid, name = _new_user(admin_client)
    victim = _login(name)
    res = admin_client.patch(f"/api/admin/users/{uid}", json={"disable_2fa": True}, headers=SAME_ORIGIN)
    assert res.status_code == 200, res.text
    assert victim.get("/api/auth/me").status_code == 401


def test_admin_rename_only_keeps_sessions(admin_client):
    uid, name = _new_user(admin_client)
    victim = _login(name)
    res = admin_client.patch(f"/api/admin/users/{uid}", json={"username": name + "x"}, headers=SAME_ORIGIN)
    assert res.status_code == 200, res.text
    assert victim.get("/api/auth/me").status_code == 200


def test_admin_resetting_own_password_keeps_current_browser(admin_client):
    uid, name = _new_user(admin_client, is_admin=True)
    me = _login(name)
    other_device = _login(name)
    res = me.patch(f"/api/admin/users/{uid}", json={"password": "new-password-9"}, headers=SAME_ORIGIN)
    assert res.status_code == 200, res.text
    assert me.get("/api/auth/me").status_code == 200
    assert other_device.get("/api/auth/me").status_code == 401


def test_admin_password_reset_clears_pending_recovery(admin_client):
    uid, name = _new_user(admin_client)
    recovery_service.generate_and_store(name)
    assert recovery_service._recovery_path(name).exists()
    res = admin_client.patch(f"/api/admin/users/{uid}", json={"password": "new-password-9"}, headers=SAME_ORIGIN)
    assert res.status_code == 200, res.text
    assert not recovery_service._recovery_path(name).exists()


def test_deleting_a_user_clears_pending_recovery(admin_client):
    uid, name = _new_user(admin_client)
    recovery_service.generate_and_store(name)
    assert recovery_service._recovery_path(name).exists()
    res = admin_client.delete(f"/api/admin/users/{uid}", headers=SAME_ORIGIN)
    assert res.status_code == 204, res.text
    assert not recovery_service._recovery_path(name).exists()


def test_session_ip_ignores_spoofed_forwarded_for(admin_client):
    _, name = _new_user(admin_client)
    c = _login(name, headers={"X-Forwarded-For": "203.0.113.9"})
    sessions = c.get("/api/profile/sessions").json()
    assert sessions, "expected the new session to be listed"
    assert all(s.get("ip_address") != "203.0.113.9" for s in sessions)


def test_bootstrap_admin_still_logs_in():
    _login(settings.admin_username, settings.admin_password)
