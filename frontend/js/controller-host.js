/* controller-host.js — runs on /play, applies phone-controller input to
 * the live emulator.
 *
 * This module is intentionally self-contained: it never reads or writes
 * any of play.js's variables, never modifies an existing DOM node, and
 * never touches EmulatorJS internals. Its only outbound dependency is
 * the public `EJS_emulator.gameManager.simulateInput(...)` API — the
 * same surface play.js already uses to mirror the analog stick onto
 * the D-pad.
 *
 * Lifecycle:
 *   1. Inject a "Pair phone" pill into the player chrome on load.
 *   2. On click → POST /api/controller/start, render a modal with the
 *      QR + 6-character code, open the host WebSocket.
 *   3. While the WS is open, every {t:"d"|"u",b} message becomes a
 *      simulateInput call. Analog axes ("ax") drive the libretro
 *      analog-stick slots so 3D games (N64/PSX) feel right.
 *   4. On WS close (host nav-away, server timeout, etc.), the modal
 *      tears down and the next click on the pill starts a fresh pairing.
 *
 * No state is persisted across page loads — pairing is a transient
 * session and reloading is the simplest reset. */

import { api } from "./api.js";
import { toast } from "./toast.js";
import { loadVendorScript } from "./util.js";

const PAIR_BUTTON_ID = "controller-pair-btn";
const MODAL_ID = "controller-pair-modal";

// Maps the EmulatorJS core name (the only system identifier reliably
// available at this layer — set by play.js as window.EJS_core) to a
// short label the pad UI uses to choose a button layout.
//
// We list the bundled cores plus the most common alternates an admin
// might add via Admin → Emulators. Unknown cores fall through to "" —
// the pad's DEFAULT_LAYOUT shows every button, which is a safe
// overshoot (the user can ignore X/Y if the system doesn't have them).
const CORE_TO_SYSTEM = {
  // Bundled with the image (see backend/app/main.py: DEFAULT_EMULATORS)
  gambatte:          "gb",     // Game Boy / Game Boy Color
  mgba:              "gba",    // Game Boy Advance
  pcsx_rearmed:      "psx",    // PlayStation
  mupen64plus_next:  "n64",    // Nintendo 64

  // Common community cores admins typically add
  fceumm:            "nes",    // NES (FCEUmm)
  nestopia:          "nes",
  snes9x:            "snes",   // SNES (Snes9x)
  snes9x2002:        "snes",
  snes9x2010:        "snes",
};

// Libretro analog-stick slot indices (mirrors DPAD_TO_LEFT_STICK_SLOT in
// play.js). simulateInput on these drives the left analog stick.
const STICK_LEFT  = 17;  // LEFT_STICK_X:-1
const STICK_RIGHT = 16;  // LEFT_STICK_X:+1
const STICK_UP    = 19;  // LEFT_STICK_Y:-1
const STICK_DOWN  = 18;  // LEFT_STICK_Y:+1

const STICK_THRESHOLD = 0.35;

/* ---------- Bootstrap ---------- */

// Wait for the emulator instance to come online. play.js already owns
// `window.EJS_emulator` (with a setter trap that wires its persistor),
// so we can't install a competing trap here. Polling is fine — this
// runs once at startup, not on every frame.
function waitForEmulator(maxMs = 60_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const sim = window.EJS_emulator?.gameManager?.simulateInput;
      if (typeof sim === "function") return resolve(window.EJS_emulator);
      if (Date.now() - start > maxMs) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function detectSystem() {
  const core = (window.EJS_core || "").toString().toLowerCase();
  return CORE_TO_SYSTEM[core] || "";
}

/* ---------- Fullscreen relocation ---------- */
/* The CSS Fullscreen Spec only paints the fullscreen element and its
 * descendants — a button on <body> goes invisible the moment EJS
 * fullscreens its inner #game (via the toolbar's fullscreen button).
 *
 * play.js's playerChrome.relocate() already handles this for the back
 * button, sync indicator, and play hint. Rather than replicate its
 * pillsHome() policy here (and risk drifting from it), we just FOLLOW
 * the sync pill's parent: wherever the Sync button currently lives is
 * exactly where the Phone button belongs. */

const FS_EVENTS = [
  "fullscreenchange", "webkitfullscreenchange",
  "mozfullscreenchange", "MSFullscreenChange",
];

/** Keep `el` parented next to the Sync indicator. Falls back to <body>
 *  when the sync pill isn't mounted yet. Returns a teardown function. */
function followSyncPillParent(el) {
  const relocate = () => {
    const sync = document.querySelector(".player__status");
    const target = sync?.parentNode || document.body;
    if (el.parentNode !== target) target.appendChild(el);
  };
  relocate();
  FS_EVENTS.forEach((evt) => document.addEventListener(evt, relocate));
  return () => FS_EVENTS.forEach((evt) => document.removeEventListener(evt, relocate));
}

/* ---------- Pair button ---------- */

function injectPairButton(onClick) {
  if (document.getElementById(PAIR_BUTTON_ID)) return null;

  const btn = document.createElement("button");
  btn.id = PAIR_BUTTON_ID;
  btn.type = "button";
  btn.setAttribute("aria-label", "Pair phone as controller");
  btn.title = "Pair phone as controller";
  btn.innerHTML = `
    <span id="controller-pair-dot" aria-hidden="true"
          style="width:10px;height:10px;border-radius:50%;background:transparent;
                 box-shadow:none;transition:background 160ms ease,box-shadow 200ms ease;
                 display:none;flex-shrink:0"></span>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="6" y="2" width="12" height="20" rx="2.5"/>
      <line x1="12" y1="18" x2="12" y2="18"/>
    </svg>
    <span id="controller-pair-label">Phone</span>
  `;

  // Visual language matches .player__back / .player__status pills (see
  // player.css) — same height, blur, border, dark-with-low-opacity bg.
  // CSS is inline so this module stays drop-in (no player.css edits).
  btn.style.cssText = `
    position: fixed;
    top: 16px;
    z-index: 9999;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font: 500 13px/1 var(--font-ui, system-ui), sans-serif;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    cursor: pointer;
    transition: opacity 200ms ease, background 150ms ease, transform 100ms ease;
  `;
  // Hover-darkens. We deliberately keep the same dark background in the
  // paired state — the green dot is enough signal, and re-tinting the
  // whole pill made it visually inconsistent with the neighboring Sync
  // pill (which never tints).
  btn.addEventListener("mouseenter", () => {
    btn.style.background = "rgba(0, 0, 0, 0.85)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "rgba(0, 0, 0, 0.55)";
  });
  btn.addEventListener("click", onClick);

  // Initial mount on body; followSyncPillParent moves it into the
  // sync pill's current parent immediately and on every fullscreenchange.
  document.body.appendChild(btn);
  followSyncPillParent(btn);

  // Position the pill immediately to the LEFT of the sync indicator
  // (.player__status, top:16px right:16px). The sync pill's width
  // changes as its label rotates ("Syncing…" → "Synced · 12:34" →
  // "Out of sync"), so we re-measure on each layout-affecting event
  // rather than hard-coding an offset. Fallback: 16px from the right
  // edge if the indicator hasn't mounted yet.
  const SPACER_PX = 8;  // gap between Phone and sync pills
  const SAFE_RIGHT = 16;  // mirror the sync pill's own right offset
  function positionRight() {
    const sync = document.querySelector(".player__status");
    if (sync) {
      const rect = sync.getBoundingClientRect();
      // Distance from the viewport's right edge to the sync pill's
      // left edge, plus our spacer. innerWidth - rect.left handles
      // both fullscreen and windowed cases without a special case.
      const right = Math.max(SAFE_RIGHT, window.innerWidth - rect.left + SPACER_PX);
      btn.style.right = `${right}px`;
    } else {
      btn.style.right = `${SAFE_RIGHT}px`;
    }
  }
  positionRight();
  // The sync pill mutates its DOM (text/class changes) and may
  // mount/relocate as the player toggles fullscreen, so observe both.
  const syncEl = document.querySelector(".player__status");
  if (syncEl) {
    new MutationObserver(positionRight).observe(syncEl, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  } else {
    // Fallback: observe body for the sync indicator's late mount.
    const obs = new MutationObserver(() => {
      if (document.querySelector(".player__status")) {
        positionRight();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener("resize", positionRight);

  // Mirror the back button's auto-fade behavior — player.js fades
  // `.player__back` after 3s of pointer idleness. Observe that class
  // as a proxy for "chrome is currently faded" and follow suit.
  const backEl = document.getElementById("back-btn");
  if (backEl) {
    const syncFade = () => {
      const faded = backEl.classList.contains("is-faded");
      btn.style.opacity = faded ? "0" : "1";
      btn.style.pointerEvents = faded ? "none" : "auto";
    };
    new MutationObserver(syncFade).observe(backEl, { attributes: true, attributeFilter: ["class"] });
    syncFade();
  }

  // Inject the paired-state keyframes once (idempotent). The pulse runs
  // once on the transition to "paired" — long-running animation on a
  // status indicator is more annoying than communicative.
  if (!document.getElementById("controller-pair-keyframes")) {
    const style = document.createElement("style");
    style.id = "controller-pair-keyframes";
    style.textContent = `
      @keyframes ctrl-pill-pulse {
        0%   { box-shadow: 0 0 0 0   rgba(52, 211, 153, 0.55); }
        100% { box-shadow: 0 0 0 14px rgba(52, 211, 153, 0);   }
      }
    `;
    document.head.appendChild(style);
  }

  /** Update the pill's paired/active indicator. Called by startSession's
   *  onStateChange so the pill reflects the live session even when the
   *  modal is hidden. The paired state is signalled ONLY by the green
   *  dot — the pill itself stays neutral so it visually matches the
   *  adjacent Sync pill (no border-color or background tinting).
   *
   *  States:
   *    idle    — no session at all (no dot)
   *    pairing — WS open, no pad yet (no dot)
   *    paired  — WS open, ≥1 pad (filled green badge + one-shot pulse)
   */
  const dot = btn.querySelector("#controller-pair-dot");
  const label = btn.querySelector("#controller-pair-label");
  let lastPaired = false;
  function setState({ active, paired }) {
    if (paired) {
      dot.style.display = "inline-block";
      // Crisp filled circle with a soft outer halo. Two-layer
      // box-shadow: inner ring for definition, outer for glow.
      dot.style.background = "#34d399";
      dot.style.boxShadow =
        "0 0 0 1px rgba(52, 211, 153, 0.45)," +
        "0 0 8px rgba(52, 211, 153, 0.45)";
      // One-shot pulse on the transition to draw the eye. Re-triggered
      // by reading offsetWidth between resets so the animation actually
      // restarts when the pill flips from idle → paired multiple times.
      if (!lastPaired) {
        btn.style.animation = "none";
        void btn.offsetWidth;
        btn.style.animation = "ctrl-pill-pulse 800ms ease-out 1";
      }
      btn.title = "Phone connected — click to manage";
      btn.setAttribute("aria-label", "Phone connected — click to manage");
      label.textContent = "Phone connected";
      lastPaired = true;
    } else {
      dot.style.display   = "none";
      btn.style.animation = "none";
      if (active) {
        btn.title = "Pairing in progress — click to view code";
        btn.setAttribute("aria-label", "Pairing in progress");
      } else {
        btn.title = "Pair phone as controller";
        btn.setAttribute("aria-label", "Pair phone as controller");
      }
      label.textContent = "Phone";
      lastPaired = false;
    }
  }
  return { setState };
}

/* ---------- Pairing modal ---------- */

/**
 * Build the pair modal. Two distinct dismissal paths:
 *
 *   onHide       — Close button / backdrop / Escape. Just removes the
 *                  modal from the DOM. The session (WebSocket, paired
 *                  phone) keeps running so the user can play with the
 *                  pad while the modal is out of the way.
 *   onDisconnect — Disconnect button. Tears the whole session down —
 *                  closes the WS, kicks the pad, returns the Phone pill
 *                  to idle. Only shown after `setPaired(true)` because
 *                  before pairing there's nothing to disconnect *from*;
 *                  in that pre-paired state Close = "cancel", which
 *                  also calls onDisconnect.
 */
function buildModal({ code, expiresIn, onHide, onDisconnect }) {
  // Backdrop + card. CSS is inline for the same drop-in reason.
  const wrap = document.createElement("div");
  wrap.id = MODAL_ID;
  wrap.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    font-family: var(--font-ui, system-ui), sans-serif;
    color: #f4f5f8;
    animation: ctrlhost-fade 160ms cubic-bezier(0.2,0.8,0.2,1);
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    width: min(420px, calc(100vw - 32px));
    background: linear-gradient(180deg, #181c24 0%, #11141a 100%);
    border: 1px solid #232834;
    border-radius: 20px;
    padding: 28px;
    box-shadow: 0 28px 80px rgba(0,0,0,0.7);
    text-align: center;
  `;

  card.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:14px">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e5a00d"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="6" y="2" width="12" height="20" rx="2.5"/>
      </svg>
      <h2 style="margin:0;font-size:18px;font-weight:700;letter-spacing:0.005em">Use phone as controller</h2>
    </div>
    <p style="margin:0 0 18px;color:#a8acb6;font-size:13.5px;line-height:1.5">
      Scan the QR or open <span style="color:#f4f5f8;font-weight:600">${escapeText(location.host)}/pair</span> on your phone.
    </p>

    <div id="ctrlhost-qr"
         style="width:212px;height:212px;margin:0 auto 16px;padding:10px;background:#fff;border-radius:14px;display:grid;place-items:center">
      <div style="width:24px;height:24px;border:2px solid #232834;border-top-color:#e5a00d;border-radius:50%;animation:ctrlhost-spin 700ms linear infinite"></div>
    </div>

    <div id="ctrlhost-code"
         style="font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:24px;font-weight:600;letter-spacing:0.4em;padding:8px 0 4px">
      ${escapeText(code)}
    </div>
    <div id="ctrlhost-expires" style="color:#6e7280;font-size:12px;margin-bottom:16px">
      Code expires in ${formatMmSs(expiresIn)}
    </div>

    <div id="ctrlhost-status" role="status" aria-live="polite"
         style="display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 14px;border-radius:12px;background:rgba(168,172,182,0.08);font-size:13px;color:#a8acb6;margin-bottom:14px">
      <span id="ctrlhost-dot" style="width:8px;height:8px;border-radius:50%;background:#a8acb6"></span>
      <span id="ctrlhost-status-text">Waiting for phone…</span>
    </div>

    <div id="ctrlhost-actions" style="display:flex;gap:10px;align-items:stretch">
      <button type="button" id="ctrlhost-close"
              style="flex:1;height:42px;border:1px solid #2f3645;border-radius:999px;background:transparent;color:#f4f5f8;font:600 14px/1 inherit;cursor:pointer;transition:background 120ms ease,border-color 120ms ease">
        Cancel
      </button>
      <button type="button" id="ctrlhost-disconnect" hidden
              style="flex:1;height:42px;border:1px solid rgba(239,68,68,0.4);border-radius:999px;background:rgba(239,68,68,0.06);color:#ef4444;font:600 14px/1 inherit;cursor:pointer;transition:background 120ms ease,color 120ms ease">
        <span style="display:inline-flex;align-items:center;gap:7px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
            <line x1="12" y1="2" x2="12" y2="12"/>
          </svg>
          Disconnect
        </span>
      </button>
    </div>
  `;

  wrap.appendChild(card);
  document.body.appendChild(wrap);
  // Modal needs the same fullscreen-aware parenting as the Phone pill —
  // otherwise opening pairing while the player is in EJS-toolbar
  // fullscreen would render an invisible (but still focus-trapping)
  // backdrop.
  const stopFollowing = followSyncPillParent(wrap);

  // One-time injection of the keyframes used above. Idempotent.
  if (!document.getElementById("ctrlhost-keyframes")) {
    const style = document.createElement("style");
    style.id = "ctrlhost-keyframes";
    style.textContent = `
      @keyframes ctrlhost-fade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes ctrlhost-spin { to { transform: rotate(360deg) } }
      #ctrlhost-close:hover { background: rgba(244,245,248,0.06); border-color: #3a4150 }
      #ctrlhost-disconnect:hover { background: rgba(239,68,68,0.16); color: #fff }
    `;
    document.head.appendChild(style);
  }

  // Track whether a pad has joined. Determines what the Close button
  // means semantically: pre-paired = "Cancel" (full disconnect, since
  // there's nothing to leave running), post-paired = "Done" (just hide
  // the modal so the user can play; explicit "Disconnect phone" link
  // exposes the teardown path for that state).
  let isPaired = false;
  const dismissClose = () => (isPaired ? onHide() : onDisconnect());

  const closeBtn = card.querySelector("#ctrlhost-close");
  const disconnectBtn = card.querySelector("#ctrlhost-disconnect");
  closeBtn.addEventListener("click", dismissClose);
  disconnectBtn.addEventListener("click", onDisconnect);
  // Click-on-backdrop dismisses, but only on the backdrop itself — so
  // clicks inside the card don't accidentally close. Same dual semantics
  // as the Close button.
  wrap.addEventListener("click", (e) => { if (e.target === wrap) dismissClose(); });
  // Escape mirrors the Close button for keyboard users.
  const onKey = (e) => { if (e.key === "Escape") dismissClose(); };
  document.addEventListener("keydown", onKey);

  return {
    root: wrap,
    setStatus(text, tone) {
      const dot  = card.querySelector("#ctrlhost-dot");
      const txt  = card.querySelector("#ctrlhost-status-text");
      if (txt) txt.textContent = text;
      if (dot) {
        dot.style.background =
          tone === "ok"      ? "#34d399" :
          tone === "warn"    ? "#f59e0b" :
          tone === "error"   ? "#ef4444" :
                               "#a8acb6";
      }
    },
    setExpires(text) {
      const el = card.querySelector("#ctrlhost-expires");
      if (el) el.textContent = text;
    },
    setQrSvg(svg) {
      const el = card.querySelector("#ctrlhost-qr");
      if (el) el.innerHTML = svg;
    },
    setPaired(paired) {
      // Updates the dismissal semantics + button copy in lockstep:
      //   paired=false → close means "abandon pairing" (Cancel)
      //   paired=true  → close means "I'll play now" (Done); explicit
      //                  Disconnect link is exposed for the teardown
      isPaired = !!paired;
      closeBtn.textContent = isPaired ? "Done" : "Cancel";
      disconnectBtn.hidden = !isPaired;
    },
    destroy() {
      document.removeEventListener("keydown", onKey);
      stopFollowing();
      wrap.remove();
    },
  };
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function formatMmSs(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------- WebSocket session ---------- */

function wsUrlFor(path) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

/** Module-level handle to the currently active session (or null).
 *  Used by the Phone pill click handler to re-open the modal instead
 *  of starting a fresh pairing every time the user wants to peek at
 *  the connection state. */
let activeSession = null;

function startSession({ token, code, expiresIn, system, onStateChange }) {
  let modal = null;
  let ws = null;
  let countdownTimer = null;
  let expiresAt = Date.now() + expiresIn * 1000;
  // Cached QR SVG so when the user hides+re-opens the modal we don't
  // have to reload qrcode.js or re-encode the URL.
  let qrSvg = null;
  // Set the moment disconnect() runs — used by the WS close handler
  // to swallow the resulting close event and suppress a spurious toast.
  let disconnected = false;
  // Track pad-state pushes locally so the modal and Phone pill can
  // both reflect the same truth. 0 = unpaired, 1+ = paired.
  let padCount = 0;
  // Held buttons we issued to the emulator. Used as a safety net: if
  // the WS dies and the server's release-on-disconnect somehow doesn't
  // reach us, we still release everything locally on disconnect.
  const heldButtons = new Set();
  // Last analog axis state we sent to simulateInput so we can release
  // direction stick slots cleanly if disconnect lands mid-stick-tilt.
  const stickHeld = { left: false, right: false, up: false, down: false };

  /** Hide the modal but keep the WebSocket alive — the user wants to
   *  play. The Phone pill stays visible (with a paired indicator if
   *  applicable) so they can re-open the modal later. */
  function hideModal() {
    if (!modal) return;
    modal.destroy();
    modal = null;
  }

  /** Show (or re-show) the modal with the current session state. */
  function showModal() {
    if (modal) return;  // already visible
    modal = buildModal({
      code,
      expiresIn,
      onHide: hideModal,
      onDisconnect: () => disconnect("host-end"),
    });
    // Re-populate the freshly-built modal with whatever state we know.
    if (qrSvg) modal.setQrSvg(qrSvg);
    applyPadCountToModal();
    applyExpiresToModal();
  }

  function applyPadCountToModal() {
    if (!modal) return;
    if (padCount <= 0) {
      modal.setStatus("Waiting for phone…", "");
    } else if (padCount === 1) {
      modal.setStatus("Phone connected — playing.", "ok");
    } else {
      modal.setStatus(`${padCount} phones connected.`, "ok");
    }
    modal.setPaired(padCount > 0);
  }

  function applyExpiresToModal() {
    if (!modal) return;
    const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    modal.setExpires(remaining > 0
      ? `Code expires in ${formatMmSs(remaining)}`
      : "Code expired");
    if (remaining === 0 && padCount === 0) {
      modal.setStatus("Code expired — close and try again.", "warn");
    }
  }

  /** Tear down the entire session: close WS, release inputs, destroy
   *  modal, clear timers. After this, `activeSession` is reset to null
   *  and the Phone pill returns to idle. */
  function disconnect(reason) {
    if (disconnected) return;
    disconnected = true;

    // Release any held inputs locally — simulateInput is idempotent so
    // double-releasing (server-side AND here) is harmless.
    const gm = window.EJS_emulator?.gameManager;
    if (gm && typeof gm.simulateInput === "function") {
      for (const b of heldButtons) gm.simulateInput(0, b, 0);
      if (stickHeld.left)  gm.simulateInput(0, STICK_LEFT,  0);
      if (stickHeld.right) gm.simulateInput(0, STICK_RIGHT, 0);
      if (stickHeld.up)    gm.simulateInput(0, STICK_UP,    0);
      if (stickHeld.down)  gm.simulateInput(0, STICK_DOWN,  0);
    }
    heldButtons.clear();

    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (ws) {
      // Pass 1000 explicitly. Without a code, the close frame carries no
      // status and the close event reports 1005 ("no status received"),
      // which would look indistinguishable from an unclean shutdown.
      try { ws.close(1000, "user closed"); } catch { /* already closed */ }
      ws = null;
    }
    hideModal();
    activeSession = null;
    onStateChange?.({ active: false, paired: false });
    if (reason === "host-end") {
      // No toast — the user explicitly clicked Cancel/Disconnect.
      return;
    }
    if (reason === "expired") {
      toast.info?.("Phone controller", "Pairing code expired.");
    }
  }

  // Expose the handle so injectPairButton's click handler can re-open
  // the modal without spawning a new pairing.
  activeSession = { showModal, disconnect, isActive: () => !disconnected };

  showModal();

  // Async render the QR. Failure is non-fatal — the manual code is
  // visible immediately and is a valid alternative. Cached on `qrSvg`
  // so re-opening the modal doesn't trigger a fresh load.
  (async () => {
    try {
      await loadVendorScript("/js/vendor/qrcode.js");
      const url = `${location.origin}/pair?code=${encodeURIComponent(code)}`;
      const qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
      qrSvg = qr.createSvgTag({ cellSize: 5, margin: 1 });
    } catch {
      qrSvg = `<div style="color:#6e7280;font-size:12px;padding:24px;text-align:center">Couldn't render the QR.<br/>Use the code below.</div>`;
    }
    modal?.setQrSvg(qrSvg);
  })();

  countdownTimer = setInterval(() => {
    applyExpiresToModal();
    const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    if (remaining === 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 1000);

  // Open the host WebSocket. It carries the secret token and is
  // cookie-authenticated — same-origin only.
  ws = new WebSocket(wsUrlFor(`/api/controller/host?token=${encodeURIComponent(token)}`));

  ws.addEventListener("open", () => {
    // Tell the server which system this game is so pads pick the right
    // layout. Cached on the room — pads joining late get this for free.
    if (system) ws.send(JSON.stringify({ t: "layout", system }));
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    // Server-pushed state — the room composition changed. We use this
    // (rather than inferring from inbound input) so the modal flips to
    // "Connected" the instant the pad joins, not on first button press.
    if (msg.t === "pad-state") {
      padCount = Number(msg.count) || 0;
      applyPadCountToModal();
      // Tell the Phone pill to update its visual state (green dot when
      // paired, gray when waiting). The pill stays mounted regardless
      // of whether the modal is open.
      onStateChange?.({ active: true, paired: padCount > 0 });
      return;
    }

    applyPadMessage(msg, heldButtons, stickHeld);
  });

  ws.addEventListener("close", (ev) => {
    // If disconnect() has already run locally (user clicked
    // Cancel/Disconnect, etc.), the inbound close event is just our
    // own close frame coming back — silently swallow it. Otherwise
    // the user would see a spurious "unexpected" toast on every clean
    // exit.
    if (disconnected) return;

    // Server-side close codes (see backend/app/routers/controller.py):
    //   4400 missing token   4401 unauthenticated   4403 origin
    //   4404 unknown/expired 4409 host not ready    4429 rate limited
    // 1000/1001 are normal closures. 1005 means "no status code" — the
    // peer closed without one. 1006 means the WS dropped without a
    // close frame (network blip / server crash).
    if (ev.code !== 1000 && ev.code !== 1001) {
      console.warn("[controller-host] WS closed", ev.code, ev.reason);
    }
    if (ev.code === 1000 || ev.code === 1001 || ev.code === 1005) {
      disconnect("host-end");
    } else if (ev.code === 4404) {
      disconnect("expired");
    } else if (ev.code === 4401) {
      disconnect("error");
      toast.error?.("Phone controller", "Sign-in expired — refresh and try again.");
    } else if (ev.code === 4403) {
      disconnect("error");
      toast.error?.("Phone controller", "Cross-origin connection refused.");
    } else {
      disconnect("error");
      const detail = ev.reason ? ` (${ev.reason})` : ` (code ${ev.code})`;
      toast.error?.("Phone controller", `Connection closed unexpectedly${detail}.`);
    }
  });

  ws.addEventListener("error", () => {
    // The "close" handler handles cleanup; "error" alone means the
    // socket failed to reach an open state. Surface that distinctly.
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      disconnect("error");
      toast.error?.("Phone controller", "Couldn't open the controller channel.");
    }
  });
}

function applyPadMessage(msg, heldButtons, stickHeld) {
  const gm = window.EJS_emulator?.gameManager;
  if (!gm || typeof gm.simulateInput !== "function") return;

  if (msg.t === "d" || msg.t === "u") {
    const b = Number(msg.b);
    if (!Number.isInteger(b) || b < 0 || b > 11) return;
    const value = msg.t === "d" ? 1 : 0;
    gm.simulateInput(0, b, value);
    if (value) heldButtons.add(b); else heldButtons.delete(b);
    return;
  }

  if (msg.t === "ax") {
    const x = Number(msg.x) || 0;
    const y = Number(msg.y) || 0;
    setStick("left",  STICK_LEFT,  x < -STICK_THRESHOLD, gm, stickHeld);
    setStick("right", STICK_RIGHT, x >  STICK_THRESHOLD, gm, stickHeld);
    setStick("up",    STICK_UP,    y < -STICK_THRESHOLD, gm, stickHeld);
    setStick("down",  STICK_DOWN,  y >  STICK_THRESHOLD, gm, stickHeld);
  }
}

function setStick(name, slot, isDown, gm, stickHeld) {
  if (stickHeld[name] === isDown) return;
  stickHeld[name] = isDown;
  gm.simulateInput(0, slot, isDown ? 1 : 0);
}

/* ---------- Pair-button click handler ---------- */

/** Click handler is bound after `injectPairButton` returns the pill
 *  handle, so we can pass `pillHandle.setState` straight through to
 *  the new session as its `onStateChange` callback. */
function makePairClickHandler(pillHandle) {
  return async function onPairClick() {
    // Already paired or pairing — re-show the existing modal instead
    // of starting a fresh /start (which would invalidate the live code
    // and kick the connected pad).
    if (activeSession?.isActive()) {
      activeSession.showModal();
      return;
    }
    // If a modal is already on screen for some reason (race window
    // between activeSession being null and DOM cleanup), just no-op.
    if (document.getElementById(MODAL_ID)) return;

    let session;
    try {
      session = await api.post("/controller/start", {});
    } catch (err) {
      toast.fromError?.(err, "Couldn't start phone pairing");
      return;
    }

    pillHandle.setState({ active: true, paired: false });
    startSession({
      token:     session.token,
      code:      session.code,
      expiresIn: session.expires_in,
      system:    detectSystem(),
      onStateChange: (s) => pillHandle.setState(s),
    });
  };
}

/* ---------- Init ---------- */

(async function init() {
  // The host module is loaded on /play.html (player-page body class) AND
  // /game.html (where game.js mounts a .player-host overlay in-place
  // after the user clicks Play). On /game.html the overlay only appears
  // post-click, so wait for it before doing anything visible — without
  // this guard the pair button would float on the game-detail page
  // before the player even existed.
  const onPlayer =
    document.body.classList.contains("player-page") ||
    document.querySelector(".player-host") !== null;

  if (!onPlayer) {
    // Wait — at most until the user navigates away — for the in-place
    // player to be mounted by game.js. Single-shot observer; disconnects
    // the moment a .player-host appears.
    await new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (document.querySelector(".player-host")) {
          obs.disconnect();
          resolve();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  const emu = await waitForEmulator();
  if (!emu) return;  // gave up waiting; emulator never came online

  // The click handler needs the pill's setState method, but
  // injectPairButton wants to know the click handler at injection time.
  // Resolve the chicken-and-egg via a deferred reference: inject with
  // a thunk that calls the as-yet-undefined handler, then assign it.
  let clickHandler;
  const pillHandle = injectPairButton(() => clickHandler?.());
  clickHandler = makePairClickHandler(pillHandle);
})();
