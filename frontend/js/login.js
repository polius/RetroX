/* Sign-in page: password + 2FA tab and cross-device QR tab.
 * Errors render inline at the top of the auth card (not as toasts). */

import { api } from "./api.js";
import { icon } from "./icons.js";
import { applyEarly } from "./theme.js";
import { isControllerInputMode } from "./input-mode.js";
import { toast } from "./toast.js";
import { loadVendorScript } from "./util.js";

applyEarly();

document.title = "Sign in · RetroX";

// Constrain `?next=` to same-origin paths only — prevents an open
// redirect ( /login?next=https://evil/ or //evil/ ) by allow-listing
// strings that begin with a single "/" and rejecting protocol-relative
// "//" URLs.
function safeNext(raw, fallback = "/games") {
  if (typeof raw !== "string") return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}

const root = document.getElementById("auth-root");
const next = safeNext(new URLSearchParams(location.search).get("next"));

let pendingTwoFactor = false;

function renderTabs(active) {
  root.innerHTML = `
    <div class="auth-card">
      <div class="auth-card__hero">
        <img src="/images/emulator-logo.png" alt="RetroX"/>
        <div class="auth-card__hero-title"><span>Retro</span>X</div>
        <p class="auth-card__hero-tagline">Your retro console, served from your own machine.</p>
        <div class="auth-card__hero-systems">
          <span>Game Boy</span><span>GBA</span><span>N64</span><span>PlayStation</span>
        </div>
        <div class="auth-card__hero-systems auth-card__hero-systems--more">
          <span class="auth-card__hero-systems-more">+ many more</span>
        </div>
      </div>
      <div class="auth-card__form">
        <h1 id="auth-heading">Welcome back</h1>
        <p class="lead" id="auth-lead">Pick up where you left off.</p>

        <div id="auth-error" class="alert" role="alert" hidden style="margin-bottom: var(--sp-4)">
          <span class="alert__icon">${icon("alert", { size: 18 })}</span>
          <div class="alert__body">
            <div class="alert__title" id="auth-error-title">Sign-in failed</div>
            <div class="alert__message" id="auth-error-message"></div>
          </div>
        </div>

        <div class="tabs" id="auth-tabs" role="tablist" aria-label="Sign-in method"
             data-nav-group data-nav-down="#tabpane">
          <button class="tab" role="tab" data-tab="password" aria-selected="${active === "password"}" type="button">
            <span>Password</span>
          </button>
          <button class="tab" role="tab" data-tab="qr" aria-selected="${active === "qr"}" type="button">
            <span>QR code</span>
          </button>
        </div>

        <div id="tabpane"></div>
      </div>
    </div>
  `;
  root.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => mount(btn.dataset.tab));
  });
  mount(active);
}

function showError(title, message) {
  const wrap = document.getElementById("auth-error");
  if (!wrap) return;
  document.getElementById("auth-error-title").textContent = title || "Sign-in failed";
  document.getElementById("auth-error-message").textContent = message || "";
  wrap.hidden = false;
  wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function clearError() {
  const wrap = document.getElementById("auth-error");
  if (wrap) wrap.hidden = true;
}

function setHeader(title, lead) {
  const h = document.getElementById("auth-heading");
  const l = document.getElementById("auth-lead");
  if (h) h.textContent = title;
  if (l) l.textContent = lead;
}

function mount(which) {
  pendingTwoFactor = false;
  clearError();
  const tabs = document.getElementById("auth-tabs");
  // Tabs are part of the sign-in flow, not the recovery flow — hide
  // them entirely on /recover so the user sees a single, focused task
  // ("type your username") and can't accidentally bounce themselves
  // back into the password form mid-request.
  if (tabs) tabs.style.display = which === "recover" ? "none" : "";
  if (which !== "recover") {
    root.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === which ? "true" : "false"));
  }
  if (which === "password" || which === "qr") {
    setHeader("Welcome back", "Pick up where you left off.");
  } else if (which === "recover") {
    setHeader("Forgot your password?", "We'll generate a new one for you in a moment.");
  }
  const pane = document.getElementById("tabpane");
  if (which === "password") {
    pane.innerHTML = passwordFormHTML();
    bindPasswordForm();
  } else if (which === "recover") {
    pane.innerHTML = recoverFormHTML();
    bindRecoverForm();
  } else {
    pane.innerHTML = qrPaneHTML();
    startQrFlow().catch(err => showError("Couldn't start QR sign-in", (err && err.message) || ""));
    // QR mode has nothing focusable inside the pane — the whole flow
    // is "look at the code, type it on the other device". Without an
    // explicit anchor a controller user lands on body and the picker
    // has nowhere obvious to start. Land focus on the active tab so
    // RIGHT/LEFT switches modes and DOWN... has nowhere to go yet,
    // which is fine.
    if (isControllerInputMode()) {
      const activeTab = root.querySelector('.tab[aria-selected="true"]');
      if (activeTab) requestAnimationFrame(() => activeTab.focus({ preventScroll: true }));
    }
  }
}

function passwordFormHTML() {
  const remembered = localStorage.getItem("retrox.remember_user") || "";
  // Autofocus on a touch device leaves the field in a weird state on
  // some mobile browsers (notably iOS Safari): the focus ring shows
  // but no on-screen keyboard appears, and a subsequent tap on the
  // already-focused field doesn't always re-trigger it. Restricting
  // autofocus to true mouse devices keeps the desktop UX (page loads
  // cursor-ready) without breaking the mobile flow (user taps to
  // focus, keyboard appears as expected).
  const wantAutoFocus = typeof window !== "undefined"
    && window.matchMedia
    && window.matchMedia("(pointer: fine)").matches;
  const userAutoFocus = wantAutoFocus && !remembered ? "autofocus" : "";
  const passAutoFocus = wantAutoFocus &&  remembered ? "autofocus" : "";
  // The whole form is one nav-group so D-pad navigation between fields
  // and submit stays inside the form. Without this the picker can drift
  // sideways onto the QR tab or sidebar mid-login, which is jarring.
  return `
    <form id="login-form" autocomplete="on" novalidate data-nav-group>
      <div class="field">
        <label class="field__label" for="username">Username</label>
        <input class="input" id="username" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" style="text-transform: lowercase" value="${remembered.toLowerCase().replace(/"/g, '&quot;')}" ${userAutoFocus} required/>
      </div>
      <div class="field">
        <label class="field__label" for="password">Password</label>
        <input class="input" id="password" name="password" type="password" autocomplete="current-password" ${passAutoFocus} required/>
      </div>
      <label class="checkbox" style="font-size:var(--fs-sm); margin-top: 0">
        <input type="checkbox" id="remember-user" ${remembered ? "checked" : ""}/>
        <span style="color:var(--text-muted)">Remember username</span>
      </label>
      <div class="field hidden" id="otp-field">
        <label class="field__label" for="otp">Authenticator code</label>
        <input class="input" id="otp" name="otp" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code"/>
        <span class="field__hint">Enter the 6-digit code from your authenticator app.</span>
      </div>
      <button class="btn btn--primary btn--lg" type="submit" id="submit-btn" data-gp-start>
        <span id="submit-label">Sign in</span>
      </button>
      <button class="btn btn--ghost btn--sm" type="button" id="recover-link" style="align-self:center; margin-top: var(--sp-2)">
        Forgot password?
      </button>
    </form>
  `;
}

function recoverFormHTML() {
  const remembered = localStorage.getItem("retrox.remember_user") || "";
  const wantAutoFocus = typeof window !== "undefined"
    && window.matchMedia
    && window.matchMedia("(pointer: fine)").matches;
  const userAutoFocus = wantAutoFocus ? "autofocus" : "";
  return `
    <form id="recover-form" autocomplete="off" novalidate data-nav-group>
      <div class="field">
        <label class="field__label" for="recover-username">Username</label>
        <input class="input" id="recover-username" name="username" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" style="text-transform: lowercase" value="${remembered.toLowerCase().replace(/"/g, '&quot;')}" ${userAutoFocus} required/>
      </div>
      <button class="btn btn--primary btn--lg" type="submit" id="recover-submit" data-gp-start>
        <span id="recover-label">Generate new password</span>
      </button>
      <button class="btn btn--ghost btn--sm" type="button" id="recover-back" style="align-self:center; margin-top: var(--sp-2)">
        Back to sign in
      </button>
    </form>
  `;
}

function recoverSuccessHTML() {
  // Note: the command itself is injected via textContent in
  // mountRecoverSuccess() so the username never reaches the HTML
  // template — keeps this view safe even if we ever loosen the
  // server-side username pattern.
  return `
    <div class="recover-success" data-nav-group>
      <div class="recover-success__title">New password ready</div>
      <p class="recover-success__lead">
        Run this on the host that runs RetroX to read your new password:
      </p>

      <div class="cmd-card" role="group" aria-label="Recovery command">
        <pre class="cmd-card__code" id="recover-cmd"></pre>
        <button type="button" class="cmd-card__copy" id="recover-copy" aria-label="Copy command">
          <span class="cmd-card__copy-icon" aria-hidden="true">${icon("copy", { size: 16 })}</span>
          <span class="cmd-card__copy-label">Copy</span>
        </button>
      </div>

      <ol class="recover-steps">
        <li>
          <span class="recover-steps__num">1</span>
          <span>Copy the <code>password</code> field from the JSON output.</span>
        </li>
        <li>
          <span class="recover-steps__num">2</span>
          <span>Sign in with it — it becomes your new password on first use.</span>
        </li>
      </ol>

      <p class="recover-success__note">
        <span class="recover-success__note-icon" aria-hidden="true">${icon("info", { size: 14 })}</span>
        <span>Your previous password keeps working until you sign in with this new one. Recovery is a full account reset: signing in with this password also disables two-factor authentication and signs out every other device on your account.</span>
      </p>

      <button class="btn btn--primary btn--lg" type="button" id="recover-back-success" data-gp-start>
        Back to sign in
      </button>
    </div>
  `;
}

function bindRecoverForm() {
  const form = document.getElementById("recover-form");
  const usernameInput = form.querySelector("#recover-username");
  const submit = form.querySelector("#recover-submit");
  const label = form.querySelector("#recover-label");
  const back = form.querySelector("#recover-back");

  if (usernameInput) {
    usernameInput.addEventListener("input", () => {
      const next = usernameInput.value.toLowerCase();
      if (next === usernameInput.value) return;
      const start = usernameInput.selectionStart;
      const end = usernameInput.selectionEnd;
      usernameInput.value = next;
      try { usernameInput.setSelectionRange(start, end); } catch {}
    });
    usernameInput.addEventListener("input", clearError);
  }

  back.addEventListener("click", () => mount("password"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();
    submit.disabled = true;
    label.textContent = "Generating...";
    try {
      const username = usernameInput.value.trim();
      await api.post("/auth/recover", { username });
      mountRecoverSuccess(username);
    } catch (err) {
      const msg = (err && err.message) || "Please try again.";
      showError("Couldn't request recovery", msg);
      submit.disabled = false;
      label.textContent = "Generate new password";
    }
  });
}

function mountRecoverSuccess(username) {
  setHeader("New password ready", "Read it from the container — see below.");
  const pane = document.getElementById("tabpane");
  pane.innerHTML = recoverSuccessHTML();

  // Set the command via textContent — the username is already
  // pattern-constrained server-side, but rendering it as text keeps
  // any edge case from becoming HTML.
  const cmdEl = pane.querySelector("#recover-cmd");
  const cmd = `docker exec retrox cat /data/recovery/${username || "<username>"}.json`;
  if (cmdEl) cmdEl.textContent = cmd;

  const copyBtn = pane.querySelector("#recover-copy");
  if (copyBtn) {
    const labelEl = copyBtn.querySelector(".cmd-card__copy-label");
    const originalLabel = labelEl.textContent;
    let revertTimer = null;
    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(cmd);
      if (!ok) {
        toast.error("Couldn't copy — select the command manually");
        return;
      }
      // Inline confirmation (green tint + label flip) plus a toast so
      // users who weren't looking at the button still see it landed.
      copyBtn.classList.add("is-copied");
      labelEl.textContent = "Copied";
      toast.success("Command copied");
      if (revertTimer) clearTimeout(revertTimer);
      revertTimer = setTimeout(() => {
        copyBtn.classList.remove("is-copied");
        labelEl.textContent = originalLabel;
      }, 1600);
    });
  }

  const backSuccess = pane.querySelector("#recover-back-success");
  if (backSuccess) {
    backSuccess.addEventListener("click", () => mount("password"));
  }
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  // Legacy fallback for HTTP-on-LAN deployments where clipboard API
  // is unavailable. execCommand is deprecated but still works in
  // every browser RetroX targets.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function bindPasswordForm() {
  const form = document.getElementById("login-form");
  const usernameInput = form.querySelector("#username");
  const passwordInput = form.querySelector("#password");
  const otpField = form.querySelector("#otp-field");
  const otpInput  = form.querySelector("#otp");
  const submit    = form.querySelector("#submit-btn");
  const label     = form.querySelector("#submit-label");
  const recoverBtn = form.querySelector("#recover-link");
  if (recoverBtn) {
    recoverBtn.addEventListener("click", () => mount("recover"));
  }

  // Usernames are always lowercase. Mobile keyboards capitalize the
  // first character by default, paste can introduce mixed case, and
  // older browsers ignore `autocapitalize="none"`. Coerce on every
  // input event and preserve the caret so typing never feels jumpy.
  if (usernameInput) {
    usernameInput.addEventListener("input", () => {
      const next = usernameInput.value.toLowerCase();
      if (next === usernameInput.value) return;
      const start = usernameInput.selectionStart;
      const end = usernameInput.selectionEnd;
      usernameInput.value = next;
      try { usernameInput.setSelectionRange(start, end); } catch {}
    });
  }

  // Clearing inputs hides the inline error.
  [usernameInput, passwordInput, otpInput].forEach(el => el && el.addEventListener("input", clearError));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();
    submit.disabled = true;
    label.textContent = pendingTwoFactor ? "Verifying..." : "Signing in...";
    try {
      if (!pendingTwoFactor) {
        const remember = form.querySelector("#remember-user");
        if (remember && remember.checked) {
          localStorage.setItem("retrox.remember_user", usernameInput.value);
        } else {
          localStorage.removeItem("retrox.remember_user");
        }
        const r = await api.post("/auth/login", { username: usernameInput.value, password: passwordInput.value });
        if (r && r.two_factor_required) {
          pendingTwoFactor = true;
          otpField.classList.remove("hidden");
          label.textContent = "Verify code";
          otpInput.focus();
          return;
        }
        location.href = next;
      } else {
        await api.post("/auth/login/2fa", { code: otpInput.value });
        location.href = next;
      }
    } catch (err) {
      const msg = (err && err.message) || "Please try again.";
      showError(pendingTwoFactor ? "Invalid code" : "Sign-in failed", msg);
    } finally {
      submit.disabled = false;
      label.textContent = pendingTwoFactor ? "Verify code" : "Sign in";
    }
  });
}

/* ---------- QR sign-in (TV side) ---------- */

let qrTimer = null;

function qrPaneHTML() {
  // Group the QR pane so any focusable elements added later (e.g. the
  // "Refresh code" button when the code expires) stay reachable via
  // D-pad without leaking focus out to the sidebar.
  return `
    <div class="qr-card" data-nav-group>
      <div class="qr-card__methods">
        <p class="qr-card__method">Scan the QR with your phone.</p>
        <div class="qr-card__or"><span>or</span></div>
        <p class="qr-card__method">
          Open <a class="qr-card__link" href="/link" target="_blank" rel="noopener">${location.host}/link</a> on another device
          and enter the code below.
        </p>
      </div>
      <div class="qr-card__qr" id="qr-img"><div class="spinner"></div></div>
      <div class="qr-card__code" id="qr-code">······</div>
      <p class="qr-card__status" id="qr-status" role="status" aria-live="polite" hidden></p>
    </div>
  `;
}

async function startQrFlow() {
  const session = await api.post("/auth/qr/start", {});
  const codeEl   = document.getElementById("qr-code");
  const statusEl = document.getElementById("qr-status");
  const imgEl    = document.getElementById("qr-img");

  const showStatus = (text, tone) => {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone || "";
    statusEl.hidden = false;
  };

  codeEl.textContent = session.code;

  // Lazy-load qrcode.js — see profile.js for why we don't rely on a
  // classic <script> tag in login.html.
  try {
    await loadVendorScript("/js/vendor/qrcode.js");
  } catch {
    showStatus("Couldn't load the QR generator. Use the code on the right instead.", "error");
    return;
  }
  const approveAbsolute = location.origin + session.approve_url;
  const qr = window.qrcode(0, "M");
  qr.addData(approveAbsolute);
  qr.make();
  imgEl.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2 });

  const expiresAt = Date.now() + (session.expires_in || 180) * 1000;
  clearInterval(qrTimer);
  qrTimer = setInterval(async () => {
    if (Date.now() > expiresAt) {
      clearInterval(qrTimer);
      showStatus("Code expired.", "error");
      const refresh = document.createElement("button");
      refresh.className = "btn btn--secondary";
      refresh.textContent = "Refresh code";
      refresh.style.marginTop = "12px";
      refresh.addEventListener("click", () => mount("qr"));
      statusEl.after(refresh);
      return;
    }
    try {
      const r = await api.get(`/auth/qr/poll?token=${encodeURIComponent(session.token)}`);
      if (r.status === "approved") {
        clearInterval(qrTimer);
        showStatus("Approved — signing you in...", "success");
        setTimeout(() => { location.href = next; }, 400);
      } else if (r.status === "expired") {
        clearInterval(qrTimer);
        showStatus("Code expired.", "error");
      }
    } catch { /* swallow transient errors */ }
  }, 2500);
}

// Default to QR when the user is on a controller — see input-mode.js
// for the dual-signal logic (current gamepad presence + persisted
// "controller seen" flag). Without the flag we'd always show Password
// on first paint because the browser hides already-connected controllers
// from a freshly-loaded page until it sees post-load input.
renderTabs(isControllerInputMode() ? "qr" : "password");

// Switch to QR if a controller becomes detected *after* the initial render.
//
// The browser hides already-connected gamepads from a freshly-loaded
// page until it observes ANY user input — `navigator.getGamepads()`
// returns an empty array up to that point, regardless of what's
// physically plugged in. So our two signals are:
//
//   1. `gamepadconnected` — fires the moment the browser first becomes
//      aware of the pad. With a pad plugged in before page load this
//      typically happens on first input on the page (button press,
//      mouse move, etc).
//   2. The first non-trivial DOM input event (pointermove, pointerdown,
//      keydown, touchstart). On that event the browser populates
//      `getGamepads()`; we recheck and switch if a pad is now visible.
//
// Both listeners persist for the page lifetime (cheap; the page
// reloads on navigation) and are no-ops when no pad is present, so
// non-controller users see zero behaviour change.
function maybeSwitchToQr() {
  if (!isControllerInputMode()) return;
  // Don't yank the form away from a user who's already typing.
  const u = document.getElementById("username");
  const p = document.getElementById("password");
  if ((u && u.value) || (p && p.value)) return;
  const activeTab = root.querySelector('.tab[aria-selected="true"]');
  if (activeTab && activeTab.dataset.tab === "qr") return;
  mount("qr");
}
window.addEventListener("gamepadconnected", maybeSwitchToQr);

// The first input event of any kind unblocks gamepad visibility.
// requestAnimationFrame defers the recheck by one tick so the browser
// has a chance to populate getGamepads() after handling the event.
let firstInputSeen = false;
function onFirstInput() {
  if (firstInputSeen) return;
  firstInputSeen = true;
  ["pointermove", "pointerdown", "keydown", "touchstart"].forEach(evt =>
    window.removeEventListener(evt, onFirstInput),
  );
  requestAnimationFrame(maybeSwitchToQr);
}
["pointermove", "pointerdown", "keydown", "touchstart"].forEach(evt =>
  window.addEventListener(evt, onFirstInput, { passive: true }),
);
