"""Gamepad navigation audit for RetroX — broad-surface integration test.

Mocks navigator.getGamepads with a controllable Standard-mapping pad and
drives every reachable surface (login QR, library grid + list, game
detail, in-app player overlay, profile, all admin tabs, modals, command
palette) verifying focus lands where the spatial-nav model says it
should.

Each surface runs in its own browser session so one broken scenario
can't poison the rest. Findings accumulate in the `issues` list and
the run ends with a `Total issues: N` summary — clean run is N == 0.

Prerequisites and how to run: see tests/gamepad/README.md.
"""
import json
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"

# Standard-mapping button indices.
A, B, X, Y         = 0, 1, 2, 3
L1, R1, L2, R2     = 4, 5, 6, 7
SELECT, START      = 8, 9
LS, RS             = 10, 11
UP, DOWN, LEFT, RIGHT = 12, 13, 14, 15

# Inject the gamepad mock as soon as the page document opens, before
# any of the app's own scripts run.
GP_SHIM = """
if (!window.__rxGpInstalled) {
  window.__rxGpInstalled = true;
  const pad = {
    id: 'RetroX Test Gamepad (Standard)', index: 0, connected: true,
    mapping: 'standard', timestamp: 0,
    buttons: Array.from({length:17}, () => ({pressed:false, value:0, touched:false})),
    axes: [0, 0, 0, 0],
  };
  window.__rxPad = pad;
  navigator.getGamepads = () => { pad.timestamp = performance.now(); return [pad, null, null, null]; };
  setTimeout(() => {
    try { window.dispatchEvent(new GamepadEvent('gamepadconnected', {gamepad: pad})); }
    catch { const e = new Event('gamepadconnected'); e.gamepad = pad; window.dispatchEvent(e); }
  }, 0);
}
"""

# Pre-stamp the persistent "controller seen" flag so initial-focus
# heuristics that read it (auto-focus first card / Play button / admin
# tab / QR default) take the controller branch on cold load.
SEEN_STAMP = """
try { localStorage.setItem('retrox.controller_seen', String(Date.now())); } catch {}
"""

issues = []
def issue(page_label, desc, evidence=None):
    issues.append({"page": page_label, "issue": desc, "evidence": evidence})
    line = f"  [!] {page_label}: {desc}"
    print(line)
    if evidence:
        print(f"      ↳ {json.dumps(evidence, default=str)[:240]}")

def setup(p, prestamp_seen=True):
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    if prestamp_seen:
        ctx.add_init_script(SEEN_STAMP)
    ctx.add_init_script(GP_SHIM)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print(f"      [pageerror] {e}"))
    return browser, ctx, page

def login(page):
    """Log in via the API directly — bypasses the UI's controller→QR
    auto-switch which makes form-mode unstable inside the audit run."""
    # Retry on 429 — backend rate-limits /api/auth/login at 5/min and the
    # audit re-logs in for every audit_* section, so a back-to-back run can
    # legitimately hit the cap even when nothing's wrong.
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
    page.goto(f"{BASE}/games")
    page.wait_for_selector(".gcard, .empty-welcome", timeout=10000)

def press(page, idx, hold_ms=80):
    page.evaluate("(i) => { window.__rxPad.buttons[i].pressed = true; window.__rxPad.buttons[i].value = 1; }", idx)
    page.wait_for_timeout(hold_ms)
    page.evaluate("(i) => { window.__rxPad.buttons[i].pressed = false; window.__rxPad.buttons[i].value = 0; }", idx)
    page.wait_for_timeout(60)

def hold_combo(page, idx_a, idx_b):
    """Press idx_b while idx_a is held — Select+Start, Select+L1, etc."""
    page.evaluate("(i) => { window.__rxPad.buttons[i].pressed = true; window.__rxPad.buttons[i].value = 1; }", idx_a)
    page.wait_for_timeout(60)
    page.evaluate("(i) => { window.__rxPad.buttons[i].pressed = true; window.__rxPad.buttons[i].value = 1; }", idx_b)
    page.wait_for_timeout(120)
    page.evaluate("(i) => { window.__rxPad.buttons[i].pressed = false; window.__rxPad.buttons[i].value = 0; }", idx_b)
    page.wait_for_timeout(60)
    page.evaluate("(i) => { window.__rxPad.buttons[i].pressed = false; window.__rxPad.buttons[i].value = 0; }", idx_a)
    page.wait_for_timeout(80)

def focus_info(page):
    return page.evaluate("""() => {
      const a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement) return { tag: 'body' };
      const r = a.getBoundingClientRect();
      const group = a.closest('[data-nav-group]');
      const text = (a.innerText || a.value || a.placeholder || a.getAttribute('aria-label') || '').trim();
      return {
        tag: a.tagName,
        id: a.id || null,
        cls: (a.className && typeof a.className === 'string') ? a.className : null,
        text: text.slice(0, 60),
        href: a.getAttribute('href'),
        ariaCurrent: a.getAttribute('aria-current'),
        ariaPressed: a.getAttribute('aria-pressed'),
        inViewport: r.top >= -1 && r.left >= -1 &&
                    r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
        rect: { t: r.top|0, l: r.left|0, w: r.width|0, h: r.height|0 },
        groupCls: group ? (group.id || group.className) : null,
      };
    }""")

def trace(label, f):
    g = (f.get("groupCls") or "").split(" ")[0] if f.get("groupCls") else "—"
    print(f"  · {label:<30} → {f.get('tag','?'):<8} #{(f.get('id') or '-'):<14} "
          f"{(f.get('text') or '')[:30]!r} viewport={'Y' if f.get('inViewport') else 'N'} "
          f"group={g}")

# =====================================================================
# Per-surface audits
# =====================================================================

def audit_login_form(p):
    """Login auto-switches to QR for controller users (intentional UX,
    see login.js maybeSwitchToQr). Form mode is the keyboard/mouse path
    and isn't part of the controller audit. Skipped."""
    print("\n=== /login (form mode) — SKIPPED (intentionally QR-only for controllers) ===")

def audit_login_qr(p):
    print("\n=== /login (QR mode — controller default) ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    page.goto(f"{BASE}/login")
    page.wait_for_timeout(1500)
    is_qr = page.evaluate("() => !!document.querySelector('.qr-card')")
    print(f"  default mode: {'QR' if is_qr else 'form'}")
    if not is_qr:
        issue("/login", "controller-seen flag did not switch login to QR mode",
              evidence={"has_qr_card": is_qr, "url": page.url})
    f = focus_info(page); trace("focus", f)
    browser.close()

def audit_library(p):
    print("\n=== /games (library, controller mode) ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.wait_for_selector(".gcard, .empty-welcome", timeout=10000)
    page.wait_for_timeout(800)
    f = focus_info(page); trace("on load", f)
    if not (f.get("cls") and "gcard" in f.get("cls")):
        issue("/games", "initial focus is not the first .gcard for a controller user",
              evidence=f)

    # Walk through the grid.
    seen_focus = []
    for d, lbl in [(DOWN,"DOWN"),(DOWN,"DOWN"),(RIGHT,"RIGHT"),(RIGHT,"RIGHT"),
                   (UP,"UP"),(LEFT,"LEFT")]:
        press(page, d); fi = focus_info(page); trace(lbl, fi); seen_focus.append(fi)

    # Spam LEFT to reach sidebar.
    for _ in range(8): press(page, LEFT)
    f = focus_info(page); trace("after spam LEFT", f)
    if "sidebar" not in (f.get("groupCls") or ""):
        issue("/games", "could not reach the sidebar from the grid via repeated LEFT", evidence=f)

    # In sidebar walk DOWN through nav items.
    for _ in range(6):
        press(page, DOWN); trace("sidebar DOWN", focus_info(page))

    # RIGHT escape back into content.
    press(page, RIGHT); f = focus_info(page); trace("RIGHT exits sidebar", f)
    if "sidebar" in (f.get("groupCls") or ""):
        issue("/games", "RIGHT from sidebar didn't escape — focus stuck in sidebar", evidence=f)

    # Filter chip cycling via L1/R1.
    press(page, R1); trace("after R1", focus_info(page))
    press(page, R1); trace("after R1", focus_info(page))
    press(page, L1); trace("after L1", focus_info(page))

    # West face button (X on Xbox / Square on PS) is intentionally
    # unbound — see gamepad-nav.js. It must NOT open the palette
    # (the palette is keyboard-only via "/" and Cmd/Ctrl-K). We do
    # still verify B closes the palette when it's somehow open, by
    # opening the palette via the keyboard shortcut instead.
    press(page, X); page.wait_for_timeout(300)
    if page.evaluate("() => !!document.querySelector('.palette-backdrop')"):
        issue("/games", "West face button (X / Square) opened the palette — should be unbound")
    # Open palette via the keyboard ("/" shortcut) so we can still
    # exercise the B-closes-palette path.
    page.keyboard.press("Slash"); page.wait_for_timeout(300)
    f = focus_info(page); trace("after / (palette via kbd)", f)
    if page.evaluate("() => !!document.querySelector('.palette-backdrop')"):
        press(page, DOWN); trace("palette DOWN", focus_info(page))
        press(page, B); page.wait_for_timeout(300)
        if page.evaluate("() => !!document.querySelector('.palette-backdrop')"):
            issue("/games", "B did not close command palette")

    # Y on a card → favorite toggle.
    page.evaluate("() => document.querySelector('.gcard')?.focus()")
    fav_before = page.evaluate("() => document.querySelector('.gcard')?.dataset.fav")
    press(page, Y); page.wait_for_timeout(400)
    fav_after = page.evaluate("() => document.querySelector('.gcard')?.dataset.fav")
    if fav_before == fav_after:
        issue("/games", "Y on a card did not toggle the favorite state",
              evidence={"before": fav_before, "after": fav_after})

    # SELECT button → first card jump.
    press(page, DOWN); press(page, DOWN); press(page, RIGHT)
    press(page, SELECT); page.wait_for_timeout(200)
    f = focus_info(page); trace("after SELECT", f)
    # Is it the first card?
    is_first = page.evaluate("() => document.activeElement === document.querySelector('.gcard')")
    if not is_first:
        issue("/games", "SELECT button didn't jump focus to the first card", evidence=f)

    # B button on the ROOT of the in-app history (/games as the first
    # shell page after /login) is intentionally a no-op: history.back()
    # would land on /login, and the explicit spec is "never go to the
    # login page". The route-tracking depth counter in router.js is 0
    # here, so canGoBackInApp() is false and goBack() returns silently.
    # Failure mode would be: navigated away, OR a stray side effect
    # (palette opened, etc.). We only flag those.
    pre_b_url = page.url
    palette_was_open = page.evaluate("() => !!document.querySelector('.palette-backdrop')")
    press(page, B); page.wait_for_timeout(400)
    post_b_url = page.url
    palette_now = page.evaluate("() => !!document.querySelector('.palette-backdrop')")
    f = focus_info(page); trace("after B", f)
    if post_b_url != pre_b_url:
        issue("/games", "B navigated away from root /games (would have hit /login)",
              evidence={"pre": pre_b_url, "post": post_b_url})
    if palette_now and not palette_was_open:
        issue("/games", "B opened the command palette (face-button remap regression)",
              evidence={"pre_open": palette_was_open, "post_open": palette_now})

    browser.close()

def audit_game_detail(p):
    print("\n=== /game/<slug> (controller mode) ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.locator('.gcard').first.click()
    page.wait_for_url(f"{BASE}/game/**", timeout=10000)
    page.wait_for_selector("#play-btn"); page.wait_for_timeout(800)
    f = focus_info(page); trace("on load", f)
    if f.get("id") != "play-btn":
        issue("/game", "Play button not auto-focused on cold-load",
              evidence=f)

    # DOWN into slot tiles.
    for d, lbl in [(DOWN,"DOWN"),(DOWN,"DOWN"),(RIGHT,"RIGHT"),
                   (UP,"UP"),(UP,"UP")]:
        press(page, d); trace(lbl, focus_info(page))

    # START opens the slot picker (CTA primary).
    page.evaluate("() => document.getElementById('play-btn')?.focus()")
    press(page, START); page.wait_for_timeout(300)
    open_after_start = page.evaluate("() => !!document.querySelector('.modal-backdrop')")
    if not open_after_start:
        issue("/game", "START did not open the slot picker modal")
    else:
        # Modal-internal nav.
        f = focus_info(page); trace("modal open", f)
        for d, lbl in [(DOWN,"modal DOWN"),(DOWN,"modal DOWN"),(UP,"modal UP")]:
            press(page, d); trace(lbl, focus_info(page))
        # B closes modal.
        press(page, B); page.wait_for_timeout(300)
        if page.evaluate("() => !!document.querySelector('.modal-backdrop')"):
            issue("/game", "B did not close the slot picker modal")

    # Y on the fav button.
    page.evaluate("() => document.getElementById('fav-btn')?.focus()")
    press(page, Y); page.wait_for_timeout(400)

    # Try to navigate INTO a slot card and reach its action buttons.
    page.evaluate("() => document.getElementById('play-btn')?.focus()")
    press(page, DOWN)  # away from header
    press(page, DOWN); press(page, DOWN)
    f = focus_info(page); trace("inside slot section", f)
    # Repeated DOWN/RIGHT — can we reach rename/download/upload/delete?
    for _ in range(8):
        press(page, RIGHT)
    f = focus_info(page); trace("after RIGHT*8", f)
    # If we're stuck inside one slot, that means the slot grid isn't a nav-group
    # and spatial pick can't traverse all cards.

    browser.close()

def audit_player(p):
    print("\n=== /play (player overlay) ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.locator('a[href="/game/asterix-obelix-gb"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").first.click()
    page.wait_for_timeout(2500)
    f = focus_info(page); trace("after entering player", f)

    # gamepad-nav.js skips while .player-host is mounted. That's deliberate
    # for in-game inputs but means the back button + sync pill are NOT
    # focusable via D-pad. Confirm.
    press(page, DOWN); press(page, DOWN); press(page, RIGHT)
    f = focus_info(page); trace("after directional presses", f)

    # Select+Y opens the sync-pill dialog (chrome reachability fix).
    hold_combo(page, SELECT, Y)
    page.wait_for_timeout(500)
    sync_open = page.evaluate("() => !!document.querySelector('.modal-backdrop')")
    print(f"  sync dialog open after Select+Y: {sync_open}")
    if not sync_open:
        issue("/play", "Select+Y did not open the sync-pill dialog")
    else:
        # Now gamepad-nav should be active (modal up), so A should close.
        press(page, A); page.wait_for_timeout(300)
        still_open = page.evaluate("() => !!document.querySelector('.modal-backdrop')")
        if still_open:
            issue("/play (sync dialog)", "A did not close the dialog from inside the player")
        else:
            print("  sync dialog: A closed it cleanly")

    # Select+Start exits the player (via play.js's poll).
    hold_combo(page, SELECT, START)
    page.wait_for_timeout(800)
    after_url = page.url
    print(f"  URL after Select+Start: {after_url}")
    if "/play/" in after_url:
        issue("/play", "Select+Start did not exit the player overlay",
              evidence={"url": after_url})
    browser.close()

def audit_profile(p):
    print("\n=== /profile ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.goto(f"{BASE}/profile"); page.wait_for_timeout(1200)
    f = focus_info(page); trace("on load", f)
    for d, lbl in [(DOWN,"DOWN"),(DOWN,"DOWN"),(RIGHT,"RIGHT"),
                   (DOWN,"DOWN"),(LEFT,"LEFT"),(UP,"UP")]:
        press(page, d); trace(lbl, focus_info(page))
    browser.close()

def audit_admin(p):
    print("\n=== /admin/library ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.goto(f"{BASE}/admin/library"); page.wait_for_timeout(1500)
    f = focus_info(page); trace("on load", f)
    if "admin-tabs" not in (f.get("groupCls") or ""):
        issue("/admin/library", "controller-mode auto-focus did not land on admin tabs", evidence=f)
    # Walk tabs.
    for _ in range(5):
        press(page, RIGHT); trace("admin tab RIGHT", focus_info(page))
    # DOWN into pane.
    for _ in range(8):
        press(page, DOWN); trace("DOWN in admin pane", focus_info(page))
    # Back UP — does it find the tabs?
    for _ in range(8):
        press(page, UP); trace("UP", focus_info(page))
    f = focus_info(page)
    if "admin-tabs" not in (f.get("groupCls") or "") and "sidebar" not in (f.get("groupCls") or ""):
        issue("/admin/library", "UP from admin pane bottom didn't return focus to the tab strip",
              evidence=f)
    browser.close()

def audit_admin_users(p):
    print("\n=== /admin/users ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.goto(f"{BASE}/admin/users"); page.wait_for_timeout(1500)
    f = focus_info(page); trace("on load", f)
    for _ in range(8):
        press(page, DOWN); trace("DOWN", focus_info(page))
    browser.close()

def audit_admin_emulators(p):
    print("\n=== /admin/emulators ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.goto(f"{BASE}/admin/emulators"); page.wait_for_timeout(1500)
    f = focus_info(page); trace("on load", f)
    for _ in range(6):
        press(page, DOWN); trace("DOWN", focus_info(page))
    browser.close()

def audit_admin_collections(p):
    print("\n=== /admin/collections ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.goto(f"{BASE}/admin/collections"); page.wait_for_timeout(1500)
    f = focus_info(page); trace("on load", f)
    for _ in range(6):
        press(page, DOWN); trace("DOWN", focus_info(page))
    browser.close()

def audit_admin_saves(p):
    print("\n=== /admin/saves ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.goto(f"{BASE}/admin/saves"); page.wait_for_timeout(1500)
    f = focus_info(page); trace("on load", f)
    for _ in range(6):
        press(page, DOWN); trace("DOWN", focus_info(page))
    browser.close()

def audit_modal_confirm(p):
    print("\n=== modal.confirm dialog ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.locator('a[href="/game/pokemon-blue-version-gb"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector(".slot[data-slot]")
    page.wait_for_timeout(800)
    page.evaluate("""() => document.querySelector('.slot[data-slot=\"1\"] [data-act=\"delete\"]')?.click()""")
    page.wait_for_selector(".modal", timeout=2000); page.wait_for_timeout(300)
    f = focus_info(page); trace("confirm modal open", f)
    # Danger=true → Cancel auto-focus expected.
    if not (f.get("text", "").lower().startswith("cancel")):
        issue("/game (confirm modal)", "danger=true confirm did NOT auto-focus Cancel",
              evidence=f)
    # RIGHT/LEFT shouldn't escape the modal foot.
    press(page, RIGHT); trace("RIGHT", focus_info(page))
    press(page, LEFT);  trace("LEFT",  focus_info(page))
    # B closes.
    press(page, B); page.wait_for_timeout(300)
    if page.evaluate("() => !!document.querySelector('.modal-backdrop')"):
        issue("/game (confirm modal)", "B did not close the confirm modal")
    browser.close()

def audit_player_chrome_dialog(p):
    print("\n=== player chrome dialog (sync pill click) ===")
    browser, ctx, page = setup(p, prestamp_seen=True)
    login(page)
    page.locator('a[href="/game/asterix-obelix-gb"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").first.click()
    page.wait_for_timeout(2500)
    page.evaluate("() => document.querySelector('.player__status')?.click()")
    page.wait_for_selector(".modal", timeout=2000); page.wait_for_timeout(300)
    f = focus_info(page); trace("dialog open", f)
    # gamepad-nav now handles input when a modal is up over the player.
    press(page, A); page.wait_for_timeout(300)
    after = page.evaluate("() => !!document.querySelector('.modal-backdrop')")
    if after:
        issue("/play (sync dialog)", "A did not close the dialog from inside the player overlay",
              evidence={"modal_still_open": True})
    else:
        print("  ✓ A closed the dialog cleanly")
    browser.close()

# =====================================================================
# Run everything
# =====================================================================

with sync_playwright() as p:
    audit_login_form(p)
    audit_login_qr(p)
    audit_library(p)
    audit_game_detail(p)
    audit_player(p)
    audit_player_chrome_dialog(p)
    audit_profile(p)
    audit_admin(p)
    audit_admin_users(p)
    audit_admin_emulators(p)
    audit_admin_collections(p)
    audit_admin_saves(p)
    audit_modal_confirm(p)

print(f"\n========\nTotal issues: {len(issues)}\n========")
for i in issues:
    print(f"- [{i['page']}] {i['issue']}")
