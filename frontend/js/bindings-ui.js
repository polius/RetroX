/* bindings-ui.js — shared rendering + capture state for keyboard and
 * gamepad bindings. Two surfaces use this:
 *
 *   1. /profile/Controls — page mode. Renders inside a .section-card.
 *      Persists rebinds; no live-apply (no emulator running).
 *
 *   2. The in-game Controls pill dialog — modal mode. Persists AND
 *      live-applies to the running EJS_emulator so changes are felt
 *      without a restart.
 *
 * The two surfaces are intentionally identical structurally — same
 * rows, same capture flow, same conflict rules — so the UI feels like
 * one feature in two places rather than two divergent screens.
 *
 * Usage:
 *   const handle = mountBindings(container, { liveApply: true });
 *   // ...later...
 *   handle.destroy();
 *
 * Layout uses CSS grid (not <table>) so spacing inside the modal is
 * predictable: two fixed-width pill columns on the right, action label
 * fills the remaining space. Earlier table-based layouts created the
 * "right edge glued to modal wall" problem because <td> intrinsic
 * widths fought modal padding.
 */

import { api } from "./api.js";
import { toast, modal } from "./toast.js";
import { icon } from "./icons.js";
import { friendlyKey, isBindable, codeToEjsKey } from "./key-codes.js";
import { escapeHtml } from "./util.js";
import {
  ACTIONS,
  SUBGROUP_LABELS,
  KEYBOARD_DEFAULTS,
  GAMEPAD_DEFAULTS,
  DPAD_TO_LEFT_STICK_SLOT,
  BUTTON_INDEX_TO_LABEL,
  LABEL_TO_DISPLAY,
  LABEL_TO_DISPLAY_SONY_NS,
  isSonyNonStandard,
} from "./bindings-defaults.js";

// Re-export ACTIONS so existing import sites that pull it from here
// keep working without churn.
export { ACTIONS };

/* ---------- Live-apply (in-game dialog only) ----------
 *
 * Mutate EJS's defaultControllers + controls in place so a rebind is
 * felt by the running emulator without a restart. setupKeys() rebuilds
 * the keyboard listener map from controls; gamepadEvent reads value2
 * fresh on each fire so it needs no equivalent.
 *
 * Multi-player policy:
 *   - Gamepad bindings are mirrored across all 4 player slots so a
 *     second / third / fourth physical controller reuses the same
 *     button mapping (matches play.js's boot-time seeding loop and the
 *     N64 / PSX co-op use case).
 *   - Keyboard bindings stay on player 0 only — EJS's keyboard handler
 *     fires simulateInput for EVERY player whose `controls[i][slot].value`
 *     matches the pressed key, so copying the keyboard map to all
 *     players would broadcast each press to all 4 slots simultaneously
 *     and break multi-player. Per-player keyboard rebinds aren't a real
 *     use case (multi-player runs on multiple gamepads, not on one
 *     shared keyboard). */
function applyKeyboardLive(action, code) {
  const emu = window.EJS_emulator;
  if (!emu) return;
  const slot = ACTIONS.find(a => a.key === action)?.ejsSlot;
  if (slot == null) return;
  const ejsKey = codeToEjsKey(code);
  if (ejsKey == null) return;
  for (const map of [emu.defaultControllers, emu.controls]) {
    if (!map || !map[0]) continue;
    map[0][slot] = { ...(map[0][slot] || {}), value: ejsKey };
    // Mirror D-pad keys onto the analog-stick slots so N64/PSX games
    // (which read the stick) follow a re-bound keyboard direction.
    const stickSlot = DPAD_TO_LEFT_STICK_SLOT[action];
    if (stickSlot != null) {
      map[0][stickSlot] = { ...(map[0][stickSlot] || {}), value: ejsKey };
    }
  }
  try { emu.setupKeys?.(); } catch { /* not fatal */ }
  try { emu.saveSettings?.(); } catch { /* best-effort */ }
}

function applyGamepadLive(action, label) {
  const emu = window.EJS_emulator;
  if (!emu) return;
  const slot = ACTIONS.find(a => a.key === action)?.ejsSlot;
  if (slot == null) return;
  for (const map of [emu.defaultControllers, emu.controls]) {
    if (!map) continue;
    for (let player = 0; player < 4; player++) {
      // EJS initializes players 1-3 as `{}`; play.js seeds them at
      // boot. We assign defensively in case the rebind dialog opens
      // before that seeding has finished.
      if (!map[player]) map[player] = {};
      map[player][slot] = { ...(map[player][slot] || {}), value2: label };
    }
  }
  try { emu.saveSettings?.(); } catch { /* best-effort */ }
}

/* ---------- Public mount ---------- */

/**
 * Render the bindings UI inside `container`. Returns `{ destroy }` for
 * cleanup. Caller is responsible for any surrounding chrome (modal
 * shell, section-card, headings).
 *
 * @param {HTMLElement} container
 * @param {object}    [opts]
 * @param {boolean}   [opts.liveApply=false]  Apply rebinds to the running EJS_emulator.
 * @param {boolean}   [opts.showHero=true]    Show controller-status banner above bindings.
 */
export function mountBindings(container, opts = {}) {
  const liveApply = !!opts.liveApply;
  const showHero  = opts.showHero !== false;

  const stored = { keyboard: {}, gamepad: {} };
  const eff = {
    kb: (action) => stored.keyboard[action] || KEYBOARD_DEFAULTS[action],
    gp: (action) => stored.gamepad[action]  || GAMEPAD_DEFAULTS[action],
  };

  // Single-instance capture state. Two captures simultaneously would
  // create ambiguous "which pill wins this press" UX, so we cancel the
  // prior whenever a new pill takes over.
  let capture = null;

  /* ---------- Skeleton render ---------- */

  container.classList.add("bindings-mount");
  container.innerHTML = `
    <div class="bindings-skeleton" aria-hidden="true">
      <div class="bindings-skeleton__row"></div>
      <div class="bindings-skeleton__row"></div>
      <div class="bindings-skeleton__row"></div>
    </div>
  `;

  let destroyed = false;
  let detachKeyListener = null;
  let detectionRaf = 0;

  /* ---------- Detection poll (drives the hero banner) ----------
   *
   * Tracks ALL connected pads (not just the first) so the hero can
   * surface the count for multi-controller setups. EJS supports up to
   * four players; navigator.getGamepads() returns up to four entries
   * with stable indices, so we just count non-null entries.
   *
   * Re-rendering the hero only when count or names change keeps DOM
   * churn minimal (the poll runs every frame). */
  let connectedPads = [];
  function pollPad() {
    if (destroyed) return;
    if (!navigator.getGamepads) {
      detectionRaf = requestAnimationFrame(pollPad);
      return;
    }
    const pads = Array.from(navigator.getGamepads() || []).filter(Boolean);
    if (padsSignature(pads) !== padsSignature(connectedPads)) {
      const wasNS = connectedPads.some(isSonyNonStandard);
      connectedPads = pads;
      updateHero();
      // If the Sony-NS state flipped (NS pad plugged in or unplugged),
      // refresh every gamepad pill — the same EJS label resolves to a
      // different physical position label between the two tables.
      if (wasNS !== connectedPads.some(isSonyNonStandard)) refreshGamepadPills();
    }
    detectionRaf = requestAnimationFrame(pollPad);
  }

  function refreshGamepadPills() {
    container.querySelectorAll('.bindings-pill[data-action][data-col="gp"]').forEach(p => {
      refreshPill(p, p.dataset.action, "gp");
    });
  }

  /** Stable identity for a pad set — count + the unique-id of each. The
   *  raw Gamepad objects are recreated each frame, so we can't compare
   *  by reference. */
  function padsSignature(pads) {
    return pads.map(p => p ? `${p.index}:${p.id}` : "_").join("|");
  }

  /** Display name for a pad: drops the "(STANDARD GAMEPAD ...)" suffix
   *  the browser tacks on, then falls back to "Generic gamepad". */
  function padName(pad) {
    const name = (pad.id || "").replace(/\s*\(.*?\)\s*/g, "").trim();
    return name || "Generic gamepad";
  }

  function updateHero() {
    const heroEl = container.querySelector(".bindings-hero");
    if (!heroEl) return;
    const count = connectedPads.length;
    heroEl.classList.toggle("is-connected", count > 0);

    const titleEl = heroEl.querySelector(".bindings-hero__title");
    const countBadge = count > 1
      ? `<span class="bindings-hero__count" aria-hidden="true">${count}</span>`
      : "";
    if (count === 0)      titleEl.innerHTML = "No controller detected";
    else if (count === 1) titleEl.innerHTML = "Controller connected";
    else                  titleEl.innerHTML = `${countBadge}<span>${count} controllers connected</span>`;

    const sub = heroEl.querySelector(".bindings-hero__sub");
    if (count === 0) {
      sub.textContent = "Plug in a USB or Bluetooth gamepad, or pair your phone, to start remapping.";
    } else {
      // De-duplicate names (two identical pads → "DualSense × 2") and
      // join with thin separators so the line stays readable.
      const counts = new Map();
      for (const p of connectedPads) {
        const n = padName(p);
        counts.set(n, (counts.get(n) || 0) + 1);
      }
      const parts = Array.from(counts.entries()).map(([n, c]) => c > 1 ? `${n} × ${c}` : n);
      sub.textContent = parts.join(" · ");
    }
  }

  /* ---------- Build the table ---------- */

  function rowsFor(subgroup) {
    return ACTIONS.filter(a => a.group === "in-game" && a.subgroup === subgroup);
  }

  /** Display string for a stored gamepad label. Sony non-standard pads
   *  (Firefox + DualShock/DualSense) shuffle the face-button indices,
   *  so the label-to-position lookup needs to know what's plugged in.
   *  When ANY connected pad is Sony NS, prefer the NS table for face
   *  buttons; everything else (shoulders, sticks, D-pad, axes) is the
   *  same on both layouts and falls through to the standard table. */
  function displayGamepad(label) {
    const ns = connectedPads.some(isSonyNonStandard);
    if (ns && label in LABEL_TO_DISPLAY_SONY_NS) {
      return LABEL_TO_DISPLAY_SONY_NS[label];
    }
    return LABEL_TO_DISPLAY[label] || label;
  }

  function pillButton(action, col, isFixed = false, fixedLabel = "") {
    if (isFixed) {
      return `<span class="bindings-pill bindings-pill--fixed" aria-disabled="true">${escapeHtml(fixedLabel)}</span>`;
    }
    const value = col === "gp" ? eff.gp(action) : eff.kb(action);
    const display = col === "gp"
      ? displayGamepad(value)
      : friendlyKey(value);
    const isOverride = col === "gp"
      ? !!stored.gamepad[action]
      : !!stored.keyboard[action];
    const aria = col === "gp"
      ? `Rebind controller button for ${actionLabel(action)}`
      : `Rebind keyboard key for ${actionLabel(action)}`;
    return `
      <button type="button" class="bindings-pill"
              data-action="${escapeHtml(action)}" data-col="${col}"
              data-override="${isOverride ? "1" : "0"}"
              aria-label="${escapeHtml(aria)}">
        <span class="bindings-pill__value">${escapeHtml(display)}</span>
      </button>
    `;
  }

  function actionLabel(actionKey) {
    return ACTIONS.find(a => a.key === actionKey)?.label || actionKey;
  }

  function rowFor(action) {
    return `
      <div class="bindings-row" data-action="${escapeHtml(action.key)}">
        <div class="bindings-row__label">
          ${escapeHtml(action.label)}${action.note ? `<sup>*</sup>` : ""}
        </div>
        <div class="bindings-row__cell">
          ${action.group === "shortcut"
            ? pillButton(action.key, "gp", true, action.gpFixed)
            : pillButton(action.key, "gp")}
        </div>
        <div class="bindings-row__cell">
          ${pillButton(action.key, "kb")}
        </div>
      </div>
    `;
  }

  function fullRender() {
    const inGameSubgroups = ["dpad", "face", "shoulder", "menu"];
    const inGameSections = inGameSubgroups.map(sg => `
      <div class="bindings-section">
        <div class="bindings-section__label">${escapeHtml(SUBGROUP_LABELS[sg])}</div>
        <div class="bindings-section__rows">
          ${rowsFor(sg).map(rowFor).join("")}
        </div>
      </div>
    `).join("");

    const shortcutRows = ACTIONS.filter(a => a.group === "shortcut").map(rowFor).join("");
    const shortcutsHtml = `
      <div class="bindings-section">
        <div class="bindings-section__label">
          <span>Game shortcuts</span>
          <span class="bindings-section__hint">Controller combos are fixed · keyboard rebindable</span>
        </div>
        <div class="bindings-section__rows">
          ${shortcutRows}
        </div>
        <div class="bindings-section__note">
          <sup>*</sup> Where the emulator supports it. On systems with native trigger
          inputs (PSX, N64), L2 / R2 send game input instead.
        </div>
      </div>
    `;

    // The hero renders an empty title/sub on first paint; updateHero()
    // fills them right after to populate count + names. Centralizing
    // that logic in updateHero keeps the "what does the hero say?"
    // answer in one place.
    container.innerHTML = `
      ${showHero ? `
        <div class="bindings-hero">
          <span class="bindings-hero__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 11h2M7 10v2"/>
              <circle cx="15" cy="10.5" r="0.6" fill="currentColor"/>
              <circle cx="17" cy="12" r="0.6" fill="currentColor"/>
              <path d="M7 7h10a4 4 0 0 1 4 4v2.5a3 3 0 0 1-5.5 1.7L13.5 13h-3l-2 2.2A3 3 0 0 1 3 13.5V11a4 4 0 0 1 4-4Z"/>
            </svg>
          </span>
          <div class="bindings-hero__copy">
            <div class="bindings-hero__title"></div>
            <div class="bindings-hero__sub"></div>
          </div>
        </div>
      ` : ""}

      <div class="bindings-grid" role="group" aria-label="Bindings">
        <div class="bindings-grid__header" aria-hidden="true">
          <div class="bindings-grid__header-cell bindings-grid__header-cell--action">Action</div>
          <div class="bindings-grid__header-cell">Controller</div>
          <div class="bindings-grid__header-cell">Keyboard</div>
        </div>
        ${inGameSections}
        ${shortcutsHtml}
      </div>

      <div class="bindings-foot">
        <button type="button" class="btn btn--ghost btn--sm" data-action-id="restore">
          ${icon("refresh", { size: 14 })}<span>Restore defaults</span>
        </button>
        <span class="bindings-status" role="status" aria-live="polite"></span>
      </div>
    `;

    wireEvents();
    updateHero();
  }

  /* ---------- Status line ---------- */

  function setStatus(msg, tone = "info") {
    const el = container.querySelector(".bindings-status");
    if (!el) return;
    el.textContent = msg || "";
    el.dataset.tone = msg ? tone : "";
  }

  /* ---------- Capture flow ---------- */

  function refreshPill(btnEl, action, col) {
    const value = col === "gp" ? eff.gp(action) : eff.kb(action);
    const display = col === "gp"
      ? displayGamepad(value)
      : friendlyKey(value);
    btnEl.dataset.override = (col === "gp" ? !!stored.gamepad[action] : !!stored.keyboard[action]) ? "1" : "0";
    const valEl = btnEl.querySelector(".bindings-pill__value");
    if (valEl) valEl.textContent = display;
  }

  function clearCapture(restoreLabel = true) {
    if (!capture) return;
    const c = capture;
    capture = null;
    if (c.kind === "gp") {
      window.__retroxRebindCapture = false;
      if (c.rafId) cancelAnimationFrame(c.rafId);
    }
    c.btn.classList.remove("is-capturing");
    if (restoreLabel) {
      const valEl = c.btn.querySelector(".bindings-pill__value");
      if (valEl) valEl.textContent = c.previousLabel;
    }
  }

  /** Find the pill element for a (action, col) pair. Used to refresh the
   *  displaced row's pill during an auto-swap. */
  function findPill(actionKey, col) {
    return container.querySelector(
      `.bindings-pill[data-action="${actionKey}"][data-col="${col}"]`,
    );
  }

  /** Restore stored[action] from a pre-swap snapshot. The snapshot is
   *  the raw map value (possibly undefined when the row was on default);
   *  restoring undefined means deleting the override. */
  function restoreStored(map, key, snapshot) {
    if (snapshot === undefined) delete map[key];
    else                        map[key] = snapshot;
  }

  /* Both commit paths follow the same shape:
   *   1. Look for the row currently bound to `value` — call it `conflict`.
   *      If found, this commit becomes a SWAP: the displaced row inherits
   *      this row's previous binding so we never end up with two actions
   *      sharing one button (or one orphaned action with no binding).
   *   2. Snapshot stored[action] and stored[conflict] before mutating so
   *      a network failure can fully restore the prior state.
   *   3. Apply the change(s) live (if liveApply) so the running emulator
   *      reflects the swap immediately.
   *   4. PUT the full map. On success, refresh both pills + status line.
   *      On failure, restore stored, revert live, refresh both pills.
   * The two columns share the same pattern but on different state slots
   * (stored.gamepad vs stored.keyboard) and conflict scopes (in-game-only
   * vs all actions). */

  async function commitGamepad(action, label, btnEl) {
    // Conflict scope = in-game rows only (shortcut rows have a fixed
    // gamepad combo that isn't represented in stored.gamepad anyway).
    const conflict = ACTIONS.find(a =>
      a.key !== action && a.group === "in-game" && eff.gp(a.key) === label,
    );
    const prevLabel = eff.gp(action);

    const snapAction   = stored.gamepad[action];
    const snapConflict = conflict ? stored.gamepad[conflict.key] : undefined;

    stored.gamepad[action] = label;
    if (liveApply) applyGamepadLive(action, label);
    if (conflict) {
      stored.gamepad[conflict.key] = prevLabel;
      if (liveApply) applyGamepadLive(conflict.key, prevLabel);
    }

    try {
      await api.put("/profile/preferences", { data: { gamepad_bindings: stored.gamepad } });
      refreshPill(btnEl, action, "gp");
      if (conflict) {
        const conflictBtn = findPill(conflict.key, "gp");
        if (conflictBtn) refreshPill(conflictBtn, conflict.key, "gp");
        setStatus(`Swapped · ${actionLabel(action)} ↔ ${conflict.label}`, "ok");
      } else {
        setStatus(`Saved · ${actionLabel(action)} → ${displayGamepad(label)}`, "ok");
      }
    } catch (err) {
      restoreStored(stored.gamepad, action, snapAction);
      if (liveApply) applyGamepadLive(action, prevLabel);
      if (conflict) {
        restoreStored(stored.gamepad, conflict.key, snapConflict);
        if (liveApply) applyGamepadLive(conflict.key, label);
        const conflictBtn = findPill(conflict.key, "gp");
        if (conflictBtn) refreshPill(conflictBtn, conflict.key, "gp");
      }
      refreshPill(btnEl, action, "gp");
      toast.fromError?.(err, "Couldn't save controller binding");
    }
  }

  async function commitKeyboard(action, code, btnEl) {
    if (!isBindable(code)) {
      setStatus(`${friendlyKey(code)} can't be used as a binding.`, "error");
      refreshPill(btnEl, action, "kb");
      return;
    }
    // Conflict scope = ALL rows (shortcut rows are keyboard-rebindable
    // too, so a game input and a shortcut can be swapped across groups).
    const conflict = ACTIONS.find(a => a.key !== action && eff.kb(a.key) === code);
    const prevCode = eff.kb(action);

    const snapAction   = stored.keyboard[action];
    const snapConflict = conflict ? stored.keyboard[conflict.key] : undefined;

    stored.keyboard[action] = code;
    if (liveApply) applyKeyboardLive(action, code);
    if (conflict) {
      stored.keyboard[conflict.key] = prevCode;
      if (liveApply) applyKeyboardLive(conflict.key, prevCode);
    }

    try {
      await api.put("/profile/preferences", { data: { keyboard_bindings: stored.keyboard } });
      refreshPill(btnEl, action, "kb");
      if (conflict) {
        const conflictBtn = findPill(conflict.key, "kb");
        if (conflictBtn) refreshPill(conflictBtn, conflict.key, "kb");
        setStatus(`Swapped · ${actionLabel(action)} ↔ ${conflict.label}`, "ok");
      } else {
        setStatus(`Saved · ${actionLabel(action)} → ${friendlyKey(code)}`, "ok");
      }
    } catch (err) {
      restoreStored(stored.keyboard, action, snapAction);
      if (liveApply) applyKeyboardLive(action, prevCode);
      if (conflict) {
        restoreStored(stored.keyboard, conflict.key, snapConflict);
        if (liveApply) applyKeyboardLive(conflict.key, code);
        const conflictBtn = findPill(conflict.key, "kb");
        if (conflictBtn) refreshPill(conflictBtn, conflict.key, "kb");
      }
      refreshPill(btnEl, action, "kb");
      toast.fromError?.(err, "Couldn't save keyboard binding");
    }
  }

  /* ---------- Gamepad capture poll ----------
   *
   * Rising-edge detection over both buttons AND axes:
   *
   *   1. On the first frame, snapshot whatever's currently held /
   *      deflected. That's the baseline; nothing in it counts as a press.
   *   2. On subsequent frames, any button that transitions UP→DOWN, or
   *      any axis that newly crosses ±AXIS_THRESH (or flips sign), is
   *      the captured input.
   *
   * Why edge-detection instead of the previous "wait for all released":
   *
   *   - Stick drift, a stuck L3/R3 sensor, or a button held over from
   *     the click that started the rebind would all keep `anyPressed`
   *     true forever and the previous gate would never arm. Edge
   *     detection is immune — those go in the baseline and get ignored.
   *   - It also drops the awkward "click pill, release controller, then
   *     press" dance — the user just presses what they want.
   *
   * Why we read axes too:
   *
   *   - Standard-mapping controllers expose the D-pad as buttons 12-15
   *     (covered by the button branch). But many non-standard pads
   *     (Firefox + DualShock/DualSense, certain generic gamepads) report
   *     the D-pad as movement on axes 0/1 with no button entries. The
   *     axis branch is what makes those bindable.
   *   - The captured axis label matches EJS GamepadHandler.getAxisLabel
   *     ("LEFT_STICK_X:+1" etc.), so what we store is exactly what EJS's
   *     axischanged dispatch matches against at runtime — no translation
   *     layer. */
  const AXIS_THRESH = 0.5;
  const AXIS_NAMES = ["LEFT_STICK_X", "LEFT_STICK_Y", "RIGHT_STICK_X", "RIGHT_STICK_Y"];

  function snapshotPadState() {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads() || []) : [];
    const buttons = new Set();
    const axes = new Map();   // axisIndex → "+1" | "-1"
    for (const gp of pads) {
      if (!gp) continue;
      for (let i = 0; i < gp.buttons.length; i++) {
        const b = gp.buttons[i];
        const down = b && (typeof b === "object" ? b.pressed : b > 0.5);
        if (down) buttons.add(i);
      }
      for (let i = 0; i < gp.axes.length; i++) {
        const v = gp.axes[i];
        if (v >  AXIS_THRESH) axes.set(i, "+1");
        else if (v < -AXIS_THRESH) axes.set(i, "-1");
      }
    }
    return { buttons, axes };
  }

  function axisLabelFor(axisIndex, dir) {
    const name = axisIndex < AXIS_NAMES.length
      ? AXIS_NAMES[axisIndex]
      : `EXTRA_STICK_${axisIndex}`;
    return `${name}:${dir}`;
  }

  function startGamepadCapture(action, btn) {
    const valEl = btn.querySelector(".bindings-pill__value");
    capture = {
      kind: "gp", action, btn,
      previousLabel: valEl?.textContent || "",
      rafId: 0,
      baseline: null,   // null until first frame; set to snapshotPadState()
    };
    btn.classList.add("is-capturing");
    if (valEl) valEl.textContent = "Press a button…";
    setStatus("Press any button or D-pad / stick direction. Esc to cancel.", "info");
    // gamepad-nav.js checks this flag and steps off the pad while
    // capturing. Without it B/Circle (its default "close modal") would
    // never be available as a binding candidate.
    window.__retroxRebindCapture = true;

    function finish(label) {
      const c = capture;
      capture = null;
      window.__retroxRebindCapture = false;
      c.btn.classList.remove("is-capturing");
      commitGamepad(action, label, c.btn);
    }

    const tick = () => {
      if (!capture || capture.kind !== "gp" || capture.btn !== btn) return;
      const now = snapshotPadState();
      if (capture.baseline === null) {
        capture.baseline = now;
      } else {
        for (const idx of now.buttons) {
          if (!capture.baseline.buttons.has(idx) && idx in BUTTON_INDEX_TO_LABEL) {
            return finish(BUTTON_INDEX_TO_LABEL[idx]);
          }
        }
        for (const [idx, dir] of now.axes) {
          if (capture.baseline.axes.get(idx) !== dir) {
            return finish(axisLabelFor(idx, dir));
          }
        }
        // Slide the baseline forward so a return-to-neutral followed
        // by a fresh deflection in the same direction registers as a
        // new press (otherwise the user could only ever bind one
        // direction per axis per capture session).
        capture.baseline = now;
      }
      capture.rafId = requestAnimationFrame(tick);
    };
    capture.rafId = requestAnimationFrame(tick);
  }

  function startKeyboardCapture(action, btn) {
    const valEl = btn.querySelector(".bindings-pill__value");
    capture = {
      kind: "kb", action, btn,
      previousLabel: valEl?.textContent || "",
    };
    btn.classList.add("is-capturing");
    if (valEl) valEl.textContent = "Press a key…";
    setStatus("Press a key. Esc to cancel.", "info");
  }

  function onKeyDown(e) {
    if (!capture) return;
    if (e.code === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const c = capture;
      clearCapture(true);
      setStatus("Cancelled.", "info");
      // Re-render the pill with its prior value (may have been a "..."
      // capture-prompt label).
      refreshPill(c.btn, c.action, c.kind);
      return;
    }
    if (capture.kind !== "kb") return;
    // Bare modifiers don't count — wait for an actual key.
    if (["ShiftLeft","ShiftRight","ControlLeft","ControlRight",
         "AltLeft","AltRight","MetaLeft","MetaRight"].includes(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    const c = capture;
    capture = null;
    c.btn.classList.remove("is-capturing");
    commitKeyboard(c.action, e.code, c.btn);
  }

  /* ---------- Wiring ---------- */

  function wireEvents() {
    container.querySelectorAll(".bindings-pill[data-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        // Drop focus so a controller A-press (which gamepad-nav routes
        // to activeElement.click()) can't re-trigger this pill while
        // we're still in the "wait for release" gate.
        btn.blur();
        if (capture && capture.btn !== btn) clearCapture(true);
        if (capture && capture.btn === btn) return;
        const action = btn.dataset.action;
        const col = btn.dataset.col;
        if (col === "gp") startGamepadCapture(action, btn);
        else              startKeyboardCapture(action, btn);
      });
    });

    const restoreBtn = container.querySelector('[data-action-id="restore"]');
    restoreBtn?.addEventListener("click", onRestore);
  }

  async function onRestore() {
    if (capture) clearCapture(true);
    const ok = await modal.confirm({
      title: "Restore default bindings?",
      body: "All controller and keyboard bindings will return to their factory defaults. Other preferences are unaffected.",
      confirmLabel: "Restore",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.put("/profile/preferences", {
        data: { gamepad_bindings: {}, keyboard_bindings: {} },
      });
      for (const k of Object.keys(stored.gamepad))  delete stored.gamepad[k];
      for (const k of Object.keys(stored.keyboard)) delete stored.keyboard[k];
      if (liveApply) {
        for (const a of ACTIONS) {
          if (a.group !== "in-game") continue;
          applyGamepadLive(a.key, GAMEPAD_DEFAULTS[a.key]);
          applyKeyboardLive(a.key, KEYBOARD_DEFAULTS[a.key]);
        }
      }
      container.querySelectorAll(".bindings-pill[data-action]").forEach(p =>
        refreshPill(p, p.dataset.action, p.dataset.col));
      setStatus("Defaults restored.", "ok");
      toast.success?.("Defaults restored", "Controller and keyboard bindings reset.");
    } catch (err) {
      toast.fromError?.(err, "Couldn't restore defaults");
    }
  }

  /* ---------- Initial load ---------- */

  (async function init() {
    let prefs = {};
    try { prefs = await api.get("/profile/preferences"); } catch { prefs = {}; }
    if (destroyed) return;
    Object.assign(stored.keyboard, prefs.keyboard_bindings || {});
    Object.assign(stored.gamepad,  prefs.gamepad_bindings  || {});
    fullRender();
    document.addEventListener("keydown", onKeyDown, true);
    detachKeyListener = () => document.removeEventListener("keydown", onKeyDown, true);
    detectionRaf = requestAnimationFrame(pollPad);
  })();

  /* ---------- Teardown ---------- */

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (capture) clearCapture(false);
      window.__retroxRebindCapture = false;
      detachKeyListener?.();
      if (detectionRaf) cancelAnimationFrame(detectionRaf);
      container.classList.remove("bindings-mount");
    },
  };
}
