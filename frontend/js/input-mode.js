/* input-mode.js — single source of truth for "is the user on a controller?".
 *
 * Two signals:
 *   1. A gamepad is currently visible to the page via getGamepads().
 *      Browsers gate this behind a post-load input event (security
 *      policy), so it's empty on a freshly-loaded page even with a
 *      controller plugged in.
 *   2. A persisted timestamp written by gamepad-nav.js whenever it
 *      observes real gamepad input anywhere in the app. This survives
 *      navigations and lets new pages know a controller is in use
 *      without waiting for the browser to reveal it.
 *
 * Pages should ALWAYS use this helper instead of calling
 * navigator.getGamepads() directly — otherwise auto-focus / QR-default
 * decisions stall until the user presses a button on the new page.
 */

const GAMEPAD_SEEN_KEY = "retrox.controller_seen";
const GAMEPAD_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

export function gamepadCurrentlyConnected() {
  try {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    return pads.some(Boolean);
  } catch {
    return false;
  }
}

export function controllerSeenRecently() {
  try {
    const raw = localStorage.getItem(GAMEPAD_SEEN_KEY);
    if (!raw) return false;
    const t = parseInt(raw, 10);
    if (!Number.isFinite(t)) return false;
    return Date.now() - t < GAMEPAD_SEEN_TTL_MS;
  } catch {
    return false;
  }
}

/** Composite check used to gate any "controller-style" UX decision. */
export function isControllerInputMode() {
  return gamepadCurrentlyConnected() || controllerSeenRecently();
}

/** Stamp the seen-recently flag. Called from gamepad-nav.js's poll on
 * every frame the user has any input held — throttled so we don't
 * write to localStorage 60 times per second during a held button. */
let _lastSeenWrite = 0;
const SEEN_WRITE_THROTTLE_MS = 5_000;
export function rememberControllerSeen() {
  const now = Date.now();
  if (now - _lastSeenWrite < SEEN_WRITE_THROTTLE_MS) return;
  _lastSeenWrite = now;
  try { localStorage.setItem(GAMEPAD_SEEN_KEY, String(now)); } catch {}
}
