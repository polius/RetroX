/* Unit tests for touch-layout.js — the pure storage/sanitize/geometry
 * helpers behind the customizable touch controls. The DOM flow (pill,
 * editor panel, dragging) is covered by tests/gamepad/test_touch_layout.py.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { importAppModule, makeDom, wireGlobals } from "./_harness.mjs";

// touch-layout.js imports api.js, which assigns window.api at import time.
const dom = makeDom("<body></body>", "https://retrox.local/play/x");
wireGlobals(dom);

const { sanitizeTouchLayout, resolveInitialState, snapCenter, clampCenter } =
  await importAppModule("touch-layout.js");

/* ---------- sanitizeTouchLayout ---------- */

test("sanitize: keeps valid layouts and options", () => {
  const out = sanitizeTouchLayout({
    scale: 1.3, opacity: 0.55, shape: "square", lefty: true,
    layouts: { "gb:landscape": { a: { x: 88.5, y: 51.2 }, dpad: { x: 11, y: 50 } } },
  });
  assert.equal(out.scale, 1.3);
  assert.equal(out.opacity, 0.55);
  assert.equal(out.shape, "square");
  assert.equal(out.lefty, true);
  assert.deepEqual(out.layouts["gb:landscape"].a, { x: 88.5, y: 51.2 });
});

test("sanitize: clamps scale/opacity/coords into range", () => {
  const out = sanitizeTouchLayout({
    scale: 42, opacity: -1,
    layouts: { "gba:portrait": { a: { x: 150, y: -3 } } },
  });
  assert.equal(out.scale, 1.8);
  assert.equal(out.opacity, 0.25);
  assert.deepEqual(out.layouts["gba:portrait"].a, { x: 100, y: 0 });
});

test("sanitize: drops junk keys, ids and positions; defaults shape", () => {
  const out = sanitizeTouchLayout({
    scale: "big", shape: "triangular",
    layouts: {
      "bad key": { a: { x: 1, y: 2 } },
      "gb:landscape": { "evil();": { x: 1, y: 2 }, a: { x: "x", y: null } },
    },
  });
  assert.equal(out.scale, 1);
  assert.equal(out.shape, "round");
  assert.deepEqual(out.layouts, {});
});

test("sanitize: null on non-object payloads", () => {
  for (const bad of [null, undefined, [1], "x", 5]) {
    assert.equal(sanitizeTouchLayout(bad), null);
  }
});

/* ---------- resolveInitialState ---------- */

test("resolve: device copy wins over server", () => {
  const local = { scale: 1.5, layouts: { "gb:landscape": { a: { x: 1, y: 2 } } } };
  const server = { scale: 0.7, layouts: {} };
  const { state, adopt } = resolveInitialState(local, server);
  assert.equal(state.scale, 1.5);
  assert.equal(adopt, false);
});

test("resolve: server seeds a device with nothing local", () => {
  const server = { scale: 0.7, layouts: { "gb:portrait": { a: { x: 3, y: 4 } } } };
  const { state, adopt } = resolveInitialState(null, server);
  assert.equal(state.scale, 0.7);
  assert.equal(adopt, true);
});

test("resolve: nothing usable anywhere falls back to defaults", () => {
  const { state, adopt } = resolveInitialState(null, null);
  assert.deepEqual(state, { scale: 1, opacity: 1, shape: "round", lefty: false, layouts: {} });
  assert.equal(adopt, false);
});

test("resolve: junk server dict degrades to default values (adopted)", () => {
  const { state, adopt } = resolveInitialState(null, { layouts: "nope" });
  assert.deepEqual(state, { scale: 1, opacity: 1, shape: "round", lefty: false, layouts: {} });
  assert.equal(adopt, true);
});

/* ---------- geometry ---------- */

test("clamp: keeps the control box inside the viewport", () => {
  // 60px half-width box dragged past the right edge on a 800x600 viewport.
  assert.deepEqual(clampCenter(900, 300, 60, 60, 800, 600),
    { x: 800 - 60 - 6, y: 300 });
  assert.deepEqual(clampCenter(-50, -50, 60, 60, 800, 600),
    { x: 66, y: 66 });
});

test("clamp: a control larger than the viewport pins to the center", () => {
  assert.deepEqual(clampCenter(10, 10, 500, 400, 800, 600),
    { x: 400, y: 300 });
});

test("snap: edges flush at the safe inset, interior untouched", () => {
  // Half-width 50 box whose left edge lands 8px shy of the 6px inset.
  assert.deepEqual(snapCenter(60, 300, 50, 50, 800, 600), { x: 56, y: 300 });
  // Same box snapped flush right.
  assert.deepEqual(snapCenter(740, 300, 50, 50, 800, 600), { x: 744, y: 300 });
  // Middle of nowhere: no magnet.
  assert.deepEqual(snapCenter(400, 300, 50, 50, 800, 600), { x: 400, y: 300 });
});
