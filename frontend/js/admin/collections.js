/* Admin > Collections tab.
 *
 * Collections are global (shared across users); admin-only mutations
 * are gated server-side. After any mutation we also call
 * refreshCollections() so the sidebar's collections list updates
 * without requiring a page reload.
 */

import { api } from "../api.js";
import { icon } from "../icons.js";
import { toast, modal } from "../toast.js";
import { escapeHtml } from "../util.js";
import { fmtDate, showMenu } from "./_shared.js";

const TAB_DESCRIPTION =
  "Group games into custom collections for easy browsing.";

let firstLoad = true;
let pane = null;
let refreshSidebarCollections = () => {};

export async function render(ctx) {
  pane = ctx.pane;
  refreshSidebarCollections = ctx.refreshCollections || (() => {});
  return renderCollections();
}

async function renderCollections() {
  const main = document.getElementById("main");
  const scrollY = main ? main.scrollTop : 0;
  if (firstLoad) {
    pane.innerHTML = `<div style="padding:32px"><div class="spinner"></div></div>`;
    firstLoad = false;
  }
  let collections = [];
  try { collections = await api.get("/collections"); }
  catch { collections = []; }

  let games = [];
  try { const r = await api.get("/games?page=1&page_size=200"); games = r.items || []; }
  catch { games = []; }

  pane.innerHTML = `
    <div class="admin-section-head">
      <span class="admin-section-head__desc">${TAB_DESCRIPTION}</span>
      <button class="btn btn--primary" id="new-coll-btn">${icon("plus", { size: 14 })} Create collection</button>
    </div>
    ${collections.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Games</th><th>Created</th><th style="width:48px"></th></tr></thead>
          <tbody data-nav-group data-nav-up=".admin-tabs" data-nav-left=".sidebar">
            ${collections.map(c => `
              <tr data-id="${c.id}">
                <td><strong>${escapeHtml(c.name)}</strong></td>
                <td>${c.game_count ?? 0}</td>
                <td style="color:var(--text-muted)">${escapeHtml(fmtDate(c.created_at))}</td>
                <td><button class="kebab" type="button" aria-label="Actions" data-act="menu">${icon("more", { size: 16 })}</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : `
      <div class="empty">
        <h3>No collections</h3>
        <p>Create a collection to group games together (e.g. "Pokémon", "Mario").</p>
      </div>
    `}
  `;

  document.getElementById("new-coll-btn").addEventListener("click", () => createCollection(games));

  pane.querySelectorAll('button[data-act="menu"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const tr = btn.closest("tr");
      const c = collections.find(x => String(x.id) === tr.dataset.id);
      showMenu(btn, [
        { label: "Rename", icon: "edit", run: () => renameCollection(c) },
        { label: "Manage games", icon: "library", run: () => manageCollectionGames(c, games) },
        { divider: true },
        { label: "Delete", icon: "trash", danger: true, run: () => deleteCollection(c) },
      ]);
    });
  });
  if (main) requestAnimationFrame(() => { main.scrollTop = scrollY; });
}

async function createCollection(games) {
  const name = await modal.open({
    title: "Create collection",
    render(body, close, foot) {
      const wrap = document.createElement("div");
      wrap.innerHTML = `<div class="field"><label class="field__label" for="cc-name">Collection name</label><input class="input" id="cc-name" type="text" required maxlength="100" placeholder="e.g. Pokémon"/></div>`;
      body.appendChild(wrap);
      const input = wrap.querySelector("#cc-name");
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn btn--primary"; ok.textContent = "Create";
      ok.disabled = true;
      input.addEventListener("input", () => { ok.disabled = !input.value.trim(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !ok.disabled) { e.preventDefault(); ok.click(); }
      });
      ok.addEventListener("click", () => {
        const value = input.value.trim();
        if (!value) {
          toast.warning("Name required", "Enter a name for the collection.");
          input.focus();
          return;
        }
        close(value);
      });
      foot.append(cancel, ok);
    },
  });
  if (!name) return;
  try {
    const created = await api.post("/collections", { name });
    toast.success("Collection created");
    renderCollections();
    refreshSidebarCollections();
    // Immediately open manage games dialog
    manageCollectionGames(created, games);
  } catch (err) { toast.fromError(err, "Create failed"); }
}

async function renameCollection(c) {
  const name = await modal.open({
    title: "Rename collection",
    render(body, close, foot) {
      const wrap = document.createElement("div");
      wrap.innerHTML = `<div class="field"><label class="field__label" for="rc-name">Name</label><input class="input" id="rc-name" type="text" required maxlength="100" value="${escapeHtml(c.name)}"/></div>`;
      body.appendChild(wrap);
      const input = wrap.querySelector("#rc-name");
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn btn--primary"; ok.textContent = "Save";
      input.addEventListener("input", () => { ok.disabled = !input.value.trim(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !ok.disabled) { e.preventDefault(); ok.click(); }
      });
      ok.addEventListener("click", () => {
        const value = input.value.trim();
        if (!value) {
          toast.warning("Name required", "Enter a name for the collection.");
          input.focus();
          return;
        }
        close(value);
      });
      foot.append(cancel, ok);
    },
  });
  if (!name) return;
  try {
    await api.patch(`/collections/${c.id}`, { name });
    toast.success("Renamed");
    renderCollections();
    refreshSidebarCollections();
  } catch (err) { toast.fromError(err, "Rename failed"); }
}

async function manageCollectionGames(c, allGames) {
  let members = [];
  try { members = await api.get(`/collections/${c.id}/games`); } catch { members = []; }
  const memberIds = new Set(members.map(g => g.id));

  await modal.open({
    title: `Games in "${c.name}"`,
    render(body, close, foot) {
      const search = document.createElement("input");
      search.className = "input";
      search.type = "search";
      search.placeholder = "Search games...";
      search.style.marginBottom = "12px";
      body.appendChild(search);

      const list = document.createElement("div");
      list.style.maxHeight = "45vh";
      list.style.overflowY = "auto";
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "2px";
      body.appendChild(list);

      function renderList(filter) {
        const filtered = filter
          ? allGames.filter(g => { const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); const words = norm(filter).split(/\s+/).filter(Boolean); const n = norm(g.name); return words.every(w => n.includes(w)); })
          : allGames;
        list.innerHTML = filtered.map(g => `
          <label class="collection-game-row">
            <input type="checkbox" value="${g.id}" ${memberIds.has(g.id) ? "checked" : ""} class="collection-game-row__check"/>
            <span class="collection-game-row__name">${escapeHtml(g.name)}</span>
            <span class="collection-game-row__system">${(g.system || "").toUpperCase()}</span>
          </label>
        `).join("");
        // Sync checked state from memberIds for items that were checked before filter
        list.querySelectorAll("input[type=checkbox]").forEach(cb => {
          cb.addEventListener("change", () => {
            if (cb.checked) memberIds.add(cb.value);
            else memberIds.delete(cb.value);
          });
        });
      }

      renderList("");
      search.addEventListener("input", () => renderList(search.value.trim()));

      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn btn--primary"; ok.textContent = "Save";
      ok.addEventListener("click", () => close([...memberIds]));
      foot.append(cancel, ok);
    },
  }).then(async (gameIds) => {
    if (!gameIds) return;
    try {
      await api.put(`/collections/${c.id}/games`, { game_ids: gameIds });
      toast.success("Collection updated");
      renderCollections();
    } catch (err) { toast.fromError(err, "Update failed"); }
  });
}

async function deleteCollection(c) {
  const ok = await modal.confirm({
    title: `Delete "${c.name}"?`,
    body: "The collection will be removed. Games themselves are not affected.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/collections/${c.id}`);
    toast.success("Collection deleted");
    renderCollections();
    refreshSidebarCollections();
  } catch (err) { toast.fromError(err, "Delete failed"); }
}
