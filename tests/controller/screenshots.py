"""README screenshot regenerator for the phone-as-controller feature.

Captures four images and saves them to landing/images/:

    phone-pair-modal.png      — host modal in the "waiting" state (QR + code visible)
    phone-pair-connected.png  — host modal after the phone joins (green status pill)
    phone-pair-pill.png       — the Phone pill in its paired state (cropped from the chrome)
    phone-pad.png             — the phone-side controller surface in landscape

This script does no assertions. It exits cleanly even if the surfaces
change shape — review the git diff under landing/images/ before
committing the new captures.

Usage:
    python3 tests/controller/screenshots.py

Prerequisites:
    - A running RetroX container at http://localhost:8888
    - admin / admin1234 credentials
    - Same `playwright>=1.50,<2` install as the sibling e2e test
"""
from __future__ import annotations

import json
import os
import time
from playwright.sync_api import sync_playwright, Route

BASE = "http://localhost:8888"
USER = "admin"
PASS = "admin1234"

OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "landing", "images")
)

# Same minimal harness the e2e test uses — gives us /play's DOM
# contract (.player-page body class, #back-btn, .player__status pill)
# without needing a real EmulatorJS instance. Cluster sizes / pill
# positions on the captures are byte-identical to what a real player
# session would render.
HARNESS_PATH = "/__phone_screenshots_host__"
HARNESS_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Phone-controller screenshots</title>
  <link rel="stylesheet" href="/css/tokens.css"/>
  <link rel="stylesheet" href="/css/components.css"/>
  <link rel="stylesheet" href="/css/player.css"/>
  <style>
    body { background: #07090c; }
    /* Fake game canvas so the player background reads as "a game is
       running" instead of a flat color — makes the pill captures
       look like real product screenshots, not synthetic tests. */
    #emulator-mount {
      background: linear-gradient(135deg, #1f2a36 0%, #11141a 100%);
      background-image:
        radial-gradient(circle at 30% 30%, rgba(229,160,13,0.10), transparent 40%),
        radial-gradient(circle at 70% 70%, rgba(56,189,248,0.08), transparent 40%);
    }
  </style>
</head>
<body class="player-page">
  <div id="player-host" class="player-host">
    <div id="emulator-mount" style="width:100%;height:100%"></div>
    <button class="player__back" id="back-btn" type="button">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>
      </svg>
      <span>Back</span>
    </button>
    <button class="player__status" id="fake-status" type="button">
      <span class="player__status__dot"></span>
      <span class="player__status__text">Synced · 14:21</span>
    </button>
  </div>
  <script>
    window.__simInputs = [];
    window.EJS_core = "gambatte";
    window.EJS_emulator = {
      gameManager: {
        simulateInput(player, slot, value) {
          window.__simInputs.push({ player, slot, value });
        },
        toggleFastForward() {},
        functions: { toggleRewind() {} },
      },
    };
  </script>
  <script type="module" src="/js/controller-host.js"></script>
</body></html>
"""


def login(ctx) -> None:
    """Same retry-on-429 dance as the e2e test — back-to-back runs
    can hit the 5/min auth limiter without this."""
    last = None
    for attempt in range(4):
        r = ctx.request.post(
            f"{BASE}/api/auth/login",
            data=json.dumps({"username": USER, "password": PASS}),
            headers={"Content-Type": "application/json", "Origin": BASE},
        )
        if r.ok:
            return
        last = (r.status, r.text()[:200])
        if r.status == 429:
            wait = 13 * (attempt + 1)
            print(f"  rate-limited; sleeping {wait}s")
            time.sleep(wait)
            continue
        break
    raise RuntimeError(f"login failed: {last}")


def install_harness(page) -> None:
    def handler(route: Route) -> None:
        if HARNESS_PATH in route.request.url:
            route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=HARNESS_HTML,
            )
        else:
            route.continue_()
    page.route("**/*", handler)


def capture_host_modal(p, name: str, after_pad_joins: bool) -> str:
    """Open the host harness, click Phone, snap the modal. If
    after_pad_joins is True, also bring up a phone-side pad first so
    the modal shows the green "Phone connected — playing." status."""
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    host_ctx = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=2.0)
    login(host_ctx)
    host = host_ctx.new_page()
    install_harness(host)
    host.goto(f"{BASE}{HARNESS_PATH}")
    host.wait_for_selector("#controller-pair-btn", timeout=8_000)
    host.click("#controller-pair-btn")
    host.wait_for_selector("#ctrlhost-code", timeout=10_000)
    # Let the QR finish rendering — qrcode.js loads lazily.
    host.wait_for_function(
        "() => document.querySelector('#ctrlhost-qr svg, #ctrlhost-qr img') !== null",
        timeout=4_000,
    )
    host.wait_for_timeout(150)

    if after_pad_joins:
        code = (host.locator("#ctrlhost-code").inner_text() or "").strip()
        pad_ctx = browser.new_context(viewport={"width": 844, "height": 390}, device_scale_factor=2.0)
        login(pad_ctx)
        pad = pad_ctx.new_page()
        pad.goto(f"{BASE}/pair?code={code}")
        pad.wait_for_selector('.pad [data-button="4"]', timeout=10_000)
        # Wait for the pad-state push to flip the host modal.
        host.wait_for_function(
            "() => /connected/i.test(document.querySelector('#ctrlhost-status-text')?.textContent || '')",
            timeout=5_000,
        )
        host.wait_for_timeout(200)

    out_path = os.path.join(OUT_DIR, name)
    host.locator("#controller-pair-modal > div").first.screenshot(path=out_path)
    print(f"  saved {out_path}")
    browser.close()
    return out_path


def capture_pill(p, name: str) -> str:
    """Snap the Phone pill in its paired state, cropped tight."""
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    host_ctx = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=2.0)
    login(host_ctx)
    host = host_ctx.new_page()
    install_harness(host)
    host.goto(f"{BASE}{HARNESS_PATH}")
    host.wait_for_selector("#controller-pair-btn", timeout=8_000)
    host.click("#controller-pair-btn")
    host.wait_for_selector("#ctrlhost-code", timeout=10_000)
    code = (host.locator("#ctrlhost-code").inner_text() or "").strip()

    # Bring a pad up so the pill flips to the paired (green dot) state.
    pad_ctx = browser.new_context(viewport={"width": 844, "height": 390}, device_scale_factor=2.0)
    login(pad_ctx)
    pad = pad_ctx.new_page()
    pad.goto(f"{BASE}/pair?code={code}")
    pad.wait_for_selector('.pad [data-button="4"]', timeout=10_000)

    # Hide the modal so only the pill is in the shot, then wait for
    # the pulse animation to settle to its steady-state look.
    host.click("#ctrlhost-close")
    host.wait_for_selector("#controller-pair-modal", state="detached", timeout=2_000)
    host.wait_for_timeout(900)  # past the 800ms pulse animation

    out_path = os.path.join(OUT_DIR, name)
    # Crop a tight area around the pill: 16px padding on each side.
    box = host.locator("#controller-pair-btn").bounding_box()
    if box is None:
        raise RuntimeError("pair pill has no bounding box")
    pad_px = 16
    host.screenshot(
        path=out_path,
        clip={
            "x": max(0, box["x"] - pad_px),
            "y": max(0, box["y"] - pad_px),
            "width":  box["width"]  + 2 * pad_px,
            "height": box["height"] + 2 * pad_px,
        },
    )
    print(f"  saved {out_path}")
    browser.close()
    return out_path


def capture_pad(p, name: str) -> str:
    """Snap the phone-side controller surface, full viewport."""
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    host_ctx = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=2.0)
    login(host_ctx)
    host = host_ctx.new_page()
    install_harness(host)
    host.goto(f"{BASE}{HARNESS_PATH}")
    host.wait_for_selector("#controller-pair-btn", timeout=8_000)
    host.click("#controller-pair-btn")
    host.wait_for_selector("#ctrlhost-code", timeout=10_000)
    code = (host.locator("#ctrlhost-code").inner_text() or "").strip()

    # Realistic landscape phone viewport (iPhone 14-ish). DPR 3 makes
    # the captured image crisp on Retina README readers.
    pad_ctx = browser.new_context(viewport={"width": 844, "height": 390}, device_scale_factor=3.0)
    login(pad_ctx)
    pad = pad_ctx.new_page()
    pad.goto(f"{BASE}/pair?code={code}")
    pad.wait_for_selector('.pad [data-button="4"]', timeout=10_000)
    # Force the SNES layout for the canonical screenshot — shows L/R
    # AND X/Y/A/B together, which best demonstrates the controller
    # capabilities. The gb layout would hide half the buttons.
    pad.evaluate("""() => {
        const face = document.getElementById('pad-face');
        face.dataset.buttons = 'abxy';
        face.querySelector('.pad-face-btn--x').hidden = false;
        face.querySelector('.pad-face-btn--y').hidden = false;
        document.querySelectorAll('.pad-btn-shoulder').forEach((b) => {
            b.hidden = false;
        });
        const txt = document.getElementById('pad-status-text');
        if (txt) txt.textContent = 'Connected · SNES';
    }""")
    pad.wait_for_timeout(150)

    out_path = os.path.join(OUT_DIR, name)
    pad.screenshot(path=out_path)
    print(f"  saved {out_path}")
    browser.close()
    return out_path


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    with sync_playwright() as p:
        print("=> phone-pair-modal (waiting state)")
        capture_host_modal(p, "phone-pair-modal.png", after_pad_joins=False)

        print("=> phone-pair-connected (after pad joins)")
        capture_host_modal(p, "phone-pair-connected.png", after_pad_joins=True)

        print("=> phone-pair-pill (paired indicator)")
        capture_pill(p, "phone-pair-pill.png")

        print("=> phone-pad (controller surface)")
        capture_pad(p, "phone-pad.png")

    print()
    print("done — review git diff under landing/images/ before committing")


if __name__ == "__main__":
    main()
