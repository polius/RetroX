/* /link — phone-side device-link approval.
 * User must already be signed in. They enter the 6-char code shown on the
 * other device (TV / desktop). */

import { api } from "./api.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";
import { applyEarly } from "./theme.js";
import { escapeHtml } from "./util.js";

applyEarly();

document.title = "Link a device · RetroX";

const root = document.getElementById("auth-root");
const fromQuery = (new URLSearchParams(location.search).get("code") || "").toUpperCase();

let me = null;
try {
  me = await api.get("/auth/me");
} catch {
  const next = encodeURIComponent(location.pathname + location.search);
  location.href = `/login?next=${next}`;
  throw new Error("not signed in");
}

function renderEntry() {
  root.innerHTML = `
    <div class="auth-card">
      <div class="auth-card__brand">
        <img src="/images/emulator-logo-transparent.png" alt=""/>
        <strong><span class="auth-card__brand-mark">Retro</span>X</strong>
      </div>
      <h1>Link a device</h1>
      <p class="lead">Enter the 6-character code shown on the device you want to sign in.</p>

      <form id="code-form" autocomplete="off" data-nav-group>
        <div class="field">
          <label class="field__label" for="code">Code</label>
          <input class="input" id="code" type="text" inputmode="latin" maxlength="6" placeholder="ABC123" autocapitalize="characters" style="font-family: var(--font-mono); letter-spacing: .25em; text-transform: uppercase; text-align: center; font-size: var(--fs-xl);" value="${escapeHtml(fromQuery)}" required/>
          <span class="field__hint">Find it on your TV / desktop screen.</span>
        </div>
        <button class="btn btn--primary btn--lg" type="submit" data-gp-start>${icon("check", { size: 16 })} Continue</button>
        <button class="btn btn--ghost" type="button" id="back-btn">Back to library</button>
      </form>
    </div>
  `;
  const form = document.getElementById("code-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = (form.querySelector("#code").value || "").trim().toUpperCase();
    if (!code) return;
    lookup(code);
  });
  document.getElementById("back-btn").addEventListener("click", () => { location.href = "/games"; });
  if (fromQuery) lookup(fromQuery).catch(() => {/* form remains for retry */});
  // Land focus on the code input — without an explicit anchor a
  // controller user would land on body and the spatial picker has
  // nowhere obvious to start. Even on touch / mouse this saves the
  // user a tap because the next thing they want is to type the code.
  const codeInput = document.getElementById("code");
  if (codeInput) requestAnimationFrame(() => codeInput.focus({ preventScroll: true }));
}

async function lookup(code) {
  try {
    const info = await api.get(`/auth/qr/${encodeURIComponent(code)}`);
    renderConfirm(code, info);
  } catch (err) {
    if (err && err.status === 404) {
      toast.error("Code not found", "It may have expired or been used already.");
    } else {
      toast.fromError(err, "Couldn't look up that code");
    }
  }
}

function renderConfirm(code, info) {
  const ua = info.user_agent || "Unknown device";
  const when = info.created_at ? new Date(info.created_at).toLocaleString() : "";
  root.innerHTML = `
    <div class="auth-card">
      <div class="auth-card__brand">
        <img src="/images/emulator-logo-transparent.png" alt=""/>
        <strong><span class="auth-card__brand-mark">Retro</span>X</strong>
      </div>
      <h1>Confirm link?</h1>
      <p class="lead">Sign this device in as <strong>${escapeHtml(me.username)}</strong>?</p>

      <div class="section-card" style="background: var(--canvas); margin-bottom: 16px;">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="user-card__avatar" style="width:36px;height:36px;font-size:14px">${escapeHtml(me.username.slice(0,1).toUpperCase())}</span>
          <div>
            <div style="font-weight:600">${escapeHtml(me.username)}</div>
            <div style="color:var(--text-dim);font-size:var(--fs-sm)">${escapeHtml(ua)}</div>
            ${when ? `<div style="color:var(--text-dim);font-size:var(--fs-xs)">Code generated ${escapeHtml(when)}</div>` : ""}
          </div>
        </div>
      </div>

      <div class="qr-card__code" style="font-size: var(--fs-xl); letter-spacing: 0.4em">${escapeHtml(code)}</div>

      <form id="approve-form" style="margin-top:16px;display:flex;flex-direction:column;gap:12px">
        <div class="field">
          <label class="field__label" for="approve-password">Confirm your password</label>
          <input class="input" id="approve-password" name="password" type="password" autocomplete="current-password" required/>
        </div>
        ${me.two_factor_enabled ? `
        <div class="field">
          <label class="field__label" for="approve-otp">Two-factor code</label>
          <input class="input" id="approve-otp" name="totp_code" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" required/>
        </div>` : ""}
        <div style="display:flex;gap:12px">
          <button class="btn btn--ghost" type="button" id="cancel-btn" style="flex:1">Cancel</button>
          <button class="btn btn--primary" type="submit" id="approve-btn" style="flex:2" data-gp-start>${icon("check", { size: 16 })} Approve</button>
        </div>
      </form>
    </div>
  `;
  document.getElementById("cancel-btn").addEventListener("click", () => { location.href = "/games"; });
  document.getElementById("approve-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("approve-password").value;
    const otpEl = document.getElementById("approve-otp");
    const body = { code, password };
    if (otpEl) body.totp_code = otpEl.value;
    try {
      await api.post("/auth/qr/approve", body);
      renderSuccess();
    } catch (err) {
      toast.fromError(err, "Approval failed");
    }
  });
}

function renderSuccess() {
  root.innerHTML = `
    <div class="auth-card" style="text-align:center">
      <div style="width:72px;height:72px;border-radius:50%;background:rgba(52,211,153,0.16);color:var(--success);display:grid;place-items:center;margin:0 auto 16px">
        ${icon("check", { size: 36 })}
      </div>
      <h1>Linked</h1>
      <p class="lead" style="margin-bottom:24px">The other device is signing in now. You can close this page.</p>
      <a class="btn btn--secondary" href="/games">Back to library</a>
    </div>
  `;
}

renderEntry();
