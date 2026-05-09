/* Command palette: Cmd-K / Ctrl-K / "/" opens a fuzzy game search.
 * Caches games on first open with a short TTL. Admin mutations
 * (rename, delete, metadata edit, library scan) call `invalidate()`
 * directly so the next palette open reflects the change without
 * waiting for the TTL. */

import { api } from "./api.js";

// Five minutes is short enough that a different admin's changes
// surface for everyone reasonably soon, and long enough that a user
// repeatedly opening the palette doesn't refetch on every keystroke.
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = null;
let cachedAt = 0;

async function loadGames() {
  const fresh = cache !== null && (Date.now() - cachedAt) < CACHE_TTL_MS;
  if (fresh) return cache;
  try {
    const r = await api.get("/games?page=1&page_size=200");
    cache = (r && r.items) || [];
  } catch {
    cache = [];
  }
  cachedAt = Date.now();
  return cache;
}

/** Drop the cached game list. The next `openPalette()` will refetch.
 *  Call this from any admin action that mutates the library. */
export function invalidate() {
  cache = null;
  cachedAt = 0;
}

function score(query, name) {
  const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const n = norm(name);
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 50;
  if (!words.every(w => n.includes(w))) return -1;
  if (n.startsWith(words[0])) return 100;
  return 50 - n.indexOf(words[0]);
}

function rankedResults(games, query) {
  if (!query) return games.slice(0, 30);
  return games
    .map(g => ({ g, s: score(query, g.name) }))
    .filter(({ s }) => s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 30)
    .map(({ g }) => g);
}

function buildPalette() {
  const backdrop = document.createElement("div");
  backdrop.className = "palette-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Search games");
  backdrop.innerHTML = `
    <div class="palette">
      <input class="palette__input" type="search" placeholder="Search games..." autocomplete="off" autofocus>
      <div class="palette__list" role="listbox"></div>
    </div>
  `;
  return backdrop;
}

let openEl = null;

export async function openPalette() {
  if (openEl) return;
  const backdrop = buildPalette();
  openEl = backdrop;
  document.body.appendChild(backdrop);

  const input = backdrop.querySelector(".palette__input");
  const list = backdrop.querySelector(".palette__list");
  const games = await loadGames();
  let active = 0;

  const renderResults = () => {
    const results = rankedResults(games, input.value.trim());
    if (!results.length) {
      list.innerHTML = `<div class="palette__empty">No matches.</div>`;
      return;
    }
    list.innerHTML = results.map((g, i) => `
      <button class="palette__item ${i === active ? "is-active" : ""}" data-slug="${g.slug || g.id}" role="option" aria-selected="${i === active}">
        <span>${g.name.replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))}</span>
        <small>${(g.system || "").toUpperCase()}</small>
      </button>
    `).join("");
    list.querySelectorAll(".palette__item").forEach((el, i) => {
      el.addEventListener("mouseenter", () => { active = i; markActive(); });
      el.addEventListener("click", () => commit(el.dataset.slug));
    });
    markActive();
  };

  const markActive = () => {
    list.querySelectorAll(".palette__item").forEach((el, i) => {
      el.classList.toggle("is-active", i === active);
      el.setAttribute("aria-selected", i === active ? "true" : "false");
      if (i === active) el.scrollIntoView({ block: "nearest" });
    });
  };

  const commit = (slug) => {
    if (!slug) return;
    close();
    location.href = `/game/${encodeURIComponent(slug)}`;
  };

  let gpRaf = null;

  const close = () => {
    cancelAnimationFrame(gpRaf);
    backdrop.remove();
    openEl = null;
    document.removeEventListener("keydown", onKey);
  };

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const items = list.querySelectorAll(".palette__item");
      if (items.length) { active = (active + 1) % items.length; markActive(); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const items = list.querySelectorAll(".palette__item");
      if (items.length) { active = (active - 1 + items.length) % items.length; markActive(); }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const items = list.querySelectorAll(".palette__item");
      if (items[active]) commit(items[active].dataset.slug);
    }
  }
  document.addEventListener("keydown", onKey);

  input.addEventListener("input", () => { active = 0; renderResults(); });
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  // Gamepad support inside palette
  const gpPrev = new Map();
  function gpBtn(gp, idx) {
    const v = gp.buttons[idx];
    const cur = !!(v && (typeof v === "object" ? v.pressed : v > 0.5));
    const key = `${gp.index}:${idx}`;
    const was = gpPrev.get(key) || false;
    gpPrev.set(key, cur);
    return cur && !was;
  }
  function gpAxis(gp, ax, sign) {
    const v = gp.axes[ax] || 0;
    const cur = sign > 0 ? v > 0.6 : v < -0.6;
    const key = `${gp.index}:a${ax}:${sign}`;
    const was = gpPrev.get(key) || false;
    gpPrev.set(key, cur);
    return cur && !was;
  }
  function pollPalette() {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    for (const gp of pads) {
      if (!gp) continue;
      if (gpBtn(gp, 12) || gpAxis(gp, 1, -1)) { const items = list.querySelectorAll(".palette__item"); if (items.length) { active = (active - 1 + items.length) % items.length; markActive(); } }
      if (gpBtn(gp, 13) || gpAxis(gp, 1, 1)) { const items = list.querySelectorAll(".palette__item"); if (items.length) { active = (active + 1) % items.length; markActive(); } }
      if (gpBtn(gp, 0)) { const items = list.querySelectorAll(".palette__item"); if (items[active]) commit(items[active].dataset.slug); }
      if (gpBtn(gp, 1)) { close(); return; }
    }
    gpRaf = requestAnimationFrame(pollPalette);
  }
  gpRaf = requestAnimationFrame(pollPalette);

  input.focus();
  renderResults();
}

/** Bind global keyboard shortcuts on `document`. */
export function bindShortcuts() {
  document.addEventListener("keydown", (e) => {
    // While the EmulatorJS player overlay is mounted, the palette would
    // pop over the game and steal focus from the emulator. Don't.
    if (document.querySelector(".player-host")) return;
    const target = e.target;
    const editable = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.key === "/" && !editable && !openEl) {
      e.preventDefault();
      openPalette();
    }
  });
}
