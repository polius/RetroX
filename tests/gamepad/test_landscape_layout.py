#!/usr/bin/env python3
"""Empirical layout test — virtual gamepad on a phone in landscape.

Boots Pokemon Blue (Game Boy) in a landscape phone viewport, measures
the rendered geometry of every gamepad cluster, and asserts the
alignment guarantees that the player.css + play.js rewrite is meant to
provide:

  1. The original Rewind button (b_speed_rewind) is display:none.
     The Slow Motion button has been rewired into a "Rewind" button
     (input 28) — it stays visible as the left half of the speed row.
  2. The d-pad's vertical content center sits on the viewport's
     vertical midline (±2px).
  3. A/B sits where a perfectly-centered (A/B + STACK_GAP + bottom
     block) stack would put it — the centering math drives A/B's
     position, so the face buttons stay put if STACK_GAP changes
     downstream of BOTTOM_EXTRA_DROP. Verified by computing the
     expected top y from parent height and the measured row heights.
  4. A/B, Select/Start and Rewind/Fast all share the same horizontal
     column — their visible content centers align (±2px).
  5. The gap between A/B's bottom and Select/Start's top equals
     STACK_GAP + BOTTOM_EXTRA_DROP (±2px). The bottom block is
     intentionally dropped past its centered slot.
  6. The d-pad's leftmost visible button sits ~EDGE_INSET px from the
     viewport's left edge (±2px) — anchored to the device edge for
     thumb ergonomics, NOT centered in the canvas pillarbox.
  7. The right cluster's rightmost visible button sits ~EDGE_INSET px
     from the viewport's right edge (±2px), same edge-anchored
     ergonomic placement.
  8. Rewind ("Rewind") and Fast ("Fast") are visible below Select/Start
     in the conventional [Rewind] [Fast] media-player order.

Prerequisites:
    docker compose up -d --build
    pip install -r tests/gamepad/requirements.txt
    playwright install chromium

Run:
    python tests/gamepad/test_landscape_layout.py

Exits 0 on full pass, 1 on any assertion failure, 2 on setup failure.
"""
import sys
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"
SLUG = "pokemon-blue-version-gb"

# iPhone 14 / 15 landscape — 852x393 logical CSS pixels at 3x DPR. A
# typical mid-size phone in landscape; the @media gate
#   (orientation: landscape) and (pointer: coarse) and (max-height: 500px)
# matches at this size.
VIEWPORT = {"width": 852, "height": 393}
DPR = 3
TOL_PX = 2        # px tolerance for centering checks
TOL_EDGE_PX = 2   # px tolerance for edge-inset checks
EDGE_INSET = 30   # must match EDGE_INSET in play.js — distance from
                  # viewport edge to the nearest visible button
STACK_GAP = 20    # must match STACK_GAP in play.js — reference gap used
                  # in the centering math (drives A/B's vertical position)
BOTTOM_EXTRA_DROP = 16  # must match BOTTOM_EXTRA_DROP — extra px the
                        # Select/Start row is dropped past its centered
                        # slot for thumb-friendly separation from A/B
ACTUAL_AB_TO_BOTTOM_GAP = STACK_GAP + BOTTOM_EXTRA_DROP


# In-page measurement: returns viewport, canvas rect, and content-bbox
# for each gamepad cluster (computed from the union of all visible
# .ejs_virtualGamepad_button + .ejs_dpad_main bounding rects, which is
# what the user actually sees regardless of container geometry).
MEASURE_JS = """
() => {
  const ejs = window.EJS_emulator;
  const parent = ejs?.elements?.parent;
  const canvas = ejs?.canvas;
  const pad    = parent?.querySelector('.ejs_virtualGamepad_parent');
  const left   = pad?.querySelector('.ejs_virtualGamepad_left');
  const right  = pad?.querySelector('.ejs_virtualGamepad_right');
  const bottom = pad?.querySelector('.ejs_virtualGamepad_bottom');
  if (!parent || !canvas || !pad || !left || !right || !bottom) return null;

  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             right: r.right, bottom: r.bottom,
             cx: r.left + r.width/2, cy: r.top + r.height/2 };
  };

  const measureContent = (cluster) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const items = cluster.querySelectorAll(
      '.ejs_virtualGamepad_button, .ejs_dpad_main'
    );
    for (const it of items) {
      if (!it.offsetWidth || !it.offsetHeight) continue;
      if (getComputedStyle(it).display === 'none') continue;
      const r = it.getBoundingClientRect();
      minX = Math.min(minX, r.left);
      maxX = Math.max(maxX, r.right);
      minY = Math.min(minY, r.top);
      maxY = Math.max(maxY, r.bottom);
    }
    if (!isFinite(minX)) return null;
    return { minX, maxX, minY, maxY,
             w: maxX - minX, h: maxY - minY,
             cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  };

  const fast   = pad.querySelector('.ejs_virtualGamepad_button.b_speed_fast');
  const slow   = pad.querySelector('.ejs_virtualGamepad_button.b_speed_slow');
  const rewind = pad.querySelector('.ejs_virtualGamepad_button.b_speed_rewind');
  const speedSnap = (el) => el ? {
    display: getComputedStyle(el).display,
    text: el.innerText.trim(),
    rect: rect(el),
  } : null;

  // EmulatorJS sizes the canvas DOM to 100%×100% of its parent; the
  // game image is centered inside it via WebGL, not CSS. Recover the
  // playable image rect from the core's intrinsic aspect ratio so the
  // test checks alignment against what the user actually sees.
  const aspect = ejs.gameManager?.getVideoDimensions?.('aspect')
              || (canvas.width && canvas.height ? canvas.width / canvas.height : 4/3);
  const dom = { w: canvas.getBoundingClientRect().width,
                h: canvas.getBoundingClientRect().height,
                left: canvas.getBoundingClientRect().left,
                top:  canvas.getBoundingClientRect().top };
  let imgW, imgH;
  if (dom.w / dom.h > aspect) { imgH = dom.h; imgW = dom.h * aspect; }
  else                        { imgW = dom.w; imgH = dom.w / aspect; }
  const image = {
    x: dom.left + (dom.w - imgW) / 2,
    y: dom.top  + (dom.h - imgH) / 2,
    w: imgW, h: imgH,
  };
  image.right  = image.x + image.w;
  image.bottom = image.y + image.h;
  image.cx     = image.x + image.w / 2;
  image.cy     = image.y + image.h / 2;

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight,
                cx: window.innerWidth / 2, cy: window.innerHeight / 2 },
    canvas:   rect(canvas),
    image,
    aspect,
    parent:   rect(parent),
    leftCluster:  rect(left),
    rightCluster: rect(right),
    bottomRow:    rect(bottom),
    leftContent:   measureContent(left),
    rightContent:  measureContent(right),
    bottomContent: measureContent(bottom),
    fast:   speedSnap(fast),
    slow:   speedSnap(slow),
    rewind: speedSnap(rewind),
    cssVars: {
      leftX:   pad.style.getPropertyValue('--vpad-left-x'),
      leftY:   pad.style.getPropertyValue('--vpad-left-y'),
      rightX:  pad.style.getPropertyValue('--vpad-right-x'),
      rightY:  pad.style.getPropertyValue('--vpad-right-y'),
      shift:   pad.style.getPropertyValue('--vpad-right-shift'),
      bottomX: pad.style.getPropertyValue('--vpad-bottom-x'),
      bottomY: pad.style.getPropertyValue('--vpad-bottom-y'),
    },
  };
}
"""


class Check:
    def __init__(self):
        self.results = []  # (ok, msg)

    def close(self, name, actual, expected, tol):
        diff = abs(actual - expected)
        ok = diff <= tol
        self.results.append((ok, f"{name}: actual={actual:.1f}, "
                                 f"expected={expected:.1f} (±{tol}), "
                                 f"diff={diff:.1f}"))

    def eq(self, name, actual, expected):
        ok = actual == expected
        self.results.append((ok, f"{name}: actual={actual!r}, expected={expected!r}"))

    def report(self):
        passes = sum(1 for ok, _ in self.results if ok)
        for ok, msg in self.results:
            print(f"  {'PASS' if ok else 'FAIL'}  {msg}")
        print()
        if passes == len(self.results):
            print(f"PASSED  {passes}/{len(self.results)} checks")
            return 0
        print(f"FAILED  {len(self.results)-passes} of {len(self.results)} checks")
        return 1


def login(page):
    # The API's CSRF guard rejects requests whose Origin doesn't match the
    # API host. APIRequestContext doesn't infer an Origin, so set it
    # explicitly. `data=dict` is JSON-encoded by Playwright.
    r = page.context.request.post(
        f"{BASE}/api/auth/login",
        data={"username": USER, "password": PASS},
        headers={"Origin": BASE},
    )
    if r.status >= 300:
        raise RuntimeError(f"login failed: HTTP {r.status} — {r.text()}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                # Skip the autoplay overlay — we don't need real audio for
                # a layout test, but we DO need EJS_onGameStart to fire so
                # installVirtualGamepadAlignment() runs.
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        ctx = browser.new_context(
            viewport=VIEWPORT,
            device_scale_factor=DPR,
            has_touch=True,
            is_mobile=True,
            user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                        "Mobile/15E148 Safari/604.1"),
        )
        page = ctx.new_page()
        page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
        page.on("console", lambda m: m.type == "error"
                and print(f"  [console.error] {m.text}"))

        try:
            login(page)
        except Exception as e:
            print(f"setup error: {e}", file=sys.stderr)
            sys.exit(2)

        # Direct navigation — mirrors the deep link the user typed.
        page.goto(f"{BASE}/play/{SLUG}?slot=1")

        # The gamepad parent appears as soon as EJS instantiates its UI.
        try:
            page.wait_for_selector(".ejs_virtualGamepad_parent",
                                   state="attached", timeout=30000)
            page.wait_for_selector(".ejs_virtualGamepad_left",
                                   state="attached", timeout=30000)
            page.wait_for_selector(".ejs_virtualGamepad_right",
                                   state="attached", timeout=30000)
            page.wait_for_selector(".ejs_virtualGamepad_bottom",
                                   state="attached", timeout=30000)
        except PWTimeout as e:
            print(f"setup error: virtual gamepad never rendered ({e})", file=sys.stderr)
            page.screenshot(path="/tmp/retrox_landscape_layout_failure.png")
            sys.exit(2)

        # Wait until installVirtualGamepadAlignment() has emitted the
        # CSS vars — this fires from EJS_onGameStart, which only fires
        # once the core has actually started running.
        try:
            page.wait_for_function(
                """() => {
                  const pad = document.querySelector('.ejs_virtualGamepad_parent');
                  return !!pad && !!pad.style.getPropertyValue('--vpad-right-y');
                }""",
                timeout=30000,
            )
        except PWTimeout:
            print("setup error: alignment CSS vars never set", file=sys.stderr)
            page.screenshot(path="/tmp/retrox_landscape_layout_failure.png")
            sys.exit(2)

        # Let any ResizeObserver settle.
        page.wait_for_timeout(500)

        m = page.evaluate(MEASURE_JS)
        if m is None:
            print("setup error: measurement returned null", file=sys.stderr)
            sys.exit(2)

        page.screenshot(path="/tmp/retrox_landscape_layout.png", full_page=False)

        # ---- Diagnostics ----
        vp = m["viewport"]
        image = m["image"]
        parentLeft  = m["parent"]["x"]
        parentRight = m["parent"]["x"] + m["parent"]["w"]
        leftMargin  = image["x"] - parentLeft
        rightMargin = parentRight - image["right"]
        leftEdgeInset  = m["leftContent"]["minX"]  - parentLeft
        rightEdgeInset = parentRight - m["rightContent"]["maxX"]

        print(f"Screenshot: /tmp/retrox_landscape_layout.png")
        print()
        print(f"Viewport:        {vp['w']}x{vp['h']}, center=({vp['cx']:.0f}, {vp['cy']:.0f})")
        print(f"Canvas DOM:      x=[{m['canvas']['x']:.1f}, {m['canvas']['right']:.1f}]  "
              f"y=[{m['canvas']['y']:.1f}, {m['canvas']['bottom']:.1f}]  "
              f"size={m['canvas']['w']:.1f}x{m['canvas']['h']:.1f}")
        print(f"Visible image:   x=[{image['x']:.1f}, {image['right']:.1f}]  "
              f"y=[{image['y']:.1f}, {image['bottom']:.1f}]  "
              f"size={image['w']:.1f}x{image['h']:.1f}  aspect={m['aspect']:.4f}")
        print(f"  left margin  = {leftMargin:.1f}px  right margin = {rightMargin:.1f}px")
        print(f"  d-pad leftmost button is {leftEdgeInset:.1f}px from viewport left")
        print(f"  A/B rightmost button   is {rightEdgeInset:.1f}px from viewport right")
        for k, label in [("leftContent",   "D-pad content        "),
                         ("rightContent",  "A/B content          "),
                         ("bottomContent", "Select/Start content ")]:
            box = m[k]
            print(f"{label} x=[{box['minX']:.1f}, {box['maxX']:.1f}]  "
                  f"y=[{box['minY']:.1f}, {box['maxY']:.1f}]  "
                  f"c=({box['cx']:.1f}, {box['cy']:.1f})")
        print(f"CSS vars: {m['cssVars']}")
        print()
        print("=== Assertions ===")

        c = Check()
        # 1. Original Rewind hidden; Slow rewired into a "Rewind" button
        #    that's still in the DOM and visible.
        c.eq("Original Rewind hidden",          m["rewind"]["display"] if m["rewind"] else "absent", "none")
        c.eq("Slow button rewired to 'Rewind'", m["slow"]["text"]    if m["slow"]   else None,  "Rewind")
        c.eq("Slow (now Rewind) visible",       (m["slow"]["display"] != "none") if m["slow"] else False, True)
        c.eq("Fast visible",                    (m["fast"]["display"] != "none") if m["fast"] else False, True)

        # 2. D-pad vertically centered (content)
        c.close("D-pad content vertical center on midline",
                m["leftContent"]["cy"], vp["cy"], TOL_PX)

        # 3. A/B sits at the centered-stack position. Compute where the
        #    top of A/B's content WOULD be if the (A/B + STACK_GAP +
        #    bottom block) stack were perfectly centered, then verify
        #    A/B's measured content top matches it. This is invariant
        #    over BOTTOM_EXTRA_DROP changes — the drop only affects the
        #    bottom block, not A/B.
        stackH = (m["rightContent"]["h"] + STACK_GAP + m["bottomContent"]["h"])
        expectedABTop = m["parent"]["y"] + (m["parent"]["h"] - stackH) / 2
        c.close("A/B content top matches centered-stack math",
                m["rightContent"]["minY"], expectedABTop, TOL_PX)

        # 4. A/B and bottom (Select/Start + Rewind/Fast) share a column.
        c.close("A/B horizontal center == bottom-row horizontal center",
                m["rightContent"]["cx"], m["bottomContent"]["cx"], TOL_PX)

        # 5. Gap between A/B's bottom and Select/Start's top equals
        #    STACK_GAP + BOTTOM_EXTRA_DROP (the bottom block is
        #    intentionally dropped past the centered slot).
        actualGap = m["bottomContent"]["minY"] - m["rightContent"]["maxY"]
        c.close("Gap between A/B and Select/Start = STACK_GAP + BOTTOM_EXTRA_DROP",
                actualGap, ACTUAL_AB_TO_BOTTOM_GAP, TOL_PX)

        # 6. D-pad's leftmost visible button anchored to the device edge
        c.close("D-pad leftmost button at EDGE_INSET from viewport left",
                leftEdgeInset, EDGE_INSET, TOL_EDGE_PX)

        # 7. Right cluster's rightmost visible button anchored to device edge
        c.close("A/B rightmost button at EDGE_INSET from viewport right",
                rightEdgeInset, EDGE_INSET, TOL_EDGE_PX)

        # 8. Rewind on the left, Fast on the right, both below Select/Start.
        if m["slow"] and m["fast"]:
            slowR, fastR = m["slow"]["rect"], m["fast"]["rect"]
            c.eq("Rewind sits left of Fast (media-player order)",
                 slowR["cx"] < fastR["cx"], True)
            # The Select/Start row's bottom edge is bottomContent.minY+31
            # (Select/Start are 31px tall after the override). The Rewind/
            # Fast row's top edge should be below that.
            selectStartBottom = m["bottomContent"]["minY"] + 31
            c.eq("Rewind row sits below Select/Start row",
                 slowR["y"] >= selectStartBottom - 1, True)
            c.eq("Fast   row sits below Select/Start row",
                 fastR["y"] >= selectStartBottom - 1, True)

        rc = c.report()
        browser.close()
        sys.exit(rc)


if __name__ == "__main__":
    main()
