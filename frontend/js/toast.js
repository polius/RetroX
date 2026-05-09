/* Toasts + modal helpers. Plex-style restraint. */

import { icon } from "./icons.js";
import { isControllerInputMode } from "./input-mode.js";

const STACK_ID = "retrox-toast-stack";

// Same fullscreen consideration as modals: when something is fullscreen
// (EmulatorJS player), only that element's subtree renders. Mount the
// toast stack into whichever element is currently fullscreen so toasts
// fired during gameplay (sync recovery, conflict, etc.) stay visible.
//
// Also: when the in-app player overlay is mounted (z-index 9000 + back
// button at 9999), a default z-index 200 toast / 100 modal-backdrop on
// <body> would render BEHIND the overlay and be invisible. Mount inside
// the .player-host so the new stacking context makes them paint over
// the canvas; the bumped z-indices in components.css then keep them
// above the in-overlay back button.
function getMountTarget() {
  return document.fullscreenElement
      || document.webkitFullscreenElement
      || document.mozFullScreenElement
      || document.msFullscreenElement
      || document.querySelector(".player-host")
      || document.body;
}

function ensureStack() {
  let stack = document.getElementById(STACK_ID);
  if (!stack) {
    stack = document.createElement("div");
    stack.id = STACK_ID;
    stack.className = "toast-stack";
    stack.setAttribute("aria-live", "polite");
    stack.setAttribute("aria-atomic", "false");
  }
  // Re-parent if the fullscreen state has changed since the stack was
  // last shown — appendChild is a move, not a clone, so existing toasts
  // (if any) come along.
  const host = getMountTarget();
  if (stack.parentNode !== host) host.appendChild(stack);
  return stack;
}

function show({ kind = "info", title, message = "", duration = 4200 }) {
  const host = ensureStack();
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.setAttribute("role", kind === "danger" ? "alert" : "status");

  const iconName =
    kind === "success" ? "check" :
    kind === "danger"  ? "alert" :
    kind === "warn"    ? "alert" : "info";

  el.innerHTML = `
    <div class="toast__icon">${icon(iconName, { size: 22 })}</div>
    <div class="toast__body">
      ${title ? `<div class="toast__title"></div>` : ""}
      ${message ? `<div class="toast__message"></div>` : ""}
    </div>
    <button class="toast__close" type="button" aria-label="Dismiss">${icon("x", { size: 14 })}</button>
  `;
  if (title) el.querySelector(".toast__title").textContent = title;
  if (message) el.querySelector(".toast__message").textContent = message;

  const dismiss = () => {
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  el.querySelector(".toast__close").addEventListener("click", dismiss);
  if (duration > 0) setTimeout(dismiss, duration);
  host.appendChild(el);
  return dismiss;
}

export const toast = {
  success: (title, message, duration) => show({ kind: "success", title, message, duration }),
  error:   (title, message, duration) => show({ kind: "danger",  title, message, duration }),
  warning: (title, message, duration) => show({ kind: "warn",    title, message, duration }),
  info:    (title, message, duration) => show({ kind: "info",    title, message, duration }),
  fromError(err, fallbackTitle = "Something went wrong") {
    const message = (err && err.message) ? err.message : "";
    show({ kind: "danger", title: fallbackTitle, message });
  },
};

window.toast = toast;

/* ---------------- Modal ---------------- */

const FOCUSABLE = 'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

// Same as FOCUSABLE but excludes elements that are never a sensible
// *initial* focus target on dialog open:
//   - input[type="file"] is hidden by createFilePicker (the visible UI
//     is a styled label). Auto-focusing it triggers :focus-within on
//     the picker shell, painting an accent border that reads like a
//     "preselected" file slot — confusing for the user.
//   - .file-picker__clear is display:none until a file is picked.
//     querySelector matches DOM regardless of CSS, so without this
//     skip the modal silently target-focuses an unrendered element.
// Tab navigation still uses FOCUSABLE so file inputs remain
// keyboard-reachable.
const INITIAL_FOCUSABLE =
  'a, button:not(.file-picker__clear), input:not([type="file"]), ' +
  'select, textarea, [tabindex]:not([tabindex="-1"])';

function trapFocus(scope, e) {
  const items = scope.querySelectorAll(FOCUSABLE);
  if (!items.length) return;
  // If focus has drifted outside the modal (browser quirks, an element
  // being removed mid-Tab, content rendered into the backdrop layer)
  // pull it back to the first focusable item. Without this guard the
  // trap silently no-ops while focus sits behind the backdrop.
  if (!scope.contains(document.activeElement)) {
    e.preventDefault();
    items[0].focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export const modal = {
  open({ title, render, dismissible = true, initialFocus }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");

      const card = document.createElement("div");
      card.className = "modal";
      // The whole card is one nav-group so D-pad spatial pick stays
      // inside the modal — without this it falls back to the legacy
      // global picker and can drift through unrelated elements
      // underneath (e.g. the inert game UI). The X close button in
      // the head is reachable via UP from the foot when present.
      card.setAttribute("data-nav-group", "");
      card.innerHTML = `
        <div class="modal__head">
          <h3></h3>
          ${dismissible ? `<button class="icon-btn modal__close" type="button" aria-label="Close">${icon("x", { size: 16 })}</button>` : ""}
        </div>
        <div class="modal__body"></div>
        <div class="modal__foot"></div>
      `;
      card.querySelector("h3").textContent = title || "";
      const body = card.querySelector(".modal__body");
      const foot = card.querySelector(".modal__foot");

      const close = (value) => {
        backdrop.remove();
        document.removeEventListener("keydown", onKey);
        if (previous && typeof previous.focus === "function") previous.focus();
        resolve(value);
      };

      function onKey(e) {
        if (e.key === "Escape" && dismissible) { e.stopPropagation(); close(undefined); }
        if (e.key === "Tab") trapFocus(card, e);
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON") {
          e.preventDefault();
          const primary = foot.querySelector(".btn--primary");
          if (primary) primary.click();
        }
      }
      document.addEventListener("keydown", onKey);

      if (dismissible) {
        card.querySelector(".modal__close").addEventListener("click", () => close(undefined));
        backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(undefined); });
      }

      backdrop.appendChild(card);
      // Append to the current fullscreen element (if any) instead of
      // <body> — see getMountTarget() comment.
      getMountTarget().appendChild(backdrop);

      try { render(body, close, foot); } catch (err) { console.error(err); close(undefined); }

      // Initial focus. Resolution order:
      //   1. Explicit `initialFocus` callback (used by .confirm() to
      //      focus Cancel for destructive actions, or the primary
      //      button for safe ones)
      //   2. First focusable in body — most modals have an input or
      //      list to navigate
      //   3. Last button in the foot — for confirm-only modals where
      //      the body is just text, this lands on the primary action
      //      (Save / Continue / Got it) so A immediately confirms
      //   4. The X close button
      //   5. The card itself (so D-pad/keyboard isn't lost in space)
      requestAnimationFrame(() => {
        let target = null;
        if (typeof initialFocus === "function") {
          try { target = initialFocus(); } catch {}
        }
        if (!target) target = body.querySelector(INITIAL_FOCUSABLE);
        if (!target) {
          const footButtons = foot.querySelectorAll("button, a[href]");
          target = footButtons[footButtons.length - 1] || null;
        }
        if (!target) target = card.querySelector(".modal__close");
        if (!target) target = card;
        // Only auto-focus in controller mode — D-pad/spatial navigation
        // needs a starting anchor inside the dialog. In mouse/keyboard
        // mode, leaving focus where it was is more honest: an input
        // showing a focus ring on dialog open looks "preselected" even
        // though the user hasn't picked anything yet, and the typical
        // mouse user clicks where they want regardless of where focus
        // sat. Tab from anywhere on the page still pulls focus into
        // the modal via the focus trap, so keyboard accessibility is
        // preserved — we just don't grab proactively.
        if (target && typeof target.focus === "function" && isControllerInputMode()) {
          target.focus();
        }
      });
    });
  },
  confirm({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
    let cancelBtn, okBtn;
    return modal.open({
      title,
      render(b, close, foot) {
        if (typeof body === "string") {
          const p = document.createElement("p");
          p.style.margin = "0";
          p.style.color = "var(--text-muted)";
          p.style.lineHeight = "1.6";
          p.textContent = body;
          b.appendChild(p);
        } else if (body instanceof Node) {
          b.appendChild(body);
        }
        cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn btn--ghost";
        cancelBtn.textContent = cancelLabel;
        cancelBtn.addEventListener("click", () => close(false));
        okBtn = document.createElement("button");
        okBtn.type = "button";
        okBtn.className = danger ? "btn btn--danger" : "btn btn--primary";
        okBtn.textContent = confirmLabel;
        okBtn.addEventListener("click", () => close(true));
        foot.append(cancelBtn, okBtn);
      },
      // Destructive actions focus Cancel by default — protects against
      // a controller user spamming A from a previous screen and
      // accidentally confirming a delete. Safe actions focus the
      // primary so confirming is one button press.
      initialFocus: () => danger ? cancelBtn : okBtn,
    });
  },
};

window.modal = modal;
