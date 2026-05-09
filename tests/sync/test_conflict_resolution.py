"""Live conflict — 409 from server triggers Out-of-sync UI flow.

Verifies the full path:
  - Server returns 409 to the persistor's PUT
  - Persistor calls _notifyConflict → conflictHalted=true
  - Indicator renders "Out of sync" pill (red, is-critical)
  - Click pill → dialog opens with conflict copy
  - Footer offers three resolution paths:
      Cancel  ·  Use my version  ·  Use server version
  - Advanced "Download my current save first" tertiary action present
  - "Use my version" calls persistor.resolveConflictWithLocal(), which
    PUTs WITHOUT X-Slot-Generation (force-push) — verified by
    intercepting the request and inspecting headers.

Methodology:
  Route every PUT /api/games/.../saves/N to a 409, write distinct bytes
  to SRAM so the persistor's poll picks up a change and tries to
  upload. The 409 trips the conflict path. Then exercise each
  resolution from the dialog.

Pass criterion:
  - Pill is red is-critical
  - Dialog has all three footer buttons + advanced link
  - "Use my version" sends a PUT without X-Slot-Generation (verified
    via request interception)
"""
import json
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"
SLUG = "pokemon-blue-version-gb"


def login_and_play(page, slot=1):
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
    page.goto(f"{BASE}/games"); page.wait_for_selector(".gcard")
    page.locator(f'a[href="/game/{SLUG}"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").nth(slot - 1).click()
    page.wait_for_timeout(2500)


def force_409_upload(page):
    """Route every save PUT to 409, then write SRAM so the poll picks
    it up and tries to upload."""
    page.route("**/api/games/**/saves/**", lambda route, req: (
        route.fulfill(status=409, body='{"detail":"slot was modified"}')
        if req.method == "PUT" else route.continue_()
    ))
    page.evaluate("""() => {
      const gm = window.EJS_emulator?.gameManager;
      const path = gm?.getSaveFilePath?.();
      if (path) gm.FS.writeFile(path, new Uint8Array(32768).fill(42));
    }""")
    page.wait_for_timeout(8000)  # 3s poll + 1s debounce + upload + handle


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

    fails = 0

    # ---- 1) Trigger the conflict and verify pill state ----
    print("\n--- 1. Trigger 409 and verify pill flips to 'Out of sync' ---")
    login_and_play(page)
    force_409_upload(page)

    pill = page.evaluate("""() => {
      const ind = document.querySelector('.player__status');
      const dot = ind?.querySelector('.player__status__dot');
      return {
        text: ind?.querySelector('.player__status__text')?.textContent.trim(),
        cls:  [...(ind?.classList || [])],
        dot:  dot ? getComputedStyle(dot).backgroundColor : null,
      };
    }""")
    print(f"  pill: text={pill['text']!r} cls={pill['cls']} dot={pill['dot']}")
    if not pill["text"].startswith("Out of sync"):
        print("  ✗ pill text is not 'Out of sync'"); fails += 1
    elif "is-critical" not in pill["cls"]:
        print("  ✗ pill missing is-critical class"); fails += 1
    elif pill["dot"] != "rgb(239, 68, 68)":
        print(f"  ✗ pill dot color {pill['dot']} != red rgb(239, 68, 68)"); fails += 1
    else:
        print("  ✓ pill state correct")

    # ---- 2) Open dialog, verify copy + 3 buttons + advanced link ----
    print("\n--- 2. Click pill → dialog has 3 buttons + advanced link ---")
    page.evaluate("() => document.querySelector('.player__status').click()")
    page.wait_for_selector(".modal", timeout=2000); page.wait_for_timeout(300)
    dlg = page.evaluate("""() => {
      const card = document.querySelector('.modal');
      if (!card) return null;
      const buttons = [...card.querySelectorAll('.modal__foot button')]
        .map(b => ({
          text: b.textContent.trim(),
          danger:  b.classList.contains('btn--danger'),
          primary: b.classList.contains('btn--primary'),
          ghost:   b.classList.contains('btn--ghost'),
        }));
      return {
        title: card.querySelector('h3')?.textContent.trim(),
        heroModifier: card.querySelector('.save-dialog__hero')?.className.match(/is-\\w+/)?.[0],
        body: card.querySelector('.save-dialog__body')?.innerText,
        buttons,
        hasAdvanced: !!card.querySelector('.save-dialog__advanced'),
        advancedText: card.querySelector('.save-dialog__advanced')?.textContent.trim(),
      };
    }""")
    print(f"  title:        {dlg['title']!r}")
    print(f"  heroModifier: {dlg['heroModifier']!r}")
    print(f"  buttons:      {[(b['text'], 'danger' if b['danger'] else 'primary' if b['primary'] else 'ghost') for b in dlg['buttons']]}")
    print(f"  advanced:     {dlg['advancedText']!r}")
    if dlg["title"] != "Out of sync":
        print(f"  ✗ wrong title"); fails += 1
    if dlg["heroModifier"] != "is-critical":
        print(f"  ✗ wrong hero modifier"); fails += 1
    if len(dlg["buttons"]) != 3:
        print(f"  ✗ expected 3 footer buttons, got {len(dlg['buttons'])}"); fails += 1
    labels = {b["text"].lower() for b in dlg["buttons"]}
    for needed in ("cancel", "use my version", "use server version"):
        if needed not in labels:
            print(f"  ✗ missing button: {needed}"); fails += 1
    danger_btns = [b for b in dlg["buttons"] if b["danger"]]
    if not danger_btns or danger_btns[0]["text"].lower() != "use my version":
        print(f"  ✗ 'Use my version' should be danger-styled"); fails += 1
    if not dlg["hasAdvanced"]:
        print(f"  ✗ advanced 'Download' link missing"); fails += 1
    if dlg["hasAdvanced"] and "advanced" in (dlg["advancedText"] or "").lower():
        print(f"  ✗ '(advanced)' marker should have been removed"); fails += 1
    if fails == 0:
        print("  ✓ dialog structure correct")

    # ---- 3) Click "Use my version" → second confirm modal → confirm ----
    # → verify a force-push PUT (no X-Slot-Generation) goes out.
    print("\n--- 3. 'Use my version' confirms then sends force-push PUT ---")
    # Stop routing 409s so the force-push can actually succeed; replace
    # with a PUT-capturing route that records the request and lets it
    # through to the real backend.
    captured = []
    page.unroute("**/api/games/**/saves/**")
    page.route("**/api/games/**/saves/**", lambda route, req: (
        captured.append({"method": req.method, "headers": req.headers}) or route.continue_()
        if req.method == "PUT" else route.continue_()
    ))

    # Click "Use my version" — opens the secondary confirm modal.
    page.evaluate("""() => {
      const btns = [...document.querySelectorAll('.modal__foot button')];
      btns.find(b => b.textContent.trim() === 'Use my version')?.click();
    }""")
    page.wait_for_timeout(400)
    # Find the confirm modal's "Overwrite" button.
    confirmed = page.evaluate("""() => {
      const cards = [...document.querySelectorAll('.modal')];
      const card = cards[cards.length - 1];  // top-most modal
      const ok = [...card.querySelectorAll('.modal__foot button')]
        .find(b => b.textContent.trim().toLowerCase() === 'overwrite');
      if (ok) { ok.click(); return true; }
      return false;
    }""")
    if not confirmed:
        print("  ✗ couldn't find 'Overwrite' button in confirm modal")
        fails += 1
    else:
        page.wait_for_timeout(2000)
        put_reqs = [c for c in captured if c["method"] == "PUT"]
        if not put_reqs:
            print(f"  ✗ no PUT request observed after 'Overwrite'")
            fails += 1
        else:
            no_gen = [r for r in put_reqs if "x-slot-generation" not in r["headers"]]
            print(f"  PUT requests after force-push: {len(put_reqs)}")
            print(f"  PUTs without X-Slot-Generation: {len(no_gen)}/{len(put_reqs)}")
            if not no_gen:
                print(f"  ✗ all PUTs carried X-Slot-Generation — should be force-push (no header)")
                fails += 1
            else:
                print(f"  ✓ force-push omitted X-Slot-Generation as expected")

    print(f"\n========")
    print(f"{'✓ all assertions pass' if fails == 0 else f'✗ {fails} assertion(s) failed'}")
    print(f"========")
    browser.close()
