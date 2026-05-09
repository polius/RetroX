"""Targeted regression check — one numbered scenario per known bug.

Each ISSUE block exercises a specific fix that's landed. This is the
first script to run when investigating a regression: tighter scope,
clearer failure output, faster than audit_full.py.

When a new gamepad-related bug ships, add an ISSUE block here. Keep
each scenario in its own browser session so a single broken test can't
poison later ones.

Prerequisites and how to run: see tests/gamepad/README.md.
"""
import json
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"
A,B,X,Y = 0,1,2,3
L1,R1 = 4,5
SELECT, START = 8, 9
UP, DOWN, LEFT, RIGHT = 12, 13, 14, 15

GP_SHIM = """
if (!window.__rxGpInstalled) {
  window.__rxGpInstalled = true;
  const pad = { id:'X', index:0, connected:true, mapping:'standard', timestamp:0,
    buttons: Array.from({length:17}, () => ({pressed:false, value:0, touched:false})),
    axes: [0,0,0,0] };
  window.__rxPad = pad;
  navigator.getGamepads = () => [pad,null,null,null];
  setTimeout(() => {
    try { window.dispatchEvent(new GamepadEvent('gamepadconnected', {gamepad:pad})); }
    catch { const e = new Event('gamepadconnected'); e.gamepad=pad; window.dispatchEvent(e); }
  }, 0);
}
"""
SEEN_STAMP = "try{localStorage.setItem('retrox.controller_seen',String(Date.now()))}catch{}"

# Login is rate-limited (5/min). Acquire one auth cookie at module load
# via urllib (cheap and no Playwright loop) and seed every per-scenario
# context with it via storage_state — scenarios skip /api/auth/login
# entirely and run instantly without tripping the limiter.
_STORAGE_STATE = None

def _acquire_storage_state():
    global _STORAGE_STATE
    if _STORAGE_STATE is not None:
        return _STORAGE_STATE
    body = json.dumps({"username": USER, "password": PASS}).encode("utf-8")
    headers = {"Content-Type": "application/json", "Origin": BASE}
    last_err = None
    for attempt in range(4):
        req = urllib.request.Request(f"{BASE}/api/auth/login", data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                set_cookies = r.headers.get_all("Set-Cookie") or []
                break
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 429:
                time.sleep(13 * (attempt + 1)); continue
            raise RuntimeError(f"login failed: {e.code} {e.read()[:200]!r}")
    else:
        raise RuntimeError(f"login still rate-limited after retries: {last_err}")

    host = urlsplit(BASE).hostname
    cookies = []
    # Minimal Set-Cookie parser — enough for FastAPI's HttpOnly session
    # cookie. Parsed Cookie attributes (Path, HttpOnly, Secure, etc.) are
    # mapped onto Playwright's storage_state cookie schema.
    for raw in set_cookies:
        parts = [p.strip() for p in raw.split(";")]
        name, _, value = parts[0].partition("=")
        attrs = {k.lower(): v for k, _, v in (p.partition("=") for p in parts[1:])}
        cookies.append({
            "name": name, "value": value, "domain": host, "path": attrs.get("path", "/"),
            "httpOnly": "httponly" in {k.lower() for k in attrs.keys()} or any(p.lower() == "httponly" for p in parts[1:]),
            "secure":   any(p.lower() == "secure"   for p in parts[1:]),
            "sameSite": (attrs.get("samesite", "Lax").capitalize() if attrs.get("samesite") else "Lax"),
        })
    _STORAGE_STATE = {"cookies": cookies, "origins": []}
    return _STORAGE_STATE

# Acquire once at import so every scenario inherits the same cookie.
_acquire_storage_state()

def setup(p):
    b = p.chromium.launch(headless=True, args=["--no-sandbox"])
    c = b.new_context(viewport={"width":1280,"height":800}, storage_state=_STORAGE_STATE)
    c.add_init_script(SEEN_STAMP); c.add_init_script(GP_SHIM)
    page = c.new_page(); page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
    return b, c, page

def login(page):
    # Cookie is already in the context; just navigate.
    page.goto(f"{BASE}/games"); page.wait_for_selector(".gcard")

def press(page, idx, hold_ms=80):
    page.evaluate("(i)=>{window.__rxPad.buttons[i].pressed=true;window.__rxPad.buttons[i].value=1}", idx)
    page.wait_for_timeout(hold_ms)
    page.evaluate("(i)=>{window.__rxPad.buttons[i].pressed=false;window.__rxPad.buttons[i].value=0}", idx)
    page.wait_for_timeout(60)

def f(page):
    return page.evaluate("""()=>{
      const a = document.activeElement;
      if (!a || a===document.body) return {tag:'body'};
      const r = a.getBoundingClientRect();
      return { tag: a.tagName, id: a.id||null, cls: (typeof a.className==='string'?a.className:null),
               text: (a.innerText||a.value||a.placeholder||'').slice(0,50).trim(),
               group: a.closest('[data-nav-group]')?.className || null };
    }""")

def trace(label, info):
    g = (info.get("group") or "—").split(" ")[0]
    print(f"  · {label:<32} → {info.get('tag','?'):<8} #{info.get('id') or '-':<14} "
          f"{(info.get('text') or '')[:30]!r} group={g}")

print("\n=== ISSUE 1: R1/L1 chip cycle leaves focus on body ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    # Focus a card
    page.evaluate("()=>document.querySelector('.gcard')?.focus()")
    # Walk UP twice to land on chips (UP from cards → library-filter primary)
    press(page, UP); trace("UP", f(page))
    press(page, R1); trace("R1 (cycle next chip)", f(page))
    press(page, R1); trace("R1 (cycle next chip)", f(page))
    press(page, L1); trace("L1 (cycle prev chip)", f(page))
    print("  → If 'tag' is 'body', the chip-cycle handler is leaving focus dropped.")
    b.close()

print("\n=== ISSUE 2: West face button is unbound; B still closes palette opened via kbd ===")
# Spec: the West face button (Standard button 2 → X on Xbox / Square
# on PS) does NOT open the palette. The palette is keyboard-only ("/"
# or Cmd/Ctrl-K). B / Circle still closes a palette opened by either
# path (it's the universal "back / cancel" gesture).
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    page.evaluate("()=>document.querySelector('.gcard')?.focus()")
    press(page, X); page.wait_for_timeout(400)
    after_x = page.evaluate("()=>!!document.querySelector('.palette-backdrop')")
    print(f"  palette open after West face button (X / Square): {after_x}  (must be False)")
    # Now open via keyboard so we can still exercise the B-closes path.
    page.keyboard.press("Slash"); page.wait_for_timeout(400)
    via_kbd = page.evaluate("()=>!!document.querySelector('.palette-backdrop')")
    print(f"  palette open after '/': {via_kbd}")
    if via_kbd:
        page.keyboard.type("doom"); page.wait_for_timeout(300)
        items = page.evaluate("()=>document.querySelectorAll('.palette__item').length")
        print(f"  results for 'doom': {items}")
        press(page, DOWN); trace("palette DOWN", f(page))
        press(page, DOWN); trace("palette DOWN", f(page))
        press(page, B); page.wait_for_timeout(300)
        still_open = page.evaluate("()=>!!document.querySelector('.palette-backdrop')")
        print(f"  palette still open after B: {still_open}  (must be False)")
    b.close()

print("\n=== ISSUE 3: UP from filter chips reaches sort/layout controls? ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    page.evaluate("()=>document.querySelector('.gcard')?.focus()")
    press(page, UP); trace("UP (cards→chips)", f(page))
    press(page, UP); trace("UP again (chips→?)", f(page))
    print("  → If still on a chip, the sort/layout/help controls in library-head are unreachable.")
    b.close()

print("\n=== ISSUE 4: /game slot grid traversal ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    page.locator('a[href="/game/pokemon-blue-version-gb"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn"); page.wait_for_timeout(800)
    # From Play, go DOWN. Should reach Slot 1 (which has saves & action buttons).
    press(page, DOWN); trace("from Play DOWN", f(page))
    press(page, RIGHT); trace("RIGHT (next slot card or action button?)", f(page))
    press(page, RIGHT); trace("RIGHT", f(page))
    press(page, RIGHT); trace("RIGHT", f(page))
    press(page, RIGHT); trace("RIGHT", f(page))
    press(page, DOWN); trace("DOWN", f(page))
    press(page, DOWN); trace("DOWN", f(page))
    print("  → Goal: each slot's action buttons (rename/download/upload/delete) reachable.")
    b.close()

print("\n=== ISSUE 5: /play sync-pill dialog with controller ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    page.locator('a[href="/game/asterix-obelix-gb"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").first.click()
    page.wait_for_timeout(2500)
    # Click pill via mouse (since controller can't reach it)
    page.evaluate("()=>document.querySelector('.player__status')?.click()")
    page.wait_for_selector(".modal", timeout=2000); page.wait_for_timeout(300)
    print("  Dialog open. Trying A button (should click Got it):")
    press(page, A); page.wait_for_timeout(300)
    still_open = page.evaluate("()=>!!document.querySelector('.modal-backdrop')")
    print(f"  modal still open: {still_open}")
    if still_open:
        print("  Trying Enter key (modal's own keyboard handler):")
        page.keyboard.press("Enter"); page.wait_for_timeout(300)
        still_open = page.evaluate("()=>!!document.querySelector('.modal-backdrop')")
        print(f"  modal still open after Enter: {still_open}")
    b.close()

print("\n=== ISSUE 6: /games auto-focus on cold load (controller mode) ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(2000)
    info = f(page); trace("cold-load focus", info)
    # Switch view by clicking a sidebar entry
    page.evaluate("()=>document.querySelector('[data-key=favorites]')?.click()")
    page.wait_for_timeout(800)
    info = f(page); trace("after sidebar click → /games?view=favorites", info)
    b.close()

print("\n=== ISSUE 7: Hold-to-repeat works for D-pad ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    page.evaluate("()=>document.querySelector('.gcard')?.focus()")
    info_before = f(page); trace("before hold", info_before)
    # Hold DOWN for 1.5s — should auto-repeat (~12 moves after the 380ms hold delay)
    page.evaluate("()=>{window.__rxPad.buttons[13].pressed=true;window.__rxPad.buttons[13].value=1}")
    page.wait_for_timeout(1500)
    page.evaluate("()=>{window.__rxPad.buttons[13].pressed=false;window.__rxPad.buttons[13].value=0}")
    page.wait_for_timeout(200)
    info_after = f(page); trace("after 1.5s hold", info_after)
    moved = info_before.get("text") != info_after.get("text")
    print(f"  → focus moved during hold: {moved}")
    b.close()

print("\n=== ISSUE 8: /link (QR-approval page) ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page)
    page.goto(f"{BASE}/link"); page.wait_for_timeout(1500)
    info = f(page); trace("/link load", info)
    press(page, DOWN); trace("DOWN", f(page))
    b.close()

print("\n=== ISSUE 9: SELECT button = first card jump (already known to work) — check view types ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    # Switch to list layout
    page.evaluate("()=>{localStorage.setItem('retrox.layout','list');location.reload();}")
    page.wait_for_timeout(1500)
    info = f(page); trace("list view load", info)
    press(page, DOWN); trace("DOWN", f(page))
    press(page, DOWN); trace("DOWN", f(page))
    press(page, SELECT); trace("after SELECT", f(page))
    is_first = page.evaluate("()=>document.activeElement === document.querySelector('.list-row, .gcard')")
    print(f"  → SELECT in list view jumps to first row: {is_first}")
    # Reset to grid
    page.evaluate("()=>{localStorage.setItem('retrox.layout','grid');location.reload();}")
    b.close()

print("\n=== ISSUE 13: RIGHT on sort select → focus moves (NOT cycle value) ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    # Reach the sort select via UP from the grid.
    page.evaluate("()=>document.querySelector('.gcard')?.focus()")
    press(page, UP); press(page, UP)
    info = f(page); trace("on sort-select (via UP*2)", info)
    if info.get("id") != "sort-select":
        print(f"  could not reach sort-select; manually focusing")
        page.evaluate("()=>document.getElementById('sort-select')?.focus()")
    # Snapshot value before the press.
    val_before = page.evaluate("()=>document.getElementById('sort-select').value")
    print(f"  sort value before: {val_before!r}")

    # GAMEPAD path
    press(page, RIGHT)
    after_pad = page.evaluate("""()=>({
      val: document.getElementById('sort-select').value,
      activeId: document.activeElement.id || null,
      activeTag: document.activeElement.tagName,
      activeAttr: document.activeElement.getAttribute('data-layout') || null,
    })""")
    print(f"  after GAMEPAD RIGHT: {after_pad}")
    pad_focus_moved = after_pad['activeAttr'] == 'grid' or after_pad['activeId'] != 'sort-select'
    pad_value_unchanged = after_pad['val'] == val_before
    print(f"    → focus moved: {pad_focus_moved}    value unchanged: {pad_value_unchanged}")

    # KEYBOARD path — re-focus the select first.
    page.evaluate("()=>document.getElementById('sort-select').focus()")
    val_before = page.evaluate("()=>document.getElementById('sort-select').value")
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(150)
    after_kb = page.evaluate("""()=>({
      val: document.getElementById('sort-select').value,
      activeId: document.activeElement.id || null,
      activeTag: document.activeElement.tagName,
      activeAttr: document.activeElement.getAttribute('data-layout') || null,
    })""")
    print(f"  after KEYBOARD ArrowRight: {after_kb}")
    kb_focus_moved = after_kb['activeAttr'] == 'grid' or (after_kb['activeId'] != 'sort-select' and after_kb['activeTag'] != 'BODY')
    kb_value_unchanged = after_kb['val'] == val_before
    print(f"    → focus moved: {kb_focus_moved}    value unchanged: {kb_value_unchanged}")

    if not (pad_focus_moved and pad_value_unchanged and kb_focus_moved and kb_value_unchanged):
        print(f"  ✗ BUG: select still misbehaves on RIGHT")
    else:
        print(f"  ✓ both paths behave correctly")
    b.close()

print("\n=== ISSUE 11: RIGHT from sidebar → first card (NOT sort dropdown) ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    # Land focus on a sidebar item
    page.evaluate('()=>document.querySelector(\'.sidebar [data-key="library"]\')?.focus()')
    info = f(page); trace("on sidebar Library", info)
    press(page, RIGHT); info2 = f(page); trace("after RIGHT", info2)
    target_is_card = info2.get("group", "").startswith("card-grid") or info2.get("group", "").startswith("list-view")
    target_is_sort = info2.get("id") == "sort-select"
    print(f"  → first focusable hit a card: {target_is_card} (sort-select instead: {target_is_sort})")

    # Same check for /games?view=favorites and a collection
    for path, label in [("/games?view=favorites", "favorites"),
                         ("/games?view=recent", "recent"),
                         ("/games?collection=Pok%C3%A9mon", "collection Pokémon")]:
        page.goto(BASE + path); page.wait_for_timeout(1000)
        page.evaluate('()=>document.querySelector(\'.sidebar [data-key]\')?.focus()')
        press(page, RIGHT); info = f(page)
        gp = (info.get("group") or "").split(" ")[0] or "—"
        idstr = info.get("id") or "—"
        text = (info.get("text") or "")[:30]
        target_is_card = gp.startswith("card-grid") or gp.startswith("list-view")
        print(f"  {label:<22} → group={gp:<12} id={idstr:<14} text={text!r} card={'✓' if target_is_card else '✗'}")
    b.close()

print("\n=== ISSUE 12: Card click via controller A → Play auto-focused on /game ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    info = f(page); trace("on /games (auto-focus)", info)
    # Simulate full controller flow: A button on the focused card
    press(page, A); page.wait_for_timeout(2000)  # wait for soft-nav + render
    info = f(page); trace("after A on card → /game", info)
    is_play = info.get("id") == "play-btn"
    print(f"  → Play button auto-focused: {is_play}")
    b.close()

print("\n=== ISSUE 14: Held direction during soft-nav must not drift focus past Play ===")
# Repro of the original bug: pressing A while the D-pad RIGHT was still
# physically held (or analog stick is drifting) used to keep firing the
# hold-to-repeat move() across the soft-nav window, walking focus past the
# Play button into the freshly-rendered slot grid. Fix: router dispatches
# 'retrox:navigated' and gamepad-nav suppresses the held direction until
# the user releases it — fresh presses on the new page still work.
def held_direction_lands_on_play(label, prep):
    with sync_playwright() as p:
        b, c, page = setup(p); login(page); page.wait_for_timeout(800)
        prep(page)
        page.wait_for_timeout(50)
        # Press A while the direction is still held / drifting.
        page.evaluate(f"window.__rxPad.buttons[{A}].pressed=true;window.__rxPad.buttons[{A}].value=1")
        page.wait_for_timeout(80)
        page.evaluate(f"window.__rxPad.buttons[{A}].pressed=false;window.__rxPad.buttons[{A}].value=0")
        page.wait_for_timeout(2200)  # let soft-nav, fetch, render, rAF focus settle
        # Release / center stick.
        page.evaluate("()=>{window.__rxPad.buttons[15].pressed=false;window.__rxPad.buttons[15].value=0;window.__rxPad.axes[0]=0;}")
        page.wait_for_timeout(150)
        info = f(page)
        ok = info.get("id") == "play-btn"
        print(f"  {label:<32} → focus={info.get('id') or info.get('cls')}  play={'✓' if ok else '✗'}")
        b.close()
        return ok

ok1 = held_direction_lands_on_play(
    "D-pad RIGHT held through nav",
    lambda page: page.evaluate(f"window.__rxPad.buttons[{RIGHT}].pressed=true;window.__rxPad.buttons[{RIGHT}].value=1"),
)
ok2 = held_direction_lands_on_play(
    "analog stick drifting RIGHT",
    lambda page: page.evaluate("window.__rxPad.axes[0]=0.7"),
)

# After the fix, a FRESH press of RIGHT on /game (post-release) must still
# move focus — the suppression only applies to the carry-over press.
print("  fresh RIGHT post-release moves focus (regression):")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    page.evaluate(f"window.__rxPad.buttons[{RIGHT}].pressed=true;window.__rxPad.buttons[{RIGHT}].value=1")
    page.wait_for_timeout(50)
    page.evaluate(f"window.__rxPad.buttons[{A}].pressed=true;window.__rxPad.buttons[{A}].value=1")
    page.wait_for_timeout(80)
    page.evaluate(f"window.__rxPad.buttons[{A}].pressed=false;window.__rxPad.buttons[{A}].value=0")
    page.wait_for_timeout(2200)
    # Release RIGHT fully, then press it again as a fresh input.
    page.evaluate(f"window.__rxPad.buttons[{RIGHT}].pressed=false;window.__rxPad.buttons[{RIGHT}].value=0")
    page.wait_for_timeout(150)
    press(page, RIGHT); page.wait_for_timeout(200)
    info = f(page)
    moved = info.get("id") != "play-btn"
    print(f"    after fresh RIGHT → {info.get('id') or info.get('cls')}  moved={'✓' if moved else '✗'}")
    b.close()

print(f"  → both held-direction repros land on Play: {ok1 and ok2}")

print("\n=== ISSUE 15: B/Circle never navigates to /login, doesn't open palette ===")
# Two regressions in one suite:
#  (a) On a fresh /games (no in-app forward history) pressing B/Circle
#      must NOT navigate — going back from here would land on /login,
#      which is exactly what the user asked to suppress. The palette
#      must also stay closed (the prior bug had B opening it because
#      DualSense's non-standard mapping puts Circle at buttons[2],
#      where the code expected Square / "open palette").
#  (b) After at least one in-app forward navigation (/games → /game/*),
#      pressing B/Circle must take us back to /games — back is allowed
#      while we're still inside the shell.
SONY_PAD_SHIM = """
if (!window.__rxGpInstalled) {
  window.__rxGpInstalled = true;
  // Mimic Firefox + DualSense: mapping="", id starts with Sony VID,
  // 14 buttons, 7 axes with hat sentinel at axes[4]≈1.286.
  const pad = { id:'054c-0ce6-DualSense Wireless Controller', index:0, connected:true,
    mapping:'', timestamp:0,
    buttons: Array.from({length:14}, () => ({pressed:false, value:0, touched:false})),
    axes: [0.01, 0.01, 0, 0, 1.286, 0, 0] };
  window.__rxPad = pad;
  navigator.getGamepads = () => [pad,null,null,null];
  setTimeout(() => {
    try { window.dispatchEvent(new GamepadEvent('gamepadconnected', {gamepad:pad})); }
    catch { const e = new Event('gamepadconnected'); e.gamepad=pad; window.dispatchEvent(e); }
  }, 0);
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--no-sandbox"])
    c = b.new_context(viewport={"width":1280,"height":800}, storage_state=_STORAGE_STATE)
    c.add_init_script(SEEN_STAMP); c.add_init_script(SONY_PAD_SHIM)
    page = c.new_page(); page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
    page.goto(f"{BASE}/games"); page.wait_for_selector(".gcard"); page.wait_for_timeout(800)

    # (a) On root /games — no in-app forward history.
    pre_url = page.url
    pre_focus = f(page)
    # Press Circle (button 2 in the Sony non-standard layout).
    page.evaluate("window.__rxPad.buttons[2].pressed=true;window.__rxPad.buttons[2].value=1")
    page.wait_for_timeout(80)
    page.evaluate("window.__rxPad.buttons[2].pressed=false;window.__rxPad.buttons[2].value=0")
    page.wait_for_timeout(400)
    post_url = page.url
    palette_open = page.evaluate("()=>!!document.querySelector('.palette-backdrop')")
    print(f"  on root /games:")
    print(f"    URL:        {pre_url[-30:]} → {post_url[-30:]}")
    print(f"    palette:    open={palette_open}  (must be False)")
    no_login_nav = "/login" not in post_url and post_url == pre_url
    print(f"    → did NOT navigate away (anywhere): {'✓' if no_login_nav else '✗'}")
    print(f"    → palette stayed closed:           {'✓' if not palette_open else '✗'}")

    # (b) After one in-app forward step, Circle should go back to /games.
    page.locator('a[href="/game/pokemon-blue-version-gb"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn"); page.wait_for_timeout(800)
    on_game_url = page.url
    page.evaluate("window.__rxPad.buttons[2].pressed=true;window.__rxPad.buttons[2].value=1")
    page.wait_for_timeout(80)
    page.evaluate("window.__rxPad.buttons[2].pressed=false;window.__rxPad.buttons[2].value=0")
    page.wait_for_timeout(800)
    after_back_url = page.url
    print(f"  after /games → /game/<slug> → Circle back:")
    print(f"    URL: {on_game_url[-30:]} → {after_back_url[-30:]}")
    went_back_to_games = "/games" in after_back_url and "/game/" not in after_back_url
    print(f"    → returned to /games: {'✓' if went_back_to_games else '✗'}")

    # (c) From /games (after step (b) we're back here), pressing Circle
    #     again should still NOT leave to /login — depth is 0 again.
    on_root_url = page.url
    page.evaluate("window.__rxPad.buttons[2].pressed=true;window.__rxPad.buttons[2].value=1")
    page.wait_for_timeout(80)
    page.evaluate("window.__rxPad.buttons[2].pressed=false;window.__rxPad.buttons[2].value=0")
    page.wait_for_timeout(400)
    final_url = page.url
    print(f"  back at root /games — Circle again must still not navigate:")
    print(f"    URL: {on_root_url[-30:]} → {final_url[-30:]}")
    print(f"    → stayed put: {'✓' if final_url == on_root_url else '✗'}")

    # (d) On /game with a DIALOG open, Circle must close the dialog and
    #     stay on the same page — never navigate. This is the user's
    #     explicit spec: "if there is a dialog open then it should just
    #     close the dialog (and do not redirect to the previous page)".
    page.locator('a[href="/game/pokemon-blue-version-gb"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn"); page.wait_for_timeout(600)
    # Open the slot-picker modal (clicking Play on /game).
    page.click("#play-btn"); page.wait_for_selector(".modal-backdrop"); page.wait_for_timeout(150)
    on_game_with_modal = page.url
    modal_open_before = page.evaluate("()=>!!document.querySelector('.modal-backdrop')")
    # Press Circle.
    page.evaluate("window.__rxPad.buttons[2].pressed=true;window.__rxPad.buttons[2].value=1")
    page.wait_for_timeout(80)
    page.evaluate("window.__rxPad.buttons[2].pressed=false;window.__rxPad.buttons[2].value=0")
    page.wait_for_timeout(400)
    after_modal_close_url = page.url
    modal_open_after = page.evaluate("()=>!!document.querySelector('.modal-backdrop')")
    print(f"  on /game with modal open:")
    print(f"    modal:  before={modal_open_before}  after Circle={modal_open_after}")
    print(f"    URL:    {on_game_with_modal[-30:]} → {after_modal_close_url[-30:]}")
    print(f"    → modal closed:           {'✓' if modal_open_before and not modal_open_after else '✗'}")
    print(f"    → URL unchanged (no nav): {'✓' if on_game_with_modal == after_modal_close_url else '✗'}")

    # (e) After dismissing the modal in (d), pressing Circle once more
    #     should now go back to /games (no modal in the way; we have
    #     in-app history depth ≥ 1).
    page.evaluate("window.__rxPad.buttons[2].pressed=true;window.__rxPad.buttons[2].value=1")
    page.wait_for_timeout(80)
    page.evaluate("window.__rxPad.buttons[2].pressed=false;window.__rxPad.buttons[2].value=0")
    page.wait_for_timeout(800)
    after_second_circle = page.url
    print(f"  after second Circle (modal already closed):")
    print(f"    URL: {after_modal_close_url[-30:]} → {after_second_circle[-30:]}")
    went_back = "/games" in after_second_circle and "/game/" not in after_second_circle
    print(f"    → returned to /games: {'✓' if went_back else '✗'}")

    # (f) Square (PS face West, buttons[0] in Sony non-standard) is
    #     intentionally INERT. It must not navigate, must not open the
    #     palette, must not change the URL, must not click anything.
    #     We focus a card first so we can also detect a stray "click"
    #     side effect — if Square accidentally fired the confirm action
    #     it would navigate to /game/<slug>.
    page.evaluate("()=>document.querySelector('.gcard')?.focus()")
    pre_sq_url = page.url
    pre_sq_focus = f(page)
    page.evaluate("window.__rxPad.buttons[0].pressed=true;window.__rxPad.buttons[0].value=1")
    page.wait_for_timeout(80)
    page.evaluate("window.__rxPad.buttons[0].pressed=false;window.__rxPad.buttons[0].value=0")
    page.wait_for_timeout(400)
    post_sq_url = page.url
    post_sq_focus = f(page)
    palette_after_sq = page.evaluate("()=>!!document.querySelector('.palette-backdrop')")
    print(f"  Square (Sony non-standard buttons[0]) press:")
    print(f"    URL:     {pre_sq_url[-30:]} → {post_sq_url[-30:]}")
    print(f"    palette: open={palette_after_sq}  (must be False)")
    print(f"    focus:   {pre_sq_focus.get('text','')[:30]!r} → {post_sq_focus.get('text','')[:30]!r}")
    inert = (post_sq_url == pre_sq_url
             and not palette_after_sq
             and pre_sq_focus.get("text") == post_sq_focus.get("text"))
    print(f"    → Square is fully inert: {'✓' if inert else '✗'}")
    b.close()

print("\n=== ISSUE 10: Modal close X button reachable via D-pad? ===")
with sync_playwright() as p:
    b, c, page = setup(p); login(page); page.wait_for_timeout(800)
    page.locator('a[href="/game/pokemon-blue-version-gb"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn"); page.wait_for_timeout(500)
    press(page, START); page.wait_for_timeout(300)  # opens slot picker
    info = f(page); trace("slot modal open", info)
    # Try UP — does it reach the X close button?
    for i in range(5):
        press(page, UP); trace(f"UP*{i+1}", f(page))
    print("  → If we never reached the X close button, modal-close isn't navigable from inside.")
    b.close()
