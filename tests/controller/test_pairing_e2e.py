"""Phone-as-controller end-to-end test.

Exercises the full lifecycle in a single browser session with two
contexts (host + pad) — the same shape a real user would see, but
without the real EmulatorJS engine.

Coverage:
  1. Host harness loads, controller-host.js injects the Phone pill
  2. Click Phone → /api/controller/start → modal renders with QR + code
  3. Pad opens /pair?code=...    → WS upgrade succeeds
  4. Host modal status flips to "Phone connected — playing." (pushed
     proactively by the server, NOT inferred from the first input)
  5. Pad presses A → host's stubbed simulateInput records [0, 0, 1]
     and the corresponding release on pad pointerup
  6. Pad pressed-and-then-disconnects mid-hold → server auto-releases
     the held button on the host
  7. Pad gone → host modal flips back to "Waiting for phone…"
  8. Host closes modal → pad WS closes cleanly, pad UI returns to the
     entry form

Strategy
--------
The real /play page boots EmulatorJS, which needs WebGL2 + a real ROM
+ WASM threading and won't run cleanly in headless CI. Instead, we
serve a tiny HARNESS HTML on a synthetic same-origin URL via
`page.route()`. The harness:

  - mirrors /play's DOM contract (.player-page body class, #back-btn,
    a fake .player__status pill the Phone button positions next to)
  - stubs window.EJS_emulator with a recorder so we can assert exactly
    which (player, slot, value) tuples the host module pushed

Cookies flow because the synthetic URL is same-origin. The host module
itself is fetched from the real server, so we test the *real*
controller-host.js byte-for-byte.

Pass criterion: every assertion line ends with ✓.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright, Page, BrowserContext, Route

# Test against the real Dockerized RetroX container — same image users
# deploy. Each run rebuilds the image so the container always reflects
# the current source tree (catching Dockerfile/COPY/permissions issues
# that a local-uvicorn shortcut would miss). The compose service is
# called `retrox` and binds 8080 → host 8888 (see docker-compose.yml).
REPO_ROOT = Path(__file__).resolve().parents[2]
BASE = "http://localhost:8888"
USER = "admin"
PASS = "admin1234"  # bootstrap default for fresh /data

# Same-origin synthetic URL the harness loads from. The path doesn't
# need to map to a real server route — page.route() intercepts before
# the request leaves the browser. We just need the origin to match the
# real server's so cookies / WS / fetch all behave as same-origin.
HARNESS_PATH = "/__test_controller_host__"


# ----------------------------------------------------------------------
# Container lifecycle (rebuild + recreate, wait for /health)
# ----------------------------------------------------------------------

def _wait_for_health(base: str, timeout_s: float = 60) -> None:
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base}/health", timeout=2) as r:
                if r.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError) as e:
            last_err = e
        time.sleep(0.5)
    raise RuntimeError(f"server didn't come up at {base}: {last_err}")


def rebuild_and_start_container() -> None:
    """`docker compose up -d --build --force-recreate` from the repo
    root, then block on /health. Rebuilding every run guarantees the
    container reflects current source — testing stale code would be
    worse than no test at all."""
    print("· rebuilding + recreating retrox container…")
    rc = subprocess.run(
        ["docker", "compose", "up", "-d", "--build", "--force-recreate"],
        cwd=REPO_ROOT,
        check=False,
    )
    if rc.returncode != 0:
        raise RuntimeError(f"docker compose up failed (exit {rc.returncode})")
    _wait_for_health(BASE)
    print(f"  container healthy at {BASE}")

# The harness is a minimal /play replica. controller-host.js calls
# `EJS_emulator.gameManager.simulateInput(player, slot, value)` — we
# replace that with a recorder so the test can assert which inputs were
# pushed without needing a real emulator. EJS_core is set so the host
# module's detectSystem() returns "gb" (NES would also do; we need a
# value that matches a known layout).
HARNESS_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Phone-controller test harness</title>
  <link rel="stylesheet" href="/css/tokens.css"/>
  <link rel="stylesheet" href="/css/components.css"/>
  <link rel="stylesheet" href="/css/player.css"/>
  <style>
    body { background: #000; }
  </style>
</head>
<body class="player-page">
  <div id="player-host" class="player-host">
    <div id="emulator-mount" style="width:100%;height:100%;"></div>
    <button class="player__back" id="back-btn" type="button">Back</button>
    <!-- Real .player__status would be injected by save-indicator.js;
         the host module just reads its parent + bounding box, so a
         static placeholder with the right class is enough. -->
    <button class="player__status" id="fake-status" type="button"
            style="position:fixed;top:16px;right:16px;padding:10px 16px;
                   border-radius:999px;background:rgba(0,0,0,0.55);
                   color:#fff;border:1px solid rgba(255,255,255,0.1)">
      <span class="player__status__dot"></span>
      <span class="player__status__text">Synced</span>
    </button>
  </div>
  <script>
    window.__simInputs = [];
    window.EJS_core = "gambatte";
    window.EJS_emulator = {
      gameManager: {
        simulateInput(player, slot, value) {
          window.__simInputs.push({ player, slot, value, ts: Date.now() });
        },
        toggleFastForward() {},
        functions: { toggleRewind() {} },
      },
    };
  </script>
  <script type="module" src="/js/controller-host.js"></script>
</body>
</html>
"""


# ----------------------------------------------------------------------
# Pretty output
# ----------------------------------------------------------------------

class Reporter:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def ok(self, msg: str) -> None:
        print(f"  ✓ {msg}")

    def fail(self, msg: str) -> None:
        print(f"  ✗ {msg}")
        self.failures.append(msg)

    def section(self, title: str) -> None:
        print(f"\n— {title} —")

    def assert_eq(self, actual, expected, label: str) -> bool:
        if actual == expected:
            self.ok(f"{label}: {actual!r}")
            return True
        self.fail(f"{label}: expected {expected!r}, got {actual!r}")
        return False

    def assert_truthy(self, value, label: str) -> bool:
        if value:
            self.ok(label)
            return True
        self.fail(f"{label}: value was {value!r}")
        return False


# ----------------------------------------------------------------------
# Server interactions
# ----------------------------------------------------------------------

def login_with_retry(ctx: BrowserContext, label: str) -> None:
    """Log the given context in as admin, retrying on the 5/min limiter.

    The container persists rate-limit state across runs (in-process); a
    fresh container we just rebuilt will be clean, but a re-run within
    the limiter window will hit 429s without this retry."""
    last = None
    for attempt in range(5):
        r = ctx.request.post(
            f"{BASE}/api/auth/login",
            data=json.dumps({"username": USER, "password": PASS}),
            headers={"Content-Type": "application/json", "Origin": BASE},
        )
        if r.ok:
            print(f"  · {label} signed in")
            return
        last = (r.status, r.text()[:200])
        if r.status == 429:
            wait = 13 * (attempt + 1)
            print(f"  · {label} rate-limited; sleeping {wait}s")
            time.sleep(wait)
            continue
        break
    raise RuntimeError(f"{label} login failed: {last}")


def install_harness_route(page: Page) -> None:
    """Intercept the synthetic harness URL and serve our test HTML.

    Every other request falls through to the real server."""

    def handler(route: Route) -> None:
        url = route.request.url
        if HARNESS_PATH in url:
            route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=HARNESS_HTML,
            )
        else:
            route.continue_()

    page.route("**/*", handler)


# ----------------------------------------------------------------------
# Host helpers
# ----------------------------------------------------------------------

def open_host(page: Page) -> None:
    install_harness_route(page)
    # Spy on every WS the host page opens by wrapping the constructor
    # in a Proxy. Naive subclass shims (`function PatchedWS()`) break
    # because WebSocket has private slots not reachable from a JS-level
    # subclass — the resulting object's `message` events never fire.
    # Proxy preserves the underlying construction path so the spy stays
    # transparent. window.__wsLog is the read-side surface; the test
    # reads it to verify pad-state messages actually deliver (not just
    # inferred via "input arrived eventually").
    page.add_init_script("""
      (() => {
        if (window.__wsPatched) return;
        window.__wsPatched = true;
        window.__wsLog = [];
        const Orig = window.WebSocket;
        window.WebSocket = new Proxy(Orig, {
          construct(Target, args) {
            const ws = new Target(...args);
            ws.addEventListener("message", (ev) => {
              try { window.__wsLog.push(JSON.parse(ev.data)); }
              catch { window.__wsLog.push({ raw: String(ev.data) }); }
            });
            return ws;
          },
        });
      })();
    """)
    page.goto(f"{BASE}{HARNESS_PATH}")
    # The host module waits for window.EJS_emulator (already stubbed
    # synchronously above), then injects the pill. 8s headroom is
    # generous for a stub-backed harness on a developer laptop.
    page.wait_for_selector("#controller-pair-btn", timeout=8_000)


def open_pair_modal(page: Page) -> dict:
    """Click Phone, return { code, modal_locator }."""
    page.click("#controller-pair-btn")
    # buildModal renders #ctrlhost-code synchronously after /start
    # resolves. The 5/min limiter on /start applies here too — surface
    # any toast text in the failure output to make rate-limit hits
    # visible.
    page.wait_for_selector("#ctrlhost-code", timeout=10_000)
    code = (page.locator("#ctrlhost-code").inner_text() or "").strip()
    return {"code": code}


def host_status_text(page: Page) -> str:
    return (page.locator("#ctrlhost-status-text").inner_text() or "").strip()


def host_simulated(page: Page) -> list[dict]:
    return page.evaluate("window.__simInputs || []")


def wait_for_host_status(page: Page, contains: str, timeout_ms: int = 5_000) -> bool:
    """Poll until the host modal's status text contains the substring."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        if contains.lower() in host_status_text(page).lower():
            return True
        time.sleep(0.1)
    return False


def wait_for_sim(
    page: Page, predicate: str, timeout_ms: int = 4_000,
) -> bool:
    """Poll window.__simInputs against a JS predicate (a function body
    that returns truthy when the condition is met). Predicate gets
    `inputs` in scope — eg "return inputs.some(i => i.slot === 0 && i.value === 1)"."""
    js = f"() => {{ const inputs = window.__simInputs || []; {predicate} }}"
    try:
        page.wait_for_function(js, timeout=timeout_ms)
        return True
    except Exception:
        return False


# ----------------------------------------------------------------------
# Pad helpers
# ----------------------------------------------------------------------

def open_pad(page: Page, code: str) -> None:
    page.goto(f"{BASE}/pair?code={code}")
    # The entry form auto-connects when ?code= is provided in the URL;
    # the live pad appears once the WS is open. Wait for any d-pad arm
    # to render as a stable signal that the live pad has mounted.
    page.wait_for_selector('.pad [data-button="4"]', timeout=10_000)


def press(page: Page, slot: int) -> None:
    """Dispatch a synthetic pointerdown on the named pad button.

    Why dispatchEvent and not page.click(): the pad uses pointerdown +
    setPointerCapture for press-then-slide ergonomics. A normal click
    fires pointerdown → pointerup back-to-back, which round-trips a
    "d" then "u" message immediately and obscures the held state. We
    fire the events explicitly so we can hold the button across other
    assertions and release it on a separate call."""
    el = page.locator(f'.pad [data-button="{slot}"]')
    el.dispatch_event(
        "pointerdown",
        {"pointerId": 1, "pointerType": "touch", "isPrimary": True,
         "bubbles": True, "cancelable": True},
    )


def release(page: Page, slot: int) -> None:
    el = page.locator(f'.pad [data-button="{slot}"]')
    el.dispatch_event(
        "pointerup",
        {"pointerId": 1, "pointerType": "touch", "isPrimary": True,
         "bubbles": True, "cancelable": True},
    )


# ----------------------------------------------------------------------
# Scenarios
# ----------------------------------------------------------------------

def run() -> int:
    r = Reporter()
    rebuild_and_start_container()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])

        # Two contexts == two devices. Cookies and storage are isolated
        # so the pad's login doesn't pollute the host's session and
        # vice versa. Both log in as the same admin user — the only
        # case the controller flow actually supports.
        host_ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        # Landscape viewport for the pad: pair.css hides the controller
        # surface under a "rotate to landscape" overlay when
        # orientation is portrait. A real user on a phone holds it
        # sideways for play; the test mirrors that.
        pad_ctx  = browser.new_context(viewport={"width": 844, "height": 390})

        host_ctx.on("weberror",   lambda e: print(f"  [host weberror]   {e.error}"))
        pad_ctx.on("weberror",    lambda e: print(f"  [pad  weberror]   {e.error}"))

        login_with_retry(host_ctx, "host")
        login_with_retry(pad_ctx,  "pad")

        host = host_ctx.new_page()
        host.on("pageerror", lambda e: print(f"  [host pageerror] {e}"))
        host.on("console",   lambda m: print(f"  [host console]   {m.type}: {m.text}") if m.type == "error" else None)

        pad = pad_ctx.new_page()
        pad.on("pageerror",  lambda e: print(f"  [pad  pageerror] {e}"))
        pad.on("console",    lambda m: print(f"  [pad  console]   {m.type}: {m.text}") if m.type == "error" else None)

        # ----- 1: harness boots, pair pill is injected
        r.section("1. Host harness + pair pill")
        open_host(host)
        r.assert_truthy(host.locator("#controller-pair-btn").is_visible(),
                        "Phone pill is visible")
        # Phone pill should sit to the LEFT of .player__status.
        layout = host.evaluate("""() => {
          const phone = document.getElementById('controller-pair-btn').getBoundingClientRect();
          const sync  = document.querySelector('.player__status').getBoundingClientRect();
          return { phoneRight: phone.right, syncLeft: sync.left };
        }""")
        r.assert_truthy(layout["phoneRight"] <= layout["syncLeft"] + 1,
                        f"Phone pill sits left of Sync pill (phone.right={layout['phoneRight']:.0f}, sync.left={layout['syncLeft']:.0f})")

        # ----- 2: pair modal renders, code is a 6-char A–Z2–9 string
        r.section("2. Pair modal + /api/controller/start")
        modal_info = open_pair_modal(host)
        code = modal_info["code"]
        valid = (
            len(code) == 6
            and all(c in "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" for c in code)
        )
        r.assert_truthy(valid, f"Code is well-formed: {code!r}")
        # Initial status before any pad joins
        r.assert_truthy("waiting" in host_status_text(host).lower(),
                        f"Host status starts as 'Waiting…' (got {host_status_text(host)!r})")

        # ----- 3 & 4: pad connects, host status pushed to "Connected"
        r.section("3. Pad joins + host receives pad-state")
        open_pad(pad, code)
        r.ok("Pad UI rendered (WS upgrade accepted)")
        connected = wait_for_host_status(host, "connected", timeout_ms=5_000)
        r.assert_truthy(connected,
                        f"Host modal flipped to 'Connected' (got {host_status_text(host)!r})")
        # Verify the modal flipped *because of* a pad-state push, not
        # because some other code path set the same string. Without
        # this check, a regression that re-introduces the old "set
        # status on first input" heuristic would pass step 3 silently.
        log = host.evaluate("window.__wsLog || []")
        saw_pad_state_one = any(
            m.get("t") == "pad-state" and m.get("count") == 1 for m in log
        )
        r.assert_truthy(saw_pad_state_one,
                        "Host received {t:'pad-state',count:1} from server")

        # ----- 3b: per-system layout (the harness sets EJS_core="gambatte"
        # → host detectSystem() resolves to "gb" → pair.js applies the
        # AB-only layout: face buttons A/B visible, X/Y hidden, no L/R).
        # Verifies the whole layout-broadcast pipeline end to end.
        r.section("3b. Per-system layout (Game Boy: A+B, no L/R, no X/Y)")
        layout = pad.evaluate("""() => ({
            a:  !document.querySelector('.pad-face-btn--a').hidden,
            b:  !document.querySelector('.pad-face-btn--b').hidden,
            x:  !document.querySelector('.pad-face-btn--x').hidden,
            y:  !document.querySelector('.pad-face-btn--y').hidden,
            l1: !document.querySelector('.pad-btn-shoulder[data-button="10"]').hidden,
            r1: !document.querySelector('.pad-btn-shoulder[data-button="11"]').hidden,
        })""")
        r.assert_truthy(layout["a"], "Face A visible (gb layout)")
        r.assert_truthy(layout["b"], "Face B visible (gb layout)")
        r.assert_truthy(not layout["x"], "Face X hidden on gb")
        r.assert_truthy(not layout["y"], "Face Y hidden on gb")
        r.assert_truthy(not layout["l1"], "Shoulder L hidden on gb")
        r.assert_truthy(not layout["r1"], "Shoulder R hidden on gb")

        # Geometry guard: Select / Start MUST sit comfortably below the
        # connected status pill, with breathing room. This catches a
        # real bug where the gb layout hid the shoulder row, the row
        # collapsed and Select/Start rendered on top of the status
        # pill. Asserts at least an 8px vertical gap — anything less
        # reads as "they're touching" on a real phone.
        geom = pad.evaluate("""() => {
            const pill = document.querySelector('.pad__status').getBoundingClientRect();
            const meta = document.querySelector('.pad__meta').getBoundingClientRect();
            return { pillBottom: pill.bottom, metaTop: meta.top };
        }""")
        gap = geom["metaTop"] - geom["pillBottom"]
        r.assert_truthy(gap >= 8,
                        f"Select/Start clear the status pill (gap={gap:.0f}px, pill.bottom={geom['pillBottom']:.0f}, meta.top={geom['metaTop']:.0f})")

        # Containment guard: every interactive button MUST fit inside
        # the viewport. The d-pad / face cluster used to size purely
        # off viewport-width and could overflow the bottom of short
        # phone viewports (e.g. iPhone SE landscape, 320px tall) —
        # the cluster is now height-aware too. We measure here at the
        # current default size; the same check runs on a small
        # viewport in scenario 3d below to catch the regression case.
        contained = pad.evaluate("""() => {
            const vh = window.innerHeight, vw = window.innerWidth;
            const sels = [
                '.pad-dpad-btn--up', '.pad-dpad-btn--down',
                '.pad-dpad-btn--left', '.pad-dpad-btn--right',
                '.pad-face-btn--a', '.pad-face-btn--b',
                '.pad-btn-meta',
            ];
            const overflow = [];
            for (const sel of sels) {
                document.querySelectorAll(sel).forEach((el) => {
                    if (el.hidden) return;
                    const r = el.getBoundingClientRect();
                    if (r.bottom > vh + 0.5 || r.top < -0.5
                        || r.right > vw + 0.5 || r.left < -0.5) {
                        overflow.push({ sel, ...r.toJSON() });
                    }
                });
            }
            return { vh, vw, overflow };
        }""")
        r.assert_truthy(not contained["overflow"],
                        f"All pad buttons fit inside viewport ({contained['vw']}x{contained['vh']}); overflow={contained['overflow']}")

        # ----- 3b-bis: L/R inset from the screen corners.
        # The user's request was specifically "L and R buttons a bit
        # more on the middle, NOT in the corner". They stay in their
        # own shoulder row at the top of the pad — we only changed the
        # horizontal padding to pull them inward. This assertion
        # locks the inset down so a future CSS tweak can't accidentally
        # push them flush against the edges again.
        #
        # Force a layout that shows the shoulders (gb hides them).
        pad.evaluate("""() => {
            document.querySelectorAll('.pad-btn-shoulder').forEach((b) => {
                b.hidden = false;
            });
        }""")
        pad.wait_for_timeout(50)
        rels = pad.evaluate("""() => {
            const vw = window.innerWidth;
            const l = document.querySelector('.pad-btn-shoulder[data-button="10"]').getBoundingClientRect();
            const rr = document.querySelector('.pad-btn-shoulder[data-button="11"]').getBoundingClientRect();
            return { vw, lLeft: l.left, rRight: rr.right };
        }""")
        # Roughly: at least 30 px clearance from each edge on a typical
        # phone viewport. The CSS uses `clamp(40px, 12vw, 96px)` so on
        # a 844-wide viewport this should be ~96 px, comfortably > 30.
        r.assert_truthy(rels["lLeft"] >= 30,
                        f"L button inset from left edge (lLeft={rels['lLeft']:.0f}px)")
        right_clearance = rels["vw"] - rels["rRight"]
        r.assert_truthy(right_clearance >= 30,
                        f"R button inset from right edge ({right_clearance:.0f}px clearance)")
        # Restore gb-mode hidden state for downstream assertions.
        pad.evaluate("""() => {
            document.querySelectorAll('.pad-btn-shoulder').forEach((b) => {
                b.hidden = true;
            });
        }""")

        # ----- 3d: small-viewport containment (iPhone SE landscape)
        # Regression guard for a real bug: the d-pad / face cluster
        # used to size purely off viewport-width (min(46vw, 240px)),
        # so on phones shorter than ~360px tall in landscape the
        # cluster overflowed the bottom of the screen and buttons got
        # cut off. The fix adds a height term to the size cap. We
        # exercise it by re-laying out the existing pad to a small
        # viewport and re-running the containment check.
        r.section("3d. Small viewport (iPhone SE landscape) keeps buttons in-frame")
        pad.set_viewport_size({"width": 568, "height": 320})
        pad.wait_for_timeout(150)  # let the layout settle
        contained_small = pad.evaluate("""() => {
            const vh = window.innerHeight, vw = window.innerWidth;
            const sels = [
                '.pad-dpad-btn--up', '.pad-dpad-btn--down',
                '.pad-dpad-btn--left', '.pad-dpad-btn--right',
                '.pad-face-btn--a', '.pad-face-btn--b',
                '.pad-btn-meta',
            ];
            const overflow = [];
            for (const sel of sels) {
                document.querySelectorAll(sel).forEach((el) => {
                    if (el.hidden) return;
                    const r = el.getBoundingClientRect();
                    if (r.bottom > vh + 0.5 || r.top < -0.5
                        || r.right > vw + 0.5 || r.left < -0.5) {
                        overflow.push({ sel, ...r.toJSON() });
                    }
                });
            }
            return { vh, vw, overflow };
        }""")
        r.assert_truthy(not contained_small["overflow"],
                        f"All pad buttons fit on iPhone-SE-landscape ({contained_small['vw']}x{contained_small['vh']}); overflow={contained_small['overflow']}")
        # Also re-verify the status-pill clearance shrinks gracefully.
        small_geom = pad.evaluate("""() => {
            const pill = document.querySelector('.pad__status').getBoundingClientRect();
            const meta = document.querySelector('.pad__meta').getBoundingClientRect();
            return { pillBottom: pill.bottom, metaTop: meta.top };
        }""")
        small_gap = small_geom["metaTop"] - small_geom["pillBottom"]
        r.assert_truthy(small_gap >= 4,
                        f"Status pill / meta gap survives small viewport (gap={small_gap:.0f}px)")
        # Restore full viewport for the rest of the run.
        pad.set_viewport_size({"width": 844, "height": 390})
        pad.wait_for_timeout(150)

        # ----- 3c: a 2nd pad supersedes the 1st (at-most-one policy)
        # Two phones can't both control player 1 cleanly (their inputs
        # would race), so the server enforces "newest wins". The old
        # pad gets close code 4001 and a specific "Another phone took
        # over" message; the new pad ends up live; the host pad-state
        # sees count: 1 → 2 → 1 (or jumps direct to 1 depending on
        # ordering — we tolerate either as long as it ends at 1).
        r.section("3c. Second pad supersedes the first")
        pad2_ctx = browser.new_context(viewport={"width": 844, "height": 390})
        login_with_retry(pad2_ctx, "pad2")
        pad2 = pad2_ctx.new_page()
        pad2.on("pageerror", lambda e: print(f"  [pad2 pageerror] {e}"))
        open_pad(pad2, code)
        # First pad should bounce to the entry form with a "took over"
        # status — that's the user-visible signal that they got kicked.
        try:
            pad.wait_for_selector("#pair-form", timeout=4_000)
            r.ok("First pad fell back to entry form on supersede")
        except Exception:
            r.fail("First pad still on live controller after second pad joined")
        first_pad_status = (pad.locator("#pair-status").inner_text() or "").strip()
        r.assert_truthy("took over" in first_pad_status.lower(),
                        f"First pad shows 'took over' status (got {first_pad_status!r})")
        # Second pad should be live + paired.
        pad2_paired = pad2.evaluate(
            "document.body.classList.contains('is-paired')",
        )
        r.assert_truthy(pad2_paired, "Second pad is the live controller")
        # Host modal still says Connected (count never dropped to 0
        # since the new pad joined within the same broadcast cycle).
        host_status = host_status_text(host)
        r.assert_truthy("connected" in host_status.lower(),
                        f"Host stays Connected through supersede (got {host_status!r})")
        # Tear down the second pad before continuing — the rest of the
        # test expects the original `pad` to be the only live one.
        pad2.close()
        pad2_ctx.close()
        # Restore the first pad as the live one for subsequent tests.
        # The first pad got the supersede notice and is on the entry
        # form; navigate it back and re-pair with the same code (still
        # alive server-side because the host session is still alive).
        open_pad(pad, code)
        re_paired = wait_for_host_status(host, "connected", timeout_ms=5_000)
        r.assert_truthy(re_paired,
                        "First pad re-paired after supersede dance")

        # ----- 4b: hiding the modal must NOT tear down the session
        # When the user clicks Done (paired state) the modal disappears
        # but the WebSocket and the pad MUST stay connected so the user
        # can play. This is the exact regression a previous build had:
        # closing the dialog kicked the phone back to /pair.
        r.section("4b. Modal close while paired keeps WS alive")
        # Close button label should now be "Done" (paired) and there
        # should be a Disconnect link visible.
        close_label = host.locator("#ctrlhost-close").inner_text().strip()
        r.assert_eq(close_label, "Done", "Close button reads 'Done' while paired")
        disconnect_visible = host.locator("#ctrlhost-disconnect").is_visible()
        r.assert_truthy(disconnect_visible,
                        "'Disconnect phone' link is visible while paired")
        host.click("#ctrlhost-close")
        # Modal should detach quickly (synchronous in our code).
        host.wait_for_selector("#controller-pair-modal",
                               state="detached", timeout=2_000)
        r.ok("Pair modal hidden")
        # Give the WS a beat to surface any spurious close — if hideModal
        # accidentally calls disconnect(), the close frame would land
        # within ~50ms on loopback. Wait conservatively.
        time.sleep(0.5)
        pad_still_alive = pad.evaluate(
            "document.body.classList.contains('is-paired')",
        )
        r.assert_truthy(pad_still_alive,
                        "Pad page still shows 'is-paired' (phone NOT disconnected)")
        # Phone pill should now show the green "paired" dot.
        dot_visible = host.locator("#controller-pair-dot").is_visible()
        r.assert_truthy(dot_visible,
                        "Phone pill shows the paired indicator dot")

        # ----- 4c: clicking the Phone pill while paired re-shows modal
        r.section("4c. Phone pill click reopens the same modal")
        host.click("#controller-pair-btn")
        try:
            host.wait_for_selector("#controller-pair-modal", timeout=2_000)
            r.ok("Modal reopened on Phone pill click")
        except Exception:
            r.fail("Phone pill click did not reopen modal")
        re_status = host_status_text(host)
        r.assert_truthy("connected" in re_status.lower(),
                        f"Reopened modal still reads 'Connected' (got {re_status!r})")

        # ----- 4cc: pad-side X button must NOT auto-reconnect
        # Regression guard for a real bug: tapping the close-X on the
        # live pad called ws.close() (no args) → close event reported
        # 1005 → "Connection lost" branch → renderEntry(code) → auto-
        # reconnect on the prefilled URL code → loop. The fix in pair.js
        # routes 1005 through the clean-close branch and drops the
        # implicit auto-connect from renderEntry. This catches either
        # half regressing.
        r.section("4cc. Pad X-button doesn't auto-reconnect")
        pad.click("#pad-exit")
        try:
            pad.wait_for_selector("#pair-form", timeout=3_000)
            r.ok("Pad showed entry form after X")
        except Exception:
            r.fail("Pad did NOT show entry form after X (auto-reconnect loop?)")
        # Wait long enough for any spurious reconnect to land + propagate.
        time.sleep(1.0)
        still_entry = pad.locator("#pair-form").is_visible()
        r.assert_truthy(still_entry,
                        "Pad still on entry form 1s later (no auto-reconnect)")
        pad_paired = pad.evaluate(
            "document.body.classList.contains('is-paired')",
        )
        r.assert_truthy(not pad_paired,
                        "Pad body class no longer 'is-paired'")
        # The host session is still alive (only the pad disconnected),
        # so re-pairing with the SAME code should work — proves the
        # X-button path is a clean local teardown, not a session-killer.
        same_code = (host.locator("#ctrlhost-code").inner_text() or "").strip()
        r.assert_eq(same_code, code,
                    "Host modal still shows the same code after pad-X")
        open_pad(pad, same_code)
        re_paired = wait_for_host_status(host, "connected", timeout_ms=5_000)
        r.assert_truthy(re_paired,
                        "Pad re-paired with the same code (host session never died)")

        # ----- 4d: explicit Disconnect button + clean reconnect afterwards
        # The flow we want to prove:
        #   1. User clicks Disconnect → WS closes, pad bounces back to
        #      its entry form, Phone pill returns to idle.
        #   2. Click Phone again → fresh /start → new code → new pad
        #      session. No leaked state from the previous pairing.
        r.section("4d. Disconnect → reconnect cleanly")
        # The button now has a flex layout — match the actual rendered
        # text (icon + " Disconnect"), case-insensitive.
        disc_text = host.locator("#ctrlhost-disconnect").inner_text().strip()
        r.assert_truthy("disconnect" in disc_text.lower(),
                        f"Disconnect button visible with right copy ({disc_text!r})")
        host.click("#ctrlhost-disconnect")
        # Modal goes away.
        host.wait_for_selector("#controller-pair-modal",
                               state="detached", timeout=2_000)
        r.ok("Modal closed on Disconnect")
        # Pad page should bounce back to the entry form (the live pad
        # surface is removed when the WS gets the "end" frame).
        try:
            pad.wait_for_selector("#pair-form", timeout=4_000)
            r.ok("Pad bounced back to /pair entry form")
        except Exception:
            r.fail("Pad still showing live controller after host disconnect")
        # Phone pill green dot should be gone.
        dot_visible_after = host.locator("#controller-pair-dot").is_visible()
        r.assert_truthy(not dot_visible_after,
                        "Phone pill paired indicator hidden after disconnect")

        # Reconnect: fresh code, new pairing, new pad context.
        # We close the old pad page (which has a stale code) and use a
        # brand-new one — that's what a real user does (they'd just
        # leave the phone open and scan the new QR).
        pad.close()
        pad = pad_ctx.new_page()
        pad.on("pageerror",  lambda e: print(f"  [pad  pageerror] {e}"))

        host.click("#controller-pair-btn")
        host.wait_for_selector("#ctrlhost-code", timeout=4_000)
        new_code = (host.locator("#ctrlhost-code").inner_text() or "").strip()
        r.assert_truthy(new_code != code and len(new_code) == 6,
                        f"Fresh /start returned a NEW code {new_code!r} (was {code!r})")
        open_pad(pad, new_code)
        r.ok("Pad reconnected with fresh code")
        reconnected = wait_for_host_status(host, "connected", timeout_ms=5_000)
        r.assert_truthy(reconnected,
                        f"Host modal flipped to 'Connected' on reconnect (got {host_status_text(host)!r})")
        # Re-verify input flows through the fresh session — no leaked
        # state from the previous one.
        before = len(host_simulated(host))
        press(pad, 4)  # D-pad UP
        ok_relive = wait_for_sim(
            host,
            f"return inputs.length > {before} && "
            "inputs.some(i => i.slot === 4 && i.value === 1)",
            timeout_ms=3_000,
        )
        release(pad, 4)
        r.assert_truthy(ok_relive,
                        "Input flows through the fresh session (D-pad UP)")

        # ----- 5: input passes through pad → server → host → simulateInput
        r.section("5. A/B button presses reach simulateInput on correct slots")
        # EmulatorJS's own virtual gamepad maps visual A → input_value 8
        # and visual B → input_value 0 (see emulator.js:3506-3559). The
        # phone pad must match that — pressing the red "A" button has to
        # fire the in-game A button, not B. We assert both halves so the
        # mapping can't silently regress on either side.
        SLOT_A = 8
        SLOT_B = 0
        press(pad, SLOT_A)
        ok_down = wait_for_sim(
            host,
            f"return inputs.some(i => i.slot === {SLOT_A} && i.value === 1)",
            timeout_ms=3_000,
        )
        r.assert_truthy(ok_down, f"Host received simulateInput(0, {SLOT_A}, 1) (A down)")

        release(pad, SLOT_A)
        ok_up = wait_for_sim(
            host,
            f"return inputs.filter(i => i.slot === {SLOT_A} && i.value === 0).length >= 1",
            timeout_ms=3_000,
        )
        r.assert_truthy(ok_up, f"Host received simulateInput(0, {SLOT_A}, 0) (A up)")

        press(pad, SLOT_B)
        ok_b = wait_for_sim(
            host,
            f"return inputs.some(i => i.slot === {SLOT_B} && i.value === 1)",
            timeout_ms=3_000,
        )
        r.assert_truthy(ok_b, f"Host received simulateInput(0, {SLOT_B}, 1) (B down)")
        release(pad, SLOT_B)

        # Sanity: pressing the visual "A" button (the red one labelled A
        # on the pad UI) MUST land on slot SLOT_A — not the other face
        # button slot. Catches a regression where the data-button
        # attribute drifts from the EJS convention.
        a_btn_slot = pad.evaluate(
            'document.querySelector(".pad-face-btn--a").getAttribute("data-button")',
        )
        r.assert_eq(int(a_btn_slot), SLOT_A,
                    "Visual 'A' button has data-button matching EJS slot 8")
        b_btn_slot = pad.evaluate(
            'document.querySelector(".pad-face-btn--b").getAttribute("data-button")',
        )
        r.assert_eq(int(b_btn_slot), SLOT_B,
                    "Visual 'B' button has data-button matching EJS slot 0")

        # ----- 5b: D-pad slide-through (no lift between directions)
        # User slides their finger from UP into RIGHT without lifting
        # — the pad must release UP and press RIGHT mid-gesture. Real
        # users do this all the time (e.g., diagonal navigation in
        # menus), and the prior implementation kept UP held because
        # setPointerCapture pinned the pointer to the originally-touched
        # button. Mouse events in Chromium generate matching pointer
        # events, so we can drive the slide with page.mouse and have it
        # exercise the same code path a real touch would.
        r.section("5b. D-pad slide-through (release UP, press RIGHT mid-gesture)")
        up_box    = pad.locator(".pad-dpad-btn--up").bounding_box()
        right_box = pad.locator(".pad-dpad-btn--right").bounding_box()
        up_cx,    up_cy    = up_box["x"]    + up_box["width"]/2,    up_box["y"]    + up_box["height"]/2
        right_cx, right_cy = right_box["x"] + right_box["width"]/2, right_box["y"] + right_box["height"]/2

        baseline = host_simulated(host)
        baseline_len = len(baseline)
        # Press on UP, then slide (multiple intermediate moves so the
        # pointermove handler actually fires — a single jump straight
        # to RIGHT can elide intermediate events).
        pad.mouse.move(up_cx, up_cy)
        pad.mouse.down()
        # Land first on UP so the down-event is recorded.
        pad.wait_for_timeout(50)
        # Slide to RIGHT in two steps.
        pad.mouse.move((up_cx + right_cx) / 2, (up_cy + right_cy) / 2, steps=4)
        pad.mouse.move(right_cx, right_cy, steps=4)
        pad.wait_for_timeout(50)
        pad.mouse.up()

        # Wait for the full pad → server → host → simulateInput chain
        # to reach the recorder before snapshotting. Without this we
        # see a short read where the final RIGHT-up hasn't propagated
        # yet, even though it does land within a few ms.
        wait_for_sim(
            host,
            "return inputs.filter(i => i.slot === 7 && i.value === 0).length >= 1",
            timeout_ms=2_000,
        )

        # Expected sequence (in order, after the baseline):
        #   slot 4 down  → UP press
        #   slot 4 up    → released as we slid off UP
        #   slot 7 down  → RIGHT press
        #   slot 7 up    → released on mouse.up
        seq = [
            (m["slot"], m["value"])
            for m in host_simulated(host)[baseline_len:]
            if m["slot"] in (4, 7)
        ]
        # Use a tolerant check: the expected ordered subsequence shows
        # up at least once. Phantom duplicates are OK; missing ones
        # mean the slide-through didn't work.
        def has_subsequence(seq, sub):
            it = iter(seq)
            return all(item in it for item in sub)
        wanted = [(4, 1), (4, 0), (7, 1), (7, 0)]
        r.assert_truthy(has_subsequence(seq, wanted),
                        f"Slide UP→RIGHT produced expected sequence (got {seq})")

        # ----- 6: held-button auto-release on pad disconnect
        r.section("6. Held button auto-released when pad WS drops")
        # Press the START button (slot 3) and hold; then close the pad
        # page. The server should synthesize a button-up so the host
        # records the release without us doing anything from the pad.
        before_count = len(host_simulated(host))
        press(pad, 3)
        # Confirm the down landed before we yank the connection — otherwise
        # we're testing nothing.
        ok_start_down = wait_for_sim(
            host,
            "return inputs.some(i => i.slot === 3 && i.value === 1)",
            timeout_ms=3_000,
        )
        r.assert_truthy(ok_start_down, "START down recorded before disconnect")
        pad.close()
        ok_start_up = wait_for_sim(
            host,
            "return inputs.filter(i => i.slot === 3 && i.value === 0).length >= 1",
            timeout_ms=4_000,
        )
        r.assert_truthy(ok_start_up,
                        "Server auto-released START on pad disconnect")
        r.assert_truthy(len(host_simulated(host)) > before_count,
                        "simulateInput call count grew (sanity)")

        # ----- 7: status flips back to "Waiting…" after pad leaves
        r.section("7. Host status returns to 'Waiting…' after pad gone")
        waiting = wait_for_host_status(host, "waiting", timeout_ms=4_000)
        r.assert_truthy(waiting,
                        f"Host modal back to 'Waiting…' (got {host_status_text(host)!r})")

        # ----- 8: clean teardown when host closes the modal
        r.section("8. Host close → modal gone, no spurious toast")
        host.click("#ctrlhost-close")
        # The modal element is removed synchronously; the WS close
        # follows. If the close handler ever regressed back to surfacing
        # an "unexpected" toast on user-initiated close, a .toast--danger
        # element would appear here.
        try:
            host.wait_for_selector("#controller-pair-modal",
                                   state="detached", timeout=2_000)
            r.ok("Pair modal removed")
        except Exception:
            r.fail("Pair modal still present after Close")
        # Toast detection: the toast container appears under .toast-host
        # (see frontend/js/toast.js). A user-initiated close should leave
        # it empty / nonexistent.
        toast_present = host.evaluate("""() => {
          const root = document.querySelector('.toast-host');
          return !!(root && root.querySelector('.toast--danger'));
        }""")
        r.assert_truthy(not toast_present,
                        "No error toast surfaced after user-initiated close")

        browser.close()

    print()
    if r.failures:
        print(f"✗ {len(r.failures)} assertion(s) failed:")
        for f in r.failures:
            print(f"   · {f}")
        return 1
    print("✓ all phone-controller assertions pass")
    return 0


if __name__ == "__main__":
    sys.exit(run())
