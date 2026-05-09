/* AppShell: persistent sidebar + sticky topbar.
 * Mount on every signed-in page (except /play and /login). */

import { api } from "./api.js";
import { icon } from "./icons.js";
import { bindShortcuts, openPalette } from "./command-palette.js";
import { escapeHtml } from "./util.js";
import { initRouter } from "./router.js";
import { toast } from "./toast.js";

// Throttle 429 toasts so a burst of rate-limited requests doesn't spam
// the user with identical warnings.
let _lastRateLimitToastAt = 0;
api.onRateLimit((retryAfter) => {
  const now = Date.now();
  if (now - _lastRateLimitToastAt < 3000) return;
  _lastRateLimitToastAt = now;
  toast.warning("Too many requests", `Please wait ${retryAfter}s before trying again.`);
});

const SYSTEM_LABELS = {
  gb:   "Game Boy",
  gbc:  "Game Boy Color",
  gba:  "Game Boy Advance",
  psx:  "PlayStation",
  n64:  "Nintendo 64",
  nes:  "NES",
  snes: "SNES",
  md:   "Mega Drive",
  segacd: "Sega CD",
  saturn: "Saturn",
  arcade: "Arcade",
};

function systemLabel(sys) {
  return SYSTEM_LABELS[sys] || (sys ? sys.toUpperCase() : "Unknown");
}

function buildShell({ active, title, hideTopbar }) {
  const root = document.createElement("div");
  root.className = "shell";
  root.innerHTML = `
    <aside class="sidebar" id="sidebar" data-nav-group
           data-nav-right=".card-grid, .list-view, [data-gp-start], .settings-nav, .admin-tabs, #page-slot [data-nav-group]"
           aria-label="Primary">
      <a class="sidebar__brand" href="/games" tabindex="-1" aria-label="RetroX home">
        <span class="sidebar__brand-icon"><img src="/images/emulator-logo-transparent.png" alt="" width="38" height="38"/></span>
        <span class="sidebar__brand-text" data-text="RetroX"><span class="sidebar__brand-mark">Retro</span>X</span>
        <span class="sidebar__version" id="app-version"></span>
      </a>

      <div class="sidebar__section">
        <nav class="sidebar__nav" aria-label="Main">
          <a class="nav-item" href="/games" data-key="library">
            <span class="nav-item__icon">${icon("library", { size: 18 })}</span>
            <span class="nav-item__label">Library</span>
          </a>
          <a class="nav-item" href="/games?view=favorites" data-key="favorites">
            <span class="nav-item__icon">${icon("heart", { size: 18 })}</span>
            <span class="nav-item__label">Favorites</span>
          </a>
          <a class="nav-item" href="/games?view=recent" data-key="recent">
            <span class="nav-item__icon">${icon("clock", { size: 18 })}</span>
            <span class="nav-item__label">Recently Played</span>
          </a>
        </nav>
      </div>

      <div class="sidebar__divider" id="collections-divider"></div>

      <div class="sidebar__section" id="collections-section">
        <div class="sidebar__label">
          <span>Collections</span>
        </div>
        <nav class="sidebar__nav sidebar__nav--systems" id="collections-nav" aria-label="Collections"></nav>
      </div>

      <div class="sidebar__divider" hidden id="systems-divider"></div>

      <div class="sidebar__section" id="systems-section" hidden>
        <div class="sidebar__label">
          <span>Systems</span>
          <span class="total" id="systems-total"></span>
        </div>
        <nav class="sidebar__nav sidebar__nav--systems" id="systems-nav" aria-label="Systems"></nav>
      </div>

      <div class="sidebar__bottom" id="user-block">
        <div class="user-menu" id="user-menu" role="menu" aria-label="Account">
          <a class="nav-item" role="menuitem" href="/profile">
            <span class="nav-item__icon">${icon("user", { size: 18 })}</span>
            <span class="nav-item__label">Profile</span>
          </a>
          <a class="nav-item" role="menuitem" href="/admin" id="admin-link" hidden>
            <span class="nav-item__icon">${icon("shield", { size: 18 })}</span>
            <span class="nav-item__label">Admin</span>
          </a>
          <button class="nav-item" role="menuitem" id="logout-btn" type="button">
            <span class="nav-item__icon">${icon("logout", { size: 18 })}</span>
            <span class="nav-item__label">Sign out</span>
          </button>
        </div>
        <button class="user-card" id="user-card" type="button" aria-haspopup="menu" aria-expanded="false">
          <span class="user-card__avatar" id="user-avatar">·</span>
          <span class="user-card__meta">
            <span class="user-card__name" id="user-name">···</span>
            <span class="user-card__role" id="user-role"></span>
          </span>
          <span class="user-card__chev">${icon("chevronUp", { size: 14 })}</span>
        </button>
      </div>
    </aside>

    <main class="main" id="main" tabindex="-1">
      ${hideTopbar ? "" : `
        <header class="topbar" id="topbar">
          <button class="menu-btn" id="menu-toggle" aria-label="Open navigation">${icon("more", { size: 20 })}</button>
          <span class="topbar__title" id="topbar-title">${title || ""}</span>
          <label class="topbar__search">
            <span class="topbar__search-icon">${icon("search", { size: 16 })}</span>
            <input id="topbar-search" type="search" placeholder="Search games..." autocomplete="off" readonly/>
            <span class="topbar__search-kbd">⌘K</span>
          </label>
        </header>
      `}
      <div id="page-slot"></div>
    </main>
  `;
  document.body.prepend(root);
  if (active) {
    root.querySelectorAll(".nav-item").forEach(el => {
      if (el.dataset.key === active) el.setAttribute("aria-current", "page");
    });
  }
  return root;
}

async function loadUser() {
  try {
    return await api.get("/auth/me");
  } catch {
    return null;
  }
}

async function loadSystems() {
  try {
    return await api.get("/games/systems");
  } catch {
    return [];
  }
}

function renderSystems(systems, currentSystem) {
  if (!systems.length) return;
  const section = document.getElementById("systems-section");
  const divider = document.getElementById("systems-divider");
  const nav = document.getElementById("systems-nav");
  const total = document.getElementById("systems-total");
  section.hidden = false;
  if (divider) divider.hidden = false;
  total.textContent = "";
  nav.innerHTML = systems
    .sort((a, b) => (a.name || systemLabel(a.system)).localeCompare(b.name || systemLabel(b.system)))
    .map(({ system, name }) => `
      <a class="nav-item" href="/games?system=${encodeURIComponent(system)}" data-system="${system}">
        <span class="nav-item__label">${escapeHtml(name || systemLabel(system))}</span>
      </a>
    `).join("");
  if (currentSystem) {
    const el = nav.querySelector(`[data-system="${CSS.escape(currentSystem)}"]`);
    if (el) el.setAttribute("aria-current", "page");
  }
}

async function loadCollections() {
  try {
    return await api.get("/collections");
  } catch {
    return [];
  }
}

function renderCollections(collections) {
  const section = document.getElementById("collections-section");
  const divider = document.getElementById("collections-divider");
  const nav = document.getElementById("collections-nav");
  section.hidden = false;
  if (divider) divider.hidden = false;
  if (!collections.length) {
    nav.innerHTML = `<span class="nav-item" style="color:var(--text-dim);font-size:var(--fs-sm);pointer-events:none">No collections yet</span>`;
    return;
  }
  nav.innerHTML = collections
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `
      <a class="nav-item" href="/games?collection=${encodeURIComponent(c.name)}">
        <span class="nav-item__icon">${icon("folder", { size: 16 })}</span>
        <span class="nav-item__label">${escapeHtml(c.name)}</span>
      </a>
    `).join("");
  // Highlight active collection
  const activeCollection = new URLSearchParams(location.search).get("collection");
  if (activeCollection) {
    const link = nav.querySelector(`[href="/games?collection=${encodeURIComponent(activeCollection)}"]`);
    if (link) link.setAttribute("aria-current", "page");
  }
}

function bindUserMenu(me) {
  const card = document.getElementById("user-card");
  const menu = document.getElementById("user-menu");
  const adminLink = document.getElementById("admin-link");
  const avatar = document.getElementById("user-avatar");
  const name = document.getElementById("user-name");
  const role = document.getElementById("user-role");

  avatar.textContent = (me?.username || "?").slice(0, 1).toUpperCase();
  name.textContent = me?.username || "Signed out";
  role.textContent = me?.is_admin ? "Administrator" : "Member";
  if (me?.is_admin) adminLink.hidden = false;

  const close = () => { menu.dataset.open = "false"; card.setAttribute("aria-expanded", "false"); };
  const open  = () => { menu.dataset.open = "true";  card.setAttribute("aria-expanded", "true");  };

  card.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (menu.dataset.open === "true") close(); else open();
  });

  // Close the menu when the user picks one of its items so the
  // popover doesn't linger open over the freshly-loaded /profile or
  // /admin page. Move focus back to the user-card afterward — that
  // gives the controller / keyboard user a sensible anchor (they can
  // press RIGHT to enter the page content via the sidebar's
  // data-nav-right transition).
  menu.addEventListener("click", (e) => {
    const item = e.target.closest('a[href], button[type="button"]');
    if (!item) return;
    close();
    requestAnimationFrame(() => card.focus({ preventScroll: true }));
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && !card.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  document.getElementById("logout-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    try { await api.post("/auth/logout"); } catch { /* ignore */ }
    location.href = "/login";
  });
}

function bindTopbar() {
  const topbar = document.getElementById("topbar");
  if (!topbar) return;

  const main = document.getElementById("main");
  if (main) {
    main.addEventListener("scroll", () => {
      topbar.classList.toggle("is-scrolled", main.scrollTop > 8);
    });
  }

  // Search field opens the palette on click/focus. The input is `readonly` so
  // it never accepts text — clicks just trigger the palette overlay.
  const search = document.getElementById("topbar-search");
  if (search) {
    search.addEventListener("focus", () => { openPalette(); search.blur(); });
    search.addEventListener("click", () => { openPalette(); });
  }

  // Mobile sidebar toggle
  const menuToggle = document.getElementById("menu-toggle");
  const sidebar = document.getElementById("sidebar");
  if (menuToggle && sidebar) {
    menuToggle.addEventListener("click", () => {
      sidebar.dataset.open = sidebar.dataset.open === "true" ? "false" : "true";
    });
    document.addEventListener("click", (e) => {
      if (window.innerWidth <= 880 && !sidebar.contains(e.target) && !menuToggle.contains(e.target)) {
        sidebar.dataset.open = "false";
      }
    });
    // On mobile, picking a sidebar entry should slide the drawer
    // closed so the user lands on their selected page without an
    // overlay covering it. Desktop layout doesn't slide the sidebar
    // so this is a no-op there.
    sidebar.addEventListener("click", (e) => {
      if (window.innerWidth > 880) return;
      const link = e.target.closest('a[href]');
      if (!link) return;
      sidebar.dataset.open = "false";
    });
  }
}

// Cached so subsequent (soft-nav) calls don't re-fetch /auth/me on
// every page change. The router clears this if it observes 401s by
// virtue of the api.js refresh-and-retry layer.
let _cachedMe = null;
let _shellBuilt = false;

export async function mountShell({ active = null, title = "", currentSystem = null, hideTopbar = false, requireAuth = true } = {}) {
  const me = _cachedMe || await loadUser();
  if (requireAuth && !me) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/login?next=${next}`;
    return null;
  }
  _cachedMe = me;

  if (!_shellBuilt) {
    // First call: build the persistent chrome.
    buildShell({ active, title, hideTopbar });
    document.getElementById("skel")?.remove();
    bindUserMenu(me);
    bindTopbar();
    bindShortcuts();
    if (me.version) document.getElementById("app-version").textContent = `v${me.version}`;
    loadSystems().then(systems => renderSystems(systems, currentSystem));
    loadCollections().then(renderCollections);
    initRouter();
    _shellBuilt = true;
  } else {
    // Subsequent call (soft-nav): chrome already exists. Just update
    // the active states and the topbar title; leave the user menu,
    // sidebar lists, and bound listeners alone.
    updateActiveState(active, currentSystem);
    const titleEl = document.getElementById("topbar-title");
    if (titleEl) titleEl.textContent = title || "";
  }

  return { me, slot: document.getElementById("page-slot") };
}

function updateActiveState(active, currentSystem) {
  // Clear all aria-current marks across the sidebar.
  document.querySelectorAll(".sidebar [aria-current]").forEach(el => el.removeAttribute("aria-current"));

  // Re-mark the primary section (Library / Favorites / Recently Played).
  if (active) {
    const el = document.querySelector(`.nav-item[data-key="${active}"]`);
    if (el) el.setAttribute("aria-current", "page");
  }

  // Re-mark the current system, if any.
  if (currentSystem) {
    const el = document.querySelector(`[data-system="${CSS.escape(currentSystem)}"]`);
    if (el) el.setAttribute("aria-current", "page");
  }

  // Re-mark the current collection, derived from the URL like the
  // collections renderer does.
  const activeCollection = new URLSearchParams(location.search).get("collection");
  if (activeCollection) {
    const link = document.querySelector(
      `#collections-nav [href="/games?collection=${encodeURIComponent(activeCollection)}"]`,
    );
    if (link) link.setAttribute("aria-current", "page");
  }
}

export { systemLabel };

export async function refreshCollections() {
  const collections = await loadCollections();
  renderCollections(collections);
}
