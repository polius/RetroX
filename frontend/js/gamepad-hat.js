/* gamepad-hat.js — D-pad-as-single-axis (hat) decoder.
 *
 * Some controllers — most notably DualSense / DualShock on Firefox+macOS,
 * where mapping is "" (non-standard) — encode the entire D-pad on a
 * single axis with discrete values around -1..+1 plus an idle sentinel
 * outside that range (typically ~1.286 or ~3.286). The standard
 * 8-position layout is:
 *
 *   UP=-1, UP-RIGHT≈-0.71, RIGHT≈-0.43, DOWN-RIGHT≈-0.14,
 *   DOWN≈+0.14, DOWN-LEFT≈+0.43, LEFT≈+0.71, UP-LEFT≈+1.0
 *
 * Two consumers need this:
 *   - gamepad-nav.js — for app navigation (focus movement).
 *   - play.js        — for in-game directional input (D-pad on the
 *                      same controllers wasn't reaching the emulator
 *                      because EJS's defaults expect buttons 12-15).
 *
 * Module-level state is shared across consumers: "this axis index is
 * a hat" only needs to be discovered once per page load. */

// Tolerance MUST stay strictly under half the anchor spacing
// (0.286/2 ≈ 0.143). With a wider band, neighbour anchors overlap AND
// idle drift on unrelated axes (e.g. axes[2]=0.0 on a non-hat axis)
// lands inside the DOWN anchor's band and makes hatDpad fire
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

// A real hat axis idles at a SENTINEL value outside the analog range
// (DualSense in Firefox: 1.286 at rest, 3.286 elsewhere). Analog
// sticks — including the right stick on non-standard mappings, which
// can occupy any axis index — idle near 0 and never travel beyond
// ±1.0. Classify each axis the first time we see |v| > 1.1: those are
// hats; the rest are analog sticks (or triggers) and stay un-decoded
// forever, even as their values pass transiently through anchor
// positions during a deflection.
const HAT_SENTINEL_THRESHOLD = 1.1;
const _axisMaxAbs = [];   // index → largest |v| ever observed

// Release-ramp guard: when the user lets go of the D-pad, some
// firmwares ramp the axis back through neighbouring anchors before
// snapping to idle (e.g. RIGHT=-0.43 → 0.14 → 0.71 → 1.29). Each
// anchor frame would otherwise look like a fresh direction press to
// callers. We compare against the previous frame: a direction-to-
// direction flip without a clean idle gap is treated as transitional
// and returns null until the axis settles.
let _prevHatDir = null;
function _sameHat(a, b) {
  return !!a && !!b
    && a.up===b.up && a.down===b.down && a.left===b.left && a.right===b.right;
}

/** Scan the gamepad's axes for a hat-style D-pad encoding and return
 *  `{ up?, down?, left?, right? }` if any direction is being pressed,
 *  else `null`. Only consults axes[2+] — axes[0] and [1] are the left
 *  analog stick on every controller in the wild and are read separately
 *  by callers. Strict "standard" mapping bails out: the D-pad is
 *  reliably on buttons[12..15] there and there's no need to peek at
 *  extra axes. */
export function hatDpad(gp) {
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
