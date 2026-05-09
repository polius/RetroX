/* Shared helpers for the admin tabs.
 *
 * Anything used by more than one tab module lives here so the per-tab
 * files (users / library / emulators / collections / saves) can stay
 * focused on a single concern. Keep this file small — when a helper
 * is only used by one tab, prefer keeping it next to its caller.
 */

import { icon } from "../icons.js";
import { escapeHtml } from "../util.js";

export function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Run `fn`, then restore the main scroll container's vertical scroll
 *  position on the next frame. Used after a re-render to avoid the
 *  page jumping back to the top while the user was halfway down. */
export function preserveScroll(fn) {
  const main = document.getElementById("main");
  const top = main ? main.scrollTop : 0;
  fn();
  if (main) requestAnimationFrame(() => { main.scrollTop = top; });
}

/** Open a native file picker and resolve with the chosen file (or null). */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    if (accept) inp.accept = accept;
    inp.onchange = () => resolve(inp.files && inp.files[0] || null);
    inp.click();
  });
}

/* -------- Floating action menu (kebab popover) ----------
 *
 * One menu open at a time, app-wide. The state below is module-private
 * — `showMenu` toggles, dismisses on outside click, and cancels its
 * own deferred listener install if the menu is closed before it fires
 * (otherwise we'd leak one document listener per open/close cycle).
 */

let _openMenu = null;
let _openAnchor = null;
let _dismissFn = null;
let _dismissAttachTimer = null;

export function showMenu(anchor, items) {
  // Toggle: clicking the same anchor again closes the menu.
  if (_openMenu && _openAnchor === anchor) { closeAllMenus(); return; }
  closeAllMenus();

  const m = document.createElement("div");
  m.className = "menu";
  m.dataset.open = "true";
  m.innerHTML = items.map(i => i.divider
    ? `<div class="menu__divider"></div>`
    : `<button class="menu__item ${i.danger ? "menu__item--danger" : ""}" type="button" ${i.disabled ? 'disabled style="opacity:0.4;pointer-events:none"' : ""}>${icon(i.icon || "dot", { size: 14 })}<span>${escapeHtml(i.label)}</span></button>`
  ).join("");
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + 4}px`;
  m.style.left = `${Math.min(r.left, window.innerWidth - m.offsetWidth - 16)}px`;

  _openMenu = m;
  _openAnchor = anchor;

  let i = 0;
  m.querySelectorAll("button").forEach(b => {
    const item = items.filter(x => !x.divider)[i++];
    b.addEventListener("click", () => { closeAllMenus(); if (item && item.run) item.run(); });
  });

  _dismissFn = (e) => {
    if (m.contains(e.target) || e.target === anchor || anchor.contains(e.target)) return;
    closeAllMenus();
  };
  // Defer install so the click that opened this menu doesn't immediately
  // close it. The timer id is tracked so closeAllMenus can cancel a
  // pending install if the menu is dismissed before this fires.
  _dismissAttachTimer = setTimeout(() => {
    _dismissAttachTimer = null;
    if (_dismissFn) document.addEventListener("click", _dismissFn);
  }, 0);
}

export function closeAllMenus() {
  if (_dismissAttachTimer !== null) {
    clearTimeout(_dismissAttachTimer);
    _dismissAttachTimer = null;
  }
  if (_dismissFn) { document.removeEventListener("click", _dismissFn); _dismissFn = null; }
  if (_openMenu) { _openMenu.remove(); _openMenu = null; }
  _openAnchor = null;
}
