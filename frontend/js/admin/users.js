/* Admin > Users tab.
 *
 * One render() entry point; everything else (modals, kebab actions,
 * row mutations) is module-private. Holds its own first-load flag so
 * the spinner only appears on the very first mount within a session.
 */

import { api } from "../api.js";
import { icon } from "../icons.js";
import { toast, modal } from "../toast.js";
import { escapeHtml, attachUsernameValidation } from "../util.js";
import { fmtDate, showMenu } from "./_shared.js";

const TAB_DESCRIPTION =
  "Create and manage user accounts, roles, and authentication.";

let firstLoad = true;
let pane = null;
let me = null;

export async function render(ctx) {
  pane = ctx.pane;
  me = ctx.me;
  return renderUsers();
}

async function renderUsers() {
  const main = document.getElementById("main");
  const scrollY = main ? main.scrollTop : 0;
  if (firstLoad) {
    pane.innerHTML = `<div style="padding:32px"><div class="spinner"></div></div>`;
    firstLoad = false;
  }
  let users = [];
  try { users = await api.get("/admin/users"); }
  catch (err) { toast.fromError(err, "Couldn't load users"); return; }

  pane.innerHTML = `
    <div class="admin-section-head">
      <span class="admin-section-head__desc">${TAB_DESCRIPTION}</span>
      <button class="btn btn--primary" id="new-user-btn">${icon("plus", { size: 14 })} Create user</button>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>2FA</th>
            <th>Last sign-in</th>
            <th>Created</th>
            <th style="width:48px"></th>
          </tr>
        </thead>
        <tbody data-nav-group data-nav-up=".admin-tabs" data-nav-left=".sidebar">
          ${users.map(u => `
            <tr data-id="${u.id}">
              <td><strong>${escapeHtml(u.username)}</strong></td>
              <td>${u.is_admin ? `<span class="pill pill--accent">Admin</span>` : `<span class="pill">Member</span>`}</td>
              <td>${u.two_factor_enabled ? `<span class="pill pill--success">Enabled</span>` : `<span class="pill">Off</span>`}</td>
              <td style="color:var(--text-muted)">${escapeHtml(fmtDate(u.last_login))}</td>
              <td style="color:var(--text-muted)">${escapeHtml(fmtDate(u.created_at))}</td>
              <td><button class="kebab" type="button" aria-label="User actions" data-act="menu">${icon("more", { size: 16 })}</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById("new-user-btn").addEventListener("click", createUser);
  pane.querySelectorAll('button[data-act="menu"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const tr = btn.closest("tr");
      const id = parseInt(tr.dataset.id, 10);
      const u = users.find(x => x.id === id);
      openUserMenu(btn, u);
    });
  });
  if (main) requestAnimationFrame(() => { main.scrollTop = scrollY; });
}

function openUserMenu(anchor, u) {
  const isSelf = u.username === me.username;
  const items = [
    { label: "Change username", icon: "edit", run: () => renameUser(u) },
    { label: "Change password", icon: "key", run: () => changePassword(u) },
    u.is_admin
      ? { label: "Demote to member", icon: "user", run: () => setAdmin(u, false), disabled: isSelf }
      : { label: "Promote to admin", icon: "shield", run: () => setAdmin(u, true) },
    { label: "Remove 2FA", icon: "shield", run: () => disable2fa(u), disabled: !u.two_factor_enabled },
    { divider: true },
    { label: "Delete user", icon: "trash", danger: true, run: () => deleteUser(u), disabled: isSelf },
  ].filter(Boolean);
  showMenu(anchor, items);
}

async function createUser() {
  const result = await modal.open({
    title: "Create user",
    render(body, close, foot) {
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <form id="cu-form" autocomplete="off" style="display:flex;flex-direction:column;gap:14px">
          <div class="field">
            <label class="field__label" for="cu-username">Username</label>
            <input class="input" id="cu-username" type="text" required autocomplete="off" autocapitalize="none" spellcheck="false" style="text-transform: lowercase"/>
            <span class="field__hint" id="cu-username-hint" hidden></span>
          </div>
          <div class="field">
            <label class="field__label" for="cu-password">Password</label>
            <input class="input" id="cu-password" type="password" minlength="8" required autocomplete="new-password"/>
            <span class="field__hint">At least 8 characters.</span>
          </div>
          <label class="checkbox" style="margin-top:4px;font-size:var(--fs-sm)">
            <input type="checkbox" id="cu-admin"/> Administrator
          </label>
        </form>
      `;
      body.appendChild(wrap);
      const usernameInput = wrap.querySelector("#cu-username");
      const usernameHint = wrap.querySelector("#cu-username-hint");
      let usernameValid = false;
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const okBtn = document.createElement("button"); okBtn.type = "button"; okBtn.className = "btn btn--primary"; okBtn.textContent = "Create";
      okBtn.disabled = true;
      attachUsernameValidation(usernameInput, usernameHint, {
        onValidChange: (ok) => {
          usernameValid = ok;
          okBtn.disabled = !ok;
        },
      });
      okBtn.addEventListener("click", () => {
        if (!usernameValid) return;
        const password = wrap.querySelector("#cu-password").value;
        if (password.length < 8) {
          toast.warning("Password too short", "Password must be at least 8 characters.");
          return;
        }
        close({
          username: usernameInput.value.trim(),
          password,
          is_admin: wrap.querySelector("#cu-admin").checked,
        });
      });
      foot.append(cancel, okBtn);
    },
  });
  if (!result) return;
  try {
    await api.post("/admin/users", result);
    toast.success("User created");
    renderUsers();
  } catch (err) {
    toast.fromError(err, "Create failed");
  }
}

async function renameUser(u) {
  const newName = await modal.open({
    title: `Rename ${u.username}`,
    render(body, close, foot) {
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <div class="field">
          <label class="field__label" for="ru-name">New username</label>
          <input class="input" id="ru-name" type="text" required autocomplete="off" autocapitalize="none" spellcheck="false" style="text-transform: lowercase" value="${escapeHtml(u.username)}"/>
          <span class="field__hint" id="ru-name-hint" hidden></span>
        </div>
      `;
      body.appendChild(wrap);
      const input = wrap.querySelector("#ru-name");
      const hint = wrap.querySelector("#ru-name-hint");
      let valid = true; // pre-existing names are accepted as-is unless edited to invalid
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const okBtn = document.createElement("button"); okBtn.type = "button"; okBtn.className = "btn btn--primary"; okBtn.textContent = "Rename";
      attachUsernameValidation(input, hint, {
        onValidChange: (ok) => { valid = ok; okBtn.disabled = !ok; },
      });
      okBtn.addEventListener("click", () => { if (valid) close(input.value.trim()); });
      foot.append(cancel, okBtn);
      // Modal auto-focuses the first input — pre-select its contents
      // so a single keystroke replaces the whole name.
      requestAnimationFrame(() => input.select());
    },
  });
  if (!newName || newName === u.username) return;
  try {
    await api.patch(`/admin/users/${u.id}`, { username: newName });
    toast.success("Username updated");
    renderUsers();
  } catch (err) {
    toast.fromError(err, "Rename failed");
  }
}

async function changePassword(u) {
  const newPwd = await modal.open({
    title: `Change password for ${u.username}`,
    render(body, close, foot) {
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <p style="margin-bottom:16px;color:var(--text-muted);line-height:1.6">Set a new password for this user.</p>
        <div class="field">
          <label class="field__label" for="rp-pwd">New password</label>
          <input class="input" id="rp-pwd" type="password" minlength="8" autocomplete="new-password" required/>
          <span class="field__hint">At least 8 characters.</span>
        </div>
        <div class="field" style="margin-top:12px">
          <label class="field__label" for="rp-pwd2">Repeat new password</label>
          <input class="input" id="rp-pwd2" type="password" minlength="8" autocomplete="new-password" required/>
          <span class="field__hint" id="rp-pwd2-hint" hidden></span>
        </div>
      `;
      body.appendChild(wrap);
      const pwd = wrap.querySelector("#rp-pwd");
      const pwd2 = wrap.querySelector("#rp-pwd2");
      const hint = wrap.querySelector("#rp-pwd2-hint");
      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const ok = document.createElement("button");
      ok.type = "button"; ok.className = "btn btn--primary"; ok.textContent = "Change password";
      ok.disabled = true;
      // Live validation: enable the primary button only when both
      // fields are filled, match exactly, and meet the length floor.
      // We deliberately stay quiet until the second field has any
      // content — flagging a mismatch on every keystroke while the
      // user is still typing the first character is noisy.
      function validate() {
        const a = pwd.value;
        const b = pwd2.value;
        if (b.length === 0) {
          hint.hidden = true;
          delete hint.dataset.state;
          ok.disabled = true;
          return;
        }
        if (a !== b) {
          hint.textContent = "Passwords don't match.";
          hint.dataset.state = "error";
          hint.hidden = false;
          ok.disabled = true;
          return;
        }
        if (a.length < 8) {
          hint.textContent = "At least 8 characters.";
          hint.dataset.state = "error";
          hint.hidden = false;
          ok.disabled = true;
          return;
        }
        hint.hidden = true;
        delete hint.dataset.state;
        ok.disabled = false;
      }
      pwd.addEventListener("input", validate);
      pwd2.addEventListener("input", validate);
      ok.addEventListener("click", () => close(pwd.value));
      foot.append(cancel, ok);
    },
  });
  if (!newPwd) return;
  try {
    await api.patch(`/admin/users/${u.id}`, { password: newPwd });
    toast.success("Password changed");
  } catch (err) {
    toast.fromError(err, "Couldn't change password");
  }
}

async function setAdmin(u, makeAdmin) {
  try {
    await api.patch(`/admin/users/${u.id}`, { is_admin: makeAdmin });
    toast.success(makeAdmin ? "Promoted" : "Demoted");
    renderUsers();
  } catch (err) {
    toast.fromError(err, "Update failed");
  }
}

async function disable2fa(u) {
  const ok = await modal.confirm({
    title: `Remove 2FA for ${u.username}?`,
    body: "This removes their TOTP secret. They'll be able to sign in with password only until they re-enable it.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.patch(`/admin/users/${u.id}`, { disable_2fa: true });
    toast.success("2FA removed");
    renderUsers();
  } catch (err) {
    toast.fromError(err, "Update failed");
  }
}

async function deleteUser(u) {
  const ok = await modal.confirm({
    title: `Delete ${u.username}?`,
    body: "Their account, save slots and on-disk save files will be removed. This can't be undone.",
    confirmLabel: "Delete user",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/admin/users/${u.id}`);
    toast.success("User deleted");
    renderUsers();
  } catch (err) {
    toast.fromError(err, "Delete failed");
  }
}
