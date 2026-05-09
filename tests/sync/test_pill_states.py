"""Sync indicator: all four pill states render + the click-dialog opens
with the correct copy, dot color, and CSS modifier class.

The four states the persistor can be in:

  - synced   (status="synced",   lastSavedAt set)         → green dot
  - empty    (status="idle",     lastSavedAt null)        → blue dot
  - offline  (status="offline",  navigator.onLine=false)  → amber dot, is-warning
  - conflict (status="conflict", conflictHalted=true)     → red dot, is-critical

Each scenario:
  1. Drive the player to the desired state (slot picked, network toggled,
     409 routed, etc).
  2. Snapshot the pill: text + dot color + class list.
  3. Click the pill, snapshot the dialog: title + key body string.
  4. Close the dialog and confirm.

Each runs in its own browser session — a single broken case can't poison
the rest. Pass criterion: every assertion-style line ends with a ✓.
"""
import json
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"

# Two slugs — one with at least one save (for synced/offline/conflict),
# one with no save on slot 1 (for the empty case). Adjust these to
# whatever your dev container has indexed.
SLUG_WITH_SAVE = "pokemon-blue-version-gb"
SLUG_NO_SAVE   = "asterix-obelix-gb"

# Expected dot colors per state — pinned so a CSS regression
# (someone repaints "no save yet" to yellow again) is caught here.
EXPECTED = {
    "synced":   {"dot": "rgb(34, 197, 94)",  "cls": [],            "text_starts": "Synced"},
    "empty":    {"dot": "rgb(96, 165, 250)", "cls": ["is-empty"],  "text_starts": "No save yet"},
    "offline":  {"dot": "rgb(251, 191, 36)", "cls": ["is-warning"], "text_starts": "Offline"},
    "conflict": {"dot": "rgb(239, 68, 68)",  "cls": ["is-critical"],"text_starts": "Out of sync"},
}

# Expected dialog titles — ditto for catching wording regressions.
EXPECTED_TITLES = {
    "synced":   "Save synced",
    "empty":    "No save yet",
    "offline":  "Offline",
    "conflict": "Out of sync",
}


def setup(p):
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    # Retry on 429 — setup() is called once per state (4×) so a single run
    # can hit the 5/min auth limiter on its own without the test being
    # actually broken.
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
    page.on("pageerror", lambda e: print(f"      [pageerror] {e}"))
    return browser, ctx, page


def play(page, slug, slot=1):
    page.goto(f"{BASE}/games"); page.wait_for_selector(".gcard")
    page.locator(f'a[href="/game/{slug}"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").nth(slot - 1).click()
    page.wait_for_timeout(2500)


def pill_snapshot(page):
    return page.evaluate("""() => {
      const ind = document.querySelector('.player__status');
      if (!ind) return null;
      const dot = ind.querySelector('.player__status__dot');
      const text = ind.querySelector('.player__status__text')?.textContent || "";
      return {
        text: text.trim(),
        cls:  [...ind.classList],
        dot:  dot ? getComputedStyle(dot).backgroundColor : null,
        display: getComputedStyle(ind).display,
      };
    }""")


def dialog_snapshot(page):
    return page.evaluate("""() => {
      const card = document.querySelector('.modal');
      if (!card) return null;
      return {
        title: card.querySelector('h3')?.textContent?.trim() || "",
        body:  card.querySelector('.modal__body')?.innerText || "",
        footButtons: [...card.querySelectorAll('.modal__foot button')]
          .map(b => `${b.className.includes('btn--danger')?'[!]':b.className.includes('btn--primary')?'[primary]':'[ghost]'} ${b.textContent.trim()}`),
        heroModifier: card.querySelector('.save-dialog__hero')?.className.match(/is-\\w+/)?.[0] || null,
      };
    }""")


def assert_state(state_key, pill, dialog):
    exp = EXPECTED[state_key]
    issues = []
    if not pill or pill["display"] == "none":
        issues.append("pill not rendered")
    else:
        if pill["dot"] != exp["dot"]:
            issues.append(f"dot color {pill['dot']} != expected {exp['dot']}")
        for c in exp["cls"]:
            if c not in pill["cls"]:
                issues.append(f"missing class {c} (got {pill['cls']})")
        if not pill["text"].startswith(exp["text_starts"]):
            issues.append(f"text {pill['text']!r} doesn't start with {exp['text_starts']!r}")
    if not dialog:
        issues.append("dialog did not open")
    else:
        if dialog["title"] != EXPECTED_TITLES[state_key]:
            issues.append(f"dialog title {dialog['title']!r} != {EXPECTED_TITLES[state_key]!r}")
    return issues


def report(label, issues):
    if issues:
        print(f"  ✗ {label}")
        for i in issues:
            print(f"      - {i}")
        return 1
    print(f"  ✓ {label}")
    return 0


def open_dialog(page):
    page.evaluate("() => document.querySelector('.player__status')?.click()")
    page.wait_for_selector(".modal", timeout=2000)
    page.wait_for_timeout(300)


def close_dialog(page):
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)


# =====================================================================
# Per-state scenarios
# =====================================================================

def test_empty(p):
    print("\n--- EMPTY (slot with no save on the server) ---")
    browser, ctx, page = setup(p)
    play(page, SLUG_NO_SAVE, slot=1)
    pill = pill_snapshot(page)
    print(f"    pill: text={pill['text']!r} cls={pill['cls']} dot={pill['dot']}")
    open_dialog(page); dlg = dialog_snapshot(page); close_dialog(page)
    print(f"    dialog: title={dlg['title']!r}")
    fails = assert_state("empty", pill, dlg)
    n = report("empty state pill + dialog", fails)
    browser.close(); return n


def test_synced(p):
    print("\n--- SYNCED (slot with existing save) ---")
    browser, ctx, page = setup(p)
    play(page, SLUG_WITH_SAVE, slot=1)
    pill = pill_snapshot(page)
    print(f"    pill: text={pill['text']!r} cls={pill['cls']} dot={pill['dot']}")
    open_dialog(page); dlg = dialog_snapshot(page); close_dialog(page)
    print(f"    dialog: title={dlg['title']!r}")
    fails = assert_state("synced", pill, dlg)
    n = report("synced state pill + dialog", fails)
    browser.close(); return n


def test_offline(p):
    print("\n--- OFFLINE (network yanked while playing) ---")
    browser, ctx, page = setup(p)
    play(page, SLUG_WITH_SAVE, slot=1)
    # Yank the network — the persistor's `offline` listener flips state
    # immediately via _onOffline → _emitState.
    ctx.set_offline(True)
    page.wait_for_timeout(700)
    pill = pill_snapshot(page)
    print(f"    pill: text={pill['text']!r} cls={pill['cls']} dot={pill['dot']}")
    open_dialog(page); dlg = dialog_snapshot(page); close_dialog(page)
    print(f"    dialog: title={dlg['title']!r}")
    fails = assert_state("offline", pill, dlg)
    n = report("offline state pill + dialog", fails)
    ctx.set_offline(False)
    browser.close(); return n


def test_conflict(p):
    print("\n--- CONFLICT (server returns 409 → conflictHalted) ---")
    browser, ctx, page = setup(p)
    play(page, SLUG_WITH_SAVE, slot=1)
    # Route every save PUT to a 409 Conflict, then trigger an upload by
    # writing distinct bytes to the emulator's save file. The persistor's
    # 3s poll picks it up, attempts the PUT, gets 409, halts.
    page.route("**/api/games/**/saves/**", lambda route, req: (
        route.fulfill(status=409, body='{"detail":"conflict"}')
        if req.method == "PUT" else route.continue_()
    ))
    page.evaluate("""() => {
      const gm = window.EJS_emulator?.gameManager;
      const path = gm?.getSaveFilePath?.();
      if (path) gm.FS.writeFile(path, new Uint8Array(32768).fill(99));
    }""")
    page.wait_for_timeout(8000)  # poll (3s) + debounce (1s) + upload + handle
    pill = pill_snapshot(page)
    print(f"    pill: text={pill['text']!r} cls={pill['cls']} dot={pill['dot']}")
    open_dialog(page); dlg = dialog_snapshot(page)
    print(f"    dialog: title={dlg['title']!r}")
    print(f"    foot buttons: {dlg['footButtons']}")
    # Conflict dialog is unique: 3 buttons + advanced download link.
    fails = assert_state("conflict", pill, dlg)
    if dlg:
        if len(dlg["footButtons"]) != 3:
            fails.append(f"expected 3 footer buttons, got {len(dlg['footButtons'])}")
        labels = " ".join(dlg["footButtons"]).lower()
        for needed in ("cancel", "use my version", "use server version"):
            if needed not in labels:
                fails.append(f"missing footer button: {needed}")
        if dlg["heroModifier"] != "is-critical":
            fails.append(f"hero modifier {dlg['heroModifier']!r} != 'is-critical'")
    close_dialog(page)
    n = report("conflict state pill + dialog + 3 resolution paths", fails)
    browser.close(); return n


# =====================================================================
# Run
# =====================================================================

with sync_playwright() as p:
    fails = 0
    fails += test_empty(p)
    fails += test_synced(p)
    fails += test_offline(p)
    fails += test_conflict(p)

print(f"\n========\n{'✓ all 4 states pass' if fails == 0 else f'✗ {fails} state(s) failed'}\n========")
