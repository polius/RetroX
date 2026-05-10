/* bindings-defaults.js — single source of truth for the action catalog
 * and default keyboard / gamepad bindings.
 *
 * Imported by:
 *   - bindings-ui.js  (renders the rebind UI; uses ACTIONS and *DEFAULTS)
 *   - play.js         (applies bindings to EJS_emulator at game start)
 *
 * Keeping these constants in one place is what guarantees the in-game
 * dialog, the Profile > Controls page, and the live emulator all agree
 * on what the defaults are. Earlier, the same data lived in three
 * places (play.js, profile.js, controller-bindings.js); each was a
 * regression waiting to happen.
 *
 * The corresponding backend whitelist lives in backend/app/routers/
 * profile.py (_KEYBOARD_ACTIONS, _GAMEPAD_ACTIONS, _GAMEPAD_LABELS) and
 * MUST stay in sync with this file. The CONSISTENCY check at the bottom
 * of this module catches drift between ACTIONS and the *_DEFAULTS dicts
 * at startup; backend-frontend drift is caught by the sanitizer dropping
 * unknown keys (a rebind silently failing to persist).
 */

/* ---------- The action catalog ----------
 *
 * Two groups:
 *   - "in-game"  → both columns rebindable; ejsSlot is the index into
 *                  EmulatorJS's defaultControllers[player][slot] map
 *                  (mirrors initControlVars in docker/emulatorjs/src/
 *                  emulator.js).
 *   - "shortcut" → keyboard rebindable only. The gamepad column shows
 *                  a fixed Select-modifier combo (or trigger), which
 *                  play.js handles in its own poll, never writing into
 *                  EJS's controls map.
 *
 * `note` flips on the asterisk for actions gated per-emulator (rewind /
 * fast forward depend on emulator support flags). */
export const ACTIONS = [
  // D-pad
  { key: "game_up",     group: "in-game", subgroup: "dpad",     label: "D-pad Up",    ejsSlot: 4  },
  { key: "game_down",   group: "in-game", subgroup: "dpad",     label: "D-pad Down",  ejsSlot: 5  },
  { key: "game_left",   group: "in-game", subgroup: "dpad",     label: "D-pad Left",  ejsSlot: 6  },
  { key: "game_right",  group: "in-game", subgroup: "dpad",     label: "D-pad Right", ejsSlot: 7  },
  // Face buttons
  { key: "game_a",      group: "in-game", subgroup: "face",     label: "A",           ejsSlot: 0  },
  { key: "game_b",      group: "in-game", subgroup: "face",     label: "B",           ejsSlot: 8  },
  { key: "game_x",      group: "in-game", subgroup: "face",     label: "X",           ejsSlot: 9  },
  { key: "game_y",      group: "in-game", subgroup: "face",     label: "Y",           ejsSlot: 1  },
  // Shoulders
  { key: "game_l1",     group: "in-game", subgroup: "shoulder", label: "L1",          ejsSlot: 10 },
  { key: "game_r1",     group: "in-game", subgroup: "shoulder", label: "R1",          ejsSlot: 11 },
  // Menu
  { key: "game_start",  group: "in-game", subgroup: "menu",     label: "Start",       ejsSlot: 3  },
  { key: "game_select", group: "in-game", subgroup: "menu",     label: "Select",      ejsSlot: 2  },
  // Shortcuts (keyboard rebindable, gamepad fixed)
  { key: "save_state",   group: "shortcut", label: "Save state",   gpFixed: "Select + L1"    },
  { key: "load_state",   group: "shortcut", label: "Load state",   gpFixed: "Select + R1"    },
  { key: "exit_game",    group: "shortcut", label: "Exit game",    gpFixed: "Select + Start" },
  { key: "fast_forward", group: "shortcut", label: "Fast forward", gpFixed: "R2", note: true },
  { key: "rewind",       group: "shortcut", label: "Rewind",       gpFixed: "L2", note: true },
];

export const SUBGROUP_LABELS = {
  dpad:     "Directional",
  face:     "Face buttons",
  shoulder: "Shoulders",
  menu:     "Menu",
};

/* ---------- Defaults ---------- */

/* KeyboardEvent.code values (layout-independent so a German QWERTZ user
 * picking "Y" still gets KeyY). MUST match what the emulator wires up
 * via play.js applyRetroxGameInputs + the KB shortcut block. */
export const KEYBOARD_DEFAULTS = {
  // Game inputs
  game_up:     "ArrowUp",
  game_down:   "ArrowDown",
  game_left:   "ArrowLeft",
  game_right:  "ArrowRight",
  game_a:      "KeyX",
  game_b:      "KeyZ",
  game_x:      "KeyS",
  game_y:      "KeyA",
  game_l1:     "KeyQ",
  game_r1:     "KeyE",
  game_start:  "Enter",
  game_select: "KeyV",
  // Shortcuts
  fast_forward: "Space",
  rewind:       "Backspace",
  save_state:   "F2",
  load_state:   "F4",
  exit_game:    "Escape",
};

/* EJS GamepadHandler labels — stored verbatim on
 * defaultControllers[*][slot].value2. Mirrors the defaults assigned by
 * EJS's initControlVars so RetroX feels like an extension of EJS rather
 * than an override. */
export const GAMEPAD_DEFAULTS = {
  game_a:      "BUTTON_2",
  game_b:      "BUTTON_1",
  game_x:      "BUTTON_3",
  game_y:      "BUTTON_4",
  game_select: "SELECT",
  game_start:  "START",
  game_up:     "DPAD_UP",
  game_down:   "DPAD_DOWN",
  game_left:   "DPAD_LEFT",
  game_right:  "DPAD_RIGHT",
  game_l1:     "LEFT_TOP_SHOULDER",
  game_r1:     "RIGHT_TOP_SHOULDER",
};

/* ---------- Slot maps (used by play.js + bindings-ui live-apply) ---------- */

/* action → EJS slot, derived from ACTIONS so we never have to hand-keep
 * two parallel tables in sync. Frozen so callers don't accidentally
 * mutate it. */
export const GAME_INPUT_TO_EJS_SLOT = Object.freeze(
  ACTIONS
    .filter(a => a.group === "in-game")
    .reduce((acc, a) => { acc[a.key] = a.ejsSlot; return acc; }, {}),
);

/* D-pad keys mirror onto the left analog stick so games that read only
 * the stick (N64, most PSX) still respond to D-pad keyboard rebinds. */
export const DPAD_TO_LEFT_STICK_SLOT = Object.freeze({
  game_up:    19,  // LEFT_STICK_Y:-1
  game_down:  18,  // LEFT_STICK_Y:+1
  game_left:  17,  // LEFT_STICK_X:-1
  game_right: 16,  // LEFT_STICK_X:+1
});

/* ---------- Display labels ---------- */

/* Web Gamepad standard mapping → EJS GamepadHandler label. Captured
 * from navigator.getGamepads() during a rebind and stored as the EJS
 * value2 string. Mirrors GamepadHandler.buttonLabels in the EJS source. */
export const BUTTON_INDEX_TO_LABEL = Object.freeze({
  0: "BUTTON_1", 1: "BUTTON_2", 2: "BUTTON_3", 3: "BUTTON_4",
  4: "LEFT_TOP_SHOULDER",    5: "RIGHT_TOP_SHOULDER",
  6: "LEFT_BOTTOM_SHOULDER", 7: "RIGHT_BOTTOM_SHOULDER",
  8: "SELECT", 9: "START",
  10: "LEFT_STICK", 11: "RIGHT_STICK",
  12: "DPAD_UP", 13: "DPAD_DOWN", 14: "DPAD_LEFT", 15: "DPAD_RIGHT",
});

/* Friendly label shown in the rebind pill. Face-button labels lead with
 * the SNES/Xbox/PS letter pair, then a parenthesized physical position
 * — "A / ✕ (bottom)" reads as "the bottom-face button, called A on Xbox
 * and ✕ on PS". Without the position suffix the row label `A` paired
 * with pill `B / ○` reads as a contradiction (it's actually showing the
 * libretro/SNES convention where the in-game `A` action lives on the
 * right-face button); the suffix turns the pill into a self-contained
 * description that doesn't depend on knowing the convention.
 *
 * D-pad arrows already encode their direction, shoulders / triggers /
 * Select / Start are unambiguous, so only the four face buttons get the
 * suffix treatment.
 *
 * Stick-axis labels match EJS GamepadHandler.getAxisLabel exactly
 * (LEFT_STICK_X:+1 etc.), so what the rebind dialog stores is what EJS
 * dispatches against at runtime. They're displayed as compact "L-Stick
 * ↑" / "R-Stick ↓" / etc.
 *
 * The "Standard" mapping is what Chrome reports for almost every
 * controller. Firefox + Sony pads (and a handful of generic gamepads)
 * advertise mapping="" instead and shuffle the face-button indices —
 * see LABEL_TO_DISPLAY_SONY_NS below for the override table. */
export const LABEL_TO_DISPLAY = Object.freeze({
  BUTTON_1: "A / ✕ (bottom)",
  BUTTON_2: "B / ○ (right)",
  BUTTON_3: "X / □ (left)",
  BUTTON_4: "Y / △ (top)",
  LEFT_TOP_SHOULDER:    "L1",
  RIGHT_TOP_SHOULDER:   "R1",
  LEFT_BOTTOM_SHOULDER: "L2",
  RIGHT_BOTTOM_SHOULDER: "R2",
  SELECT: "Select",
  START:  "Start",
  LEFT_STICK:  "L3",
  RIGHT_STICK: "R3",
  DPAD_UP:    "D-pad ↑",
  DPAD_DOWN:  "D-pad ↓",
  DPAD_LEFT:  "D-pad ←",
  DPAD_RIGHT: "D-pad →",
  // Stick axes (used as a fallback when a controller reports the D-pad
  // as analog stick movement instead of buttons 12-15).
  "LEFT_STICK_X:+1": "L-Stick →", "LEFT_STICK_X:-1": "L-Stick ←",
  "LEFT_STICK_Y:+1": "L-Stick ↓", "LEFT_STICK_Y:-1": "L-Stick ↑",
  "RIGHT_STICK_X:+1": "R-Stick →", "RIGHT_STICK_X:-1": "R-Stick ←",
  "RIGHT_STICK_Y:+1": "R-Stick ↓", "RIGHT_STICK_Y:-1": "R-Stick ↑",
});

/* Sony non-standard mapping (Firefox + DualShock/DualSense, some Mac
 * setups). The browser reports buttons in the order [Square, Cross,
 * Circle, Triangle] — i.e., button index 0 is Square, not Cross. EJS's
 * GamepadHandler labels by raw index, so:
 *
 *   index 0 → "BUTTON_1"  → physically: Square (LEFT face)
 *   index 1 → "BUTTON_2"  → physically: Cross  (BOTTOM face)
 *   index 2 → "BUTTON_3"  → physically: Circle (RIGHT face)
 *   index 3 → "BUTTON_4"  → physically: Triangle (TOP face)
 *
 * The standard table above hard-codes a different mental model — index
 * 0 = bottom — so on these controllers it lies about every face button
 * except Triangle (index 3 lines up by chance). Pressing Square shows
 * "A / ✕ (bottom)" instead of "X / □ (left)", and the swap UX falls
 * over because users see B/O and A/X in the wrong rows.
 *
 * Captured labels are still raw indices (BUTTON_1 etc.) — that has to
 * stay index-based so EJS's runtime dispatch keeps matching the right
 * physical button. Only the DISPLAY changes.
 *
 * Non-face entries are inherited from the standard table at runtime,
 * which is why this object only overrides the four face buttons. */
export const LABEL_TO_DISPLAY_SONY_NS = Object.freeze({
  BUTTON_1: "X / □ (left)",     // index 0 on NS = Square
  BUTTON_2: "A / ✕ (bottom)",   // index 1 on NS = Cross
  BUTTON_3: "B / ○ (right)",    // index 2 on NS = Circle
  BUTTON_4: "Y / △ (top)",      // index 3 on NS = Triangle (unchanged)
});

/** True when this gamepad reports the Sony non-standard layout — the
 *  browser advertised an empty `mapping` and the id matches a known
 *  PlayStation controller pattern. Mirrors the test gamepad-nav.js
 *  uses for face-button confirm/back swapping. */
export function isSonyNonStandard(pad) {
  return !!pad
    && pad.mapping === ""
    && /(?:054c-|DualShock|DualSense|PLAYSTATION)/i.test(pad.id || "");
}

/* ---------- Startup consistency check ----------
 *
 * Guards against silent drift inside this file: every in-game action
 * MUST have a default in BOTH KEYBOARD_DEFAULTS and GAMEPAD_DEFAULTS;
 * every shortcut action MUST have a KEYBOARD_DEFAULTS entry. If anyone
 * adds an action without filling out the defaults, this throws at
 * module load — failing fast in dev rather than silently rendering an
 * empty pill in production. */
(function checkConsistency() {
  const missing = [];
  for (const a of ACTIONS) {
    if (!(a.key in KEYBOARD_DEFAULTS)) missing.push(`KEYBOARD_DEFAULTS[${a.key}]`);
    if (a.group === "in-game" && !(a.key in GAMEPAD_DEFAULTS)) {
      missing.push(`GAMEPAD_DEFAULTS[${a.key}]`);
    }
    if (a.group === "in-game" && typeof a.ejsSlot !== "number") {
      missing.push(`ACTIONS[${a.key}].ejsSlot`);
    }
  }
  if (missing.length) {
    throw new Error(`bindings-defaults.js inconsistency: missing ${missing.join(", ")}`);
  }
})();
