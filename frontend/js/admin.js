/* Admin panel entry point.
 *
 * Mounts the shell and admin guard, builds the tab strip, then
 * dispatches the active tab to its dedicated module under ./admin/.
 * Each tab module owns its own state (first-load flag, caches) and
 * exposes a single render(ctx) function. The split exists so each
 * surface can grow without making this file unmanageable, and so
 * editing one tab doesn't risk regressions in the others.
 */

import { mountShell, refreshCollections } from "./shell.js";
import { applyEarly, hydrate } from "./theme.js";
import { isControllerInputMode } from "./input-mode.js";
import { invalidate as invalidatePaletteCache } from "./command-palette.js";
import "./gamepad-nav.js";

import * as usersTab from "./admin/users.js";
import * as libraryTab from "./admin/library.js";
import * as emulatorsTab from "./admin/emulators.js";
import * as collectionsTab from "./admin/collections.js";
import * as savesTab from "./admin/saves.js";

applyEarly();

document.title = "Admin · RetroX";

const shell = await mountShell({ active: null, title: "Admin" });
if (!shell) throw new Error("not signed in");
const { me, slot } = shell;
hydrate();

if (!me.is_admin) {
  slot.innerHTML = `
    <div class="page">
      <div class="empty">
        <h3>Access denied</h3>
        <p>You need administrator privileges to view this page.</p>
        <a class="btn btn--primary" href="/games">Back to library</a>
      </div>
    </div>
  `;
  throw new Error("not admin");
}

const TABS = ["library", "emulators", "collections", "saves", "users"];
const path = location.pathname;
let active =
  path.endsWith("/library") ? "library" :
  path.endsWith("/emulators") ? "emulators" :
  path.endsWith("/collections") ? "collections" :
  path.endsWith("/saves") ? "saves" :
  path.endsWith("/users") ? "users" : "library";

slot.innerHTML = `
  <div class="page">
    <div class="page__head">
      <h1>Administration</h1>
      <span class="spacer"></span>
    </div>
    <div class="admin-tabs" data-nav-group data-nav-down="#admin-pane" data-nav-up=".sidebar" data-nav-left=".sidebar">
      ${TABS.map(t => `
        <a class="chip" data-tab="${t}" href="/admin/${t}" aria-pressed="${active === t}">${t.charAt(0).toUpperCase() + t.slice(1)}</a>
      `).join("")}
    </div>
    <div id="admin-pane" data-nav-group data-nav-up=".admin-tabs" data-nav-left=".sidebar"></div>
  </div>
`;
const pane = document.getElementById("admin-pane");

document.querySelectorAll(".admin-tabs .chip").forEach(c => {
  c.addEventListener("click", (e) => {
    e.preventDefault();
    active = c.dataset.tab;
    history.replaceState(null, "", `/admin/${active}`);
    document.querySelectorAll(".admin-tabs .chip").forEach(x => x.setAttribute("aria-pressed", x.dataset.tab === active ? "true" : "false"));
    render();
  });
});

// Per-tab dispatch. Each module receives only the context it actually
// needs — keeping that surface small makes it obvious what cross-tab
// dependencies exist (in practice: just the palette cache invalidation
// from library, and the sidebar collection refresh from collections).
function render() {
  if (active === "users") {
    usersTab.render({ pane, me });
  } else if (active === "library") {
    libraryTab.render({ pane, invalidatePalette: invalidatePaletteCache });
  } else if (active === "emulators") {
    emulatorsTab.render({ pane });
  } else if (active === "collections") {
    collectionsTab.render({ pane, refreshCollections });
  } else if (active === "saves") {
    savesTab.render({ pane, me });
  }
}
render();

// Auto-focus the active admin tab on initial controller-mode load
// (e.g. user opened /admin from a bookmark with a controller in hand).
// Skip if focus is already on something meaningful — soft-nav from
// the user-card menu leaves focus on the user-card and we let the
// user press RIGHT to enter the admin tabs from there.
(function autoFocusAdminTab() {
  if (!isControllerInputMode()) return;
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement) return;
  const target = document.querySelector('.admin-tabs [aria-pressed="true"]')
              || document.querySelector('.admin-tabs .chip');
  if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
})();
