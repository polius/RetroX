/* Admin > Saves tab.
 *
 * Lists every user's save slots (active + orphaned), with download
 * and delete actions. Orphaned = the slot's game_id no longer exists
 * in the library; the row is shown so admins can clean it up.
 */

import { api } from "../api.js";
import { icon } from "../icons.js";
import { toast, modal } from "../toast.js";
import { escapeHtml } from "../util.js";
import { fmtDate, showMenu } from "./_shared.js";

const TAB_DESCRIPTION =
  "View and manage save files across all users and games.";

let firstLoad = true;
// Cached so the saves table can show display names without re-fetching
// the games list on every re-render. Refreshed when the tab is mounted
// from cold (firstLoad).
let gamesCache = null;

let pane = null;
let me = null;

export async function render(ctx) {
  pane = ctx.pane;
  me = ctx.me;
  return renderSaves();
}

async function ensureGamesCache() {
  if (!gamesCache) {
    try {
      gamesCache = await api.get("/admin/games");
    } catch {
      gamesCache = [];
    }
  }
}

async function renderSaves() {
  const main = document.getElementById("main");
  const scrollY = main ? main.scrollTop : 0;
  if (firstLoad) {
    pane.innerHTML = `<div style="padding:32px"><div class="spinner"></div></div>`;
    firstLoad = false;
  }
  let saves = [];
  try {
    await ensureGamesCache();
    saves = await api.get("/admin/saves");
  } catch (err) { toast.fromError(err, "Couldn't load saves"); return; }

  const gameIndex = gamesCache || [];
  const gameMap = new Map(gameIndex.map(g => [g.id, g]));

  pane.innerHTML = `
    <div class="admin-section-head">
      <span class="admin-section-head__desc">${TAB_DESCRIPTION}</span>
    </div>
    <div class="field" style="margin-bottom:16px">
      <input class="input" id="saves-search" type="search" placeholder="Search by user or game..." autocomplete="off"/>
    </div>
    <div id="saves-table-wrap"></div>
  `;

  function drawTable(filter) {
    const filtered = filter
      ? saves.filter(s => {
          const norm = v => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
          const words = norm(filter).split(/\s+/).filter(Boolean);
          const game = gameMap.get(s.game_id);
          const haystack = norm(s.username) + " " + (game ? norm(game.name) : norm(s.game_id));
          return words.every(w => haystack.includes(w));
        })
      : saves;

    const wrap = document.getElementById("saves-table-wrap");
    if (!filtered.length) {
      wrap.innerHTML = `<div class="empty"><h3>No saves</h3><p>${filter ? "No saves match your search." : "No save slots have been created yet."}</p></div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>User</th><th>Game</th><th>Slot</th><th>Label</th><th>Updated</th><th>Status</th><th style="width:48px"></th></tr></thead>
          <tbody data-nav-group data-nav-up=".admin-tabs" data-nav-left=".sidebar">
            ${filtered.map(s => {
              const game = gameMap.get(s.game_id);
              const orphan = !game;
              return `
                <tr data-id="${s.id}" ${orphan ? 'style="opacity:0.7"' : ''}>
                  <td><strong>${escapeHtml(s.username)}</strong></td>
                  <td>${orphan ? `<span style="color:var(--danger)">${escapeHtml(s.game_id)}</span>` : escapeHtml(game.name)}</td>
                  <td>${s.slot}</td>
                  <td style="color:var(--text-muted)">${escapeHtml(s.name || "—")}</td>
                  <td style="color:var(--text-muted)">${escapeHtml(fmtDate(s.updated_at))}</td>
                  <td>${orphan ? '<span class="pill pill--danger">Orphaned</span>' : '<span class="pill pill--success">Active</span>'}</td>
                  <td><button class="kebab" type="button" data-act="menu">${icon("more", { size: 16 })}</button></td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
    wrap.querySelectorAll('button[data-act="menu"]').forEach(btn => {
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        const id = parseInt(tr.dataset.id, 10);
        const s = saves.find(x => x.id === id);
        showMenu(btn, [
          { label: "Download save",  icon: "download", run: () => downloadSaveFile(s, "save"),  disabled: !s.has_save  },
          { label: "Download state", icon: "download", run: () => downloadSaveFile(s, "state"), disabled: !s.has_state },
          { divider: true },
          { label: "Delete", icon: "trash", danger: true, run: () => deleteAdminSave(s) },
        ]);
      });
    });
  }

  document.getElementById("saves-search").addEventListener("input", (e) => drawTable(e.target.value.trim()));
  drawTable("");
  if (main) requestAnimationFrame(() => { main.scrollTop = scrollY; });
}

async function downloadSaveFile(s, type) {
  try {
    const r = await api.raw(`/admin/saves/${s.id}/${type}`);
    if (!r.ok) { toast.warning("Not found", `This slot has no ${type} file.`); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.username}_${s.game_id}_slot${s.slot}.${type}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) { toast.fromError(err, "Download failed"); }
}

async function deleteAdminSave(s) {
  // Resolve the user-facing name from the games cache populated in
  // renderSaves(). Orphaned slots (the game was removed from the
  // library) have no entry — fall back to the raw game_id so the
  // admin still has *something* to identify the row by.
  const game = (gamesCache || []).find(g => g.id === s.game_id);
  const gameLabel = game ? game.name : s.game_id;
  const ok = await modal.confirm({
    title: `Delete save slot?`,
    body: `This will permanently remove ${s.username}'s slot ${s.slot} for "${gameLabel}".`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/admin/saves/${s.id}`);
    // If the admin is deleting their own save, also clear the local
    // cache so the next launch doesn't resurrect it. We can't reach
    // other users' browsers from here — their offline cache may briefly
    // try to re-upload, but the clean dedup path will catch it.
    if (s.username === me?.username) {
      const { saveCache } = await import("../save-cache.js");
      saveCache.delete(me.username, s.game_id, s.slot).catch(() => {});
    }
    toast.success("Save deleted");
    renderSaves();
  } catch (err) { toast.fromError(err, "Delete failed"); }
}
