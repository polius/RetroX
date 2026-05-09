/* Library page. URL params drive the view:
 *
 *   /games                       → full library grid (default landing)
 *   /games?view=favorites        → favorites grid
 *   /games?view=recent           → recently-played grid
 *   /games?system=psx            → per-system grid */

import { api } from "./api.js";
import { mountShell, systemLabel } from "./shell.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";
import { applyEarly, hydrate } from "./theme.js";
import { toggleFavorite } from "./favorites.js";
import { isControllerInputMode } from "./input-mode.js";
import { escapeHtml } from "./util.js";
import "./gamepad-nav.js";

applyEarly();

const params = new URLSearchParams(location.search);
const VIEW = params.get("view");        // null | favorites | recent
const SYSTEM = params.get("system");    // null | gb | gbc | gba | psx | n64...
const COLLECTION = params.get("collection"); // null | collection id

const VIEW_KEY =
  COLLECTION ? null :
  SYSTEM ? null :
  VIEW === "favorites" ? "favorites" :
  VIEW === "recent" ? "recent" : "library";

const PAGE_TITLE =
  SYSTEM ? systemLabel(SYSTEM) :
  VIEW === "favorites" ? "Favorites" :
  VIEW === "recent" ? "Recently Played" : "Library";

document.title = `${PAGE_TITLE} · RetroX`;

const shell = await mountShell({ active: VIEW_KEY, title: PAGE_TITLE, currentSystem: SYSTEM });
if (!shell) throw new Error("not signed in");
const { slot } = shell;

hydrate();

// ---------- helpers ----------

const FALLBACK_COVER = "/images/default-cover.svg";
function coverUrl(g) { return g.has_cover ? api.url(`/games/${encodeURIComponent(g.id)}/cover`) : FALLBACK_COVER; }
function formatPlaytime(seconds) {
  if (!seconds || seconds < 1) return "";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function gcardHTML(g) {
  const pt = formatPlaytime(g.playtime_seconds);
  // width/height attrs lock the intrinsic aspect ratio at parse time
  // so the browser reserves space before the image decodes — no CLS
  // even on slow connections. CSS still controls the rendered size.
  return `
    <a class="gcard" href="/game/${encodeURIComponent(g.slug || g.id)}" data-id="${g.id}" data-fav="${g.is_favorite ? "1" : "0"}" data-gp-y data-gp-first>
      <img class="gcard__cover" src="${coverUrl(g)}" alt="" width="240" height="240" loading="lazy" decoding="async"/>
      <span class="gcard__overlay"></span>
      <button class="gcard__fav ${g.is_favorite ? "is-active" : ""}" type="button" aria-label="${g.is_favorite ? "Unfavorite" : "Favorite"}" data-fav-btn>
        ${icon(g.is_favorite ? "heartFilled" : "heart", { size: 16 })}
      </button>
      <span class="gcard__meta">
        <span class="gcard__title">${escapeHtml(g.name)}</span>
        <span class="gcard__system">${escapeHtml((g.system || "").toUpperCase())}${pt ? ` · ${pt}` : ""}</span>
      </span>
    </a>
  `;
}

function listRowHTML(g) {
  return `
    <a class="list-row" href="/game/${encodeURIComponent(g.slug || g.id)}" data-id="${g.id}" data-fav="${g.is_favorite ? "1" : "0"}" data-gp-y data-gp-first>
      <img class="list-row__cover" src="${coverUrl(g)}" alt="" width="36" height="44" loading="lazy"/>
      <span class="list-row__name">${escapeHtml(g.name)}</span>
      <span class="list-row__system">${escapeHtml(systemLabel(g.system))}</span>
      <span class="list-row__playtime">${formatPlaytime(g.playtime_seconds) || "—"}</span>
      <button class="list-row__fav ${g.is_favorite ? "is-active" : ""}" type="button" aria-label="${g.is_favorite ? "Unfavorite" : "Favorite"}" data-fav-btn>
        ${icon(g.is_favorite ? "heartFilled" : "heart", { size: 14 })}
      </button>
    </a>
  `;
}

function bindCardFavorites(scope) {
  scope.querySelectorAll(".gcard, .list-row").forEach(card => {
    const btn = card.querySelector("[data-fav-btn]");
    const flip = async () => {
      const id = card.dataset.id;
      const wasFav = card.dataset.fav === "1";
      try {
        const nowFav = await toggleFavorite(id, wasFav);
        card.dataset.fav = nowFav ? "1" : "0";
        btn.classList.toggle("is-active", nowFav);
        btn.innerHTML = icon(nowFav ? "heartFilled" : "heart", { size: card.classList.contains("list-row") ? 14 : 16 });
        btn.setAttribute("aria-label", nowFav ? "Unfavorite" : "Favorite");
      } catch (err) {
        toast.fromError(err, "Couldn't update favorite");
      }
    };
    if (btn) {
      btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); flip(); });
    }
    card.addEventListener("gp:y", (e) => { e.preventDefault(); flip(); });
  });
}

function renderEmptyLibrary() {
  // Mark the welcome card as a nav-group so the controller picker
  // doesn't drift to the sidebar when the user is on the only action.
  // data-nav-left points at the sidebar so LEFT still makes sense, but
  // UP/DOWN have no candidates and stay put.
  slot.innerHTML = `
    <div class="page">
      <div class="empty-welcome" data-nav-group data-nav-left=".sidebar">
        <img src="/images/emulator-logo.png" alt="" class="empty-welcome__logo"/>
        <h2>No games yet</h2>
        <p>Add ROM files to the shared volume and rescan from the admin panel.</p>
        <a href="/admin/library" class="btn btn--primary">Go to Admin</a>
      </div>
    </div>
  `;
  // Land focus on the only useful action — same logic as the
  // populated-library first-card auto-focus.
  const action = slot.querySelector(".btn--primary");
  if (action && shouldAutoFocusForLibraryView()) {
    requestAnimationFrame(() => action.focus({ preventScroll: true }));
  }
}

// Shared by the populated and empty library views.
//
// Auto-focus the first card (or empty-state CTA) when a controller
// user lands here AND there's no existing meaningful focus to preserve.
// On soft-nav from a sidebar click, the clicked sidebar item stays
// focused — the user expects to keep that focus and use D-pad RIGHT
// to enter the grid (the Plex/Netflix model). On a fresh page load
// or arrival via popstate from a slot child that no longer exists,
// document.activeElement is body — that's when we step in.
function shouldAutoFocusForLibraryView() {
  if (!isControllerInputMode()) return false;
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement) return false;
  return true;
}

/* ---------- shared library renderer ---------- */

let viewState = { systemFilter: null, sort: localStorage.getItem("retrox.sort") || "name", layout: localStorage.getItem("retrox.layout") || "grid" };

const SORT_FNS = {
  name: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  system: (a, b) => (a.system || "").localeCompare(b.system || "") || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  recent: (a, b) => (b.added_at || "").localeCompare(a.added_at || ""),
};

async function renderLibraryView({ items, title, hint, allowSystemFilter = true }) {
  if (!items.length) {
    slot.innerHTML = `
      <div class="page">
        <div class="library-head">
          <h1>${escapeHtml(title)}</h1>
          <span class="library-head__count">0 games</span>
        </div>
        <div class="empty">
          <h3>Nothing to show</h3>
          <p>${escapeHtml(hint)}</p>
        </div>
      </div>
    `;
    return;
  }

  const presentSystems = [...new Set(items.map(g => g.system))].sort((a, b) =>
    systemLabel(a).localeCompare(systemLabel(b))
  );

  const draw = () => {
    let list = items.slice();
    if (allowSystemFilter && viewState.systemFilter) {
      list = list.filter(g => g.system === viewState.systemFilter);
    }
    const sortFn = SORT_FNS[viewState.sort] || SORT_FNS.name;
    list.sort(sortFn);

    const isGrid = viewState.layout === "grid";

    slot.innerHTML = `
      <div class="page">
        <div class="library-head" data-nav-group
             data-nav-down=".library-filter, .card-grid, .list-view"
             data-nav-left=".sidebar">
          <h1>${escapeHtml(title)}</h1>
          <span class="library-head__count">${list.length} game${list.length === 1 ? "" : "s"}</span>
          <div class="library-head__controls">
            <div class="library-head__sort">
              <select class="select" id="sort-select" aria-label="Sort by">
                <option value="name" ${viewState.sort === "name" ? "selected" : ""}>Name</option>
                <option value="recent" ${viewState.sort === "recent" ? "selected" : ""}>Recently Added</option>
                <option value="system" ${viewState.sort === "system" ? "selected" : ""}>System</option>
              </select>
            </div>
            <div class="library-head__layout">
              <button class="icon-btn ${isGrid ? "is-active" : ""}" type="button" data-layout="grid" aria-label="Grid view" title="Grid view">
                ${icon("library", { size: 16 })}
              </button>
              <button class="icon-btn ${!isGrid ? "is-active" : ""}" type="button" data-layout="list" aria-label="List view" title="List view">
                ${icon("list", { size: 16 })}
              </button>
            </div>
          </div>
        </div>

        ${allowSystemFilter && presentSystems.length >= 1 ? `
          <div class="chips library-filter" data-nav-group
               data-nav-up=".library-head"
               data-nav-down=".card-grid, .list-view"
               data-nav-left=".sidebar" role="tablist" aria-label="Filter by system">
            <button class="chip" type="button" data-sys="" aria-pressed="${!viewState.systemFilter}">All</button>
            ${presentSystems.map(s => `
              <button class="chip" type="button" data-sys="${s}" aria-pressed="${viewState.systemFilter === s}">
                ${escapeHtml(systemLabel(s))}
              </button>
            `).join("")}
          </div>
        ` : ""}

        ${list.length ? (isGrid ? `
          <div class="card-grid" data-nav-group
               data-nav-up=".library-filter, .library-head"
               data-nav-left=".sidebar">
            ${list.map(gcardHTML).join("")}
          </div>
        ` : `
          <div class="list-view" data-nav-group
               data-nav-up=".library-filter, .library-head"
               data-nav-left=".sidebar">
            <div class="list-view__header">
              <span></span>
              <span>Name</span>
              <span>System</span>
              <span>Playtime</span>
              <span></span>
            </div>
            ${list.map(listRowHTML).join("")}
          </div>
        `) : `
          <div class="empty" style="margin-top: var(--sp-5)">
            <h3>No matches</h3>
            <p>Try a different filter.</p>
          </div>
        `}
      </div>
    `;
    bindCardFavorites(slot);

    // Sort
    slot.querySelector("#sort-select")?.addEventListener("change", (e) => {
      viewState.sort = e.target.value;
      localStorage.setItem("retrox.sort", viewState.sort);
      draw();
    });

    // Layout toggle
    slot.querySelectorAll("[data-layout]").forEach(btn => {
      btn.addEventListener("click", () => {
        viewState.layout = btn.dataset.layout;
        localStorage.setItem("retrox.layout", viewState.layout);
        draw();
      });
    });

    // System filter
    slot.querySelectorAll(".library-filter .chip").forEach(c => {
      c.addEventListener("click", () => {
        viewState.systemFilter = c.dataset.sys || null;
        draw();
      });
    });

    // Initial focus: first ROM card so D-pad / arrow keys land in the
    // grid, not on the sidebar brand. We only do this when the user is
    // actually navigating with a controller (or has TV mode on) —
    // otherwise mouse users see an unexpected focus ring on a card they
    // didn't pick. We also only do it on the *first* draw of the page,
    // so subsequent sort/filter changes don't steal focus from controls.
    if (!didInitialFocus && shouldAutoFocusForLibraryView()) {
      didInitialFocus = true;
      focusFirstCard();
    }
  };

  // Late-detection paths. The browser hides connected controllers from a
  // freshly-loaded page until it sees post-load input (security policy),
  // so even a user who's been navigating with a controller may show
  // empty getGamepads() at first paint. Three signals catch them:
  //
  //   1. The native `gamepadconnected` event — fires when the browser
  //      first reveals a gamepad on this page (might not fire at all if
  //      the gamepad was known from a previous page).
  //   2. A 3-second poll — catches the moment getGamepads() becomes
  //      non-empty, even if no event fires.
  //   3. The next time the gamepad-nav.js poll loop sees real input,
  //      it stamps the controller-seen flag — covered by the regular
  //      shouldAutoFocusForLibraryView check on subsequent draws.
  //
  // All three only act if focus hasn't already moved somewhere else.
  function lateAutoFocus() {
    if (didInitialFocus) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (!isControllerInputMode()) return;
    didInitialFocus = true;
    focusFirstCard();
  }
  window.addEventListener("gamepadconnected", lateAutoFocus);
  const pollDeadline = Date.now() + 3000;
  const pollId = setInterval(() => {
    if (didInitialFocus || Date.now() > pollDeadline) {
      clearInterval(pollId);
      return;
    }
    lateAutoFocus();
    if (didInitialFocus) clearInterval(pollId);
  }, 200);

  function focusFirstCard() {
    const firstCard = slot.querySelector(".gcard, .list-row");
    if (!firstCard) return;
    // rAF so the focus happens after layout settles — otherwise
    // scroll-on-focus may jump unexpectedly.
    requestAnimationFrame(() => firstCard.focus({ preventScroll: true }));
  }

  let didInitialFocus = false;
  draw();
}


/* ---------- views ---------- */

async function renderLibrary() {
  const list = await api.get("/games?page=1&page_size=200").catch(() => ({ items: [] }));
  const items = list.items || [];
  if (!items.length) {
    renderEmptyLibrary();
    return;
  }
  await renderLibraryView({
    items,
    title: "Library",
    hint: "There are no games matching this view.",
  });
}

async function renderSystem() {
  const list = await api.get(`/games?page=1&page_size=200`).catch(() => ({ items: [] }));
  const items = (list.items || []).filter(g => g.system === SYSTEM);
  await renderLibraryView({
    items,
    title: systemLabel(SYSTEM),
    hint: "No games for this system are indexed.",
    allowSystemFilter: false,
  });
}

async function renderFavorites() {
  const list = await api.get("/games/favorites").catch(() => []);
  await renderLibraryView({
    items: list || [],
    title: "Favorites",
    hint: "Mark a game as favorite from its detail page or with Y on the gamepad.",
  });
}

async function renderRecent() {
  const list = await api.get("/games/recent").catch(() => []);
  await renderLibraryView({
    items: list || [],
    title: "Recently Played",
    hint: "Save states you create will appear here.",
  });
}

async function renderCollection() {
  const [collections, allGames] = await Promise.all([
    api.get("/collections").catch(() => []),
    api.get("/games?page=1&page_size=200").catch(() => ({ items: [] })),
  ]);
  const coll = collections.find(c => c.name === COLLECTION);
  if (!coll) {
    slot.innerHTML = `<div class="page"><div class="empty"><h3>Collection not found</h3><p>This collection may have been deleted.</p></div></div>`;
    return;
  }
  const memberList = await api.get(`/collections/${coll.id}/games`).catch(() => []);
  const memberIds = new Set((memberList || []).map(g => g.id));
  const items = (allGames.items || []).filter(g => memberIds.has(g.id));
  document.title = `${coll.name} · RetroX`;
  await renderLibraryView({
    items,
    title: coll.name,
    hint: "This collection is empty. Add games from Admin → Collections.",
    // System chips are useful here — collections often span multiple
    // systems and the user wants to drill in by platform within the
    // collection. Defaults to true; explicit for clarity.
    allowSystemFilter: true,
  });
}

// ---------- dispatch ----------

(async () => {
  try {
    if (SYSTEM)                       await renderSystem();
    else if (COLLECTION)              await renderCollection();
    else if (VIEW === "favorites")    await renderFavorites();
    else if (VIEW === "recent")       await renderRecent();
    else                              await renderLibrary();
  } catch (err) {
    if (err && err.status === 401) return;
    toast.fromError(err, "Couldn't load library");
  }
})();
