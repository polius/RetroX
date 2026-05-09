/* Profile / settings page. */

import { api } from "./api.js";
import { mountShell } from "./shell.js";
import { icon } from "./icons.js";
import { toast, modal } from "./toast.js";
import { applyEarly, hydrate } from "./theme.js";
import { saveCache } from "./save-cache.js";
import { escapeHtml, loadVendorScript, withBusy } from "./util.js";
import { isControllerInputMode } from "./input-mode.js";
import { friendlyKey, isBindable } from "./key-codes.js";
import "./gamepad-nav.js";

applyEarly();

document.title = "Profile · RetroX";

const shell = await mountShell({ active: null, title: "Profile" });
if (!shell) throw new Error("not signed in");
const { me, slot } = shell;
hydrate();

const SECTIONS = [
  { key: "account",  label: "Account",   icon: "user" },
  { key: "stats",    label: "My Stats",  icon: "clock" },
  { key: "saves",    label: "My Saves",  icon: "download" },
  { key: "security", label: "Security",  icon: "shield" },
  { key: "controls", label: "Controls",  icon: "game" },
];
let active = location.hash.replace("#", "") || "account";
if (!SECTIONS.find(s => s.key === active)) active = "account";

slot.innerHTML = `
  <div class="page">
    <div class="profile-header">
      <div class="profile-header__avatar">${escapeHtml(me.username.slice(0, 1).toUpperCase())}</div>
      <div>
        <div class="profile-header__name">${escapeHtml(me.username)}</div>
        <div class="profile-header__role">${me.is_admin ? "Administrator" : "Member"}${me.two_factor_enabled ? " · 2FA enabled" : ""}</div>
      </div>
    </div>

    <div class="settings">
      <nav class="settings-nav" id="settings-nav" data-nav-group data-nav-right="#settings-pane" data-nav-up=".sidebar" data-nav-left=".sidebar" aria-label="Settings sections"></nav>
      <div id="settings-pane" data-nav-group data-nav-left="#settings-nav" data-nav-up=".sidebar"></div>
    </div>
  </div>
`;
const navEl = document.getElementById("settings-nav");
const paneEl = document.getElementById("settings-pane");

navEl.innerHTML = SECTIONS.map(s => `
  <button type="button" data-key="${s.key}" aria-selected="${active === s.key}">
    ${icon(s.icon, { size: 16 })} <span style="margin-left:8px">${s.label}</span>
  </button>
`).join("");
navEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-key]");
  if (!btn) return;
  active = btn.dataset.key;
  navEl.querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", b.dataset.key === active ? "true" : "false"));
  history.replaceState(null, "", `#${active}`);
  renderSection();
});

function formatPlaytime(seconds) {
  if (!seconds || seconds < 1) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function relativeTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const delta = (Date.now() - t) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* ---------- Account ---------- */

function renderAccount() {
  paneEl.innerHTML = `
    <div class="section-card">
      <h2>Account</h2>
      <p class="lead">You're signed in as <strong>${escapeHtml(me.username)}</strong>${me.is_admin ? " — administrator" : ""}.</p>
      <div class="actions">
        <button class="btn btn--secondary" type="button" id="signout-btn">${icon("logout", { size: 14 })} Sign out</button>
      </div>
    </div>
  `;
  document.getElementById("signout-btn").addEventListener("click", async () => {
    try { await api.post("/auth/logout"); } catch { /* ignore */ }
    location.href = "/login";
  });
}

/* ---------- My Stats ---------- */

async function renderMyStats() {
  paneEl.innerHTML = `<div style="padding:32px;text-align:center"><div class="spinner"></div></div>`;
  let stats = [];
  try {
    stats = await api.get("/profile/stats");
  } catch {
    stats = [];
  }

  if (!stats.length) {
    paneEl.innerHTML = `
      <div class="section-card">
        <h2>My Stats</h2>
        <p class="lead">No playtime recorded yet. Hit Play on any game and the timer starts running automatically.</p>
      </div>
    `;
    return;
  }

  const totalSeconds = stats.reduce((sum, s) => sum + (s.playtime_seconds || 0), 0);

  paneEl.innerHTML = `
    <div class="section-card">
      <h2>My Stats</h2>
      <p class="lead">Time you've spent in each game. Counted from the moment a game loads in the emulator until you leave it.</p>
      <div class="stat-summary" role="group" aria-label="Totals">
        <div class="stat-summary__cell">
          <span class="stat-summary__label">Total time</span>
          <span class="stat-summary__value">${formatPlaytime(totalSeconds)}</span>
        </div>
        <div class="stat-summary__cell">
          <span class="stat-summary__label">Games played</span>
          <span class="stat-summary__value">${stats.length}</span>
        </div>
      </div>
      <div id="stats-list" style="border:1px solid var(--border);border-radius:var(--r-3);overflow:hidden"></div>
    </div>
  `;

  const listEl = document.getElementById("stats-list");
  listEl.innerHTML = stats.map(s => {
    const cover = s.has_cover
      ? api.url(`/games/${encodeURIComponent(s.game_id)}/cover`)
      : "/images/default-cover.svg";
    return `
      <div class="my-stat-row" data-game="${escapeHtml(s.game_id)}">
        <img class="my-stat-row__cover" src="${cover}" alt="" loading="lazy"/>
        <div class="my-stat-row__body">
          <a class="my-stat-row__name" href="/game/${encodeURIComponent(s.slug || s.game_id)}">${escapeHtml(s.game_name)}</a>
          <span class="my-stat-row__sub">
            <span>${escapeHtml((s.system || "").toUpperCase())}</span>
            ${s.last_played_at ? `<span class="dot"></span><span>Last played ${escapeHtml(relativeTime(s.last_played_at))}</span>` : ""}
          </span>
        </div>
        <span class="my-stat-row__playtime">${formatPlaytime(s.playtime_seconds)}</span>
        <span class="my-stat-row__actions">
          <button class="btn btn--ghost btn--sm" data-act="clear" title="Clear timer for this game" aria-label="Clear timer for ${escapeHtml(s.game_name)}" style="color:var(--danger)">${icon("trash", { size: 14 })}</button>
        </span>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".my-stat-row").forEach(row => {
    const gameId = row.dataset.game;
    const name = row.querySelector(".my-stat-row__name").textContent;
    row.querySelector('[data-act="clear"]').addEventListener("click", async (e) => {
      e.preventDefault();
      const ok = await modal.confirm({
        title: `Clear timer for ${name}?`,
        body: "The recorded playtime and last-played date for this game will be permanently reset. Save slots are not affected.",
        confirmLabel: "Clear timer",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/profile/stats/${encodeURIComponent(gameId)}`);
        toast.success("Timer cleared");
        renderMyStats();
      } catch (err) {
        toast.fromError(err, "Couldn't clear timer");
      }
    });
  });
}

/* ---------- My Saves ---------- */

async function renderMySaves() {
  paneEl.innerHTML = `<div style="padding:32px;text-align:center"><div class="spinner"></div></div>`;
  let allSlots = [];
  try { allSlots = await api.get("/profile/saves"); } catch { allSlots = []; }

  if (!allSlots.length) {
    paneEl.innerHTML = `
      <div class="section-card">
        <h2>My Saves</h2>
        <p class="lead">You haven't saved any games yet. Play a game and use the save state button to create your first save.</p>
      </div>
    `;
    return;
  }

  // Group by game
  const byGame = new Map();
  for (const s of allSlots) {
    if (!byGame.has(s.game_id)) byGame.set(s.game_id, []);
    byGame.get(s.game_id).push(s);
  }

  paneEl.innerHTML = `
    <div class="section-card">
      <h2>My Saves</h2>
      <p class="lead">All your save slots across every game. Download them as backups or delete ones you no longer need.</p>
      <div class="field" style="margin-top:16px;margin-bottom:16px">
        <input class="input" id="saves-search" type="search" placeholder="Search by game name..." autocomplete="off"/>
      </div>
      <div id="saves-list" style="display:flex;flex-direction:column;gap:16px">
      </div>
    </div>
  `;

  const listEl = document.getElementById("saves-list");
  const searchEl = document.getElementById("saves-search");

  function drawSaves(filter) {
    const filtered = filter
      ? [...byGame.entries()].filter(([, slots]) => { const norm = s => (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); const words = norm(filter).split(/\s+/).filter(Boolean); const n = norm(slots[0].game_name); return words.every(w => n.includes(w)); })
      : [...byGame.entries()];

    if (!filtered.length) {
      listEl.innerHTML = `<p style="color:var(--text-dim);text-align:center;padding:20px">No saves match your search.</p>`;
      return;
    }

    listEl.innerHTML = filtered.map(([gameId, slots]) => {
      const gameName = slots[0].game_name || gameId;
      return `
        <div style="border:1px solid var(--border);border-radius:var(--r-3);overflow:hidden">
          <div style="padding:12px 16px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
            <strong style="font-size:var(--fs-md)">${escapeHtml(gameName)}</strong>
            <span style="font-size:var(--fs-xs);color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em">${escapeHtml(slots[0].system || "")}</span>
            <span style="margin-left:auto;font-size:var(--fs-xs);color:var(--text-dim)">${slots.length} slot${slots.length > 1 ? "s" : ""}</span>
          </div>
          <div style="display:flex;flex-direction:column">
            ${slots.sort((a, b) => a.slot - b.slot).map(s => `
              <div class="my-save-row" data-id="${s.id}" data-game="${gameId}" data-slot="${s.slot}">
                <span class="my-save-row__slot">Slot ${s.slot}</span>
                <span class="my-save-row__name">${escapeHtml(s.name || "Unnamed")}</span>
                <span class="my-save-row__time">${s.updated_at ? new Date(s.updated_at).toLocaleDateString() : "—"}</span>
                <span class="my-save-row__actions">
                  <button class="btn btn--ghost btn--sm" data-act="download" title="Download">${icon("download", { size: 14 })}</button>
                  <button class="btn btn--ghost btn--sm" data-act="delete" title="Delete" style="color:var(--danger)">${icon("trash", { size: 14 })}</button>
                </span>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }).join("");

    bindSaveActions();
  }

  function bindSaveActions() {
    paneEl.querySelectorAll(".my-save-row").forEach(row => {
      const gameId = row.dataset.game;
      const slotNum = parseInt(row.dataset.slot, 10);
      row.querySelector('[data-act="download"]').addEventListener("click", async () => {
        try {
          const r = await api.raw(`/games/${encodeURIComponent(gameId)}/saves/${slotNum}/state`);
          if (r.ok) {
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = `${gameId}_slot${slotNum}.state`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } else {
            toast.warning("No state file", "This slot only has a battery save.");
          }
        } catch (err) { toast.fromError(err, "Download failed"); }
      });
      row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
        const ok = await modal.confirm({
          title: "Delete save?",
          body: `Slot ${slotNum} will be permanently removed.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
        try {
          await api.del(`/games/${encodeURIComponent(gameId)}/saves/${slotNum}`);
          // Clear the local cache too — without this the next launch
          // would resurrect the deleted save from the offline cache.
          if (me?.username) {
            saveCache.delete(me.username, gameId, slotNum).catch(() => {});
          }
          toast.success("Save deleted");
          renderMySaves();
        } catch (err) { toast.fromError(err, "Delete failed"); }
      });
    });
  }

  searchEl.addEventListener("input", () => drawSaves(searchEl.value.trim()));
  drawSaves("");
}

/* ---------- Security ---------- */

function renderSecurity() {
  paneEl.innerHTML = `
    <div class="section-card">
      <h2>Change password</h2>
      <p class="lead">Use a long passphrase. Minimum 8 characters.</p>
      <form id="pwd-form">
        <div class="field">
          <label class="field__label" for="cur">Current password</label>
          <input class="input" id="cur" type="password" required autocomplete="current-password"/>
        </div>
        <div class="field">
          <label class="field__label" for="new1">New password</label>
          <input class="input" id="new1" type="password" minlength="8" required autocomplete="new-password"/>
        </div>
        <div class="field">
          <label class="field__label" for="new2">Confirm new password</label>
          <input class="input" id="new2" type="password" minlength="8" required autocomplete="new-password"/>
        </div>
        <div class="actions">
          <button type="submit" class="btn btn--primary">${icon("key", { size: 14 })} Update password</button>
        </div>
      </form>
    </div>

    <div class="section-card">
      <h2>Two-factor authentication</h2>
      <p class="lead">${me.two_factor_enabled ? "2FA is currently enabled. Disabling will weaken your account security." : "Add an authenticator app for an extra sign-in step."}</p>
      <div id="totp-zone"></div>
    </div>

    <div class="section-card">
      <h2>Active sessions</h2>
      <p class="lead">These browsers and devices are currently signed in to your account. Revoke any you don't recognize.</p>
      <div id="sessions-zone"><div style="padding:24px"><div class="spinner"></div></div></div>
    </div>
  `;
  document.getElementById("pwd-form").addEventListener("submit", changePassword);
  renderTotpZone();
  renderSessionsZone();
}

async function renderSessionsZone() {
  const zone = document.getElementById("sessions-zone");
  if (!zone) return;
  let sessions = [];
  try {
    sessions = await api.get("/profile/sessions");
  } catch (err) {
    zone.innerHTML = `<p class="lead" style="color:var(--text-muted)">Couldn't load sessions.</p>`;
    toast.fromError(err, "Couldn't load sessions");
    return;
  }
  // Sort: current session first (so it's anchored), then most-recently
  // seen. Server already orders by last_seen_at desc, but keep the
  // current row pinned to the top so the user always knows what
  // "this device" looks like before revoking siblings.
  sessions.sort((a, b) => {
    if (a.is_current && !b.is_current) return -1;
    if (!a.is_current && b.is_current) return 1;
    return new Date(b.last_seen_at) - new Date(a.last_seen_at);
  });
  const others = sessions.filter(s => !s.is_current).length;
  zone.innerHTML = `
    <div class="session-list" role="list">
      ${sessions.map(s => `
        <div class="session-row" role="listitem" data-id="${s.id}">
          <div class="session-row__icon">${icon("monitor", { size: 18 })}</div>
          <div class="session-row__body">
            <div class="session-row__head">
              <strong>${escapeHtml(s.label || "Unknown device")}</strong>
              ${s.is_current ? `<span class="pill pill--success">This device</span>` : ""}
            </div>
            <div class="session-row__meta">
              <span title="${escapeHtml(new Date(s.last_seen_at).toLocaleString())}">Active ${escapeHtml(relativeTime(s.last_seen_at))}</span>
              ${s.ip_address ? ` · <span>${escapeHtml(s.ip_address)}</span>` : ""}
              · <span title="${escapeHtml(s.user_agent || "")}">since ${escapeHtml(new Date(s.created_at).toLocaleDateString())}</span>
            </div>
          </div>
          <div class="session-row__action">
            <button class="btn btn--ghost btn--sm" type="button" data-act="revoke" data-current="${s.is_current ? "1" : "0"}">${icon("logout", { size: 14 })} Revoke</button>
          </div>
        </div>
      `).join("")}
    </div>
    ${others > 0 ? `
      <div class="actions" style="margin-top:16px">
        <button class="btn btn--ghost" type="button" id="revoke-others-btn">${icon("shield", { size: 14 })} Sign out ${others} other ${others === 1 ? "device" : "devices"}</button>
      </div>
    ` : ""}
  `;
  zone.querySelectorAll('button[data-act="revoke"]').forEach(btn => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".session-row");
      const id = parseInt(row.dataset.id, 10);
      const isCurrent = btn.dataset.current === "1";
      if (isCurrent) {
        const ok = await modal.confirm({
          title: "Sign out this device?",
          body: "You'll be sent back to the login page within a few minutes when this device's access token expires. Other devices stay signed in.",
          confirmLabel: "Sign out",
          danger: true,
        });
        if (!ok) return;
      }
      try {
        await api.del(`/profile/sessions/${id}`);
        toast.success("Session revoked");
        renderSessionsZone();
      } catch (err) {
        toast.fromError(err, "Couldn't revoke session");
      }
    });
  });
  const revokeOthers = document.getElementById("revoke-others-btn");
  if (revokeOthers) {
    revokeOthers.addEventListener("click", async () => {
      const ok = await modal.confirm({
        title: "Sign out other devices?",
        body: "Every other browser signed in to your account will be signed out within a few minutes. This device stays signed in.",
        confirmLabel: "Sign out others",
        danger: true,
      });
      if (!ok) return;
      try {
        const r = await api.post("/profile/sessions/revoke-others");
        toast.success(`${r.revoked} ${r.revoked === 1 ? "session" : "sessions"} revoked`);
        renderSessionsZone();
      } catch (err) {
        toast.fromError(err, "Couldn't revoke sessions");
      }
    });
  }
}

async function changePassword(e) {
  e.preventDefault();
  const cur = document.getElementById("cur").value;
  const a = document.getElementById("new1").value;
  const b = document.getElementById("new2").value;
  if (a !== b) { toast.error("Passwords don't match"); return; }
  // Guard against a slow API + impatient double-click submitting twice.
  const submitBtn = e.target.querySelector('button[type="submit"]');
  await withBusy(submitBtn, async () => {
    try {
      await api.post("/profile/password", { current_password: cur, new_password: a });
      toast.success("Password updated");
      e.target.reset();
    } catch (err) {
      toast.fromError(err, "Couldn't change password");
    }
  }, { busyLabel: "Updating..." });
}

function renderTotpZone() {
  const zone = document.getElementById("totp-zone");
  if (me.two_factor_enabled) {
    zone.innerHTML = `
      <div class="actions">
        <button class="btn btn--danger" id="disable-2fa">${icon("shield", { size: 14 })} Disable 2FA</button>
      </div>
    `;
    document.getElementById("disable-2fa").addEventListener("click", disable2fa);
  } else {
    zone.innerHTML = `
      <div class="actions">
        <button class="btn btn--primary" id="enable-2fa">${icon("shield", { size: 14 })} Set up 2FA</button>
      </div>
    `;
    document.getElementById("enable-2fa").addEventListener("click", setup2fa);
  }
}

async function setup2fa() {
  let setup;
  try {
    setup = await api.get("/profile/2fa/setup");
  } catch (err) {
    toast.fromError(err, "Couldn't begin 2FA setup");
    return;
  }
  // qrcode.js is a non-module vendor lib that publishes window.qrcode.
  // The SPA router skips classic <script> tags in soft-navigated HTML,
  // so we explicitly request it here rather than relying on a tag in
  // profile.html (which only fires on a hard load of /profile).
  try {
    await loadVendorScript("/js/vendor/qrcode.js");
  } catch (err) {
    toast.fromError(err, "Couldn't load the QR generator");
    return;
  }
  const enabled = await modal.open({
    title: "Set up two-factor",
    render(body, close, foot) {
      const qrSvg = (() => {
        const qr = window.qrcode(0, "M");
        qr.addData(setup.otpauth_uri);
        qr.make();
        return qr.createSvgTag({ cellSize: 5, margin: 2 });
      })();
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <p class="totp-setup__intro">
          Add an authenticator app to require a 6-digit code in addition to your
          password at sign-in.
        </p>

        <div class="totp-setup">
          <div class="totp-setup__step">
            <div class="totp-setup__step-no" aria-hidden="true">1</div>
            <div class="totp-setup__step-body">
              <h4 class="totp-setup__step-title">Scan the QR code</h4>
              <p class="totp-setup__step-help">
                Open an authenticator app (1Password, Google Authenticator, Authy, etc.)
                and add a new account.
              </p>
              <div class="totp-setup__scan">
                <div class="totp-setup__qr">${qrSvg}</div>
                <div class="totp-setup__manual">
                  <span class="totp-setup__manual-label">Or enter this key manually</span>
                  <div class="totp-setup__secret-row">
                    <code class="totp-setup__secret" id="totp-secret">${escapeHtml(setup.secret)}</code>
                    <button type="button" class="btn btn--ghost btn--sm totp-setup__copy" id="totp-copy" aria-label="Copy secret">
                      <span class="totp-setup__copy-icon" data-state="idle">${icon("copy", { size: 14 })}</span>
                      <span class="totp-setup__copy-label">Copy</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="totp-setup__step">
            <div class="totp-setup__step-no" aria-hidden="true">2</div>
            <div class="totp-setup__step-body">
              <h4 class="totp-setup__step-title">Enter the 6-digit code</h4>
              <p class="totp-setup__step-help">
                Type the code your authenticator app shows for this account.
              </p>
              <input class="input totp-setup__code" id="otp-input" type="text"
                     inputmode="numeric" maxlength="6" pattern="[0-9]{6}"
                     autocomplete="one-time-code" placeholder="000000"
                     aria-label="6-digit verification code"/>
            </div>
          </div>
        </div>
      `;
      body.appendChild(wrap);

      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));

      const enable = document.createElement("button");
      enable.type = "button"; enable.className = "btn btn--primary"; enable.textContent = "Enable 2FA";
      enable.disabled = true;
      // Verify INSIDE the dialog. Closing first and then hitting the API
      // means a wrong code dismisses the dialog, and the next setup call
      // mints a brand-new secret + QR — the user has to re-pair their
      // authenticator. Resolving on success only keeps the same QR/secret
      // available for retry.
      enable.addEventListener("click", async () => {
        const codeInput = wrap.querySelector("#otp-input");
        const code = codeInput.value;
        if (code.length !== 6) return;
        enable.disabled = true;
        const originalLabel = enable.textContent;
        enable.textContent = "Verifying...";
        try {
          await api.post("/profile/2fa/enable", { code });
          close(true);
        } catch (err) {
          toast.fromError(err, "Enable failed");
          enable.textContent = originalLabel;
          codeInput.value = "";
          codeInput.focus();
          // The input listener flips `enable.disabled` back on/off as
          // the user retypes; we leave it disabled here until then.
        }
      });

      // Code input: enable the primary button only with a complete 6-digit
      // code, and auto-jump focus to it once typing is done so a controller
      // user can press the action button without a Tab.
      const codeInput = wrap.querySelector("#otp-input");
      codeInput.addEventListener("input", () => {
        // Strip non-digits that paste/IME may sneak through.
        const digits = codeInput.value.replace(/\D/g, "").slice(0, 6);
        if (digits !== codeInput.value) codeInput.value = digits;
        const complete = digits.length === 6;
        enable.disabled = !complete;
        if (complete) enable.focus();
      });

      // Copy-to-clipboard with check-mark feedback. Falls back to a toast
      // on browsers/contexts without async clipboard (rare, but http:// or
      // sandboxed iframes can block it).
      const copyBtn = wrap.querySelector("#totp-copy");
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(setup.secret);
          const iconWrap = copyBtn.querySelector(".totp-setup__copy-icon");
          const labelWrap = copyBtn.querySelector(".totp-setup__copy-label");
          iconWrap.dataset.state = "done";
          iconWrap.innerHTML = icon("check", { size: 14 });
          labelWrap.textContent = "Copied";
          setTimeout(() => {
            iconWrap.dataset.state = "idle";
            iconWrap.innerHTML = icon("copy", { size: 14 });
            labelWrap.textContent = "Copy";
          }, 1600);
        } catch {
          toast.warning("Couldn't copy", "Select the key and copy it manually.");
        }
      });

      foot.append(cancel, enable);
    },
  });
  if (!enabled) return;
  toast.success("Two-factor enabled");
  me.two_factor_enabled = true;
  renderTotpZone();
}

async function disable2fa() {
  const result = await modal.open({
    title: "Disable two-factor",
    render(body, close, foot) {
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <p class="lead" style="margin-bottom:16px">Confirm with your password and current 6-digit code to disable 2FA.</p>
        <div class="field"><label class="field__label" for="dis-pwd">Password</label><input class="input" id="dis-pwd" type="password" autocomplete="current-password"/></div>
        <div class="field" style="margin-top:12px"><label class="field__label" for="dis-otp">Authenticator code</label><input class="input" id="dis-otp" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]{6}"/></div>
      `;
      body.appendChild(wrap);
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn btn--danger"; ok.textContent = "Disable 2FA";
      ok.addEventListener("click", () => close({ password: wrap.querySelector("#dis-pwd").value, code: wrap.querySelector("#dis-otp").value }));
      foot.append(cancel, ok);
    },
  });
  if (!result) return;
  try {
    await api.post("/profile/2fa/disable", result);
    toast.success("Two-factor disabled");
    me.two_factor_enabled = false;
    renderTotpZone();
  } catch (err) {
    toast.fromError(err, "Disable failed");
  }
}

/* ---------- dispatch ---------- */

function renderSection() {
  if (active === "account") renderAccount();
  else if (active === "stats") renderMyStats();
  else if (active === "saves") renderMySaves();
  else if (active === "security") renderSecurity();
  else if (active === "controls") renderControls();
}

/* ---------- Controls ---------- */

// Defaults are KeyboardEvent.code values so rebinds are layout-independent
// (a German QWERTZ user picking "Y" still gets KeyY). Two groups, one
// table — game inputs are sent into the emulator, RetroX shortcuts are
// intercepted around it. Both must mirror play.js: SHORTCUT_DEFAULTS
// matches the KB fallback at the keyboard wiring block; GAME_INPUT_DEFAULTS
// matches GAME_INPUT_DEFAULTS in play.js.
const SHORTCUT_DEFAULTS = {
  fast_forward: "Space",
  rewind:       "Backspace",
  save_state:   "F2",
  load_state:   "F4",
  exit_game:    "Escape",
};
const GAME_INPUT_DEFAULTS = {
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
};
// Display order in the unified table: D-pad, face buttons, shoulders,
// menu buttons, then RetroX meta-actions. `gamepad` is the label shown
// in the gamepad column; `note` flips on the asterisk for actions that
// are gated per-emulator.
const BINDINGS = [
  { key: "game_up",     group: "in-game", label: "D-pad Up",      gamepad: "D-pad ↑" },
  { key: "game_down",   group: "in-game", label: "D-pad Down",    gamepad: "D-pad ↓" },
  { key: "game_left",   group: "in-game", label: "D-pad Left",    gamepad: "D-pad ←" },
  { key: "game_right",  group: "in-game", label: "D-pad Right",   gamepad: "D-pad →" },
  { key: "game_a",      group: "in-game", label: "A",             gamepad: "A / ✕" },
  { key: "game_b",      group: "in-game", label: "B",             gamepad: "B / ○" },
  { key: "game_x",      group: "in-game", label: "X",             gamepad: "X / □" },
  { key: "game_y",      group: "in-game", label: "Y",             gamepad: "Y / △" },
  { key: "game_l1",     group: "in-game", label: "L1",            gamepad: "L1" },
  { key: "game_r1",     group: "in-game", label: "R1",            gamepad: "R1" },
  { key: "game_start",  group: "in-game", label: "Start",         gamepad: "Start" },
  { key: "game_select", group: "in-game", label: "Select",        gamepad: "Select" },
  { key: "fast_forward", group: "retrox", label: "Fast forward",  gamepad: "R2",              note: true },
  { key: "rewind",       group: "retrox", label: "Rewind",        gamepad: "L2",              note: true },
  { key: "save_state",   group: "retrox", label: "Save state",    gamepad: "Select + L1" },
  { key: "load_state",   group: "retrox", label: "Load state",    gamepad: "Select + R1" },
  { key: "exit_game",    group: "retrox", label: "Exit game",     gamepad: "Select + Start" },
];
const ALL_DEFAULTS = { ...GAME_INPUT_DEFAULTS, ...SHORTCUT_DEFAULTS };

// One-shot module-level capture state. The keydown listener installed
// at the bottom of the file watches this to know when to intercept.
let _rebindCapture = null;

async function renderControls() {
  paneEl.innerHTML = `<div style="padding:32px;text-align:center"><div class="spinner"></div></div>`;
  let prefs;
  try { prefs = await api.get("/profile/preferences"); } catch { prefs = {}; }
  const stored = (prefs && prefs.keyboard_bindings) || {};
  const effective = (action) => stored[action] || ALL_DEFAULTS[action];

  const renderRow = (b) => `
    <tr>
      <td>${escapeHtml(b.label)}${b.note ? `<sup>*</sup>` : ""}</td>
      <td><strong>${escapeHtml(b.gamepad)}</strong></td>
      <td><button class="btn btn--ghost btn--sm" type="button" data-rebind="${b.key}" style="font-family:var(--font-mono);min-width:96px">${escapeHtml(friendlyKey(effective(b.key)))}</button></td>
    </tr>
  `;
  const inGameRows = BINDINGS.filter(b => b.group === "in-game").map(renderRow).join("");
  const retroxRows = BINDINGS.filter(b => b.group === "retrox").map(renderRow).join("");

  paneEl.innerHTML = `
    <div class="section-card">
      <h2>Navigation</h2>
      <p class="lead">These controls work everywhere in the app — library, game detail, modals, and search.</p>
      <table class="table" style="margin-top:16px">
        <thead><tr><th>Button</th><th>Action</th></tr></thead>
        <tbody>
          <tr><td><strong>D-pad / Left stick</strong></td><td>Move focus between elements</td></tr>
          <tr><td><strong>A / ✕</strong></td><td>Select / Click</td></tr>
          <tr><td><strong>B / ○</strong></td><td>Go back</td></tr>
          <tr><td><strong>X / □</strong></td><td>Open search</td></tr>
          <tr><td><strong>Y / △</strong></td><td>Toggle favorite</td></tr>
          <tr><td><strong>L1 / R1</strong></td><td>Cycle filter chips</td></tr>
          <tr><td><strong>Start</strong></td><td>Primary action (Play)</td></tr>
          <tr><td><strong>Select</strong></td><td>Jump to first game</td></tr>
        </tbody>
      </table>
    </div>
    <div class="section-card">
      <h2>In-game</h2>
      <p class="lead">Click any keyboard binding to change it. Game inputs are sent to the emulator.</p>
      <table class="table" style="margin-top:16px">
        <thead><tr><th>Action</th><th>Gamepad</th><th>Keyboard</th></tr></thead>
        <tbody>
          ${inGameRows}
          <tr class="table__group-row"><td colspan="3">RetroX actions</td></tr>
          ${retroxRows}
        </tbody>
      </table>
      <div style="display:flex;gap:8px;margin-top:16px;align-items:center">
        <button class="btn btn--ghost btn--sm" type="button" id="reset-binds-btn">${icon("refresh", { size: 14 })} Restore defaults</button>
        <span class="field__hint" id="rebind-status" aria-live="polite"></span>
      </div>
      <p class="lead" style="margin-top:12px;font-size:var(--fs-sm);color:var(--text-muted)"><sup>*</sup> Where the emulator supports it. On systems where fast forward is off (e.g. PSX, N64), the gamepad L2/R2 triggers send their normal game input instead and the keyboard equivalents do nothing.</p>
    </div>
  `;

  const status = document.getElementById("rebind-status");
  const setStatus = (msg, isError = false) => {
    status.textContent = msg || "";
    status.style.color = isError ? "var(--danger)" : "var(--text-dim)";
  };

  paneEl.querySelectorAll("button[data-rebind]").forEach(btn => {
    btn.addEventListener("click", () => {
      // Cancel any other pending capture so we never have two highlighted buttons.
      if (_rebindCapture && _rebindCapture.btn !== btn) {
        _rebindCapture.btn.textContent = _rebindCapture.original;
        _rebindCapture = null;
      }
      const action = btn.dataset.rebind;
      const original = btn.textContent;
      btn.textContent = "Press a key…";
      btn.style.color = "var(--accent)";
      _rebindCapture = {
        action,
        btn,
        original,
        commit: async (code) => {
          // Reject keys we can't apply to EJS — the converter is the
          // authoritative list of bindable codes.
          if (!isBindable(code)) {
            setStatus(`${friendlyKey(code)} can't be used as a binding.`, true);
            btn.textContent = original;
            btn.style.color = "";
            return;
          }
          // Conflict scope spans both groups — a key bound to a game input
          // can't simultaneously fire a RetroX shortcut and vice versa.
          const conflict = BINDINGS.find(b => b.key !== action && effective(b.key) === code);
          if (conflict) {
            setStatus(`${friendlyKey(code)} is already used for ${conflict.label}.`, true);
            btn.textContent = original;
            btn.style.color = "";
            return;
          }
          stored[action] = code;
          btn.textContent = friendlyKey(code);
          btn.style.color = "";
          try {
            await api.put("/profile/preferences", { data: { keyboard_bindings: stored } });
            setStatus("Saved. Restart any running game to apply game input changes.");
          } catch (err) {
            toast.fromError(err, "Couldn't save keybinding");
            // Revert local state on failure so the next render reflects what's
            // actually persisted.
            delete stored[action];
            btn.textContent = original;
          }
        },
        cancel: () => {
          btn.textContent = _rebindCapture.original;
          btn.style.color = "";
        },
      };
      setStatus("Press a key (Esc to cancel).");
    });
  });

  document.getElementById("reset-binds-btn").addEventListener("click", async () => {
    if (_rebindCapture) { _rebindCapture.cancel(); _rebindCapture = null; }
    try {
      await api.put("/profile/preferences", { data: { keyboard_bindings: {} } });
      // Patch the existing DOM in place rather than re-rendering the pane.
      // A full re-render flashes a spinner, collapses the page height, and
      // the browser clamps scrollY to the top — jarring when the user is
      // mid-scroll over a tall table.
      for (const k of Object.keys(stored)) delete stored[k];
      paneEl.querySelectorAll("button[data-rebind]").forEach(btn => {
        btn.textContent = friendlyKey(ALL_DEFAULTS[btn.dataset.rebind]);
        btn.style.color = "";
      });
      toast.success("Defaults restored");
      setStatus("");
    } catch (err) {
      toast.fromError(err, "Couldn't restore defaults");
    }
  });
}

// Module-level keydown interceptor for the rebind flow. Capture phase so
// we run before any other listener (the Escape→back handler in play.js
// runs at bubble phase; here we don't care since /profile is its own
// page, but the discipline is right).
function _rebindKeydown(e) {
  if (!_rebindCapture) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === "Escape") {
    _rebindCapture.cancel();
    _rebindCapture = null;
    return;
  }
  // Ignore bare modifier keypresses — wait for an actual key.
  if (["ShiftLeft","ShiftRight","ControlLeft","ControlRight","AltLeft","AltRight","MetaLeft","MetaRight"].includes(e.code)) {
    return;
  }
  const cap = _rebindCapture;
  _rebindCapture = null;
  cap.commit(e.code);
}
// Soft-nav re-imports this module; replace any previously-installed
// handler so listeners don't accumulate across visits.
if (document.__retroxProfileRebindHandler) {
  document.removeEventListener("keydown", document.__retroxProfileRebindHandler, true);
}
document.__retroxProfileRebindHandler = _rebindKeydown;
document.addEventListener("keydown", _rebindKeydown, true);

renderSection();

// Auto-focus the active settings nav item on initial controller-mode
// load (e.g. user opened /profile from a bookmark with a controller in
// hand). Skip if focus is already on something meaningful — soft-nav
// from the user-card menu leaves focus on the user-card and we let
// the user press RIGHT to enter the settings nav from there.
(function autoFocusSettingsNav() {
  if (!isControllerInputMode()) return;
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement) return;
  const target = document.querySelector('#settings-nav [aria-selected="true"]')
              || document.querySelector('#settings-nav button');
  if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
})();
