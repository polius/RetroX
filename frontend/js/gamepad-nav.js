/* Spatial focus navigation for gamepads + arrow keys.
 *
 * Model
 * -----
 *   - Every navigable container is marked `data-nav-group`. Spatial nav
 *     ALWAYS stays inside the active element's group — no spillover.
 *   - To cross from one group into another, the source group declares an
 *     explicit transition with `data-nav-up` / `-down` / `-left` /
 *     `-right`. The value is a CSS selector list; the first matching
 *     element's group's primary item gets focus.
 *   - "Primary" = aria-pressed=true ▸ aria-current ▸ aria-selected ▸
 *     [data-nav-primary] ▸ first focusable in the group.
 *   - When there's no same-group candidate AND no transition, focus
 *     stays put. That's how "right from rightmost chip" or "down from
 *     last card row" reach a clean dead-end instead of jumping to
 *     unrelated UI like the sidebar.
 *
 * Buttons (standard mapping)
 * --------------------------
 *   - D-pad / left stick → spatial move
 *   - A (0)              → click focused
 *   - B (1)              → focus the Library link (no history navigation;
 *                          previously called history.back which often
 *                          landed on /login and looked like a logout)
 *   - X (2)              → command palette
 *   - Y (3)              → trigger [data-gp-y] action on focused
 *   - L1/R1 (4/5)        → cycle filter chips
 *   - Select (8)         → focus first card / data-gp-first
 *   - Start (9)          → click primary CTA
 *
 * Things that bit us — DO NOT regress
 * ------------------------------------
 *   1. cycleChips: the chip's click triggers a re-render that destroys
 *      every chip node, so `chips[next].focus()` immediately after the
 *      click focuses a detached element → focus drops to body. Fix:
 *      snapshot data-sys, click, then requery in a rAF callback.
 *   2. Sidebar `data-nav-right` selector list MUST be content-first,
 *      chrome-last (`.card-grid, .list-view, [data-gp-start], …`).
 *      Putting a generic `#page-slot [data-nav-group]` early lands
 *      RIGHT-from-sidebar on whatever nav-group is first in DOM
 *      (often the page header), not the actual content.
 *   3. The keydown handler's text-input bail-out MUST NOT include
 *      SELECT — Chrome/Edge cycle a closed select's value silently on
 *      ArrowLeft/Right/Up/Down, which is jarring during spatial nav.
 *      Bail for INPUT/TEXTAREA/contentEditable only; keep Alt+Arrow
 *      passing through so the dropdown-open accelerator still works.
 *   4. Player overlay skip exception: when `.player-host` is mounted
 *      AND no modal/palette is open, gamepad-nav skips and play.js's
 *      poll owns the emulator inputs. When a modal IS open atop the
 *      player, gamepad-nav drives it (otherwise the user can open the
 *      sync dialog but can't dismiss it without a mouse). play.js's
 *      poll mirrors this: it releases all in-game inputs when a modal
 *      opens so dialog navigation can't double-trigger the emulator.
 *   5. Module-scope `let` closures captured by event listeners can
 *      throw TDZ ReferenceError if the listener fires before the
 *      declaration runs — relevant in play.js where the in-app flow
 *      requests fullscreen BEFORE the module finishes loading. Hoist
 *      `indicator`, `playHint`, `persistor` to the top of play.js. */

import { openPalette } from "./command-palette.js";
import { rememberControllerSeen } from "./input-mode.js";
import { canGoBackInApp } from "./router.js";

// Each selector explicitly excludes tabindex="-1". The `a[href]`
// selector is the important one — without the negation, an anchor
// with `tabindex="-1"` (like the sidebar brand link, deliberately
// removed from D-pad nav) is still matched, defeating the opt-out.
const FOCUSABLE_SELECTOR = [
  "a[href]:not([tabindex='-1'])",
  "button:not([disabled]):not([tabindex='-1'])",
  "input:not([disabled]):not([type='hidden']):not([tabindex='-1'])",
  "select:not([disabled]):not([tabindex='-1'])",
  "textarea:not([disabled]):not([tabindex='-1'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function visible(el) {
  // "Visible" = rendered and selectable, NOT necessarily inside the viewport.
  // Restricting candidates to the viewport breaks D-pad scrolling.
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  return true;
}

function allFocusable(scope = document) {
  return Array.from(scope.querySelectorAll(FOCUSABLE_SELECTOR)).filter(visible);
}

function rectCenter(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

function navGroup(el) { return el && el.closest("[data-nav-group]"); }

function primaryOfGroup(group) {
  if (!group) return null;
  const selected = group.querySelector(
    '[aria-pressed="true"], [aria-current="page"], [aria-current="true"], [aria-selected="true"]'
  );
  if (selected && visible(selected)) return selected;
  const explicit = group.querySelector("[data-nav-primary]");
  if (explicit && visible(explicit)) return explicit;
  const first = group.querySelector(FOCUSABLE_SELECTOR);
  return (first && visible(first)) ? first : null;
}

/* ====================================================================
 * Same-group spatial picker
 * ==================================================================== */

function spatialPick(direction) {
  const active = document.activeElement;
  if (!active || active === document.body) {
    return allFocusable()[0] || null;
  }
  const fromRect = active.getBoundingClientRect();
  const from = rectCenter(fromRect);
  const activeGroup = navGroup(active);
  if (!activeGroup) {
    // Active element isn't inside any nav-group — fall back to the
    // legacy whole-document spatial pick. This keeps things working
    // on pages that haven't been tagged yet.
    return spatialPickGlobal(direction, active, fromRect, from);
  }

  let best = null;
  let bestScore = Infinity;

  for (const el of allFocusable(activeGroup)) {
    if (el === active) continue;
    if (active.contains(el) || el.contains(active)) continue;
    const r = el.getBoundingClientRect();
    const c = rectCenter(r);
    const dx = c.x - from.x;
    const dy = c.y - from.y;

    let primary, secondary;
    switch (direction) {
      case "up":
        if (dy >= -2) continue;
        // Same-column requirement so UP within a grid lands in the
        // matching column of the row above.
        if (Math.abs(dx) > (fromRect.width + r.width) / 2) continue;
        primary = -dy; secondary = Math.abs(dx); break;
      case "down":
        if (dy <= 2) continue;
        if (Math.abs(dx) > (fromRect.width + r.width) / 2) continue;
        primary = dy; secondary = Math.abs(dx); break;
      case "left":
        if (dx >= -2) continue;
        // Same-row requirement so LEFT within a grid stays on the row.
        if (Math.abs(dy) > (fromRect.height + r.height) / 2) continue;
        primary = -dx; secondary = Math.abs(dy); break;
      case "right":
        if (dx <= 2) continue;
        if (Math.abs(dy) > (fromRect.height + r.height) / 2) continue;
        primary = dx; secondary = Math.abs(dy); break;
      default: continue;
    }
    const score = primary + secondary * 1.6;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function spatialPickGlobal(direction, active, fromRect, from) {
  // Used when the active element isn't inside any data-nav-group.
  // Looser scoring (no overlap requirement) so legacy pages still navigate.
  let best = null;
  let bestScore = Infinity;
  for (const el of allFocusable()) {
    if (el === active) continue;
    if (active.contains(el) || el.contains(active)) continue;
    const r = el.getBoundingClientRect();
    const c = rectCenter(r);
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    let primary, secondary;
    switch (direction) {
      case "up":    if (dy >= -2) continue; primary = -dy; secondary = Math.abs(dx); break;
      case "down":  if (dy <=  2) continue; primary =  dy; secondary = Math.abs(dx); break;
      case "left":  if (dx >= -2) continue; primary = -dx; secondary = Math.abs(dy); break;
      case "right": if (dx <=  2) continue; primary =  dx; secondary = Math.abs(dy); break;
      default: continue;
    }
    const score = primary + secondary * 1.6;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

/* ====================================================================
 * move(): same-group spatial pick → fall back to declarative transition
 * ==================================================================== */

function followTransition(group, direction) {
  if (!group) return null;
  const sel = group.getAttribute(`data-nav-${direction}`);
  if (!sel) return null;
  // Selector list: try each candidate selector in order; first match wins.
  for (const part of sel.split(",")) {
    const target = document.querySelector(part.trim());
    if (target && visible(target)) {
      const tg = navGroup(target);
      const primary = tg ? primaryOfGroup(tg) : target;
      if (primary && visible(primary)) return primary;
    }
  }
  return null;
}

function focusElement(target) {
  target.focus();
  target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function move(direction) {
  const candidate = spatialPick(direction);
  if (candidate) { focusElement(candidate); return; }

  // No same-group candidate. Try the active group's declarative transition.
  const active = document.activeElement;
  const group = navGroup(active);
  const transitionTarget = followTransition(group, direction);
  if (transitionTarget) { focusElement(transitionTarget); return; }

  // No transition declared either → stay put (deliberate dead-end).
}

/* ====================================================================
 * Keyboard arrow-key navigation
 * ==================================================================== */

document.addEventListener("keydown", (e) => {
  const t = e.target;
  // Don't intercept arrow keys inside genuinely-text inputs — the user
  // is editing and arrows must move the caret. Selects are a different
  // case: native browser behaviour for ArrowLeft/Right/Up/Down on a
  // closed select cycles its value SILENTLY (Chrome/Edge), which is
  // jarring during spatial navigation — the user navigates RIGHT to
  // the sort dropdown, presses RIGHT again to continue, and the sort
  // order changes instead of focus moving to the next button. Treat
  // selects like any other focusable: arrows move spatial focus,
  // Enter/Space (default) opens the dropdown.
  const isText = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (isText) return;
  // Alt+ArrowDown / Alt+ArrowUp are the keyboard accelerators for
  // OPENING / CLOSING a select dropdown — keep those native so users
  // who rely on that pattern aren't blocked.
  if (t && t.tagName === "SELECT" && e.altKey) return;
  switch (e.key) {
    case "ArrowUp":    e.preventDefault(); move("up"); break;
    case "ArrowDown":  e.preventDefault(); move("down"); break;
    case "ArrowLeft":  e.preventDefault(); move("left"); break;
    case "ArrowRight": e.preventDefault(); move("right"); break;
  }
});

/* ====================================================================
 * Gamepad polling
 * ==================================================================== */

const prev = new Map();
function btnPressed(gp, idx) {
  const v = gp.buttons[idx];
  const cur = !!(v && (typeof v === "object" ? v.pressed : v > 0.5));
  const key = `${gp.index}:${idx}`;
  const was = prev.get(key) || false;
  prev.set(key, cur);
  return cur && !was;
}
/* ====================================================================
 * Hold-to-repeat directional navigation
 *
 * The browser already gives us OS-level key-repeat for arrow keys, so
 * keyboard users get hold-to-move for free. The gamepad path needs us
 * to provide it: the rAF poll observes the held state every frame, but
 * we want only ONE move() call per press until the user has held the
 * direction long enough to be intentionally scrolling.
 *
 * Timing matches Plex/Netflix on TV:
 *   first move fires immediately on press
 *   then a 380 ms hold delay before repeats kick in (so quick taps
 *     don't accidentally double-move)
 *   then a 80 ms repeat interval while held (≈ 12 moves/sec, fast
 *     enough to traverse a long shelf comfortably without runaway)
 * ==================================================================== */

const REPEAT_HOLD_MS = 380;
const REPEAT_INTERVAL_MS = 80;

const dirState = {
  up:    { held: false, downAt: 0, lastFire: 0, suppressed: false },
  down:  { held: false, downAt: 0, lastFire: 0, suppressed: false },
  left:  { held: false, downAt: 0, lastFire: 0, suppressed: false },
  right: { held: false, downAt: 0, lastFire: 0, suppressed: false },
};

function btnHeld(gp, idx) {
  const v = gp.buttons[idx];
  return !!(v && (typeof v === "object" ? v.pressed : v > 0.5));
}
function axisHeld(gp, axisIdx, sign) {
  const v = gp.axes[axisIdx] || 0;
  return sign > 0 ? v > 0.6 : v < -0.6;
}

// Hat-axis (D-pad-as-single-axis) decoder. Some controllers — most
// notably DualSense / DualShock on Firefox+macOS, where mapping is ""
// (non-standard) — encode the entire D-pad on a single axis with
// discrete values around -1..+1 plus an idle sentinel outside that
// range (typically ~1.286 or ~3.286). The standard 8-position layout
// is: UP=-1, UP-RIGHT≈-0.71, RIGHT≈-0.43, DOWN-RIGHT≈-0.14,
// DOWN≈+0.14, DOWN-LEFT≈+0.43, LEFT≈+0.71, UP-LEFT≈+1.0.
//
// Tolerance MUST stay strictly under half the anchor spacing
// (0.286/2 ≈ 0.143). With a wider band, neighbour anchors overlap
// AND idle drift on unrelated axes (e.g. axes[2]=0.0 on a non-hat
// axis) lands inside the DOWN anchor's band and makes hatDpad fire
// continuously without any user input. 0.10 leaves clear dead zones
// between anchors and rejects idle-drift values cleanly.
const HAT_DIR_TOL = 0.10;
const HAT_ANCHORS = [
  { v: -1.00, dirs: { up: true } },
  { v: -0.71, dirs: { up: true, right: true } },
  { v: -0.43, dirs: { right: true } },
  { v: -0.14, dirs: { down: true, right: true } },
  { v:  0.14, dirs: { down: true } },
  { v:  0.43, dirs: { down: true, left: true } },
  { v:  0.71, dirs: { left: true } },
  { v:  1.00, dirs: { up: true, left: true } },
];
function decodeHatAxis(v) {
  if (!Number.isFinite(v) || v < -1.1 || v > 1.1) return null;
  for (const a of HAT_ANCHORS) {
    if (Math.abs(v - a.v) < HAT_DIR_TOL) return a.dirs;
  }
  return null;
}
// Scan axes for a hat-style D-pad encoding. Only consults axes[2+] —
// axes[0] and [1] are the left analog stick on every controller in
// the wild and are read separately by axisHeld. We bail out for
// strict "standard" mappings, where the D-pad is reliably on
// buttons[12..15] and there's no need to peek at extra axes.
//
// Right-stick guard: a real hat axis idles at a SENTINEL value
// outside the analog range (DualSense in Firefox: 1.286 at rest,
// 3.286 elsewhere). Analog sticks — including the right stick on
// non-standard mappings, which can occupy any axis index — idle
// near 0 and never travel beyond ±1.0. Classify each axis the first
// time we see |v| > 1.1: those are hats; the rest are analog sticks
// (or triggers) and stay un-decoded forever, even as their values
// pass transiently through anchor positions during a deflection.
//
// Release-ramp guard: when the user lets go of the D-pad, some
// firmwares ramp the axis back through neighbouring anchors before
// snapping to idle (e.g. RIGHT=-0.43 → 0.14 → 0.71 → 1.29). Each
// anchor frame would otherwise look like a fresh direction press to
// tickDirection. We compare against the previous frame: a
// direction-to-direction flip without a clean idle gap is treated
// as transitional and returns null until the axis settles.
const HAT_SENTINEL_THRESHOLD = 1.1;
const _axisMaxAbs = [];   // index → largest |v| ever observed
let _prevHatDir = null;
function _sameHat(a, b) {
  return !!a && !!b
    && a.up===b.up && a.down===b.down && a.left===b.left && a.right===b.right;
}
function hatDpad(gp) {
  if (gp.mapping === "standard") return null;
  for (let i = 2; i < gp.axes.length; i++) {
    const v = gp.axes[i];
    if (!Number.isFinite(v)) continue;
    const mag = Math.abs(v);
    if (mag > (_axisMaxAbs[i] || 0)) _axisMaxAbs[i] = mag;
    // Only decode axes that have proven they're hats (saw a sentinel
    // value outside the analog range). Analog sticks never satisfy
    // this and are silently skipped.
    if ((_axisMaxAbs[i] || 0) <= HAT_SENTINEL_THRESHOLD) continue;
    const d = decodeHatAxis(v);
    if (d && (d.up || d.down || d.left || d.right)) {
      if (_prevHatDir === null) {
        _prevHatDir = d;       // idle → press (rising edge)
        return d;
      }
      if (_sameHat(_prevHatDir, d)) return d;  // stable held value
      return null;              // direction flipped without idle: ramp artifact
    }
  }
  _prevHatDir = null;            // hat is idle on every scanned axis
  return null;
}

function tickDirection(direction, isHeld, now) {
  const s = dirState[direction];
  if (!isHeld) {
    // Release clears both held and any post-navigation suppression so the
    // next genuine press is treated as a fresh rising edge.
    s.held = false;
    s.suppressed = false;
    return;
  }
  if (s.suppressed) {
    // A direction that was already held when a navigation happened —
    // the user is still physically pressing it, but they didn't ask
    // for spatial moves on the page they just landed on. Wait for the
    // release before resuming.
    return;
  }
  if (!s.held) {
    // Rising edge — fire once immediately, then arm the repeat timer.
    s.held = true;
    s.downAt = now;
    s.lastFire = now;
    move(direction);
    return;
  }
  // Held — wait for the initial hold delay, then auto-repeat.
  if (now - s.downAt < REPEAT_HOLD_MS) return;
  if (now - s.lastFire >= REPEAT_INTERVAL_MS) {
    s.lastFire = now;
    move(direction);
  }
}

// On a soft-nav, freeze any direction that's currently held: the press
// belonged to the previous page (e.g. the D-pad RIGHT used to reach the
// card that was just clicked, or analog-stick drift). Without this, the
// hold-to-repeat keeps firing move() during the soft-nav await window and
// drifts focus away from the new page's intended landing spot (e.g. the
// Play button on /game). Released-then-pressed-again clears the freeze.
function suspendHeldDirectionsForNav() {
  for (const dir of ["up", "down", "left", "right"]) {
    if (dirState[dir].held) dirState[dir].suppressed = true;
  }
}
window.addEventListener("retrox:navigated", suspendHeldDirectionsForNav);
window.addEventListener("popstate", suspendHeldDirectionsForNav);

function focusLibraryLink() {
  const lib = document.querySelector('.sidebar [data-key="library"]')
           || document.querySelector('.sidebar [href="/games"]');
  if (lib) focusElement(lib);
}

// "Back" gesture for the controller. Goes back ONE in-app step when
// there's somewhere safe to go (i.e. another app page is in the
// soft-nav stack). When the user is already at the root of their
// in-app history, history.back() would leave the shell entirely —
// most commonly to /login, which the user does NOT want to land on
// (they're authenticated; bouncing them to a login page they don't
// need is the worst possible "back" UX). In that case we explicitly
// do nothing: the user is at the start of their app session and the
// only way "out" is closing the tab.
//
// Modal dismissal is handled separately by the caller; by the time
// we get here, no modal is open.
function goBack() {
  if (canGoBackInApp()) {
    window.history.back();
  }
  // else: silently no-op. Going back from here would land on /login
  // (or whatever non-shell page preceded this document); the spec
  // says "never go to the login page", so we stay put.
}

function dismissTopmostModal() {
  // Modals AND the command palette listen for Escape on document and
  // call close() on a match. Synthesizing the same event lets us reuse
  // their existing dismiss path without coupling to internal close
  // handles. Palette uses .palette-backdrop, regular modals use
  // .modal-backdrop — both must be treated as "blocking the back
  // gesture", otherwise pressing B on /games with the palette open
  // would close the palette AND fire goBackOrLibrary, navigating off
  // the page the user is still trying to reach.
  if (!document.querySelector(".modal-backdrop, .palette-backdrop")) return false;
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true,
  }));
  return true;
}

function pollGamepad() {
  const now = performance.now();
  // We always read getGamepads(), even when delegating to the player.
  // Chromium grants gamepad-driven user activation only when JS calls
  // getGamepads() AND observes a rising edge in the same frame. If we
  // skipped this read while the overlay was mounted, the window
  // between the modal-close click and play.js's own poll starting
  // (top-level fetches in play.js take 200–500ms) would swallow any
  // button presses unobserved — Chromium wouldn't see them as
  // activation, and the EJS AudioContext would later spawn suspended
  // with no fresh activation available to resume() it.
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];

  // While the EmulatorJS player overlay is mounted AND no modal is up,
  // action handling (D-pad → emulator input, Select+L1 → save state,
  // A → click) is owned by play.js's poller. We kept the getGamepads
  // read above to keep activation flowing; skip the rest to avoid two
  // pollers fighting over the same buttons.
  //
  // EXCEPTION: if a modal (regular dialog or palette) is open ATOP
  // the player overlay — e.g. the sync-pill dialog, "Use my version"
  // confirm, command palette — the modal is what the user is
  // interacting with, not the game. gamepad-nav drives the modal
  // (A clicks focused button, B closes, D-pad navigates) and play.js
  // backs off in that scenario. Without this exception the user could
  // open the sync dialog from the player but couldn't dismiss it
  // without a mouse.
  const playerActive = !!document.querySelector(".player-host");
  const modalActive  = !!document.querySelector(".modal-backdrop, .palette-backdrop");
  if (playerActive && !modalActive) {
    requestAnimationFrame(pollGamepad);
    return;
  }
  for (const gp of pads) {
    if (!gp) continue;

    // Persist "controller seen" so other pages' load-time decisions
    // (login QR default, /game Play auto-focus, /games card auto-focus)
    // can see the controller without waiting for post-load input.
    if (gp.buttons.some(b => b && (typeof b === "object" ? b.pressed : b > 0.5)) ||
        gp.axes.some(a => Math.abs(a) > 0.5)) {
      rememberControllerSeen();
    }

    // Direction handling: hold-to-repeat for Plex/Netflix-like nav.
    // First press fires immediately; sustained hold auto-repeats
    // after a short delay. See REPEAT_HOLD_MS / REPEAT_INTERVAL_MS.
    //
    // Three input sources feed each direction:
    //   1. The standard D-pad button at index 12..15 (most controllers).
    //   2. The left analog stick on axes[0]/axes[1] (Standard mapping
    //      and most non-standard ones too).
    //   3. A "hat axis" — D-pad encoded as discrete values on a single
    //      axis. Common when gamepad.mapping is "" (e.g. DualSense in
    //      Firefox/macOS). See decodeHatAxis above.
    const hat = hatDpad(gp);
    tickDirection("up",    btnHeld(gp, 12) || axisHeld(gp, 1, -1) || !!(hat && hat.up),    now);
    tickDirection("down",  btnHeld(gp, 13) || axisHeld(gp, 1,  1) || !!(hat && hat.down),  now);
    tickDirection("left",  btnHeld(gp, 14) || axisHeld(gp, 0, -1) || !!(hat && hat.left),  now);
    tickDirection("right", btnHeld(gp, 15) || axisHeld(gp, 0,  1) || !!(hat && hat.right), now);

    // Face-button layout. The Web Gamepad API's "standard" mapping
    // puts the bottom face button (A / Cross) at index 0 and the right
    // face button (B / Circle) at index 1 — that's what Chromium
    // delivers for almost every controller. Firefox + Sony controllers
    // (DualShock 4 / DualSense) report mapping="" and shuffle the
    // face buttons: Square at 0, Cross at 1, Circle at 2, Triangle
    // at 3. Without remapping, pressing Circle (the natural PS "back")
    // would land on the slot we use for "confirm" — which is exactly
    // the bug the user filed.
    //
    // West face button (Square on PS / X on Xbox) is intentionally
    // UNBOUND. Earlier it opened the command palette, which surprised
    // PS users for whom "Square does something" felt arbitrary. The
    // palette is still reachable via "/" and Cmd/Ctrl-K from any
    // keyboard, so removing the face-button binding doesn't lose a
    // critical surface — it just stops triggering on accidental
    // presses.
    const isSonyNonStandard = gp.mapping === ""
      && /(?:054c-|DualShock|DualSense|PLAYSTATION)/i.test(gp.id || "");
    const faceConfirm = isSonyNonStandard ? 1 : 0;  // Cross / A
    const faceBack    = isSonyNonStandard ? 2 : 1;  // Circle / B
    const faceY       = 3;                           // Triangle / Y

    if (btnPressed(gp, faceConfirm)) {
      const a = document.activeElement;
      if (a && typeof a.click === "function") a.click();
    }
    // Back gesture (B / Circle):
    //   - If a modal/palette is open → close it (the natural "cancel" action).
    //   - Otherwise → step one in-app history entry back via goBack().
    //     goBack() refuses to leave the shell, so the user never gets
    //     bounced to /login from the controller's back button.
    if (btnPressed(gp, faceBack)) {
      if (!dismissTopmostModal()) goBack();
    }
    if (btnPressed(gp, faceY)) {
      const a = document.activeElement;
      const target = a && a.closest("[data-gp-y]");
      if (target) target.dispatchEvent(new CustomEvent("gp:y", { bubbles: true }));
    }
    if (btnPressed(gp, 4)) cycleChips(-1);
    if (btnPressed(gp, 5)) cycleChips( 1);
    if (btnPressed(gp, 9)) {
      const cta = document.querySelector("[data-gp-start], .btn--primary");
      if (cta) cta.click();
    }
    if (btnPressed(gp, 8)) {
      const first = document.querySelector(".gcard, [data-gp-first]");
      if (first) first.focus();
    }
  }
  requestAnimationFrame(pollGamepad);
}

function cycleChips(delta) {
  const chips = Array.from(document.querySelectorAll(".chips .chip"));
  if (!chips.length) return;
  const activeIdx = chips.findIndex(c => c.getAttribute("aria-pressed") === "true");
  const next = (activeIdx + delta + chips.length) % chips.length;
  // Snapshot the data-sys before click — the click handler in games.js
  // calls draw() which DESTROYS every chip node and rebuilds them, so
  // chips[next] is detached by the time we'd otherwise call .focus()
  // on it. Refocus after re-render by querying the new instance.
  // (Empty data-sys is the "All" chip; that's why we use the explicit
  // empty-string match rather than a missing-attribute selector.)
  const nextSys = chips[next].dataset.sys || "";
  chips[next].click();
  // Wait one frame for draw() to complete, then refocus the fresh node.
  requestAnimationFrame(() => {
    const fresh = document.querySelector(`.chips .chip[data-sys="${CSS.escape(nextSys)}"]`);
    if (fresh) focusElement(fresh);
  });
}

// Always poll. The browser hides already-connected controllers from a
// freshly-loaded page until it sees post-load input — gamepadconnected
// often does NOT fire on in-app navigation. Polling is cheap (rAF, no
// allocation when the array is empty).
requestAnimationFrame(pollGamepad);
