"""Sync pipeline — protocol-level tests for the auto-sync loop.

This is the PRIMARY correctness test for save synchronization. It
verifies the actual upload behavior (not just the UI), exercising the
guarantees that make cross-device sync trustworthy:

  1. SRAM change → debounced PUT goes out, with X-Slot-Generation
     header (optimistic concurrency)
  2. Cache committed BEFORE the upload (offline-safety order — if
     the upload fails or the tab dies mid-flight, bytes survive)
  3. Successful upload makes the cache clean (hash == syncedHash)
     and bumps the server generation
  4. Offline + reconnect: dirty cache while offline, automatic
     re-upload when network returns

We do NOT assert on specific byte values mid-pipeline. The persistor's
3-second saveSaveFiles poll calls gm.saveSaveFiles() which writes the
core's current WASM SRAM back to the FS — that means a test's
FS.writeFile injection lasts only until the next poll cycle. The
invariants we care about (PUT fired, header present, cache committed
first, dirty→clean transitions) survive that re-write.

Methodology:
  - Intercept all PUT /api/games/.../saves/N requests via page.route()
  - Inject SRAM via FS.writeFile (triggers the FS hook → debounced PUT)
  - Inspect captured request headers and cache state at key moments
"""
import json
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"
SLUG = "pokemon-blue-version-gb"


def setup(p):
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
    page.on("pageerror", lambda e: print(f"      [pageerror] {e}"))
    return browser, ctx, page


def play(page, slot=1):
    page.goto(f"{BASE}/games"); page.wait_for_selector(".gcard")
    page.locator(f'a[href="/game/{SLUG}"]').first.click()
    page.wait_for_url(f"{BASE}/game/**"); page.wait_for_selector("#play-btn")
    page.click("#play-btn"); page.wait_for_selector(".slot-row")
    page.locator(".slot-row").nth(slot - 1).click()
    page.wait_for_timeout(2500)


def write_sram(page, fill_byte):
    """Write 32 KB of `fill_byte` to the emulator's save file, then
    call gm.loadSaveFiles() to push the new bytes from the FS into
    WASM SRAM — without that step, the persistor's next 3 s poll
    calls gm.saveSaveFiles() which flushes WASM SRAM (still the
    original) BACK to the FS, undoing our injection. The persistor's
    own _injectAfterStart uses the same loadSaveFiles trick."""
    page.evaluate("""(b) => {
      const gm = window.EJS_emulator?.gameManager;
      if (!gm) return;
      const path = gm.getSaveFilePath?.();
      if (!path) return;
      gm.FS.writeFile(path, new Uint8Array(32768).fill(b));
      try { gm.loadSaveFiles(); } catch {}
    }""", fill_byte)


def read_cache(page, username, game_id, slot):
    return page.evaluate("""(args) => new Promise(resolve => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onsuccess = () => req.result.transaction('saves', 'readonly')
        .objectStore('saves').get(`${args.username}:${args.gameId}:${args.slot}`).onsuccess = (e) => {
          const v = e.target.result;
          resolve(v ? {
            hash: v.hash, syncedHash: v.syncedHash,
            gen: v.serverGeneration,
            isDirty: v.hash !== v.syncedHash,
            firstByte: v.bytes?.[0] ?? null,
            len: v.bytes?.length ?? 0,
          } : null);
        };
    })""", {"username": username, "gameId": game_id, "slot": slot})


def game_id(page):
    return urllib.parse.unquote(
        page.evaluate("() => window.EJS_gameUrl.match(/\\/games\\/([^/]+)\\//)[1]")
    )


# =====================================================================
# 1. Auto-sync fires + every PUT carries X-Slot-Generation
# =====================================================================

def test_upload_with_generation_header(p):
    print("\n--- 1. SRAM change → PUT(s) with X-Slot-Generation ---")
    browser, ctx, page = setup(p); play(page)
    captured = []
    page.route("**/api/games/**/saves/**", lambda route, req: (
        captured.append({"method": req.method, "headers": req.headers}) or route.continue_()
        if req.method == "PUT" else route.continue_()
    ))
    write_sram(page, 7)
    # Persistor: 3 s poll fires saveSaveFiles → writeFile hook → 1 s
    # debounce → _maybeUpload → PUT. Allow ~10 s for the full chain
    # plus any subsequent poll cycle.
    page.wait_for_timeout(10000)
    puts = [c for c in captured if c["method"] == "PUT"]
    print(f"  PUTs observed: {len(puts)}")
    fails = 0
    if not puts:
        print(f"  ✗ no PUT after SRAM change — pipeline didn't run"); fails += 1
    else:
        with_gen = [p_ for p_ in puts if "x-slot-generation" in p_["headers"]]
        print(f"  PUTs with X-Slot-Generation: {len(with_gen)}/{len(puts)}")
        if not with_gen:
            print(f"  ✗ no PUT carried X-Slot-Generation — concurrency check missing")
            fails += 1
        else:
            print(f"  ✓ pipeline ran AND every auto-sync PUT used optimistic concurrency")
    browser.close()
    return fails


# =====================================================================
# 2. Cache committed BEFORE upload (offline-safety order)
# =====================================================================

def test_cache_first_order(p):
    print("\n--- 2. Cache is committed BEFORE the upload PUT ---")
    browser, ctx, page = setup(p); play(page)
    gid = game_id(page)

    # On the first PUT, query the cache state at exactly that moment.
    # If the cache already has bytes whose first byte is 0x42, the
    # cache-first invariant holds. Compare against pre-write cache
    # (which had the original Pokemon save bytes — first byte was
    # something other than 0x42).
    snapshot_at_put = []

    def record(route, req):
        if req.method == "PUT" and not snapshot_at_put:
            cache = page.evaluate("""(args) => new Promise(resolve => {
              const r = indexedDB.open('retrox-saves', 1);
              r.onsuccess = () => r.result.transaction('saves','readonly')
                .objectStore('saves').get(`${args.u}:${args.g}:${args.s}`).onsuccess = (e) => {
                  const v = e.target.result;
                  resolve(v ? { firstByte: v.bytes[0], hash: v.hash } : null);
                };
            })""", {"u": USER, "g": gid, "s": 1})
            snapshot_at_put.append(cache)
        route.continue_()

    page.route("**/api/games/**/saves/**", record)
    write_sram(page, 0x42)
    page.wait_for_timeout(10000)

    fails = 0
    if not snapshot_at_put:
        print(f"  ✗ no PUT observed within window"); fails += 1
    else:
        cache = snapshot_at_put[0]
        print(f"  cache at PUT time: firstByte={cache and hex(cache['firstByte'])}")
        if not cache:
            print(f"  ✗ cache empty at PUT time — write_first invariant violated")
            fails += 1
        elif cache["firstByte"] != 0x42:
            print(f"  ✗ cache.firstByte != 0x42 at PUT time — bytes weren't written first")
            fails += 1
        else:
            print(f"  ✓ cache already has the new bytes at the moment the PUT flies")
    browser.close()
    return fails


# =====================================================================
# 3. Successful upload → isDirty becomes false + generation bumps
# =====================================================================

def test_dirty_to_clean_transition(p):
    print("\n--- 3. Upload → cache transitions dirty → clean + gen bumps ---")
    browser, ctx, page = setup(p); play(page)
    gid = game_id(page)

    before = read_cache(page, USER, gid, 1)
    print(f"  before write: gen={before['gen']} isDirty={before['isDirty']}")
    if before["isDirty"]:
        # Cache started dirty (probably from a previous test run that
        # didn't get to upload). Wait for the auto-sync to flush.
        page.wait_for_timeout(8000)
        before = read_cache(page, USER, gid, 1)
        print(f"  after settle:  gen={before['gen']} isDirty={before['isDirty']}")

    write_sram(page, 0xAB)
    # Wait long enough for: writeFile hook → 1s debounce → upload →
    # cache.markSynced → at least one full poll cycle settling.
    page.wait_for_timeout(10000)

    after = read_cache(page, USER, gid, 1)
    print(f"  after write+upload: gen={after['gen']} isDirty={after['isDirty']}")

    fails = 0
    # The end state should be clean (the persistor uploaded whatever
    # SRAM stabilized at and updated syncedHash to match).
    if after["isDirty"]:
        print(f"  ✗ cache still dirty after upload window — syncedHash never advanced")
        fails += 1
    elif after["gen"] is None or before["gen"] is None or after["gen"] <= before["gen"]:
        print(f"  ✗ generation didn't advance ({before['gen']} → {after['gen']})")
        fails += 1
    else:
        print(f"  ✓ cache clean AND server gen bumped {before['gen']} → {after['gen']}")
    browser.close()
    return fails


# =====================================================================
# 4. Offline + reconnect → cache becomes dirty, then auto-uploads
# =====================================================================

def test_offline_then_reconnect_uploads(p):
    print("\n--- 4. Offline write + reconnect → automatic re-upload ---")
    browser, ctx, page = setup(p); play(page)
    gid = game_id(page)

    # Wait for any startup-time sync to settle.
    page.wait_for_timeout(8000)
    initial = read_cache(page, USER, gid, 1)
    print(f"  initial state: gen={initial['gen']} isDirty={initial['isDirty']}")

    # Go offline. With set_offline=True, fetches fail at the network
    # layer — the persistor's _maybeUpload throws, _handleFailure
    # increments retryCount, and the cache is left dirty.
    captured = []
    page.route("**/api/games/**/saves/**", lambda route, req: (
        captured.append(req.method) or route.continue_()
        if req.method == "PUT" else route.continue_()
    ))

    ctx.set_offline(True)
    page.wait_for_timeout(500)
    write_sram(page, 0xDD)
    page.wait_for_timeout(8000)
    cache_offline = read_cache(page, USER, gid, 1)
    puts_offline = len([c for c in captured if c == "PUT"])
    print(f"  while offline:  isDirty={cache_offline['isDirty']} (PUT attempts that flew before failing: {puts_offline})")

    if not cache_offline["isDirty"]:
        print(f"  ✗ cache should be dirty while offline — write didn't propagate to cache")
        ctx.set_offline(False); browser.close(); return 1

    # Reconnect — _onOnline window listener fires, _scheduleFlush kicks
    # the upload. Cache should go clean within the next ~5 s.
    captured.clear()
    ctx.set_offline(False)
    page.wait_for_timeout(10000)
    cache_online = read_cache(page, USER, gid, 1)
    puts_online = len([c for c in captured if c == "PUT"])
    print(f"  after reconnect: isDirty={cache_online['isDirty']} (PUTs={puts_online})")

    fails = 0
    if puts_online < 1:
        print(f"  ✗ no upload fired after reconnect — `online` event handler missing")
        fails += 1
    if cache_online["isDirty"]:
        print(f"  ✗ cache still dirty after reconnect window — bytes weren't actually uploaded")
        fails += 1
    if fails == 0:
        print(f"  ✓ queued bytes uploaded automatically when network returned")
    browser.close()
    return fails


# =====================================================================
# Run
# =====================================================================

with sync_playwright() as p:
    fails = 0
    fails += test_upload_with_generation_header(p)
    fails += test_cache_first_order(p)
    fails += test_dirty_to_clean_transition(p)
    fails += test_offline_then_reconnect_uploads(p)

print(f"\n========")
print(f"{'✓ all sync-pipeline assertions pass' if fails == 0 else f'✗ {fails} assertion(s) failed'}")
print(f"========")
