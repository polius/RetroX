"""Phone-controller WebSockets must not hold a pooled DB connection while
they're open: ~15 of them used to exhaust the pool and hang every HTTP
request for 30 s."""
from app.db import _engine
from app.limiter import limiter
from tests.conftest import SAME_ORIGIN

WS_HEADERS = {"origin": "http://testserver", "sec-fetch-site": "same-origin"}


def _start(client) -> dict:
    res = client.post("/api/controller/start", headers=SAME_ORIGIN)
    assert res.status_code == 200, res.text
    return res.json()


def test_open_sockets_hold_no_db_connection(admin_client):
    limiter.reset()
    pool = _engine.pool
    baseline = pool.checkedout()
    s = _start(admin_client)
    with admin_client.websocket_connect(f"/api/controller/host?token={s['token']}", headers=WS_HEADERS) as host:
        assert host.receive_json()["t"] == "pad-state"
        with admin_client.websocket_connect(f"/api/controller/pad?code={s['code']}", headers=WS_HEADERS) as pad:
            assert pad.receive_json()["t"] == "hello"
            assert host.receive_json()["t"] == "pad-state"
            assert pool.checkedout() == baseline, "an open socket is holding a DB connection"
            # Input still flows end to end.
            pad.send_json({"t": "d", "b": 0})
            assert host.receive_json() == {"t": "d", "b": 0}
            # HTTP keeps working while sockets are open.
            assert admin_client.get("/api/auth/me").status_code == 200
    # The host leaving still deletes the pairing row.
    assert admin_client.get(f"/api/controller/lookup/{s['code']}").status_code == 404
