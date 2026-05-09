/* util.js — small helpers shared across pages.
 *
 * Single home for primitives that previously had file-local copies (and
 * therefore could drift). New helpers go here unless they have a strong
 * reason to live next to a specific page module.
 */

/**
 * Disable a button while an async function runs, then re-enable it.
 * Drops re-entry while the operation is in flight, so a double-click
 * on a submit button only triggers one request even if the button
 * sits in the DOM for a noticeable beat (slow API).
 *
 *   submitBtn.addEventListener("click", () => withBusy(submitBtn, doIt, { busyLabel: "Saving..." }));
 *
 * Returns whatever asyncFn returns, or undefined if a re-entry was dropped.
 */
export async function withBusy(button, asyncFn, { busyLabel } = {}) {
  if (!button) return asyncFn();
  if (button.dataset.busy === "1") return undefined;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.dataset.busy = "1";
  if (busyLabel) button.textContent = busyLabel;
  try {
    return await asyncFn();
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
    if (busyLabel) button.textContent = originalLabel;
  }
}

/** Escape a string for safe interpolation into innerHTML. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[<>&"']/g, ch => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

/* --------------------------------------------------------------------
 * Username validation
 *
 * Mirrors the server-side USERNAME_PATTERN in
 * backend/app/models/schemas.py — lowercase ASCII letters, digits,
 * and dots; first and last char must be alphanumeric. Keeping these
 * in sync matters: server is authoritative, but failing client-side
 * before the round-trip is what makes the UX pleasant.
 * ------------------------------------------------------------------ */

export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9.]*[a-z0-9])?$/;
const USERNAME_ALLOWED_CHAR = /^[a-z0-9.]$/;

/**
 * Strip everything that's not in the allowed alphabet, lowercasing
 * letters as we go. Returns the cleaned string.
 */
export function sanitizeUsername(raw) {
  if (raw == null) return "";
  let out = "";
  for (const ch of String(raw).toLowerCase()) {
    if (USERNAME_ALLOWED_CHAR.test(ch)) out += ch;
  }
  return out;
}

/** Return null on success, or a human-readable problem string. */
export function describeUsernameProblem(value) {
  if (!value) return "Username is required.";
  if (value.length > 64) return "Username can be at most 64 characters.";
  if (!USERNAME_PATTERN.test(value)) {
    if (value.startsWith(".") || value.endsWith(".")) {
      return "Username can't start or end with a dot.";
    }
    return "Use only lowercase letters, numbers, and dots.";
  }
  return null;
}

/**
 * Wire an `<input>` so the user can only type characters the backend
 * will accept. Pass an optional element to render the inline error
 * message into (kept hidden until the user does something the rule
 * blocks). Returns a teardown function for callers that re-render.
 *
 *   attachUsernameValidation(inputEl, hintEl, { onValidChange });
 *
 * The handler is intentionally chatty — it surfaces a hint as soon as
 * the user attempts a forbidden character (paste / IME / keystroke)
 * rather than waiting for the form submit. That's the requested UX
 * emphasis: fail fast, explain why.
 */
export function attachUsernameValidation(input, hint, { onValidChange } = {}) {
  if (!input) return () => {};

  const setHint = (msg, state) => {
    if (!hint) return;
    if (msg) {
      hint.textContent = msg;
      hint.dataset.state = state;
      hint.hidden = false;
    } else {
      hint.textContent = "";
      delete hint.dataset.state;
      hint.hidden = true;
    }
  };

  let touched = false;

  const apply = () => {
    const raw = input.value;
    const cleaned = sanitizeUsername(raw);
    let charsRejected = false;
    if (cleaned !== raw) {
      // The user tried a character we don't accept (uppercase, space,
      // emoji, etc). Strip it silently and surface a concrete reason.
      input.value = cleaned;
      charsRejected = true;
    }
    const problem = charsRejected
      ? "Use only lowercase letters, numbers, and dots."
      : describeUsernameProblem(cleaned);
    if (problem && cleaned !== "") {
      // Non-empty but invalid — surface the specific reason in error
      // tone (e.g. "Username can't start or end with a dot.").
      setHint(problem, "error");
    } else if (touched || cleaned) {
      // Either valid, or empty-after-interaction. We deliberately
      // never show "Username is required." for the empty case: the
      // disabled submit button already conveys "incomplete", and a
      // red required-label reads as scolding rather than guidance.
      // The constructive rule is what the user actually needs.
      setHint("Lowercase letters, numbers, and dots.", "info");
    } else {
      setHint(null);
    }
    // onValidChange reflects the strict validity (button stays disabled
    // for empty/invalid) regardless of what we chose to render in the
    // hint slot.
    if (onValidChange) onValidChange(!problem, cleaned);
  };

  const markTouched = () => {
    if (touched) return;
    touched = true;
    apply();
  };

  input.addEventListener("input", () => { touched = true; apply(); });
  input.addEventListener("paste", () => requestAnimationFrame(() => { touched = true; apply(); }));
  input.addEventListener("blur", markTouched);
  // Surface the rule on first focus so the user knows the constraint
  // before they discover it the hard way.
  input.addEventListener("focus", () => {
    if (hint && !hint.dataset.state) {
      hint.textContent = "Lowercase letters, numbers, and dots.";
      hint.dataset.state = "info";
      hint.hidden = false;
    }
  }, { once: true });

  // Run once in case the field already has a value.
  apply();

  return () => {
    input.removeEventListener("input", apply);
  };
}

/**
 * Lazy-load a non-module vendor script and resolve once it's parsed.
 *
 * The SPA router (router.js) only re-imports the page's module script
 * on soft-nav; classic `<script src=...>` tags inside the fetched HTML
 * are not executed. So any vendor lib that publishes itself as a
 * window-global (qrcode.js, etc.) must be requested explicitly from JS
 * by whichever module needs it, not declared as an inline tag in HTML.
 *
 * Idempotent: concurrent and repeat calls share a single Promise and
 * the script is only injected once. A failed load drops the cache so
 * a retry is possible.
 */
const _vendorScripts = new Map();
export function loadVendorScript(src) {
  let p = _vendorScripts.get(src);
  if (p) return p;
  p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.addEventListener("load", () => resolve(), { once: true });
    s.addEventListener("error", () => {
      _vendorScripts.delete(src);
      reject(new Error(`failed to load ${src}`));
    }, { once: true });
    document.head.appendChild(s);
  });
  _vendorScripts.set(src, p);
  return p;
}
