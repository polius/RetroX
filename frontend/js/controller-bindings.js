/* controller-bindings.js — runs on /play (and /game's in-app player
 * overlay). Surfaces a "Controls" pill left of the Phone pill, lights
 * up green when a physical gamepad is detected, and opens the bindings
 * dialog on click. The pill covers BOTH keyboard and gamepad bindings,
 * which is why the label is "Controls" and not "Controller".
 *
 * The bindings UI itself lives in bindings-ui.js — both this dialog
 * and the /profile/Controls page share that module so the two surfaces
 * stay in lockstep.
 *
 * Lifecycle (mirrors controller-host.js so the two pills feel like
 * siblings):
 *   1. Wait for the .player-host overlay (covers both /play.html and
 *      the in-place /game flow where game.js mounts it post-Play).
 *   2. Inject a self-contained inline-styled pill — no player.css
 *      changes needed for the chrome itself.
 *   3. Poll navigator.getGamepads() to keep the dot + label honest.
 *      Polling (rather than relying on gamepadconnected) catches the
 *      case where the browser had already granted gamepad visibility
 *      before this module loaded — same gotcha gamepad-nav.js documents.
 *   4. On click → open the bindings dialog. */

import { modal } from "./toast.js";
import { mountBindings } from "./bindings-ui.js";

const PILL_ID = "controller-bindings-btn";
const KEYFRAMES_ID = "controller-bindings-keyframes";

/* ---------- One-time keyframes ---------- */

function ensureKeyframes() {
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement("style");
  style.id = KEYFRAMES_ID;
  style.textContent = `
    @keyframes ctrlbind-pulse {
      0%   { box-shadow: 0 0 0 0   rgba(52, 211, 153, 0.55); }
      100% { box-shadow: 0 0 0 14px rgba(52, 211, 153, 0);   }
    }
  `;
  document.head.appendChild(style);
}

/* ---------- Fullscreen-aware re-parenting ----------
 *
 * We follow the sync pill (.player__status), the same anchor controller-
 * host.js uses for the Phone pill. play.js's playerChrome mounts the
 * sync pill into `pillsHome()` — the current fullscreen element if any,
 * else .player-host — and re-parents it on every fullscreenchange. By
 * matching parents we land in the same stacking subtree, which is the
 * one that actually renders under the CSS Fullscreen Spec.
 *
 * Two cases need handling:
 *
 *   1. Sync pill ALREADY mounted at injection time (the standalone
 *      /play.html flow, where play.js has long since run). One initial
 *      relocate() picks it up; subsequent fullscreenchange events keep
 *      us in sync.
 *
 *   2. Sync pill NOT YET mounted (the in-place /game flow, where this
 *      module's init resolves the moment .player-host appears, BEFORE
 *      play.js has done its boot awaits and constructed SaveIndicator).
 *      The initial relocate() falls back to body — but body is OUTSIDE
 *      the fullscreen subtree once .player-host is fullscreened, so the
 *      pill silently disappears. The one-shot MutationObserver fixes
 *      this: it fires the moment .player__status mounts and triggers a
 *      fresh relocate that lands us next to it. */

const FS_EVENTS = [
  "fullscreenchange", "webkitfullscreenchange",
  "mozfullscreenchange", "MSFullscreenChange",
];

function followSyncPillParent(el) {
  const relocate = () => {
    const sync = document.querySelector(".player__status");
    const target = sync?.parentNode || document.body;
    if (el.parentNode !== target) target.appendChild(el);
  };
  relocate();
  FS_EVENTS.forEach((evt) => document.addEventListener(evt, relocate));
  // Late-mount catch: if the sync pill hasn't been constructed yet,
  // observe body until it appears, then relocate once and disconnect.
  if (!document.querySelector(".player__status")) {
    const obs = new MutationObserver(() => {
      if (document.querySelector(".player__status")) {
        relocate();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
}

/* ---------- The pill ---------- */

function injectPill(onClick) {
  if (document.getElementById(PILL_ID)) return null;
  ensureKeyframes();

  const btn = document.createElement("button");
  btn.id = PILL_ID;
  btn.type = "button";
  btn.setAttribute("aria-label", "Controls");
  btn.title = "Controls";
  // Label stays "Controls" regardless of connection state — this pill
  // covers BOTH keyboard and controller bindings, so the name reflects
  // the breadth. The green dot is the connection indicator.
  btn.innerHTML = `
    <span id="ctrlbind-dot" aria-hidden="true"
          style="width:10px;height:10px;border-radius:50%;background:transparent;
                 box-shadow:none;transition:background 160ms ease,box-shadow 200ms ease;
                 display:none;flex-shrink:0"></span>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 11h2M7 10v2"/>
      <circle cx="15" cy="10.5" r="0.6" fill="currentColor"/>
      <circle cx="17" cy="12" r="0.6" fill="currentColor"/>
      <path d="M7 7h10a4 4 0 0 1 4 4v2.5a3 3 0 0 1-5.5 1.7L13.5 13h-3l-2 2.2A3 3 0 0 1 3 13.5V11a4 4 0 0 1 4-4Z"/>
    </svg>
    <span id="ctrlbind-label">Controls</span>
  `;

  // Match .player__back / .player__status / Phone pill exactly. Inline
  // so the pill is drop-in (no player.css edits required).
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
  btn.addEventListener("mouseenter", () => { btn.style.background = "rgba(0, 0, 0, 0.85)"; });
  btn.addEventListener("mouseleave", () => { btn.style.background = "rgba(0, 0, 0, 0.55)"; });
  btn.addEventListener("click", onClick);

  document.body.appendChild(btn);
  followSyncPillParent(btn);

  /* Right offset: sit immediately to the LEFT of the Sync pill, with a
   * small spacer. The Sync pill mutates width as its label rotates
   * ("Syncing…" → "Synced · 12:34" → "Out of sync"), so we re-measure
   * on each layout-affecting event rather than hard-coding an offset.
   * Fallback: 16px from the right edge if the sync indicator hasn't
   * mounted yet (Profile-mode and a brief window during player boot). */
  const SPACER_PX = 8;
  const SAFE_RIGHT = 16;
  function positionRight() {
    const sync = document.querySelector(".player__status");
    if (sync) {
      const rect = sync.getBoundingClientRect();
      btn.style.right = `${Math.max(SAFE_RIGHT, window.innerWidth - rect.left + SPACER_PX)}px`;
    } else {
      btn.style.right = `${SAFE_RIGHT}px`;
    }
  }
  positionRight();

  // Watch the Sync pill (and its late mount) for layout-affecting
  // changes. play.js's SaveIndicator mounts it after the top-level
  // boot awaits, which can land after our pill is already injected.
  const syncEl = document.querySelector(".player__status");
  if (syncEl) {
    new MutationObserver(positionRight).observe(syncEl, {
      attributes: true, childList: true, subtree: true, characterData: true,
    });
  } else {
    const obs = new MutationObserver(() => {
      const fresh = document.querySelector(".player__status");
      if (fresh) {
        positionRight();
        new MutationObserver(positionRight).observe(fresh, {
          attributes: true, childList: true, subtree: true, characterData: true,
        });
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener("resize", positionRight);

  // Mirror the back button's auto-fade. Hidden chrome shouldn't
  // intercept clicks.
  const backEl = document.getElementById("back-btn");
  if (backEl) {
    const syncFade = () => {
      const faded = backEl.classList.contains("is-faded");
      btn.style.opacity = faded ? "0" : "1";
      btn.style.pointerEvents = faded ? "none" : "auto";
    };
    new MutationObserver(syncFade).observe(backEl, {
      attributes: true, attributeFilter: ["class"],
    });
    syncFade();
  }

  const dot = btn.querySelector("#ctrlbind-dot");
  let lastConnected = false;
  function setConnected(connected, padName) {
    if (connected) {
      dot.style.display = "inline-block";
      dot.style.background = "#34d399";
      dot.style.boxShadow =
        "0 0 0 1px rgba(52, 211, 153, 0.45)," +
        "0 0 8px rgba(52, 211, 153, 0.45)";
      if (!lastConnected) {
        // One-shot pulse on rising edge — same treatment as the Phone
        // pill so connected states feel coherent across pills.
        btn.style.animation = "none";
        void btn.offsetWidth;
        btn.style.animation = "ctrlbind-pulse 800ms ease-out 1";
      }
      btn.title = padName ? `Controls · ${padName} connected` : "Controls · controller connected";
      btn.setAttribute("aria-label", "Controls — controller connected");
    } else {
      dot.style.display = "none";
      btn.style.animation = "none";
      btn.title = "Controls";
      btn.setAttribute("aria-label", "Controls");
    }
    lastConnected = connected;
  }
  return { setConnected, element: btn };
}

/* ---------- Detection poll ---------- */

function startDetectionPoll(pillHandle) {
  let last = false;
  const tick = () => {
    if (!navigator.getGamepads) {
      requestAnimationFrame(tick);
      return;
    }
    const pads = Array.from(navigator.getGamepads() || []);
    const pad = pads.find(Boolean) || null;
    const connected = !!pad;
    const padName = pad ? (pad.id || "").replace(/\s*\(.*?\)\s*/g, "").trim() : "";
    if (connected !== last) {
      pillHandle.setConnected(connected, padName);
      last = connected;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- Click → dialog ---------- */

function openDialog(pillEl) {
  let bindingsHandle = null;
  // Hide the pill while the dialog is open. Two reasons: its presence
  // behind the modal would just be visual noise (the user got here by
  // clicking it), and the modal's own backdrop-filter doesn't always
  // reach the pill's stacking context cleanly across browsers — hiding
  // sidesteps the question. Restored on close.
  if (pillEl) pillEl.style.visibility = "hidden";
  modal.open({
    title: "Controls",
    render(body, close, foot) {
      // Tag the modal body and the modal itself so dialog-specific CSS
      // (wider modal, comfortable body padding) can target this dialog
      // without leaking onto /profile/Controls.
      body.classList.add("bindings-dialog");
      const modalEl = body.closest(".modal");
      if (modalEl) modalEl.classList.add("modal--bindings");
      bindingsHandle = mountBindings(body, { liveApply: true });

      const doneBtn = document.createElement("button");
      doneBtn.type = "button";
      doneBtn.className = "btn btn--primary";
      doneBtn.textContent = "Done";
      doneBtn.addEventListener("click", () => close());
      foot.appendChild(doneBtn);
    },
    initialFocus: () => null,
  }).then(() => {
    bindingsHandle?.destroy();
    if (pillEl) pillEl.style.visibility = "";
    // The toast.js modal restores focus to whatever was active before
    // open — i.e., the Controls pill the user clicked. With focus on a
    // button, pressing Space (fast forward) triggers the button's click
    // default and re-opens the dialog. Hand focus to the EJS player
    // surface so keyboard shortcuts (Space, Backspace, F2/F4) reach
    // play.js's handler instead of bouncing off the pill.
    const ejsParent = window.EJS_emulator?.elements?.parent;
    if (ejsParent && typeof ejsParent.focus === "function") {
      try { ejsParent.focus({ preventScroll: true }); } catch { /* noop */ }
    }
  });
}

/* ---------- Init ---------- */

(async function init() {
  // Mirror controller-host.js: we mount on /play.html (player-page body
  // class) AND on /game.html's in-place player overlay. On /game we
  // wait for the overlay before doing anything visible.
  const onPlayer =
    document.body.classList.contains("player-page") ||
    document.querySelector(".player-host") !== null;

  if (!onPlayer) {
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

  // Two-step: inject the pill with a deferred click handler, then bind
  // the handler with the pill element it needs (the click handler hides
  // the pill while the dialog is open).
  let openHandler;
  const pillHandle = injectPill(() => openHandler?.());
  if (!pillHandle) return;
  openHandler = () => openDialog(pillHandle.element);
  startDetectionPoll(pillHandle);
})();
