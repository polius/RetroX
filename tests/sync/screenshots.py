"""README screenshot regenerator — NOT a regression test.

Captures the four sync-state dialogs at 2x device-pixel-ratio and
saves them to landing/images/sync-{synced,empty,offline,conflict}.png.
Run this when the dialog copy / styling changes and the README images
should be refreshed.

This script does no assertions. It exits cleanly even if the dialogs
have changed shape — the next git diff will tell you whether the new
images are what you wanted.

Usage:
    python3 tests/sync/screenshots.py
"""
import json
import os
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"
SLUG_WITH_SAVE = "pokemon-blue-version-gb"
SLUG_NO_SAVE   = "asterix-obelix-gb"

OUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "landing", "images"
)

VIEWPORT = {"width": 1280, "height": 800}
DPR = 2.0


def fresh_page(p):
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport=VIEWPORT, device_scale_factor=DPR)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
    # Retry on 429 (rate-limited) so back-to-back runs don't fail
    # spuriously at the 5/min auth cap.
    for _attempt in range(4):
        r = page.context.request.post(
            f"{BASE}/api/auth/login",
            data=json.dumps({"username": USER, "password": PASS}),
            headers={"Content-Type": "application/json", "Origin": BASE},
        )
        if r.ok: break
        if r.status == 429: time.sleep(13 * (_attempt + 1)); continue
        raise RuntimeError(f"login failed: {r.status} {r.text()[:200]}")
    else:
        raise RuntimeError("login still rate-limited after retries")
    return browser, ctx, page


def play(page, slug, slot=1):
    page.goto(f"{BASE}/games"); page.wait_for_selector(".gcard")
    page.locator(f'a[href="/game/{slug}"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").nth(slot - 1).click()
    page.wait_for_timeout(2500)


def capture(page, name):
    page.evaluate("() => document.querySelector('.player__status')?.click()")
    page.wait_for_timeout(500)
    out_path = os.path.normpath(os.path.join(OUT_DIR, name))
    page.locator(".modal").first.screenshot(path=out_path)
    print(f"  saved {out_path}")


with sync_playwright() as p:
    print("=> synced")
    browser, ctx, page = fresh_page(p)
    play(page, SLUG_WITH_SAVE, slot=1)
    capture(page, "sync-synced.png")
    browser.close()

    print("=> empty")
    browser, ctx, page = fresh_page(p)
    play(page, SLUG_NO_SAVE, slot=1)
    capture(page, "sync-empty.png")
    browser.close()

    print("=> offline")
    browser, ctx, page = fresh_page(p)
    play(page, SLUG_WITH_SAVE, slot=1)
    ctx.set_offline(True)
    page.wait_for_timeout(700)
    capture(page, "sync-offline.png")
    browser.close()

    print("=> conflict")
    browser, ctx, page = fresh_page(p)
    play(page, SLUG_WITH_SAVE, slot=1)
    page.route("**/api/games/**/saves/**", lambda route, req: (
        route.fulfill(status=409, body='{"detail":"conflict"}')
        if req.method == "PUT" else route.continue_()
    ))
    page.evaluate("""() => {
      const gm = window.EJS_emulator?.gameManager;
      const path = gm?.getSaveFilePath?.();
      if (path) gm.FS.writeFile(path, new Uint8Array(32768).fill(99));
    }""")
    page.wait_for_timeout(8000)
    capture(page, "sync-conflict.png")
    browser.close()

    print("done — review git diff under landing/images/ before committing")
