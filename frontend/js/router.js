/* router.js — soft navigation between in-app pages.
 *
 * Goal: when the user clicks a sidebar entry (or any other internal
 * link), only #page-slot updates. The sidebar, topbar, user menu, and
 * any in-flight state in shell-level singletons (gamepad-nav,
 * command-palette, save indicator on /play, etc.) stay alive.
 *
 * Mechanism (deliberately simple):
 *   1. Intercept clicks on internal <a href> links.
 *   2. Fetch the target URL as HTML.
 *   3. From the response, pull out the new <title>, the new
 *      #page-slot innerHTML, and the page module's <script src>.
 *   4. pushState the new URL, swap the slot content, scroll to top.
 *   5. Dynamically import the page module with a cache-bust query
 *      (?_v=<token>) so its top-level code re-runs against the
 *      now-current location.pathname / location.search. The page
 *      then calls mountShell — which detects the existing shell and
 *      just updates the active state — and populates the slot.
 *
 * Why cache-bust instead of refactoring every page module to expose
 * mount/unmount: zero API change to the existing pages, zero risk of
 * regressions in their setup logic, and the per-navigation memory
 * cost (the previous module instance sitting in the registry until
 * GC) is bounded — a typical session sees a few dozen navigations.
 *
 * Routes that AREN'T eligible for soft-nav:
 *   /login   — different shell (centered card, no sidebar)
 *   /play    — fullscreen player, no shell
 *   /link    — phone-side QR approval, different shell
 *   anything outside /                    — we don't own it
 */

const HARD_NAV_PREFIXES = ["/login", "/play", "/link"];

let initialized = false;

// Token-based cancellation: rapid clicks supersede earlier navs.
let navToken = 0;

// True after the first click-driven navigation; prevents the very
// first page load (which is the document the browser served us) from
// being re-fetched as a soft-nav.
let hasNavigated = false;

// In-app navigation depth — number of soft-nav forward steps we've
// taken since landing in this document. Each forward navigate() bumps
// it; popstate (back/forward) decrements. Exposed so back-gesture
// handlers can tell whether history.back() would stay inside the app
// shell (depth > 0) or would land somewhere else — most notably
// /login, the only common entry route into a fresh shell document.
// The B/Circle controller button refuses to go back when depth is 0
// so the user never gets bounced out to /login by accident.
let _navDepth = 0;
export function canGoBackInApp() { return _navDepth > 0; }

export function initRouter() {
  if (initialized) return;
  initialized = true;

  // Standard for SPAs: we'll handle scroll restoration ourselves so
  // forward navigations land at the top while back/forward retain
  // the previous scroll position via popstate (browser still keeps
  // the position in its history entry).
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  document.addEventListener("click", onLinkClick);
  window.addEventListener("popstate", onPopState);
}

function isHardNavPath(path) {
  return HARD_NAV_PREFIXES.some(p => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
}

function onLinkClick(e) {
  // Honor the user's intent for new tab / new window / save link.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (e.button !== undefined && e.button !== 0) return;
  if (e.defaultPrevented) return;

  const link = e.target.closest("a[href]");
  if (!link) return;
  if (link.target && link.target !== "_self") return;
  if (link.hasAttribute("download")) return;
  // External or non-HTTP scheme.
  const href = link.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  // Resolve relative to current location.
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return;
  if (isHardNavPath(url.pathname)) return;

  e.preventDefault();
  navigate(url.pathname + url.search + url.hash);
}

function onPopState() {
  // Browser back/forward; URL has already updated. Re-mount the page
  // for the new path without pushing another history entry. Depth
  // decrements one step toward 0 — back outside the shell would have
  // already left the document by the time popstate fires.
  if (_navDepth > 0) _navDepth -= 1;
  navigate(location.pathname + location.search + location.hash, { replace: true });
}

/**
 * Programmatic soft-nav. Exposed so other code (e.g. the command
 * palette, login redirects) can use it instead of location.href when
 * staying inside the shell.
 */
export async function navigate(target, { replace = false } = {}) {
  const targetUrl = new URL(target, location.href);
  const path = targetUrl.pathname + targetUrl.search + targetUrl.hash;

  // Hard nav for routes outside the shell.
  if (isHardNavPath(targetUrl.pathname)) {
    location.href = path;
    return;
  }

  // No-op if already there — but only for forward navigations. On
  // popstate (replace=true) the browser has ALREADY updated location
  // before firing the event, so by the time we get here `path ===
  // location.*` is always true even though the page content is still
  // showing the previous route. Skipping in that case left the URL
  // and the rendered DOM out of sync (browser-back appeared to do
  // nothing). Forward link clicks still benefit from the dedup.
  if (!replace && path === location.pathname + location.search + location.hash && hasNavigated) return;

  const myToken = ++navToken;

  let html;
  try {
    const r = await fetch(targetUrl.href, {
      credentials: "include",
      headers: { Accept: "text/html" },
    });
    if (!r.ok) {
      // 401/404/etc — let the browser handle it with a real load so
      // the user gets the actual error page (the 404 page, the
      // /login redirect, etc).
      location.href = path;
      return;
    }
    html = await r.text();
  } catch {
    location.href = path;
    return;
  }
  if (myToken !== navToken) return;

  // Parse the response, extract the next title + page-slot content +
  // module script src.
  const doc = new DOMParser().parseFromString(html, "text/html");
  const newTitle = doc.querySelector("title")?.textContent;
  const newSlot = doc.getElementById("page-slot");
  const moduleScript = Array.from(doc.querySelectorAll('script[type="module"][src]'))
    // Skip the router itself if it appears.
    .find(s => !/router\.js(?:[?#].*)?$/.test(s.getAttribute("src")));

  // Pull in any stylesheets the new page needs that aren't already in
  // the live document. Each shell-eligible page (games, game, profile,
  // admin, …) shares the bulk of its CSS, but a few pages add their
  // own — /game.html for instance includes /css/player.css for the
  // in-app player overlay that startPlayInPlace mounts later. Without
  // this merge, soft-navigating to /game from /games would never pull
  // in player.css, and the player overlay's back button + status pill
  // would render with zero applied rules — default `display:inline-block`
  // in normal flow, clipped by player-host's `overflow:hidden`,
  // invisible. Pressing Back hard-nav'd back to /game and the next
  // launch worked, hiding this from anyone who tested by reloading.
  await mergeStylesheets(doc);

  // History push BEFORE module re-import so the module sees the new
  // location.pathname when it reads it at top level.
  if (replace) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
    _navDepth += 1;
  }
  if (newTitle) document.title = newTitle;
  hasNavigated = true;

  // Notify shell-level singletons that a soft-nav happened. gamepad-nav
  // uses this to freeze any direction that was held at click time, so a
  // held D-pad (or analog-stick drift) doesn't keep firing move() during
  // the soft-nav window and drift focus away from the new page's intended
  // landing element (e.g. /game's Play button).
  window.dispatchEvent(new CustomEvent("retrox:navigated", { detail: { path, replace } }));

  // Swap the slot. Pre-render whatever the server gave us (often a
  // skeleton placeholder) so the user sees something during the
  // module load instead of a flash of empty.
  const slot = document.getElementById("page-slot");
  if (slot) {
    slot.innerHTML = newSlot ? newSlot.innerHTML : "";
    // Forward navigation: top of new content. Back/forward (replace
    // path) is left where the browser positioned the scroll.
    if (!replace) {
      const main = document.getElementById("main");
      if (main) main.scrollTop = 0;
    }
  }

  // Re-import the page module. The cache-bust query forces a fresh
  // module instance so its top-level code (which reads location.*,
  // calls mountShell, populates the slot) runs again.
  if (moduleScript) {
    const moduleSrc = withCacheBust(moduleScript.getAttribute("src"));
    try {
      // Token check after the await: a faster click may have already
      // moved on to a different page. Don't run the stale module's
      // setup against the wrong URL.
      const importPromise = import(moduleSrc);
      const mod = await importPromise;
      if (myToken !== navToken) return;
      // Some modules use `if (!me.is_admin) throw` — that surfaces as
      // a rejected import promise. The module already wrote an
      // access-denied page into the slot before throwing, so the
      // user sees the right thing. Nothing else to do here.
      void mod;
    } catch (err) {
      // Two flavours of error end up here:
      //
      //  - The module ran far enough to render something then
      //    deliberately threw (e.g. admin.js's `throw new Error
      //    ("not admin")` after writing an access-denied state into
      //    the slot). Hard-navigating would flash the user's already-
      //    rendered page off and on.
      //
      //  - True module load/syntax failure. The slot still contains
      //    the server's pre-rendered HTML for the new page (we set it
      //    above), so the user sees a static but reasonable view.
      //
      // Either way the right move is to leave the user where they
      // are — the shell is alive, they can navigate elsewhere — and
      // log the underlying error for diagnosis.
      if (myToken === navToken) {
        console.warn("[router] page module setup error", err);
      }
    }
  }
}

function withCacheBust(src) {
  const sep = src.includes("?") ? "&" : "?";
  return `${src}${sep}_v=${Date.now()}`;
}

/**
 * Append any <link rel="stylesheet"> tags from the new document that
 * aren't already loaded into the live document. Awaits each newly-added
 * sheet's load (or error) before resolving so the slot swap and module
 * re-run that follow run with the new rules already applied — no flash
 * of unstyled content, no race where dynamically-created elements (e.g.
 * the player overlay's back button) render with default styles.
 */
function mergeStylesheets(doc) {
  const liveHrefs = new Set(
    [...document.querySelectorAll('link[rel="stylesheet"][href]')]
      .map(l => l.href),
  );
  const additions = [];
  for (const link of doc.querySelectorAll('link[rel="stylesheet"][href]')) {
    const absHref = new URL(link.getAttribute("href"), location.href).href;
    if (liveHrefs.has(absHref)) continue;
    const newLink = document.createElement("link");
    newLink.rel = "stylesheet";
    newLink.href = link.getAttribute("href");
    document.head.appendChild(newLink);
    additions.push(newLink);
  }
  if (additions.length === 0) return Promise.resolve();
  // Resolve on either load or error — a missing sheet shouldn't strand
  // the navigation. The user lands on the page either way; a
  // misconfigured sheet just renders unstyled, same as today.
  return Promise.all(additions.map(link => new Promise(resolve => {
    if (link.sheet) return resolve();
    link.addEventListener("load",  resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
  })));
}
