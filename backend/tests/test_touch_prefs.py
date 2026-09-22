"""Tests for the touch_layout preference key (on-screen control customization).

The PUT endpoint MERGES sanitized keys into the stored prefs, so each test
first writes a known full base and asserts relative to it.
"""
from tests.conftest import SAME_ORIGIN

BASE = {
  "scale": 1.25,
    "opacity": 0.6,
    "shape": "square",
    "lefty": True,
    "layouts": {
        "gb:landscape": {"a": {"x": 88.5, "y": 51.2}, "dpad": {"x": 11.1, "y": 50}},
        "gb:portrait": {"a": {"x": 90, "y": 80}},
    },
}


def _put(client, data):
    return client.put(
        "/api/profile/preferences",
        json={"data": {"touch_layout": data}},
        headers=SAME_ORIGIN,
    )


def _get(client):
    return client.get("/api/profile/preferences", headers=SAME_ORIGIN).json()["touch_layout"]


def test_touch_layout_roundtrip(admin_client):
    _put(admin_client, BASE)
    stored = _get(admin_client)
    assert stored["scale"] == 1.25
    assert stored["opacity"] == 0.6
    assert stored["shape"] == "square"
    assert stored["lefty"] is True
    assert stored["layouts"]["gb:landscape"]["a"] == {"x": 88.5, "y": 51.2}
    assert stored["layouts"]["gb:landscape"]["dpad"] == {"x": 11.1, "y": 50}


def test_touch_layout_values_clamped(admin_client):
    _put(admin_client, {**BASE, "scale": 9.9, "opacity": -3, "layouts": {
        "gb:landscape": {"a": {"x": 150, "y": -20}},
    }})
    stored = _get(admin_client)
    assert stored["scale"] == 1.8
    assert stored["opacity"] == 0.25
    assert stored["layouts"]["gb:landscape"]["a"] == {"x": 100, "y": 0}


def test_touch_layout_junk_fields_dropped(admin_client):
    _put(admin_client, BASE)
    _put(admin_client, {
        "scale": "big",
        "shape": "triangular",
        "lefty": "sometimes",
        "layouts": {
            "DROP TABLE:landscape": {"a": {"x": 1, "y": 2}},   # bad map key
            "gb:landscape": {"evil();": {"x": 1, "y": 2}},     # bad control id
        },
    })
    stored = _get(admin_client)
    # Invalid fields are dropped; the sanitized remainder replaces the
    # whole touch_layout object (the frontend always sends the full state).
    assert "scale" not in stored
    assert "shape" not in stored
    assert "lefty" not in stored
    assert stored["layouts"] == {}


def test_touch_layout_invalid_payload_ignored(admin_client):
    _put(admin_client, BASE)
    for bad in ([1, 2], "yes", 42, None):
        _put(admin_client, bad)
    # A payload whose touch_layout can't be sanitized at all leaves the
    # previous value untouched.
    assert _get(admin_client) == BASE


def test_touch_layout_survives_other_pref_update(admin_client):
    _put(admin_client, BASE)
    admin_client.put(
        "/api/profile/preferences",
        json={"data": {"theme": "ocean"}},
        headers=SAME_ORIGIN,
    )
    assert _get(admin_client)["layouts"]["gb:portrait"]["a"] == {"x": 90, "y": 80}
