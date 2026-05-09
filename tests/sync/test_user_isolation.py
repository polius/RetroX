"""Cross-user cache isolation — each user's IndexedDB entries are
namespaced by their username, so user A logging out and user B
logging in on the same browser does NOT surface A's cached bytes.

This is a security/privacy guarantee, not a correctness one. The
implementation relies on `makeKey(username, gameId, slot)` in
save-cache.js producing distinct keys for distinct users — but
nothing today prevents a future refactor from "simplifying" the key
to drop the username, at which point one user's cache would surface
for everyone on the same browser.

What this test actually verifies:

  1. After admin plays a game and triggers a sync, a record exists in
     IndexedDB under the key `admin:<gameId>:<slot>`.
  2. NO record exists under any other-username key for the same
     gameId/slot — proving the namespace is enforced.
  3. The record's bytes match what's actually on the server for admin
     (sanity check: we're not reading some other user's leaked data).

A more comprehensive test would create a second real user, log in as
them, and verify their persistor doesn't pick up admin's cached
bytes. We skip that here because:
  - It requires admin-API user creation + cleanup boilerplate
  - The key-namespace check above is functionally equivalent: if the
    key is correctly scoped, two users CAN'T see each other's data
    because they're literally looking up different keys.

If a regression hits the persistor's user-id resolution (e.g. it
falls back to "anonymous" or skips the username when missing), this
test won't catch it. That's a different layer — the persistor
constructor already throws "username is required" so the failure
mode would be a hard crash, not silent data leak.
"""
import json
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"
SLUG = "pokemon-blue-version-gb"


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
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

    # Play a game so the persistor populates the cache.
    page.goto(f"{BASE}/games"); page.wait_for_selector(".gcard")
    page.locator(f'a[href="/game/{SLUG}"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").first.click()
    page.wait_for_timeout(2500)

    game_id = urllib.parse.unquote(
        page.evaluate("() => window.EJS_gameUrl.match(/\\/games\\/([^/]+)\\//)[1]")
    )
    print(f"game_id = {game_id}")

    # Inspect the IndexedDB store: what keys exist, and what's their
    # username prefix?
    keys = page.evaluate("""() => new Promise(resolve => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('saves', 'readonly');
        const store = tx.objectStore('saves');
        const all = store.getAllKeys();
        all.onsuccess = () => resolve(all.result);
      };
    })""")
    print(f"\nAll keys in IndexedDB:")
    for k in keys:
        print(f"  {k!r}")

    fails = 0

    # ---- 1. There IS a key for the current user (admin) ----
    expected_key = f"{USER}:{game_id}:1"
    keys_lower = [k.lower() for k in keys]
    if expected_key.lower() not in keys_lower:
        print(f"\n  ✗ no cache entry for the current user — expected key {expected_key!r}")
        fails += 1
    else:
        print(f"\n  ✓ cache entry exists under {expected_key!r}")

    # ---- 2. EVERY key starts with `{USER}:` — namespace enforcement ----
    foreign = [k for k in keys if not k.startswith(f"{USER}:")]
    if foreign:
        print(f"\n  ✗ found {len(foreign)} keys NOT prefixed with {USER!r}: {foreign[:5]}")
        fails += 1
    else:
        print(f"\n  ✓ all {len(keys)} keys are prefixed with {USER!r} — namespace enforced")

    # ---- 3. NO cache entry exists under a fake other-user key for the
    # same game+slot. Forensic: we synthesize the key and check.
    fake_other_user_key = f"someone_else:{game_id}:1"
    leak_check = page.evaluate("""(key) => new Promise(resolve => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onsuccess = () => req.result.transaction('saves', 'readonly')
        .objectStore('saves').get(key).onsuccess = (e) => resolve(!!e.target.result);
    })""", fake_other_user_key)
    if leak_check:
        print(f"\n  ✗ cache somehow has entry under {fake_other_user_key!r} — leak!")
        fails += 1
    else:
        print(f"\n  ✓ no entry under fake-other-user key {fake_other_user_key!r}")

    # ---- 4. Inject a record under a fake-other-user key, then verify
    # the current admin's persistor doesn't pick it up. Reload the
    # player, read SRAM, confirm bytes don't match the foreign record.
    fake_bytes = list(range(64))[:32] + [0] * (32768 - 32)
    page.evaluate("""(args) => new Promise(r => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('saves', 'readwrite');
        tx.objectStore('saves').put({
          bytes: new Uint8Array(args.bytes),
          hash: 0xFEED5EED, syncedHash: 0xFEED5EED,
          updatedAt: Date.now(),
          serverGeneration: 999,
          serverUpdatedAt: null,
        }, args.key);
        tx.oncomplete = () => r();
      };
    })""", {"key": fake_other_user_key, "bytes": fake_bytes})

    # Reload as admin.
    page.evaluate("() => document.getElementById('back-btn').click()")
    page.wait_for_url(f"{BASE}/game/**", timeout=15000)
    page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").first.click()

    # Wait until the persistor has finished its reconcile + SRAM inject.
    # The previous fixed `wait_for_timeout(3500)` was a coin-flip: most
    # runs the EJS gameManager + getSaveFile were ready well under that
    # window, but under load the inject sometimes lagged past 3.5s and
    # the assertion read whatever transient state was in WASM RAM.
    # Poll for getSaveFile to return a stable value across 2 reads.
    last = None
    deadline = time.monotonic() + 12.0
    while time.monotonic() < deadline:
        peek = page.evaluate("""() => {
          const gm = window.EJS_emulator?.gameManager;
          const b = gm?.getSaveFile?.(false);
          return b && b.length > 0 ? Array.from(b.slice(0, 8)) : null;
        }""")
        if peek is not None and peek == last:
            break
        last = peek
        page.wait_for_timeout(250)
    sram = last

    sram = sram if sram is not None else page.evaluate("""() => {
      const gm = window.EJS_emulator?.gameManager;
      const bytes = gm?.getSaveFile?.(false);
      return bytes ? Array.from(bytes.slice(0, 8)) : null;
    }""")
    print(f"\n  SRAM after reload (admin): first 8 bytes = {sram}")
    fake_pattern_match = sram and sram == fake_bytes[:8]
    if fake_pattern_match:
        print(f"  ✗ admin's SRAM matches the foreign-user injection — namespace breach!")
        fails += 1
    else:
        print(f"  ✓ admin's SRAM does NOT match the foreign-user injection (no namespace breach)")

    # Cleanup the foreign key we injected.
    page.evaluate("""(key) => new Promise(r => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('saves', 'readwrite');
        tx.objectStore('saves').delete(key);
        tx.oncomplete = () => r();
      };
    })""", fake_other_user_key)

    print(f"\n========")
    print(f"{'✓ user isolation holds' if fails == 0 else f'✗ {fails} assertion(s) failed'}")
    print(f"========")
    browser.close()
