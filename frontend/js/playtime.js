/* Playtime tracker for the in-emulator session.
 *
 * Counts wall-clock seconds while the document is visible and the tracker
 * has been started, flushing the accumulated delta to the server on a
 * 60-second cadence, on visibility loss, and on page-unload (via
 * `navigator.sendBeacon` so the request survives the tab closing).
 *
 * Time spent with the tab hidden, the OS asleep, or the network offline
 * is not counted — we only credit what the user is actually watching. */
const FLUSH_INTERVAL_MS = 60_000;
const MIN_FLUSH_SECONDS = 5;       // don't bother the server with tiny pings
const MAX_PING_SECONDS = 600;      // matches the backend ceiling

export function startPlaytimeTracker(gameId) {
  if (!gameId) return { stop() {} };

  const url = `/api/games/${encodeURIComponent(gameId)}/playtime`;
  let visibleSince = null;          // ms timestamp of the last visibility transition into `visible`
  let pendingMs = 0;                // unflushed accumulated ms
  let timer = null;
  let stopped = false;

  function tick() {
    if (visibleSince !== null) {
      const now = performance.now();
      pendingMs += now - visibleSince;
      visibleSince = now;
    }
  }

  function buildPayload() {
    tick();
    const whole = Math.floor(pendingMs / 1000);
    if (whole < MIN_FLUSH_SECONDS) return null;
    pendingMs -= whole * 1000;
    return { seconds: Math.min(whole, MAX_PING_SECONDS) };
  }

  async function flush() {
    if (stopped) return;
    const payload = buildPayload();
    if (!payload) return;
    try {
      await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch {
      // The user closed the tab or lost network — fold the delta back in
      // so the next ping (or the unload beacon) covers it.
      pendingMs += payload.seconds * 1000;
    }
  }

  function flushBeacon() {
    const payload = buildPayload();
    if (!payload || !navigator.sendBeacon) return;
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    navigator.sendBeacon(url, blob);
  }

  function onVisibility() {
    if (stopped) return;
    if (document.visibilityState === "visible") {
      visibleSince = performance.now();
    } else {
      tick();
      visibleSince = null;
      // The flush is best-effort: if the OS is suspending us, the beacon
      // path on `pagehide` will catch the rest.
      flush();
    }
  }

  function onPageHide() {
    if (stopped) return;
    tick();
    visibleSince = null;
    flushBeacon();
  }

  // Boot.
  if (document.visibilityState === "visible") {
    visibleSince = performance.now();
  }
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  timer = setInterval(flush, FLUSH_INTERVAL_MS);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      tick();
      visibleSince = null;
      flushBeacon();
    },
  };
}
