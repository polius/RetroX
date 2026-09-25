#!/usr/bin/env python3
"""Empirical e2e test — customizable on-screen touch controls.

Boots Pokemon Blue (Game Boy) in phone/tablet viewports and verifies the
touch-layout editor end to end:

  1.  Pill appears on touch devices; with no customization the stock
      layout is untouched (no custom class, no style vars).
  2.  Opening the editor pauses the game and shows the panel.
  3.  Dragging a control moves it live by exactly the drag delta.
  4.  Scale slider rescales buttons (transform), Fade slider changes
      opacity, shape toggle switches border-radius — all live.
  5.  Escape exits editing and resumes the game.
  6.  A reload restores the customized layout from device storage.
  7.  Reset restores the exact stock geometry for the orientation.
  8.  A second browser (same account) adopts the layout from the server
      — and percent coordinates land proportionally on a bigger iPad
      viewport.
  9.  Portrait phone: stock layout until customized; editing works there
      too.

Prerequisites:
    docker compose up -d --build
    pip install -r tests/gamepad/requirements.txt
    playwright install chromium

Run:
    python tests/gamepad/test_touch_layout.py

Exits 0 on full pass, 1 on any assertion failure, 2 on setup failure.
"""
import sys
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE = "http://localhost:8888"
USER = "admin"
PASS = "admin1234"
SLUG = "pokemon-blue-version-gb"

TOL_PX = 2
EDGE_INSET = 30       # must match EDGE_INSET in play.js
DPAD_BOX = 125        # .ejs_virtualGamepad_left / .ejs_dpad_main box size

SHOTS = []


def shot(page, name):
    path = f"/tmp/retrox_touch_{name}.png"
    page.screenshot(path=path)
    SHOTS.append(path)
    print(f"  [shot] {path}")


class Check:
    def __init__(self):
        self.results = []

    def eq(self, name, actual, expected):
        ok = actual == expected
        self.results.append((ok, f"{name}: actual={actual!r}, expected={expected!r}"))

    def close(self, name, actual, expected, tol):
        diff = abs(actual - expected)
        ok = diff <= tol
        self.results.append((ok, f"{name}: actual={actual:.1f}, expected={expected:.1f} (±{tol}), diff={diff:.1f}"))

    def ok(self, name, cond):
        self.results.append((bool(cond), f"{name}: {'ok' if cond else 'FAILED'}"))

    def report(self):
        passes = sum(1 for ok, _ in self.results if ok)
        for ok, msg in self.results:
            print(f"  {'PASS' if ok else 'FAIL'}  {msg}")
        print()
        if passes == len(self.results):
            print(f"PASSED  {passes}/{len(self.results)} checks")
            return 0
        print(f"FAILED  {len(self.results) - passes} of {len(self.results)} checks")
        return 1


MEASURE_JS = """
(controlSel) => {
  const ejs = window.EJS_emulator;
  const pad = ejs?.elements?.parent?.querySelector('.ejs_virtualGamepad_parent');
  const el = pad && controlSel ? pad.querySelector(controlSel) : null;
  const r = el ? el.getBoundingClientRect() : null;
  return {
    present: !!el,
    cx: r ? r.left + r.width / 2 : null,
    cy: r ? r.top + r.height / 2 : null,
    w: r ? r.width : null,
    h: r ? r.height : null,
    customClass: pad ? pad.classList.contains('rx-vpad-custom') : null,
    editingClass: pad ? pad.classList.contains('rx-vpad-editing') : null,
    scaleVar: pad ? pad.style.getPropertyValue('--rx-vpad-scale') : null,
    paused: ejs ? !!ejs.paused : null,
    pillHidden: (() => { const p = document.getElementById('touch-layout-btn');
                         return p ? p.style.display === 'none' : null; })(),
    panelHidden: (() => { const p = document.querySelector('.rx-editor');
                          return p ? p.classList.contains('rx-editor--hidden') : null; })(),
    editorStyle: (() => { const b = pad?.querySelector('.ejs_virtualGamepad_button.b_a');
                          if (!b) return null;
                          const cs = getComputedStyle(b);
                          return { transform: cs.transform, radius: cs.borderRadius }; })(),
    padOpacity: pad ? getComputedStyle(pad).opacity : null,
    stored: (() => { try { return JSON.parse(localStorage.getItem('retrox.touch_layout')); }
                     catch { return null; } })(),
  };
}
"""


def login(page):
    r = page.context.request.post(
        f"{BASE}/api/auth/login",
        data={"username": USER, "password": PASS},
        headers={"Origin": BASE},
    )
    if r.status >= 300:
        raise RuntimeError(f"login failed: HTTP {r.status} — {r.text()}")


def boot(page, timeout=45000):
    """Wait until the emulator started and the touch-layout pill is live."""
    page.goto(f"{BASE}/play/{SLUG}?slot=1")
    page.wait_for_selector(".ejs_virtualGamepad_parent", state="attached", timeout=timeout)
    try:
        page.wait_for_selector("#touch-layout-btn", state="attached", timeout=timeout)
    except PWTimeout:
        page.screenshot(path="/tmp/retrox_touch_setup_failure.png")
        raise RuntimeError("touch-layout pill never appeared")
    page.wait_for_function(
        "() => !!window.EJS_emulator?.elements?.parent?.querySelector('.ejs_virtualGamepad_parent')"
        " && window.EJS_emulator.paused === false",
        timeout=timeout,
    )
    page.wait_for_timeout(600)


def center_of(page, sel):
    m = page.evaluate(MEASURE_JS, sel)
    assert m["present"], f"{sel} not found"
    return m["cx"], m["cy"]


def drag(page, sel, dx, dy, steps=14):
    box = page.locator(sel).bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx, y + dy, steps=steps)
    page.mouse.up()
    page.wait_for_timeout(120)


def open_editor(page):
    page.click("#touch-layout-btn")
    page.wait_for_selector(".rx-editor:not(.rx-editor--hidden)", timeout=5000)
    page.wait_for_timeout(250)


def done(page):
    page.click("#rx-done")
    page.wait_for_selector(".rx-editor.rx-editor--hidden", state="attached", timeout=5000)
    page.wait_for_timeout(250)


def set_slider(page, sel, value):
    page.locator(sel).evaluate(
        "(el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }",
        value,
    )
    page.wait_for_timeout(120)


def main():
    c = Check()
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
        )

        # ================= Context 1: iPhone 14 landscape =================
        ctx = browser.new_context(
            viewport={"width": 852, "height": 393},
            device_scale_factor=3,
            has_touch=True,
            is_mobile=True,
            user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                        "Mobile/15E148 Safari/604.1"),
        )
        page = ctx.new_page()
        page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
        page.on("console", lambda m: m.type == "error" and print(f"  [console.error] {m.text}"))
        login(page)
        # Clean slate: drop any touch_layout saved by previous runs so the
        # defaults phase always starts virgin.
        r = page.context.request.put(
            f"{BASE}/api/profile/preferences",
            data={"data": {"touch_layout": {"layouts": {}}}},
            headers={"Origin": BASE},
        )
        if r.status >= 300:
            raise RuntimeError(f"cleanup PUT failed: HTTP {r.status} — {r.text()}")
        boot(page)

        print("== Phase A: defaults untouched ==")
        m = page.evaluate(MEASURE_JS, ".ejs_dpad_main")
        c.ok("pill visible on touch device", m["pillHidden"] is False)
        c.eq("no custom mode before editing", m["customClass"], False)
        c.ok("no scale var before editing", m["scaleVar"] == "")
        stock = (m["cx"], m["cy"])
        shot(page, "A_defaults")

        print("== Phase B: editor opens, game pauses ==")
        open_editor(page)
        m = page.evaluate(MEASURE_JS, ".ejs_dpad_main")
        c.eq("game paused while editing", m["paused"], True)
        c.eq("editing class on pad", m["editingClass"], True)
        c.eq("custom mode active after freeze", m["customClass"], True)
        shot(page, "B_editor_open")

        print("== Phase C: drag moves the d-pad live ==")
        dx, dy = 90, 40
        box = page.locator(".ejs_dpad_main").bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + dx / 2, y + dy / 2, steps=7)
        page.wait_for_timeout(150)
        shot(page, "C1_mid_drag_lift")
        page.mouse.move(x + dx, y + dy, steps=7)
        page.mouse.up()
        page.wait_for_timeout(120)
        cx, cy = center_of(page, ".ejs_dpad_main")
        c.close("d-pad moved by the drag delta (x)", cx, stock[0] + dx, TOL_PX)
        c.close("d-pad moved by the drag delta (y)", cy, stock[1] + dy, TOL_PX)
        stored = page.evaluate(MEASURE_JS, ".ejs_dpad_main")["stored"]
        c.ok("layout persisted to device storage",
             bool(stored and stored.get("layouts", {}).get("gb:landscape", {}).get("dpad")))
        shot(page, "C_after_drag")

        print("== Phase D: style controls apply live ==")
        set_slider(page, "#rx-scale", 150)
        set_slider(page, "#rx-opacity", 50)
        page.click('[data-shape="square"]')
        page.wait_for_timeout(150)
        m = page.evaluate(MEASURE_JS, ".ejs_dpad_main")
        c.eq("scale 1.5 applied to buttons", m["editorStyle"]["transform"], "matrix(1.5, 0, 0, 1.5, 0, 0)")
        c.close("pad opacity 0.5", float(m["padOpacity"]), 0.5, 0.01)
        c.eq("square shape radius", m["editorStyle"]["radius"], "12px")
        # Scale is visual-only: the d-pad center must not move.
        cx, cy = center_of(page, ".ejs_dpad_main")
        c.close("center stable under scale (x)", cx, stock[0] + dx, TOL_PX)
        c.close("center stable under scale (y)", cy, stock[1] + dy, TOL_PX)
        shot(page, "D_styled")

        print("== Phase E: Esc exits and resumes ==")
        # Collapse/expand first — the panel must get out of the way.
        page.click("#rx-collapse")
        page.wait_for_timeout(250)
        c.ok("panel collapsed to mini bar", (page.locator(".rx-editor").get_attribute("class") or "").find("rx-editor--min") >= 0)
        shot(page, "E1_collapsed")
        page.click("#rx-collapse")
        page.wait_for_timeout(250)
        page.keyboard.press("Escape")
        page.wait_for_selector(".rx-editor.rx-editor--hidden", state="attached", timeout=5000)
        page.wait_for_timeout(300)
        m = page.evaluate(MEASURE_JS, ".ejs_dpad_main")
        c.eq("editor hidden after Esc", m["panelHidden"], True)
        c.eq("game resumed after Esc", m["paused"], False)
        c.eq("editing class removed", m["editingClass"], False)
        c.eq("custom mode stays after editing", m["customClass"], True)

        print("== Phase F: layout survives a reload ==")
        boot(page)
        cx, cy = center_of(page, ".ejs_dpad_main")
        c.close("d-pad position restored after reload (x)", cx, stock[0] + dx, TOL_PX)
        c.close("d-pad position restored after reload (y)", cy, stock[1] + dy, TOL_PX)
        m = page.evaluate(MEASURE_JS, ".ejs_dpad_main")
        c.eq("custom mode restored at boot", m["customClass"], True)
        c.eq("scale restored at boot", m["editorStyle"]["transform"], "matrix(1.5, 0, 0, 1.5, 0, 0)")
        c.close("opacity restored at boot", float(m["padOpacity"]), 0.5, 0.01)

        print("== Phase G: reset restores stock geometry ==")
        open_editor(page)
        page.click("#rx-reset")
        page.wait_for_timeout(350)
        cx, cy = center_of(page, ".ejs_dpad_main")
        c.close("d-pad back at stock x", cx, stock[0], TOL_PX)
        c.close("d-pad back at stock y", cy, stock[1], TOL_PX)
        m = page.evaluate(MEASURE_JS, ".ejs_dpad_main")
        c.eq("style reset to defaults", m["editorStyle"]["transform"], "matrix(1, 0, 0, 1, 0, 0)")
        c.close("opacity reset to 1", float(m["padOpacity"]), 1.0, 0.01)
        shot(page, "G_reset")
        done(page)

        print("== Phase G2: fullscreen — editor must follow the surface ==")
        page.evaluate("window.EJS_emulator.toggleFullscreen(true)")
        page.wait_for_function("() => !!document.fullscreenElement", timeout=10000)
        page.wait_for_timeout(400)
        open_editor(page)
        panel_w = page.evaluate("() => document.querySelector('.rx-editor').getBoundingClientRect().width")
        c.ok("editor panel renders in fullscreen", panel_w > 100)
        cx, cy = center_of(page, ".ejs_dpad_main")
        c.ok("controls follow the new viewport", 0 < cx < page.evaluate("() => innerWidth"))
        shot(page, "K_fullscreen_editing")
        page.keyboard.press("Escape")
        page.wait_for_selector(".rx-editor.rx-editor--hidden", state="attached", timeout=5000)
        page.evaluate("window.EJS_emulator.toggleFullscreen(false)")
        page.wait_for_function("() => !document.fullscreenElement", timeout=10000)
        page.wait_for_timeout(400)

        # Wait for the debounced server PUT to land.
        page.wait_for_timeout(1200)

        # ================= Context 2: same account, server seeding =================
        print("== Phase H: second device adopts the layout from the account ==")
        ctx2 = browser.new_context(
            viewport={"width": 852, "height": 393},
            device_scale_factor=3, has_touch=True, is_mobile=True,
            user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                        "Mobile/15E148 Safari/604.1"),
        )
        page2 = ctx2.new_page()
        page2.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
        login(page2)
        boot(page2)
        cx, cy = center_of(page2, ".ejs_dpad_main")
        c.close("adopted d-pad at stock position (x)", cx, stock[0], TOL_PX)
        c.close("adopted d-pad at stock position (y)", cy, stock[1], TOL_PX)
        m = page2.evaluate(MEASURE_JS, ".ejs_dpad_main")
        c.eq("adopted layout runs in custom mode", m["customClass"], True)
        ctx2.close()

        # ================= Context 3: iPad landscape — percent scaling =================
        print("== Phase I: iPad landscape — percent coordinates scale up ==")
        ctx3 = browser.new_context(
            viewport={"width": 1194, "height": 834},
            device_scale_factor=2, has_touch=True, is_mobile=True,
            user_agent=("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
        )
        page3 = ctx3.new_page()
        page3.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
        login(page3)
        boot(page3)
        cx, cy = center_of(page3, ".ejs_dpad_main")
        # Frozen at ~11.33% / 50% of the iPhone viewport — percents must hold.
        c.close("d-pad percent x holds on iPad", cx, 1194 * stock[0] / 852, TOL_PX + 1)
        c.close("d-pad percent y holds on iPad", cy, 834 * stock[1] / 393, TOL_PX + 1)
        open_editor(page3)
        drag(page3, ".ejs_dpad_main", -30, -60)
        ncx, ncy = center_of(page3, ".ejs_dpad_main")
        c.close("drag works on iPad (x)", ncx, cx - 30, TOL_PX)
        c.close("drag works on iPad (y)", ncy, cy - 60, TOL_PX)
        shot(page3, "I_ipad_editing")
        done(page3)

        # Clamp check: dragging far past the edge keeps the control visible.
        open_editor(page3)
        drag(page3, ".ejs_dpad_main", -800, -800)
        cx, cy = center_of(page3, ".ejs_dpad_main")
        c.ok("d-pad clamped inside left edge", cx >= 6 + DPAD_BOX / 2 - TOL_PX)
        c.ok("d-pad clamped inside top edge", cy >= 6 + DPAD_BOX / 2 - TOL_PX)
        done(page3)
        ctx3.close()

        # ================= Context 4: portrait phone =================
        print("== Phase J: portrait phone — stock until customized ==")
        ctx4 = browser.new_context(
            viewport={"width": 393, "height": 852},
            device_scale_factor=3, has_touch=True, is_mobile=True,
            user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
        )
        page4 = ctx4.new_page()
        page4.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
        login(page4)
        boot(page4)
        m = page4.evaluate(MEASURE_JS, ".ejs_dpad_main")
        c.eq("portrait stays stock (no map yet)", m["customClass"], False)
        c.ok("pill visible in portrait", m["pillHidden"] is False)
        open_editor(page4)
        before = center_of(page4, ".ejs_dpad_main")
        drag(page4, ".ejs_dpad_main", 40, -50)
        after = center_of(page4, ".ejs_dpad_main")
        c.close("portrait drag works (x)", after[0], before[0] + 40, TOL_PX)
        c.close("portrait drag works (y)", after[1], before[1] - 50, TOL_PX)
        c.ok("EJS settings menu stays closed while editing", not page4.evaluate(
            "() => !!window.EJS_emulator?.menu?.isOpen"
            " || !!document.querySelector('.ejs_settings_menu')"))
        shot(page4, "J_portrait_editing")
        done(page4)
        ctx4.close()

        ctx.close()
        browser.close()

    print("\nScreenshots:")
    for s in SHOTS:
        print(f"  {s}")
    sys.exit(c.report())


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"setup error: {e}", file=sys.stderr)
        sys.exit(2)
