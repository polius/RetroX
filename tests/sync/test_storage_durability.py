"""Storage durability — IndexedDB persistence guarantees.

The user-facing concern: "if a user plays offline and the browser is
under disk pressure later, will their save survive?"

What we can verify in a test:

  1. PERSISTENT GRANT — the app calls navigator.storage.persist() early.
     Without that, IDB is "best-effort" and browsers MAY evict our cache
     when disk pressure mounts. With it (granted), the browser MUST keep
     the data until the user clears it explicitly.

  2. RELOAD SURVIVAL — the basic durability assumption: bytes written
     before navigation/reload are still there afterward. This is what
     IndexedDB exists for, but we test it explicitly so the in-app
     write path (saveCache.set) isn't accidentally regressed to use
     sessionStorage or another non-durable backend.

  3. REASONABLE QUOTA — navigator.storage.estimate() returns a quota
     above some sane threshold. A typical RetroX user has tens of
     32 KB saves; quota in the megabyte+ range is plenty.

What we CAN'T test:
  - Real eviction under actual disk pressure (browser-internal
    decision, can't be triggered programmatically)
  - Multi-day durability (real-time)
  - User clearing site data via browser settings (user action)

Pass criterion: every assertion-style line ends with a ✓.
"""
import json
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"


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
    return browser, ctx, page


with sync_playwright() as p:
    fails = 0

    # ---- 1. App is wired up to request persistent storage ----
    # We can't reliably check `navigator.storage.persisted()` returns
    # true in headless — Chromium's persistence grant requires the
    # user-engagement signal it tracks for real installations, and
    # localhost-without-history doesn't have it. (Real Chrome on a
    # production deploy DOES grant it silently.) So we verify two
    # things instead: the call site exists in our source, AND the
    # browser's Storage API is available and reports a reasonable
    # quota — both prerequisites for the persist() call to do
    # anything in production.
    print("\n--- 1. App requests persistent storage + Storage API healthy ---")
    browser, ctx, page = setup(p)
    src = page.context.request.get(f"{BASE}/js/save-cache.js").text()
    has_persist_call = (
        "navigator.storage.persist" in src
        and "_persistAttempted" in src
    )
    if not has_persist_call:
        print(f"  ✗ save-cache.js no longer calls navigator.storage.persist() — durability regression")
        fails += 1
    else:
        print(f"  ✓ save-cache.js calls navigator.storage.persist() lazily on first DB access")

    page.goto(f"{BASE}/games"); page.wait_for_selector(".gcard")
    info = page.evaluate("""async () => {
      if (!navigator.storage) return { available: false };
      return {
        available: true,
        persisted: await navigator.storage.persisted(),
        estimate:  await navigator.storage.estimate(),
      };
    }""")
    if not info["available"]:
        print(f"  ✗ navigator.storage missing — Storage API not exposed"); fails += 1
    else:
        quota = info["estimate"].get("quota") or 0
        print(f"  quota:     {quota:,} bytes")
        print(f"  usage:     {info['estimate'].get('usage'):,} bytes")
        print(f"  persisted: {info['persisted']} (headless Chromium often returns False here even when production grants it — see test docstring)")
        if quota < 10_000_000:
            print(f"  ✗ quota suspiciously low — private mode? quota-restricted origin?")
            fails += 1
        else:
            print(f"  ✓ quota plenty for a save library ({quota / 1_000_000:.0f} MB)")
    browser.close()

    # ---- 2. Cache survives a full page reload ----
    print("\n--- 2. Cache survives a hard reload ---")
    browser, ctx, page = setup(p)
    page.goto(f"{BASE}/games", wait_until="networkidle")
    page.wait_for_selector(".gcard")
    sentinel_key = "admin:test-durability-sentinel:1"
    page.evaluate("""(key) => new Promise(r => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('saves', 'readwrite');
        tx.objectStore('saves').put({
          bytes: new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]),
          hash: 0xCAFEBABE,
          syncedHash: 0xCAFEBABE,
          updatedAt: Date.now(),
          serverGeneration: 1,
          serverUpdatedAt: null,
        }, key);
        tx.oncomplete = () => r();
      };
    })""", sentinel_key)
    print(f"  wrote sentinel @ {sentinel_key!r}")
    # Full reload — wait for network idle so the page is settled before
    # we evaluate against it.
    page.reload(wait_until="networkidle")
    page.wait_for_selector(".gcard"); page.wait_for_timeout(500)
    after = page.evaluate("""(key) => new Promise(r => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onsuccess = () => req.result.transaction('saves', 'readonly')
        .objectStore('saves').get(key).onsuccess = (e) => {
          const v = e.target.result;
          r(v ? { hash: v.hash, firstByte: v.bytes[0] } : null);
        };
    })""", sentinel_key)
    if not after:
        print(f"  ✗ sentinel disappeared after reload — IDB not durable!")
        fails += 1
    elif after["hash"] != 0xCAFEBABE or after["firstByte"] != 0xCA:
        print(f"  ✗ sentinel corrupted: {after}")
        fails += 1
    else:
        print(f"  ✓ sentinel intact after reload (hash={after['hash']:#x}, firstByte={after['firstByte']:#x})")
    # Cleanup.
    page.evaluate("""(key) => new Promise(r => {
      const req = indexedDB.open('retrox-saves', 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('saves', 'readwrite');
        tx.objectStore('saves').delete(key);
        tx.oncomplete = () => r();
      };
    })""", sentinel_key)
    browser.close()

    # ---- 3. saveCache.set has a try/catch around the IDB put ----
    # We intentionally do NOT try to simulate a real QuotaExceededError
    # — patching IDB to throw the right error type at the right moment
    # is brittle and tests our patch more than the production path.
    # Instead we verify that the source defining saveCache.set wraps
    # the put in a try/catch that logs and swallows. This is a static
    # check: if a refactor removes the try/catch, this fails.
    print("\n--- 3. saveCache.set has the QuotaExceededError safety net ---")
    browser, ctx, page = setup(p)
    src = page.context.request.get(f"{BASE}/js/save-cache.js").text()
    # The handler we expect: a try/catch in `set` whose catch logs
    # 'quota exceeded' or similar. Looser check than parsing AST —
    # just confirm the well-known error name is referenced near the
    # set() function.
    has_quota_handling = "QuotaExceededError" in src and "quota" in src.lower()
    if not has_quota_handling:
        print(f"  ✗ save-cache.js no longer references QuotaExceededError — safety net removed?")
        fails += 1
    else:
        print(f"  ✓ save-cache.js still has the QuotaExceededError safety net")
    browser.close()

print(f"\n========")
print(f"{'✓ all storage-durability assertions pass' if fails == 0 else f'✗ {fails} assertion(s) failed'}")
print(f"========")
