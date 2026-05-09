/* pair.js — phone-as-controller front-end.
 *
 * Three states:
 *
 *   1. ENTRY      — no code in URL. Show an input + helper text.
 *   2. CONNECTING — POSTed lookup, opening WS.
 *   3. LIVE       — paired; the controller pad is on screen.
 *
 * Why not a router framework: the page has three states, each owns its
 * own DOM tree, and the transitions are not stack-like. A 25-line state
 * machine is clearer than wiring up a router.
 *
 * Touch model: pointerdown / pointerup / pointercancel only. Each
 * interactive button captures the pointer it was first pressed by
 * (`setPointerCapture`) so a sliding finger that left the button still
 * fires its `pointerup`/`pointercancel` on the original element. This
 * is what prevents the classic "stuck button on swipe" bug.
 *
 * Held buttons are released defensively on visibilitychange/pagehide
 * AND on the WS close handler — three layers because phone browsers
 * vary in what events they fire when the user pulls down notification
 * shade or switches apps. */

import { api } from "./api.js";
import { applyEarly } from "./theme.js";

applyEarly();

document.title = "Controller · RetroX";

const root = document.getElementById("pair-root");

/* ---------- Auth gate ---------- */

try {
  await api.get("/auth/me");
} catch {
  // Bounce through /login then back here. Same pattern as link.js so
  // this page works as a standalone QR target even on a phone that
  // hasn't been signed in yet. The user's profile isn't needed beyond
  // this gate — the WS upgrade is cookie-authed end-to-end.
  const next = encodeURIComponent(location.pathname + location.search);
  location.href = `/login?next=${next}`;
  throw new Error("not signed in");
}

/* ---------- EmulatorJS slot indices ---------- */
/* These match EmulatorJS's own virtual-gamepad mapping in
 * docker/emulatorjs/src/emulator.js — the visual "A" on EJS's pad
 * sends input_value 8, "B" sends 0, "X" sends 9, "Y" sends 1.
 *
 * Why this differs from play.js's GAME_INPUT_TO_EJS_SLOT (which has
 * game_a: 0, game_b: 8): play.js binds keyboard *keys* under labels
 * users can rebind ("which key fires my A button?"). The phone pad
 * doesn't rebind — its visual labels are the contract, and they have
 * to match what the rest of EJS already calls A/B/X/Y or pressing
 * the red "A" button on the pad would fire NES B in-game. (We
 * verified this against the EJS source — same convention as the
 * built-in virtual gamepad and as physical Xbox/SNES controllers.)
 */
const BTN = {
  A:      8,
  Y:      1,
  SELECT: 2,
  START:  3,
  UP:     4,
  DOWN:   5,
  LEFT:   6,
  RIGHT:  7,
  B:      0,
  X:      9,
  L1:     10,
  R1:     11,
};

/* Which buttons (besides D-pad + SELECT/START) each system surfaces.
   Anything not in this list is hidden — keeps the pad uncluttered for
   2-button consoles. Unknown systems fall back to "all". */
const SYSTEM_LAYOUT = {
  gb:   { face: "ab",  shoulders: false },
  gbc:  { face: "ab",  shoulders: false },
  nes:  { face: "ab",  shoulders: false },
  gba:  { face: "ab",  shoulders: true  },
  snes: { face: "abxy", shoulders: true },
  psx:  { face: "abxy", shoulders: true },
  n64:  { face: "abxy", shoulders: true },
};
const DEFAULT_LAYOUT = { face: "abxy", shoulders: true };

/* ---------- WebSocket plumbing ---------- */

function wsUrlFor(path) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

let socket = null;
let wakeLockSentinel = null;
let layoutApplied = "";

const heldButtons = new Set();   // libretro slot indices currently down

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function pressDown(button) {
  if (heldButtons.has(button)) return;
  heldButtons.add(button);
  send({ t: "d", b: button });
  hapticTap();
}

function pressUp(button) {
  if (!heldButtons.has(button)) return;
  heldButtons.delete(button);
  send({ t: "u", b: button });
}

function releaseAll() {
  for (const b of heldButtons) send({ t: "u", b });
  heldButtons.clear();
}

function hapticTap() {
  // Best-effort, silent failure on iOS Safari (which doesn't implement
  // navigator.vibrate). 14ms is the threshold below which the OS will
  // typically actually fire the linear-resonant motor instead of
  // collapsing it to nothing.
  if (typeof navigator.vibrate === "function") {
    try { navigator.vibrate(14); } catch { /* noop */ }
  }
}

/* ---------- Wake lock ---------- */

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    // If the system releases it (lock-screen, low battery), re-request
    // automatically when the page comes back into focus.
    wakeLockSentinel.addEventListener("release", () => {
      wakeLockSentinel = null;
    });
  } catch {
    // User denied / not in foreground — non-fatal.
    wakeLockSentinel = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    // Phone backgrounded: the OS likely tore the WS down, but even if
    // it didn't, we should release every button so the game doesn't
    // freeze on whatever direction was last pressed.
    releaseAll();
  } else if (document.visibilityState === "visible" && socket && !wakeLockSentinel) {
    requestWakeLock();
  }
});

window.addEventListener("pagehide", releaseAll);

/* ---------- Entry: code form ---------- */

function renderEntry(prefilledCode = "") {
  document.body.classList.remove("is-paired", "is-disconnected");
  root.innerHTML = `
    <div class="pair-shell">
      <div class="pair-card">
        <div class="pair-card__brand">
          <img src="/images/emulator-logo-transparent.png" alt=""/>
          <strong><span class="pair-card__brand-mark">Retro</span>X</strong>
        </div>
        <h1>Use phone as controller</h1>
        <p>Open <strong>Phone</strong> on the device that is playing, then enter the 6-character code shown.</p>

        <form id="pair-form" autocomplete="off" novalidate>
          <input
            class="pair-input"
            id="pair-code"
            type="text"
            inputmode="latin"
            autocapitalize="characters"
            autocorrect="off"
            spellcheck="false"
            maxlength="6"
            placeholder="ABC123"
            value="${escapeHtml(prefilledCode)}"
            required
          />
          <button class="pair-btn" id="pair-submit" type="submit">Connect</button>
          <button class="pair-btn pair-btn--ghost" id="pair-back" type="button">Back to library</button>
        </form>

        <div class="pair-status" id="pair-status" hidden></div>
      </div>
    </div>
  `;

  const form = document.getElementById("pair-form");
  const input = document.getElementById("pair-code");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = (input.value || "").trim().toUpperCase();
    if (code.length === 0) return;
    void connect(code);
  });
  document.getElementById("pair-back").addEventListener("click", () => {
    location.href = "/games";
  });

  // Land focus on the code input so a manual code or a freshly-pasted
  // one is editable immediately. We deliberately do NOT auto-connect
  // here even when the input is prefilled — auto-connect is the
  // caller's intent, controlled at the bootstrap call site below.
  // Re-renders triggered by tear-down (X button, server end, network
  // drop) re-prefill but should NOT loop back into a dead session.
  input.focus({ preventScroll: true });
}

function setEntryStatus(text, tone) {
  const el = document.getElementById("pair-status");
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  el.className = "pair-status" + (tone ? ` pair-status--${tone}` : "");
}

/* ---------- Connecting ---------- */

async function connect(code) {
  setEntryStatus("Looking up code…");
  try {
    await api.get(`/controller/lookup/${encodeURIComponent(code)}`);
  } catch (err) {
    if (err && err.status === 404) {
      setEntryStatus("Code not found — check it's correct and try again.", "error");
    } else {
      setEntryStatus(err?.message || "Couldn't reach the server.", "error");
    }
    return;
  }

  setEntryStatus("Connecting…");
  openSocket(code);
}

function openSocket(code) {
  socket = new WebSocket(wsUrlFor(`/api/controller/pad?code=${encodeURIComponent(code)}`));

  socket.addEventListener("open", () => {
    // The "hello" message will land momentarily; render the live UI
    // immediately so the user sees a snappy transition rather than a
    // second of blank screen while the host's layout broadcast races
    // through the room.
    renderPad(DEFAULT_LAYOUT);
    document.body.classList.add("is-paired");
    void requestWakeLock();
  });

  socket.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === "hello") {
      const layout = SYSTEM_LAYOUT[msg.system] || DEFAULT_LAYOUT;
      applyLayout(layout, msg.system || "");
    } else if (msg.t === "end") {
      // Host left — the room and code are already gone server-side, so
      // do NOT prefill the code on the entry form (a Connect retry
      // would just round-trip a 4404). Show the entry form blank with
      // an explanation instead.
      teardownSocket();
      document.body.classList.remove("is-paired");
      document.body.classList.add("is-disconnected");
      renderEntry();
      setEntryStatus("The other device closed the controller session.", "warn");
    }
  });

  socket.addEventListener("close", (ev) => {
    teardownSocket();
    document.body.classList.remove("is-paired");
    // 1000 = clean close we initiated (X button, navigation away).
    // 1005 = close frame with no status — our own ws.close() with
    // no args produces this; some browsers also surface it on tab
    // sleep. Treat both the same: render the entry form, no error.
    const isCleanClose = ev.code === 1000 || ev.code === 1005;
    if (ev.code === 4404) {
      renderEntry();
      setEntryStatus("Code expired or no longer valid.", "warn");
    } else if (ev.code === 4001) {
      // Server kicked this pad because a newer one connected with the
      // same code. Don't prefill — the user is now on the OTHER phone,
      // not this one, and a re-connect from here would just kick that
      // device in turn. Land them on a clean entry form.
      renderEntry();
      setEntryStatus("Another phone took over this controller.", "warn");
    } else if (ev.code === 4409) {
      renderEntry(code);
      setEntryStatus("That session isn't active yet — make sure the game page is open.", "warn");
    } else if (ev.code === 4401) {
      renderEntry();
      setEntryStatus("Sign-in expired. Please refresh and try again.", "error");
    } else if (isCleanClose) {
      // The user closed the controller intentionally. Show the entry
      // form so they can re-pair if they want to, but do NOT prefill
      // the now-dead code (it would just confuse a follow-up "Connect"
      // press into a 4404 round-trip).
      renderEntry();
    } else {
      document.body.classList.add("is-disconnected");
      renderEntry(code);
      setEntryStatus("Connection lost.", "error");
    }
  });

  socket.addEventListener("error", () => {
    // close handler covers cleanup — error alone (without close) means
    // the upgrade itself failed mid-flight.
  });
}

function teardownSocket() {
  releaseAll();
  if (socket) {
    // Pass 1000 explicitly — without an argument, the close frame
    // carries no status and both peers' close events surface code
    // 1005 ("no status received"), which is indistinguishable from
    // an unclean shutdown without extra logic. Tagging the close as
    // "user closed" makes the host log readable too.
    try { socket.close(1000, "user closed"); } catch { /* already closed */ }
    socket = null;
  }
  if (wakeLockSentinel) {
    try { wakeLockSentinel.release(); } catch { /* noop */ }
    wakeLockSentinel = null;
  }
}

/* ---------- Live pad ---------- */

function renderPad(layout) {
  layoutApplied = "";
  document.body.classList.add("is-paired");
  root.innerHTML = `
    <div class="pad-rotate-hint" aria-hidden="true">
      <div>
        <div style="font-size:18px;font-weight:600;margin-bottom:6px;color:#f4f5f8">Rotate to landscape</div>
        <div style="font-size:13px">The controller is designed for a horizontal grip.</div>
      </div>
    </div>

    <div class="pad" id="pad" aria-label="Game controller">
      <div class="pad__shoulders pad__shoulders--left">
        <button class="pad-btn-shoulder" data-button="${BTN.L1}" aria-label="L">L</button>
      </div>
      <div class="pad__shoulders pad__shoulders--right">
        <button class="pad-btn-shoulder" data-button="${BTN.R1}" aria-label="R">R</button>
      </div>

      <div class="pad__dpad-wrap">
        <div class="pad__dpad" role="group" aria-label="Direction pad">
          <button class="pad-dpad-btn pad-dpad-btn--up"    data-button="${BTN.UP}"    aria-label="Up">${arrowSvg("up")}</button>
          <button class="pad-dpad-btn pad-dpad-btn--down"  data-button="${BTN.DOWN}"  aria-label="Down">${arrowSvg("down")}</button>
          <button class="pad-dpad-btn pad-dpad-btn--left"  data-button="${BTN.LEFT}"  aria-label="Left">${arrowSvg("left")}</button>
          <button class="pad-dpad-btn pad-dpad-btn--right" data-button="${BTN.RIGHT}" aria-label="Right">${arrowSvg("right")}</button>
        </div>
      </div>

      <div class="pad__face-wrap">
        <div class="pad__face" id="pad-face" role="group" aria-label="Face buttons">
          <button class="pad-face-btn pad-face-btn--y" data-button="${BTN.Y}" aria-label="Y">Y</button>
          <button class="pad-face-btn pad-face-btn--x" data-button="${BTN.X}" aria-label="X">X</button>
          <button class="pad-face-btn pad-face-btn--a" data-button="${BTN.A}" aria-label="A">A</button>
          <button class="pad-face-btn pad-face-btn--b" data-button="${BTN.B}" aria-label="B">B</button>
        </div>
      </div>

      <div class="pad__meta">
        <button class="pad-btn-meta" data-button="${BTN.SELECT}">Select</button>
        <button class="pad-btn-meta" data-button="${BTN.START}">Start</button>
      </div>

      <div class="pad__status" id="pad-status">
        <span class="pad__status-dot"></span>
        <span id="pad-status-text">Connected</span>
      </div>

      <button class="pad__exit" id="pad-exit" type="button" aria-label="Disconnect">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="6" y1="6"  x2="18" y2="18"/>
          <line x1="6" y1="18" x2="18" y2="6"/>
        </svg>
      </button>
    </div>
  `;

  applyLayout(layout, "");
  bindPad();
}

function applyLayout(layout, system) {
  // Idempotent — reapply when a layout broadcast lands later.
  const stamp = `${layout.face}|${layout.shoulders ? 1 : 0}|${system}`;
  if (stamp === layoutApplied) return;
  layoutApplied = stamp;

  const face = document.getElementById("pad-face");
  if (!face) return;
  face.dataset.buttons = layout.face;

  const showXY = layout.face === "abxy";
  face.querySelector(".pad-face-btn--x").hidden = !showXY;
  face.querySelector(".pad-face-btn--y").hidden = !showXY;

  const showShoulders = !!layout.shoulders;
  document.querySelectorAll(".pad-btn-shoulder").forEach((b) => { b.hidden = !showShoulders; });

  const txt = document.getElementById("pad-status-text");
  if (txt) {
    txt.textContent = system ? `Connected · ${system.toUpperCase()}` : "Connected";
  }
}

function bindPad() {
  // Single delegated listener per phase. Pointer-capture per button so
  // a finger sliding off a button still produces a clean release.
  const pad = document.getElementById("pad");
  if (!pad) return;

  const buttonOf = (target) => {
    if (!(target instanceof Element)) return null;
    const el = target.closest("[data-button]");
    if (!el) return null;
    const v = Number(el.getAttribute("data-button"));
    return Number.isInteger(v) ? { el, btn: v } : null;
  };

  // Two distinct pointer behaviors share this handler set:
  //
  //   FACE / SHOULDER / META buttons: setPointerCapture pins the press
  //     to the originally-touched button so a sliding finger doesn't
  //     accidentally release it. This is what users expect from a real
  //     gamepad — once you start pressing A you keep pressing it
  //     regardless of where on the screen your thumb wanders.
  //
  //   D-PAD arms: NO pointer capture; we track per-pointer state in
  //     activeDpad and on every pointermove we re-check what's under
  //     the finger. Sliding from UP into RIGHT (without lifting) flips
  //     the input UP-up + RIGHT-down on the same gesture — the joystick-
  //     style behavior modern touch controllers have.
  //
  // Both behaviors coexist per-pointer so multi-touch works: one finger
  // on a face button (captured) while another slides across the d-pad
  // doesn't cross-contaminate.
  const activeDpad = new Map();   // pointerId → { el, btn } currently held within d-pad
  const isDpadButton = (el) => el && el.classList && el.classList.contains("pad-dpad-btn");

  pad.addEventListener("pointerdown", (e) => {
    const hit = buttonOf(e.target);
    if (!hit) return;
    e.preventDefault();
    if (isDpadButton(hit.el)) {
      // No setPointerCapture — we want pointermove to fire on whatever
      // element the finger currently overlaps, so we can detect arm
      // changes via document.elementFromPoint below.
      activeDpad.set(e.pointerId, { el: hit.el, btn: hit.btn });
      hit.el.classList.add("is-down");
      pressDown(hit.btn);
    } else {
      // Face / shoulder / meta button: capture so it stays held even
      // if the finger drifts off.
      try { hit.el.setPointerCapture(e.pointerId); } catch { /* polyfill */ }
      hit.el.classList.add("is-down");
      pressDown(hit.btn);
    }
  });

  pad.addEventListener("pointermove", (e) => {
    const active = activeDpad.get(e.pointerId);
    if (!active) return;  // not a d-pad-rooted pointer

    // What's directly under the finger right now? document.elementFromPoint
    // returns the topmost element at viewport coordinates — exactly the
    // primitive we need to detect "you slid into a different button".
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const hit    = buttonOf(target);
    const ontoDpad = hit && isDpadButton(hit.el);

    if (ontoDpad) {
      if (hit.btn === active.btn) return;  // same arm, no change
      // Switched to another d-pad arm: release the old, press the new.
      // Order matters — release first so a game seeing both UP and
      // RIGHT held briefly is the WORST case here, never an unmapped
      // ghost input.
      if (active.el) active.el.classList.remove("is-down");
      pressUp(active.btn);
      active.el  = hit.el;
      active.btn = hit.btn;
      hit.el.classList.add("is-down");
      pressDown(hit.btn);
    } else if (active.btn != null) {
      // Slid OFF every arm (center cap, gap, or off the d-pad entirely).
      // Release whatever was held but keep the entry alive — sliding
      // back IN should reactivate without requiring a fresh tap.
      if (active.el) active.el.classList.remove("is-down");
      pressUp(active.btn);
      active.el  = null;
      active.btn = null;
    }
  });

  const release = (e) => {
    // D-pad pointer ending: release whatever arm (if any) was held.
    const dpadActive = activeDpad.get(e.pointerId);
    if (dpadActive !== undefined) {
      if (dpadActive.btn != null) {
        if (dpadActive.el) dpadActive.el.classList.remove("is-down");
        pressUp(dpadActive.btn);
      }
      activeDpad.delete(e.pointerId);
      return;
    }
    // Face / shoulder / meta pointer ending: pointer capture means the
    // event targets the original button even if the finger moved off,
    // so we can release based on e.target.
    const hit = buttonOf(e.target);
    if (!hit) return;
    hit.el.classList.remove("is-down");
    pressUp(hit.btn);
  };
  pad.addEventListener("pointerup", release);
  pad.addEventListener("pointercancel", release);

  // Mouse-only safety net: a finger leaving the pad surface fires
  // pointerleave (touch fires pointercancel above, which is enough).
  pad.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") release(e);
  });

  document.getElementById("pad-exit").addEventListener("click", () => {
    teardownSocket();
    document.body.classList.remove("is-paired");
    renderEntry();
    setEntryStatus("Disconnected.", "");
  });
}

/* ---------- Helpers ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function arrowSvg(dir) {
  // Single chevron sized to the dpad arm.
  const paths = {
    up:    "M6 14 L12 8 L18 14",
    down:  "M6 10 L12 16 L18 10",
    left:  "M14 6 L8 12 L14 18",
    right: "M10 6 L16 12 L10 18",
  };
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="${paths[dir]}"/>
    </svg>
  `;
}

/* ---------- Bootstrap ---------- */

const initialCode = (new URLSearchParams(location.search).get("code") || "")
  .toUpperCase()
  .slice(0, 6);

renderEntry(initialCode);
// QR-scan flow: the URL carries the code, so the user clearly intends
// to pair right now — kick off the connect on their behalf. Manual
// re-renders (after tear-down) reach this file via the in-page state
// machine, NOT a fresh document load, so they don't re-trigger this.
if (initialCode.length === 6) {
  void connect(initialCode);
}
