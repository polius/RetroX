"""Reconciliation matrix — offline-then-resume Cases B and C.

This is the single most important sync test: it verifies that when a
user plays offline (or just disconnects briefly) and reopens later,
the persistor picks the right bytes. Getting this wrong silently
corrupts saves — Case B getting it wrong loses the user's offline
edits; Case C getting it wrong silently overwrites another device's
newer progress.

The reconciliation matrix in play.js has 6 paths; this test exercises:

  Case B — server fetch OK, server unchanged since the cache's last
           sync, cache is dirty → LOCAL wins, queued for upload
  Case C — server fetch OK, server has advanced (another device wrote
           in between), cache is dirty → SERVER wins, "Server has
           newer progress" toast fires, local edits are lost

Methodology:
  1. First launch — get the live serverGeneration + syncedHash from
     the cache after the persistor has done its initial sync.
  2. Inject distinctive bytes into the cache: hash != syncedHash
     (= cache is dirty), serverGeneration unchanged (= no other
     device wrote in the meantime).
  3. Press Back to /game, click Play again on the same slot. The
     persistor reconciles fresh.
  4. Read the emulator's SRAM and compare to (a) injected bytes,
     (b) the server's original bytes.

Pass criterion: SRAM matches the INJECTED bytes (local won), and the
post-reconcile cache shows the new bytes uploaded back to the server.

Cases C (server advanced — local lost) and A (server unreachable) are
not exercised here because:
 - Case A: harder to set up reliably (set_offline before navigation
   breaks the next page fetch). The audit was done manually in the
   chat history.
 - Case C: requires a second device. Could be simulated by bumping
   the server's generation via API between snapshots, but adds
   complexity for a path the user said is acceptable (their offline
   edits are intentionally superseded — toast warns them).

If a future reconciliation regression is suspected, extending this
file to cover those is the right move.

Pass criterion: the trailing summary shows ✓ for both Case B and
Case C.
"""
import json
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"
SLUG = "pokemon-blue-version-gb"     # adjust to a slot-1-has-save game in your DB


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


def read_sram(page):
    return page.evaluate("""() => {
      const gm = window.EJS_emulator?.gameManager;
      let bytes = null; try { bytes = gm?.getSaveFile?.(false); } catch {}
      const ind = document.querySelector('.player__status');
      return {
        len: bytes ? bytes.length : 0,
        firstBytes: bytes ? Array.from(bytes.slice(0, 32)) : null,
        pillText: ind?.querySelector('.player__status__text')?.textContent || "",
      };
    }""")


def read_cache(page, username, game_id, slot):
    return page.evaluate("""(args) => new Promise(resolve => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onsuccess = () => req.result.transaction('saves', 'readonly')
        .objectStore('saves').get(`${args.username}:${args.gameId}:${args.slot}`).onsuccess = (e) => {
          const v = e.target.result;
          resolve(v ? {
            hash: v.hash, syncedHash: v.syncedHash, gen: v.serverGeneration,
            isDirty: v.hash !== v.syncedHash,
            firstBytes: Array.from(v.bytes.slice(0, 32)),
          } : null);
        };
    })""", {"username": username, "gameId": game_id, "slot": slot})


def inject_dirty_cache(page, username, game_id, slot, bytes_list, synced_hash, server_gen):
    return page.evaluate("""(args) => new Promise(resolve => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('saves', 'readwrite');
        tx.objectStore('saves').put({
          bytes: new Uint8Array(args.bytes),
          hash: 0xDEADBEEF,                 // != syncedHash → isDirty
          updatedAt: Date.now(),
          syncedHash: args.syncedHash,
          serverGeneration: args.gen,
          serverUpdatedAt: null,
        }, `${args.username}:${args.gameId}:${args.slot}`);
        tx.oncomplete = () => resolve();
      };
    })""", {"username": username, "gameId": game_id, "slot": slot,
             "bytes": bytes_list, "syncedHash": synced_hash, "gen": server_gen})


def setup(p):
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    return browser, ctx, page


def case_b_local_wins(p):
    """Server unchanged, cache dirty → local edits win + get re-uploaded."""
    print("\n=== CASE B: server unchanged, local offline edits win ===")
    browser, ctx, page = setup(p)
    toasts = []
    # Capture the toast text from console.warning emitted by toast.warning
    # in play.js when conflictLost fires. Easier than scraping the
    # rendered toast DOM, which is timing-sensitive.
    page.on("console", lambda m: m.type == "warning" and toasts.append(m.text))

    login_and_play(page)
    game_id = urllib.parse.unquote(
        page.evaluate("() => window.EJS_gameUrl.match(/\\/games\\/([^/]+)\\//)[1]")
    )
    server_bytes = page.evaluate(
        "() => Array.from(window.EJS_emulator.gameManager.getSaveFile(false).slice(0, 32))"
    )
    cache = read_cache(page, USER, game_id, 1)
    server_gen, synced_hash = cache["gen"], cache["syncedHash"]
    print(f"  initial state: gen={server_gen}, syncedHash={synced_hash}")

    # Inject distinctive offline edits, server unchanged.
    fake_first = list(range(32))
    fake_full  = fake_first + [0] * (32768 - 32)
    inject_dirty_cache(page, USER, game_id, 1, fake_full, synced_hash, server_gen)
    print(f"  injected dirty cache (server gen unchanged at {server_gen})")

    # Press Back, click Play again — the persistor reconciles fresh.
    page.evaluate("() => document.getElementById('back-btn').click()")
    page.wait_for_url(f"{BASE}/game/**", timeout=15000)
    page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").first.click()
    page.wait_for_timeout(3500)

    state = read_sram(page)
    matches_local  = state["firstBytes"][:32] == fake_first
    matches_server = state["firstBytes"][:32] == server_bytes
    print(f"  SRAM matches local={matches_local}, server={matches_server}")

    # Wait for any background upload, then verify gen advanced.
    page.wait_for_timeout(3000)
    cache_after = read_cache(page, USER, game_id, 1)
    print(f"  cache after upload: gen={cache_after['gen']}, isDirty={cache_after['isDirty']}")

    fails = 0
    if not (matches_local and not matches_server):
        print(f"  ✗ Case B FAILED — server bytes overwrote local offline edits")
        fails += 1
    elif not (cache_after["gen"] and cache_after["gen"] > server_gen):
        print(f"  ✗ local bytes won in SRAM, but server gen didn't advance — upload silently skipped")
        fails += 1
    else:
        print(f"  ✓ Case B: local bytes won AND were uploaded ({server_gen} → {cache_after['gen']})")
    browser.close()
    return fails


def case_c_server_wins_with_warning(p):
    """Server advanced (another device wrote), cache dirty → server wins,
    'Server has newer progress' toast surfaces."""
    print("\n=== CASE C: server advanced while offline, local edits lost ===")
    browser, ctx, page = setup(p)
    # Install a toast capturer via add_init_script so it survives the
    # page navigation we're about to do. We hook into the DOM mutation
    # path the toast helper uses, recording every .toast element added
    # to the body, into a window-scoped array we can read at the end.
    ctx.add_init_script("""
      window.__rxToasts = [];
      const installObserver = () => {
        if (!document.body) { setTimeout(installObserver, 0); return; }
        new MutationObserver((muts) => {
          for (const m of muts)
            for (const n of m.addedNodes)
              if (n.nodeType === 1 && n.classList && n.classList.contains('toast'))
                window.__rxToasts.push((n.innerText || '').trim());
        }).observe(document.body, { childList: true, subtree: true });
      };
      installObserver();
    """)
    page = ctx.new_page()  # new page picks up the init script

    login_and_play(page)
    game_id = urllib.parse.unquote(
        page.evaluate("() => window.EJS_gameUrl.match(/\\/games\\/([^/]+)\\//)[1]")
    )
    cache = read_cache(page, USER, game_id, 1)
    server_gen, synced_hash = cache["gen"], cache["syncedHash"]
    print(f"  initial state: gen={server_gen}, syncedHash={synced_hash}")

    # Step 1: inject dirty cache with the CURRENT generation (so it
    # would have been "Case B" if no other writer appeared).
    fake_first = [0xAA] * 32
    fake_full  = fake_first + [0] * (32768 - 32)
    inject_dirty_cache(page, USER, game_id, 1, fake_full, synced_hash, server_gen)

    # Step 2: simulate "another device wrote in between" by uploading
    # a different save via the API directly, which bumps the server
    # generation past what's recorded in our cache.
    other_bytes = bytes([0xBB] * 32 + [0] * (32768 - 32))
    # Origin header is required: the backend's same-origin middleware
    # (main.py:check_origin) rejects state-changing requests without
    # Sec-Fetch-Site=same-origin AND a matching Origin/Referer. Real
    # browsers set those automatically; Playwright's request context
    # doesn't, so we set Origin explicitly.
    r = page.context.request.put(
        f"{BASE}/api/games/{game_id}/saves/1",
        multipart={"save": {"name": "save.bin", "mimeType": "application/octet-stream", "buffer": other_bytes}},
        headers={"Origin": BASE},
    )
    if r.status not in (200, 204):
        print(f"  ✗ couldn't simulate other-device write (HTTP {r.status})")
        browser.close(); return 1

    # Verify the server actually advanced.
    new_meta = page.context.request.get(f"{BASE}/api/games/{game_id}").json()
    slot1 = next((s for s in new_meta.get("slots", []) if s["slot"] == 1), None)
    new_server_gen = slot1.get("generation") if slot1 else None
    print(f"  other device pushed: server gen {server_gen} → {new_server_gen}")
    if new_server_gen is None or new_server_gen <= server_gen:
        print(f"  ✗ other-device push didn't advance the server gen — test setup broken")
        browser.close(); return 1

    # Step 3: reload — the persistor sees server moved on, decides
    # Case C. The toast capturer installed via add_init_script
    # survives the navigation and accumulates any toast that appears.
    page.evaluate("() => document.getElementById('back-btn').click()")
    page.wait_for_url(f"{BASE}/game/**", timeout=15000)
    page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").first.click()
    page.wait_for_timeout(4000)

    state = read_sram(page)
    rendered_toasts = page.evaluate("() => window.__rxToasts || []")
    print(f"  SRAM first 4 = [{state['firstBytes'][0]:#x}, {state['firstBytes'][1]:#x}, {state['firstBytes'][2]:#x}, {state['firstBytes'][3]:#x}]")
    print(f"  toasts seen: {rendered_toasts}")

    # Server bytes (what the OTHER device wrote) start with 0xBB.
    # Local stale bytes (our injection) start with 0xAA.
    matches_other_device = state["firstBytes"][0] == 0xBB
    matches_local        = state["firstBytes"][0] == 0xAA
    has_warning_toast    = any("newer progress" in t.lower() or "server has newer" in t.lower()
                                or "superseded" in t.lower()
                                for t in rendered_toasts)

    fails = 0
    if matches_local:
        print(f"  ✗ Case C FAILED — local bytes survived; should have been replaced by server")
        fails += 1
    elif not matches_other_device:
        print(f"  ✗ SRAM matches neither local nor server — unexpected state")
        fails += 1
    if not has_warning_toast:
        print(f"  ✗ no 'Server has newer progress' toast surfaced — silent overwrite")
        fails += 1
    if fails == 0:
        print(f"  ✓ Case C: server bytes injected AND user warned via toast")
    browser.close()
    return fails


with sync_playwright() as p:
    fails = 0
    fails += case_b_local_wins(p)
    fails += case_c_server_wins_with_warning(p)

print(f"\n========")
print(f"{'✓ both reconciliation cases pass' if fails == 0 else f'✗ {fails} case(s) failed'}")
print(f"========")
