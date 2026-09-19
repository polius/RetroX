/* DOM-level regression tests for pair.js — the phone-side controller page.
 * Covers fix #6: socket ownership (a stale socket's close event must never
 * tear down its replacement) and the double-submit guard on connect().
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeWebSocket, importAppModule, makeDom, resetWebSockets,
  stubFetch, waitFor, wireGlobals, jsonResponse,
} from "./_harness.mjs";

test("pair: double-submit guard, socket ownership, and server kick (4001)", async () => {
  resetWebSockets();
  const dom = makeDom('<div id="pair-root"></div>', "https://retrox.local/pair?code=ABC123");
  const window = wireGlobals(dom);
  window.WebSocket = FakeWebSocket;
  globalThis.WebSocket = FakeWebSocket;

  // Hold the first lookup in flight so we can prove the in-flight guard.
  let lookupCalls = 0;
  let releaseLookup;
  const lookupGate = new Promise((r) => { releaseLookup = r; });
  stubFetch((call) => {
    if (call.url.includes("/controller/lookup/")) {
      lookupCalls++;
      return lookupGate.then(() => jsonResponse({ code: "ABC123" }));
    }
    return Promise.resolve(jsonResponse({ username: "tester", is_admin: false }));
  });

  await importAppModule("pair.js");
  await waitFor(() => window.document.getElementById("pair-form"), "entry form rendered");
  assert.equal(window.document.getElementById("pair-code").value, "ABC123",
    "code prefilled from the QR-scan URL");

  const form = window.document.getElementById("pair-form");
  const submit = () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  // Double-submit while the first connect is in flight -> exactly one lookup.
  submit();
  submit();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lookupCalls, 1, `double-submit guard: one lookup in flight (got ${lookupCalls})`);

  releaseLookup();
  await waitFor(() => FakeWebSocket.instances.length === 1, "first socket opened");
  const sockA = FakeWebSocket.instances[0];
  await waitFor(() => window.document.getElementById("pad"), "pad UI rendered for live socket");

  // Re-connect after completion: replacement socket opens, old one is closed
  // by openSocket itself (1000) — not left dangling.
  submit();
  await waitFor(() => FakeWebSocket.instances.length === 2, "replacement socket opened");
  const sockB = FakeWebSocket.instances[1];
  assert.ok(Array.isArray(sockA.closeArgs) && sockA.closeArgs[0] === 1000,
    `old socket closed with 1000 (got ${JSON.stringify(sockA.closeArgs)})`);

  // The reported bug: A's close event arrives AFTER its replacement exists.
  // Ownership check must ignore it — the live pad stays on screen.
  sockA.emit("close", { code: 4001, reason: "" });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(window.document.getElementById("pad"),
    "stale close event ignored; live socket unaffected");

  // Now the CURRENT socket is kicked by the server (a newer phone took over).
  sockB.emit("close", { code: 4001, reason: "" });
  await waitFor(() => !window.document.getElementById("pad"), "entry form restored after kick");
  const status = window.document.getElementById("pair-status").textContent;
  assert.ok(status.includes("took over"), `4001 lands on takeover message (got "${status}")`);

});
