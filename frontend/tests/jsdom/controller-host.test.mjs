/* DOM-level regression tests for controller-host.js — the phone-pairing
 * pill on the player pages. Covers the fixes for:
 *   #5  pill/session teardown on retrox:navigated (was: pill + WS leaked
 *       over every page after an in-place play session ended)
 *   #14 pair modal carries .modal-backdrop so Escape/gamepad-B treat it
 *       as a blocking modal
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeWebSocket, importAppModule, jsonResponse, makeDom, resetWebSockets,
  stubFetch, waitFor, wireGlobals,
} from "./_harness.mjs";

const PLAYER_BODY = `
  <div class="player-host">
    <button id="back-btn"></button>
    <div class="player__status"><span>sync pill</span></div>
    <button id="controller-bindings-btn">Controls</button>
    <div id="emulator-mount"></div>
  </div>`;

test("controller-host: pill injection, live session, and teardown on soft-nav", async () => {
  resetWebSockets();
  const dom = makeDom(PLAYER_BODY, "https://retrox.local/play/Test%20Game?slot=1");
  const window = wireGlobals(dom);
  window.WebSocket = FakeWebSocket;
  globalThis.WebSocket = FakeWebSocket;

  // Emulator already online — init()'s poll resolves on its first tick.
  window.EJS_emulator = { gameManager: { simulateInput() {} } };

  const calls = stubFetch(() => jsonResponse({
    token: "tok123", code: "ABC123", expires_in: 120, pair_url: "/pair?code=ABC123",
  }));

  await importAppModule("controller-host.js");
  await waitFor(() => window.document.getElementById("controller-pair-btn"),
    "pair pill injected");

  const pill = window.document.getElementById("controller-pair-btn");
  assert.ok(pill, "pill injected into player chrome");
  assert.ok(pill.parentNode.querySelector(".player__status"), "pill parents next to sync pill");

  // Click pill -> POST /controller/start -> host WS opens -> modal mounts.
  pill.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => FakeWebSocket.instances.length === 1, "host WebSocket opened");
  assert.ok(
    calls.some((c) => c.method === "POST" && c.url.includes("/controller/start")),
    "pairing started via POST /controller/start",
  );
  assert.ok(
    FakeWebSocket.instances[0].url.includes("/api/controller/host?token=tok123"),
    "WS URL carries the pairing token",
  );

  const modal = window.document.getElementById("controller-pair-modal");
  assert.ok(modal, "pair modal mounted");
  assert.ok(
    modal.className.includes("modal-backdrop"),
    "pair modal carries .modal-backdrop so Escape/gamepad-B treat it as blocking (#14)",
  );

  // Phone joins -> pill flips to paired (green dot visible).
  FakeWebSocket.instances[0].emit("message", { data: JSON.stringify({ t: "pad-state", count: 1 }) });
  await waitFor(() => window.document.getElementById("controller-pair-dot").style.display === "inline-block",
    "pill shows paired state");

  // Soft-nav away (what ending an in-place play session triggers): the WS
  // must close cleanly and pill + modal must leave the DOM (#5).
  const ws = FakeWebSocket.instances[0];
  window.dispatchEvent(new window.CustomEvent("retrox:navigated", { detail: { path: "/games" } }));
  await waitFor(() => window.document.getElementById("controller-pair-btn") === null,
    "pill removed on navigation");
  assert.ok(Array.isArray(ws.closeArgs) && ws.closeArgs[0] === 1000,
    `WS closed with clean code 1000 (got ${JSON.stringify(ws.closeArgs)})`);
  assert.equal(window.document.getElementById("controller-pair-modal"), null,
    "modal removed on navigation");

  // The teardown listener is registered { once: true } — repeat events and
  // late window events must be harmless no-ops.
  window.dispatchEvent(new window.CustomEvent("retrox:navigated", { detail: { path: "/x" } }));
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(window.document.getElementById("controller-pair-btn"), null,
    "no resurrection / crash after teardown");

});
