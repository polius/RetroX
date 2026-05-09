/* Admin > Library tab.
 *
 * Game list + per-game edit / cover / delete actions, plus a "rescan
 * filesystem" trigger. Calls invalidatePalette() after any mutation
 * that could change what the command palette would show (rename,
 * delete, rescan).
 */

import { api } from "../api.js";
import { icon } from "../icons.js";
import { toast, modal } from "../toast.js";
import { escapeHtml } from "../util.js";
import { fmtDate, showMenu } from "./_shared.js";

const TAB_DESCRIPTION =
  "Scan for new games, manage covers, and organize your ROM library.";

let firstLoad = true;
// Bumped after a mutation so cover-image src URLs change and the
// browser re-fetches them instead of showing a stale cached image.
let cacheBust = Date.now();

let pane = null;
let invalidatePalette = () => {};

export async function render(ctx) {
  pane = ctx.pane;
  invalidatePalette = ctx.invalidatePalette || (() => {});
  return renderLibrary();
}

async function renderLibrary() {
  const main = document.getElementById("main");
  const scrollY = main ? main.scrollTop : 0;
  if (firstLoad) {
    pane.innerHTML = `<div style="padding:32px"><div class="spinner"></div></div>`;
    firstLoad = false;
  }
  let status, games;
  try {
    [status, games] = await Promise.all([
      api.get("/admin/library"),
      api.get("/admin/games"),
    ]);
  } catch (err) {
    toast.fromError(err, "Couldn't load library");
    return;
  }
  games.sort((a, b) => a.system.localeCompare(b.system) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  pane.innerHTML = `
    <p style="color:var(--text-muted);font-size:var(--fs-sm);margin-bottom:16px">${TAB_DESCRIPTION}</p>
    <div class="lib-status">
      <span><span class="lib-status__count">${status.indexed}</span> games indexed</span>
      <span class="spacer"></span>
      <span style="color:var(--text-dim);font-size:var(--fs-sm)">Last scan ${escapeHtml(fmtDate(status.scanned_at))}</span>
      <button class="btn btn--secondary" id="rescan-btn">${icon("refresh", { size: 14 })} Rescan</button>
      <button class="btn btn--primary" id="add-game-btn">${icon("info", { size: 14 })} How to add games</button>
    </div>

    <div class="field" style="margin-bottom:16px">
      <input class="input" id="lib-search" type="search" placeholder="Search by name..." autocomplete="off"/>
    </div>

    <div id="lib-table-wrap"></div>
  `;

  document.getElementById("rescan-btn").addEventListener("click", async () => {
    try {
      await api.post("/admin/library/scan");
      // Names, slugs, or the entire game set may have changed —
      // drop the palette cache so the next open reflects the rescan.
      invalidatePalette();
      toast.success("Library rescanned");
      renderLibrary();
    } catch (err) {
      toast.fromError(err, "Rescan failed");
    }
  });

  document.getElementById("add-game-btn").addEventListener("click", openHowToAddGames);

  const search = document.getElementById("lib-search");
  let st = null;

  function renderTableBody(filtered) {
    const wrap = document.getElementById("lib-table-wrap");
    if (!filtered.length) {
      wrap.innerHTML = games.length
        ? `<div class="empty"><h3>No matches</h3><p>No games match your search.</p></div>`
        : `<div class="empty">
             <h3>No games yet</h3>
             <p>Drop ROM files into the system folders under your data volume (e.g. <code>roms/gb/</code>, <code>roms/psx/</code>) and click <strong>Rescan</strong> to index them. See <em>How to add games</em> for the full guide.</p>
           </div>`;
      return;
    }
    filtered.sort((a, b) => a.system.localeCompare(b.system) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    wrap.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th style="width:64px"></th>
              <th>Name</th>
              <th>System</th>
              <th>Discs</th>
              <th>Saves</th>
              <th style="width:48px"></th>
            </tr>
          </thead>
          <tbody data-nav-group data-nav-up=".admin-tabs" data-nav-left=".sidebar">
            ${filtered.map(g => rowHTML(g)).join("")}
          </tbody>
        </table>
      </div>
    `;
    bindGameMenus(filtered);
  }

  function bindGameMenus(list) {
    pane.querySelectorAll('button[data-act="menu"]').forEach(btn => {
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        const id = tr.dataset.id;
        const g = list.find(x => x.id === id);
        openGameMenu(btn, g);
      });
    });
  }

  search.addEventListener("input", () => {
    clearTimeout(st);
    st = setTimeout(() => {
      const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const words = norm(search.value.trim()).split(/\s+/).filter(Boolean);
      const filtered = words.length ? games.filter(g => { const n = norm(g.name); return words.every(w => n.includes(w)); }) : games;
      renderTableBody(filtered);
    }, 150);
  });

  renderTableBody(games);
  if (main) requestAnimationFrame(() => { main.scrollTop = scrollY; });
}

function rowHTML(g) {
  const cover = g.has_cover
    ? `${api.url(`/games/${encodeURIComponent(g.id)}/cover`)}?t=${cacheBust}`
    : "/images/default-cover.svg";
  return `
    <tr data-id="${escapeHtml(g.id)}">
      <td><img class="cover-thumb" loading="lazy" src="${cover}" alt=""/></td>
      <td>
        <div style="font-weight:600">${escapeHtml(g.name)}</div>
        <div style="color:var(--text-dim);font-size:var(--fs-xs);font-family:var(--font-mono)">${escapeHtml(g.file_name)}</div>
      </td>
      <td><span class="pill">${escapeHtml((g.system || "").toUpperCase())}</span></td>
      <td>${g.disks}</td>
      <td>${g.slot_count} <span style="color:var(--text-dim)">(${g.user_count} users)</span></td>
      <td><button class="kebab" type="button" aria-label="Game actions" data-act="menu">${icon("more", { size: 16 })}</button></td>
    </tr>
  `;
}

function openGameMenu(anchor, g) {
  showMenu(anchor, [
    { label: "Edit game", icon: "edit", run: () => editGame(g) },
    { divider: true },
    { label: "Delete game", icon: "trash", danger: true, run: () => deleteGame(g) },
  ]);
}

async function editGame(g) {
  const coverSrc = g.has_cover ? api.url(`/games/${encodeURIComponent(g.id)}/cover`) + `?t=${cacheBust}` : null;
  let newCoverFile = null;
  let removeCoverFlag = false;

  const result = await modal.open({
    title: "Edit game",
    render(body, close, foot) {
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="field">
            <label class="field__label">System</label>
            <input class="input" type="text" value="${escapeHtml((g.system || '').toUpperCase())}" disabled style="opacity:0.6"/>
          </div>
          <div class="field">
            <label class="field__label" for="eg-name">Name</label>
            <input class="input" id="eg-name" type="text" maxlength="200" value="${escapeHtml(g.name)}"/>
          </div>
          <div class="field">
            <label class="field__label" for="eg-desc">Description</label>
            <textarea class="textarea" id="eg-desc" maxlength="2000" rows="3" placeholder="Optional overview or notes...">${escapeHtml(g.description || "")}</textarea>
          </div>
          <div class="field">
            <label class="field__label" for="eg-release">Release date</label>
            <input class="input" id="eg-release" type="text" maxlength="20" placeholder="e.g. September 07, 2005" value="${escapeHtml(g.release_date || "")}"/>
          </div>
          <div class="field">
            <label class="field__label">Cover</label>
            <div id="eg-cover-zone" style="display:flex;align-items:center;gap:16px;padding:12px;border:1px dashed var(--border);border-radius:8px;min-height:80px;cursor:pointer;transition:border-color .15s">
              <img id="eg-cover-preview" src="${coverSrc || "/images/default-cover.svg"}" style="width:56px;height:56px;object-fit:contain;border-radius:4px;background:var(--surface-2)"/>
              <div style="flex:1">
                <div style="font-size:var(--fs-sm);color:var(--text-muted)" id="eg-cover-label">${coverSrc ? "Drop image to replace" : "Drop image or click to upload"}</div>
              </div>
              ${g.custom_cover ? `<button type="button" class="btn btn--ghost btn--sm" id="eg-cover-remove" style="color:var(--danger)">Remove</button>` : ""}
            </div>
            <input type="file" id="eg-cover-input" accept="image/*" hidden/>
          </div>
        </div>
      `;
      const zone = body.querySelector("#eg-cover-zone");
      const preview = body.querySelector("#eg-cover-preview");
      const label = body.querySelector("#eg-cover-label");
      const fileInput = body.querySelector("#eg-cover-input");
      const removeBtn = body.querySelector("#eg-cover-remove");

      zone.addEventListener("click", (e) => { if (e.target !== removeBtn && !removeBtn?.contains(e.target)) fileInput.click(); });
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.style.borderColor = "var(--accent)"; });
      zone.addEventListener("dragleave", () => { zone.style.borderColor = ""; });
      zone.addEventListener("drop", (e) => {
        e.preventDefault(); zone.style.borderColor = "";
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith("image/")) setCoverFile(file);
      });
      fileInput.addEventListener("change", () => { if (fileInput.files[0]) setCoverFile(fileInput.files[0]); });
      if (removeBtn) removeBtn.addEventListener("click", (e) => {
        e.stopPropagation(); removeCoverFlag = true; newCoverFile = null;
        preview.src = "/images/default-cover.svg";
        label.textContent = "Cover will be removed";
        removeBtn.remove();
      });
      function setCoverFile(file) { newCoverFile = file; removeCoverFlag = false; preview.src = URL.createObjectURL(file); label.textContent = file.name; }

      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const save = document.createElement("button"); save.type = "button"; save.className = "btn btn--primary"; save.textContent = "Save";
      save.addEventListener("click", () => close({ name: body.querySelector("#eg-name").value.trim(), description: body.querySelector("#eg-desc").value.trim(), release_date: body.querySelector("#eg-release").value.trim() }));
      foot.append(cancel, save);
    },
  });
  if (!result) return;
  try {
    await api.patch(`/admin/games/${encodeURIComponent(g.id)}/name`, { name: result.name, description: result.description, release_date: result.release_date });
    if (removeCoverFlag) await api.del(`/admin/games/${encodeURIComponent(g.id)}/cover`);
    else if (newCoverFile) { const fd = new FormData(); fd.append("file", newCoverFile); await api.upload(`/admin/games/${encodeURIComponent(g.id)}/cover`, fd, { method: "POST" }); }
    // The display name (what the palette searches against) may have
    // changed; covers are not in the palette so they don't matter.
    invalidatePalette();
    toast.success("Game updated");
    cacheBust = Date.now();
    renderLibrary();
  } catch (err) { toast.fromError(err, "Update failed"); }
}

async function deleteGame(g) {
  const ok = await modal.confirm({
    title: `Delete ${g.name}?`,
    body: "The ROM file, custom cover, and every user's save slots for this game will be removed. This can't be undone.",
    confirmLabel: "Delete game",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/admin/games/${encodeURIComponent(g.id)}`, { "X-Confirm-Delete": g.id });
    invalidatePalette();
    toast.success("Game deleted");
    renderLibrary();
  } catch (err) {
    toast.fromError(err, "Delete failed");
  }
}

function openHowToAddGames() {
  modal.open({
    title: "How to add games",
    render(body, close, foot) {
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:16px">
          <p style="color:var(--text-muted);line-height:1.6">Place ROM files into the correct system folder inside your mounted data volume, then rescan.</p>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div style="display:flex;align-items:flex-start;gap:12px">
              <span style="width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:var(--accent-tint);color:var(--accent);font-size:12px;font-weight:700;flex:0 0 24px">1</span>
              <div>
                <div style="font-weight:600;margin-bottom:2px">Copy ROM files to the system folder</div>
                <code style="display:block;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted);margin-top:4px">retrox-data/roms/<strong style="color:var(--accent)">&lt;system&gt;</strong>/game.rom</code>
                <div style="font-size:12px;color:var(--text-dim);margin-top:4px">System folders: <strong>gb</strong>, <strong>gbc</strong>, <strong>gba</strong>, <strong>psx</strong>, <strong>n64</strong>, or any custom emulator folder.</div>
              </div>
            </div>
            <div style="display:flex;align-items:flex-start;gap:12px">
              <span style="width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:var(--accent-tint);color:var(--accent);font-size:12px;font-weight:700;flex:0 0 24px">2</span>
              <div>
                <div style="font-weight:600;margin-bottom:2px">Multi-disc games (PSX)</div>
                <code style="display:block;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted);margin-top:4px">roms/psx/Final Fantasy VII/<br>├── disc1.cue<br>├── disc2.cue<br>└── metadata.json <span style="color:var(--text-dim)">(optional)</span></code>
              </div>
            </div>
            <div style="display:flex;align-items:flex-start;gap:12px">
              <span style="width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:var(--accent-tint);color:var(--accent);font-size:12px;font-weight:700;flex:0 0 24px">3</span>
              <div>
                <div style="font-weight:600;margin-bottom:2px">Click Rescan</div>
                <div style="font-size:13px;color:var(--text-muted)">RetroX will detect new files and add them to the library.</div>
              </div>
            </div>
          </div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;color:var(--text-muted);line-height:1.5">
            <strong style="color:var(--text)">Supported formats:</strong> .gb, .gbc, .gba, .n64, .z64, .v64, .bin, .cue, .iso, .chd, .pbp — all also accept .gz compression.
          </div>
        </div>
      `;
      const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn btn--primary"; ok.textContent = "Got it";
      ok.addEventListener("click", () => close());
      foot.appendChild(ok);
    },
  });
}
