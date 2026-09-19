/* DOM-level regression tests for router.js — soft navigation and the
 * in-app history depth used by the gamepad back gesture.
 * Covers fix #15: Forward after Back used to decrement the depth again,
 * dead-ending the B/Circle back gesture until the next forward push.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { importAppModule, makeDom, waitFor, wireGlobals } from "./_harness.mjs";

const SHELL_BODY = `
  <main id="main"></main>
  <div id="page-slot"><p>library</p></div>
  <a id="lnk" href="/game/sonic">go</a>`;

test("router: nav depth survives Back/Forward round-trips (#15)", async () => {
  const dom = makeDom(SHELL_BODY, "https://retrox.local/games");
  const window = wireGlobals(dom);

  const navEvents = [];
  window.addEventListener("retrox:navigated", (e) => navEvents.push(e.detail.path));
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    // No <script type="module" src> in the payload — the router skips the
    // page-module import, which keeps the harness free of page modules.
    text: async () => "<html><head><title>Game · RetroX</title></head><body><div id=\"page-slot\"><p>game page</p></div></body></html>",
  });

  const router = await importAppModule("router.js");
  router.initRouter();
  assert.equal(router.canGoBackInApp(), false, "depth starts at 0");

  // Forward click -> pushState -> depth 1, navigated event fires.
  window.document.getElementById("lnk")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => window.location.pathname === "/game/sonic", "soft-nav to /game/sonic");
  assert.equal(router.canGoBackInApp(), true, "depth 1 after push");
  assert.ok(navEvents.includes("/game/sonic"), "retrox:navigated dispatched");

  // Browser Back fires popstate with the previous entry's state (null).
  window.dispatchEvent(new window.PopStateEvent("popstate", { state: null }));
  await waitFor(() => router.canGoBackInApp() === false, "Back restores depth 0");

  // Browser Forward fires popstate with the pushed entry's stamped state —
  // the exact case that used to wrongly decrement into a dead-end.
  window.dispatchEvent(new window.PopStateEvent("popstate", { state: { retroxDepth: 1 } }));
  await waitFor(() => router.canGoBackInApp() === true,
    "Forward restores stamped depth 1 (#15)");

  // And Back again reaches 0 — no negative drift, no stuck gesture.
  window.dispatchEvent(new window.PopStateEvent("popstate", { state: null }));
  await waitFor(() => router.canGoBackInApp() === false, "Back reaches depth 0 again");

  // Let navigate()'s async tail drain before the test ends, so the runner
  // doesn't attribute late microtask activity to a closed window.
  await new Promise((r) => setTimeout(r, 100));

});
