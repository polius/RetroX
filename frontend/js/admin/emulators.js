/* Admin > Emulators tab.
 *
 * Lists registered (system-folder, EmulatorJS-core) bindings, plus
 * add/edit/delete dialogs. The "core variants installed on disk" hint
 * in the edit dialog is purely informational — the browser picks the
 * variant at load time.
 */

import { api } from "../api.js";
import { icon } from "../icons.js";
import { toast, modal } from "../toast.js";
import { escapeHtml } from "../util.js";
import { showMenu } from "./_shared.js";

const TAB_DESCRIPTION =
  "Configure emulator cores and supported file types for each system.";

let firstLoad = true;
let pane = null;

export async function render(ctx) {
  pane = ctx.pane;
  return renderEmulators();
}

async function renderEmulators() {
  const main = document.getElementById("main");
  const scrollY = main ? main.scrollTop : 0;
  if (firstLoad) {
    pane.innerHTML = `<div style="padding:32px"><div class="spinner"></div></div>`;
    firstLoad = false;
  }
  let emus, cores;
  try {
    [emus, cores] = await Promise.all([
      api.get("/admin/emulators"),
      api.get("/admin/cores").catch(() => []),
    ]);
  } catch (err) {
    toast.fromError(err, "Couldn't load emulators");
    return;
  }
  pane.innerHTML = `
    <div class="admin-section-head">
      <span class="admin-section-head__desc">${TAB_DESCRIPTION}</span>
      <button class="btn btn--primary" id="new-emu-btn">${icon("plus", { size: 14 })} Add emulator</button>
    </div>
    ${emus.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Folder</th>
              <th>Extensions</th>
              <th>Core</th>
              <th style="width:48px"></th>
            </tr>
          </thead>
          <tbody data-nav-group data-nav-up=".admin-tabs" data-nav-left=".sidebar">
            ${emus.map(e => {
              const info = cores.find(c => c.name === e.core);
              const variants = info?.variants || [];
              const variantChips = variants
                .map(v => `<span class="pill" style="font-size:10px;padding:1px 6px;margin-left:4px;color:var(--text-dim)">${v}</span>`)
                .join("");
              return `
                <tr data-id="${e.id}">
                  <td><strong>${escapeHtml(e.name)}</strong></td>
                  <td><code style="background:var(--canvas);padding:2px 6px;border-radius:4px;font-family:var(--font-mono);font-size:12px">${escapeHtml(e.system)}</code></td>
                  <td style="color:var(--text-muted)">${escapeHtml(e.extensions)}</td>
                  <td><span class="pill">${escapeHtml(e.core)}</span>${variantChips}</td>
                  <td><button class="kebab" type="button" aria-label="Emulator actions" data-act="menu">${icon("more", { size: 16 })}</button></td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    ` : `
      <div class="empty">
        <h3>No emulators registered</h3>
        <p>Register an emulator to bind a system folder (e.g. <code>snes</code>, <code>megadrive</code>) to an EmulatorJS core. Click <strong>Add emulator</strong> for the step-by-step guide.</p>
      </div>
    `}
  `;
  document.getElementById("new-emu-btn").addEventListener("click", () => {
    modal.open({
      title: "Add a new emulator",
      render(body, close, foot) {
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:16px">
            <p style="color:var(--text-muted);line-height:1.6">Emulators map a system folder to an EmulatorJS core. Follow these steps:</p>
            <div style="display:flex;flex-direction:column;gap:12px">
              <div style="display:flex;align-items:flex-start;gap:12px">
                <span style="width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:var(--accent-tint);color:var(--accent);font-size:12px;font-weight:700;flex:0 0 24px">1</span>
                <div>
                  <div style="font-weight:600;margin-bottom:2px">Download the core</div>
                  <div style="font-size:13px;color:var(--text-muted)">Get the <code>.data</code> core file from <a href="https://github.com/EmulatorJS/EmulatorJS/releases" target="_blank" rel="noopener" style="color:var(--accent)">EmulatorJS releases</a> and place it in:</div>
                  <code style="display:block;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted);margin-top:4px">retrox-data/cores/<strong style="color:var(--accent)">corename</strong>-wasm.data</code>
                </div>
              </div>
              <div style="display:flex;align-items:flex-start;gap:12px">
                <span style="width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:var(--accent-tint);color:var(--accent);font-size:12px;font-weight:700;flex:0 0 24px">2</span>
                <div>
                  <div style="font-weight:600;margin-bottom:2px">Create the system folder</div>
                  <code style="display:block;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted);margin-top:4px">retrox-data/roms/<strong style="color:var(--accent)">&lt;system&gt;</strong>/</code>
                  <div style="font-size:12px;color:var(--text-dim);margin-top:4px">Use a short lowercase name (e.g. <code>snes</code>, <code>megadrive</code>).</div>
                </div>
              </div>
              <div style="display:flex;align-items:flex-start;gap:12px">
                <span style="width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:var(--accent-tint);color:var(--accent);font-size:12px;font-weight:700;flex:0 0 24px">3</span>
                <div>
                  <div style="font-weight:600;margin-bottom:2px">Register it here</div>
                  <div style="font-size:13px;color:var(--text-muted)">Fill in the form with the display name, system folder, file extensions, and core name.</div>
                </div>
              </div>
            </div>
          </div>
        `;
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => close(undefined));
        const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn btn--primary"; ok.textContent = "Continue to form";
        ok.addEventListener("click", () => close(true));
        foot.append(cancel, ok);
      },
    }).then(proceed => { if (proceed) createOrEditEmu(null, cores); });
  });
  pane.querySelectorAll('button[data-act="menu"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const tr = btn.closest("tr");
      const id = parseInt(tr.dataset.id, 10);
      const e = emus.find(x => x.id === id);
      showMenu(btn, [
        { label: "Edit", icon: "edit", run: () => createOrEditEmu(e, cores) },
        { divider: true },
        { label: "Delete", icon: "trash", danger: true, run: () => deleteEmulator(e) },
      ]);
    });
  });
  if (main) requestAnimationFrame(() => { main.scrollTop = scrollY; });
}

async function createOrEditEmu(existing, cores) {
  const result = await modal.open({
    title: existing ? "Edit emulator" : "Add emulator",
    render(body, close, foot) {
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <form id="emu-form" autocomplete="off">
          <div class="field"><label class="field__label" for="ef-name">Display name</label><input class="input" id="ef-name" type="text" required value="${escapeHtml(existing?.name || "")}"/></div>
          <div class="field" style="margin-top:12px">
            <label class="field__label" for="ef-system">System folder</label>
            <input class="input" id="ef-system" type="text" required pattern="[a-z0-9_]+" value="${escapeHtml(existing?.system || "")}" ${existing ? "disabled" : ""}/>
            <span class="field__hint">Lowercase + digits + underscore. Must match the folder under your library root.</span>
          </div>
          <div class="field" style="margin-top:12px">
            <label class="field__label" for="ef-ext">Extensions (comma separated)</label>
            <input class="input" id="ef-ext" type="text" required value="${escapeHtml(existing?.extensions || "")}"/>
          </div>
          <div class="field" style="margin-top:12px">
            <label class="field__label" for="ef-core">Core</label>
            ${cores.length
              ? `<select class="select" id="ef-core" required>${cores.map(c => `<option value="${escapeHtml(c.name)}" ${existing?.core === c.name ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select>
                 <span class="field__hint" id="ef-core-variants" aria-live="polite"></span>`
              : `<input class="input" id="ef-core" type="text" required value="${escapeHtml(existing?.core || "")}"/>`}
          </div>
          <div class="field" style="margin-top:28px">
            <label class="checkbox" style="font-size:var(--fs-sm)"><input type="checkbox" id="ef-ff" ${existing?.fast_forward_enabled !== false ? "checked" : ""}/> Enable fast forward</label>
            <span class="field__hint">Hold R2 to fast-forward. It is better to disable it for systems whose games use R2 natively (PSX, PS2, N64).</span>
          </div>
          <div class="field" style="margin-top:20px">
            <label class="checkbox" style="font-size:var(--fs-sm)"><input type="checkbox" id="ef-rw" ${existing?.rewind_enabled ? "checked" : ""}/> Enable rewind</label>
            <span class="field__hint" id="ef-rw-hint">Hold L2 to rewind the last few seconds of gameplay. Supported cores: gambatte, mgba, snes9x, fceumm, genesis_plus_gx.</span>
          </div>
        </form>
      `;
      body.appendChild(wrap);

      // Live hint reflecting which compiled variants of the selected core
      // are present on disk. The browser picks one automatically — this
      // just lets the admin verify the file set is what they expect.
      const coreSelect = wrap.querySelector("#ef-core");
      const variantHint = wrap.querySelector("#ef-core-variants");
      if (coreSelect && variantHint && coreSelect.tagName === "SELECT") {
        const renderVariantHint = () => {
          const sel = cores.find(c => c.name === coreSelect.value);
          if (!sel || sel.variants.length === 0) {
            variantHint.textContent = "";
            return;
          }
          const list = sel.variants.join(" + ");
          variantHint.textContent = `Installed variants: ${list}. The browser picks one automatically.`;
        };
        coreSelect.addEventListener("change", renderVariantHint);
        renderVariantHint();
      }

      // Rewind shares L2 with fast-forward — toggling fast-forward off
      // makes rewind impossible to bind, so disable + uncheck it.
      const ffCheckbox = wrap.querySelector("#ef-ff");
      const rwCheckbox = wrap.querySelector("#ef-rw");
      const syncRewindAvailability = () => {
        if (!ffCheckbox.checked) {
          rwCheckbox.checked = false;
          rwCheckbox.disabled = true;
        } else {
          rwCheckbox.disabled = false;
        }
      };
      ffCheckbox.addEventListener("change", syncRewindAvailability);
      syncRewindAvailability();

      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn btn--primary"; ok.textContent = "Save";
      // Run the save INSIDE the dialog. Closing first and then calling
      // the API means a backend rejection (duplicate folder, missing
      // core file, schema validation, etc.) dismisses the form and
      // discards what the admin typed — they'd have to reopen and
      // re-enter everything. Resolving on success only keeps the form
      // available with their values intact for retry.
      ok.addEventListener("click", async () => {
        const payload = {
          name: wrap.querySelector("#ef-name").value.trim(),
          system: (wrap.querySelector("#ef-system").value || existing?.system || "").trim(),
          extensions: wrap.querySelector("#ef-ext").value.trim(),
          core: wrap.querySelector("#ef-core").value.trim(),
          fast_forward_enabled: ffCheckbox.checked,
          rewind_enabled: rwCheckbox.checked,
        };
        // Cheap client-side gate so we don't roundtrip to learn the
        // backend would have rejected an empty required field.
        const missing = [];
        if (!payload.name) missing.push("Display name");
        if (!payload.system) missing.push("System folder");
        if (!payload.extensions) missing.push("Extensions");
        if (!payload.core) missing.push("Core");
        if (missing.length) {
          toast.warning("Missing fields", `Please fill in: ${missing.join(", ")}.`);
          return;
        }
        ok.disabled = true;
        const originalLabel = ok.textContent;
        ok.textContent = "Saving...";
        try {
          if (existing) {
            await api.patch(`/admin/emulators/${existing.id}`, {
              name: payload.name,
              extensions: payload.extensions,
              core: payload.core,
              fast_forward_enabled: payload.fast_forward_enabled,
              rewind_enabled: payload.rewind_enabled,
            });
          } else {
            await api.post("/admin/emulators", payload);
          }
          close(true);
        } catch (err) {
          toast.fromError(err, "Save failed");
          ok.textContent = originalLabel;
          ok.disabled = false;
        }
      });
      foot.append(cancel, ok);
    },
  });
  if (!result) return;
  toast.success(existing ? "Emulator updated" : "Emulator added");
  renderEmulators();
}

async function deleteEmulator(e) {
  const ok = await modal.confirm({
    title: `Delete emulator "${e.name}"?`,
    body: "Games on disk will remain, but they won't load until another emulator is configured for this system folder.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/admin/emulators/${e.id}`);
    toast.success("Emulator deleted");
    renderEmulators();
  } catch (err) {
    toast.fromError(err, "Delete failed");
  }
}
