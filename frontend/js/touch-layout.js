/* touch-layout.js — user-customizable on-screen touch controls.
 *
 * Drag-to-reposition editing plus scale/opacity/shape/left-handed options
 * for EmulatorJS's virtual gamepad. Layouts are stored per control scheme
 * and orientation as percent-of-viewport control centers — locally
 * (instant, offline) and in the user's server preferences (device wins).
 */

import { api } from "./api.js";

const LS_KEY = "retrox.touch_layout";
const PREF_KEY = "touch_layout";

const SCALE_MIN = 0.6;
const SCALE_MAX = 1.8;
const OPACITY_MIN = 0.25;
const EDGE_PX = 6;      // control boxes never come closer than this to the viewport edge
const SNAP_PX = 14;     // magnet range that pulls a control edge flush to EDGE_PX
const SAVE_DEBOUNCE_MS = 600;

const DEFAULTS = Object.freeze({
  scale: 1, opacity: 1, shape: "round", lefty: false, layouts: {},
});

/* ==================== pure helpers (exported for tests) ==================== */

// Mirror of the backend sanitizer: coerces stored/synced data into a clean
// state object, or null when the payload is unusable.
export function sanitizeTouchLayout(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  out.scale = clampNum(raw.scale, SCALE_MIN, SCALE_MAX, 1);
  out.opacity = clampNum(raw.opacity, OPACITY_MIN, 1, 1);
  out.shape = raw.shape === "square" ? "square" : "round";
  out.lefty = raw.lefty === true;
  out.layouts = {};
  const layouts = raw.layouts;
  if (layouts && typeof layouts === "object" && !Array.isArray(layouts)) {
    for (const [key, map] of Object.entries(layouts)) {
      if (!/^[a-z0-9_-]{1,40}:(landscape|portrait)$/.test(key)) continue;
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      const entries = {};
      for (const [id, pos] of Object.entries(map)) {
        if (!/^[a-z0-9_]{1,24}$/.test(id)) continue;
        const x = clampNum(pos?.x, 0, 100, null);
        const y = clampNum(pos?.y, 0, 100, null);
        if (x === null || y === null) continue;
        entries[id] = { x, y };
      }
      if (Object.keys(entries).length) out.layouts[key] = entries;
    }
  }
  return out;
}

function clampNum(v, lo, hi, fallback) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
}

// Device copy wins; the server copy only seeds devices with nothing local.
export function resolveInitialState(localRaw, serverRaw) {
  const local = sanitizeTouchLayout(localRaw);
  if (local) return { state: local, adopt: false };
  const server = sanitizeTouchLayout(serverRaw);
  if (server) return { state: server, adopt: true };
  return { state: JSON.parse(JSON.stringify(DEFAULTS)), adopt: false };
}

// Keep a control's center so its (scaled) box stays inside the viewport.
export function clampCenter(x, y, halfW, halfH, vw, vh) {
  const loX = Math.min(halfW + EDGE_PX, vw / 2);
  const hiX = Math.max(vw - halfW - EDGE_PX, vw / 2);
  const loY = Math.min(halfH + EDGE_PX, vh / 2);
  const hiY = Math.max(vh - halfH - EDGE_PX, vh / 2);
  return { x: Math.min(hiX, Math.max(loX, x)), y: Math.min(hiY, Math.max(loY, y)) };
}

// Magnet: when an edge of the box is within SNAP_PX of the safe inset,
// pull it flush — this is what makes edges feel tidy.
export function snapCenter(x, y, halfW, halfH, vw, vh) {
  const targets = [
    [EDGE_PX + halfW, x - (EDGE_PX + halfW)],
    [vw - EDGE_PX - halfW, x - (vw - EDGE_PX - halfW)],
  ];
  for (const [t, d] of targets) if (Math.abs(d) < SNAP_PX) x = t;
  const vTargets = [
    [EDGE_PX + halfH, y - (EDGE_PX + halfH)],
    [vh - EDGE_PX - halfH, y - (vh - EDGE_PX - halfH)],
  ];
  for (const [t, d] of vTargets) if (Math.abs(d) < SNAP_PX) y = t;
  return { x, y };
}

/* ==================== module state ==================== */

let state = null;
let emu = null;
let pad = null;
let realign = null;
let scheme = "default";
let orient = "landscape";
let controls = [];        // { id, el }
let styleEl = null;
let panel = null;
let pill = null;
let editing = false;
let wePaused = false;
let drag = null;
let rafId = 0;
let saveTimer = 0;
let cleanups = [];

const mapKey = () => `${scheme}:${orient}`;
const currentOrient = () => (window.innerWidth >= window.innerHeight ? "landscape" : "portrait");
const isTouchDevice = () =>
  matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;

/* ==================== init / teardown ==================== */

export function initTouchLayout({ serverPrefs, realign: onRealign } = {}) {
  emu = window.EJS_emulator;
  pad = emu?.elements?.parent?.querySelector?.(".ejs_virtualGamepad_parent");
  if (!pad || document.getElementById("touch-layout-btn")) return null;
  realign = onRealign;

  const localRaw = readLocal();
  const { state: s, adopt } = resolveInitialState(localRaw, serverPrefs?.[PREF_KEY]);
  state = s;
  if (adopt) writeLocal();

  scheme = typeof emu.getControlScheme === "function" ? emu.getControlScheme() : "default";
  orient = currentOrient();
  discoverControls();
  buildPanel();
  injectPill();
  installEditBlockers();
  syncMode();

  // Device wins: if a local layout exists and differs from the server's,
  // push it up so new devices get seeded with it.
  if (Object.keys(state.layouts).length
      && JSON.stringify(sanitizeTouchLayout(serverPrefs?.[PREF_KEY])) !== JSON.stringify(state)) {
    persist();
  }

  const onViewport = () => {
    const next = currentOrient();
    if (next !== orient) {
      orient = next;
      if (editing) stopEditing();   // re-baseline on rotation; user re-opens the editor
    }
    syncMode();
    syncPillVisibility();
  };
  window.addEventListener("resize", onViewport);
  window.addEventListener("orientationchange", onViewport);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("retrox:navigated", destroy, { once: true });
  cleanups.push(
    () => window.removeEventListener("resize", onViewport),
    () => window.removeEventListener("orientationchange", onViewport),
    () => document.removeEventListener("visibilitychange", onVisibility),
  );

  // EJS can hide/show the pad from its own settings menu — track it.
  const padObserver = new MutationObserver(syncPillVisibility);
  padObserver.observe(pad, { attributes: true, attributeFilter: ["style"] });
  cleanups.push(() => padObserver.disconnect());
  syncPillVisibility();
  return {};
}

function destroy() {
  for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* noop */ } }
  if (editing) { editing = false; pad?.classList.remove("rx-vpad-editing"); }
  pad?.classList.remove("rx-vpad-custom", "rx-vpad-square", "rx-vpad-editing");
  const menuBar = document.querySelector(".ejs_menu_bar");
  if (menuBar) menuBar.style.visibility = "";
  pill?.remove();
  panel?.remove();
  styleEl?.remove();
  clearTimeout(saveTimer);
  flushServerSave();
  emu = pad = panel = pill = styleEl = null;
  controls = [];
}

function onVisibility() {
  if (document.hidden) flushServerSave();
}

/* ==================== storage ==================== */

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; }
}

function writeLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

function persist() {
  writeLocal();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushServerSave, SAVE_DEBOUNCE_MS);
}

function flushServerSave() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!state) return;
  api.put("/profile/preferences", { data: { [PREF_KEY]: state } })
    .catch((err) => console.warn("[touch-layout] preference sync failed", err));
}

/* ==================== control discovery ==================== */

function discoverControls() {
  controls = [];
  for (const el of pad.querySelectorAll(".ejs_virtualGamepad_button")) {
    const id = [...el.classList].find((c) => c.startsWith("b_"))?.slice(2);
    if (!id || (!el.offsetWidth && !el.offsetHeight)) continue;   // hidden button
    el.dataset.rxId = id;
    controls.push({ id, el });
  }
  const dpad = pad.querySelector(".ejs_dpad_main");
  if (dpad && dpad.offsetWidth) {
    dpad.dataset.rxId = "dpad";
    controls.push({ id: "dpad", el: dpad });
  }
  for (const { el } of controls) {
    el.classList.add("rx-vpad-control");
    el.addEventListener("pointerdown", onControlPointerDown);
    el.addEventListener("pointermove", onControlPointerMove);
    el.addEventListener("pointerup", onControlPointerUp);
    el.addEventListener("pointercancel", onControlPointerUp);
  }
}

// While editing, swallow every touch before EJS's handlers see it and
// block pointer traffic that isn't one of our drag targets.
function installEditBlockers() {
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    pad.addEventListener(type, touchBlock, true);
    cleanups.push(() => pad.removeEventListener(type, touchBlock, true));
  }
  pad.addEventListener("pointerdown", pointerBlock, true);
  cleanups.push(() => pad.removeEventListener("pointerdown", pointerBlock, true));
}

/* ==================== apply (custom mode) ==================== */

// Custom mode is all-or-nothing per scheme+orientation: either every
// control follows the frozen map, or the stock auto-layout stands.
function syncMode() {
  if (!pad) return;
  const custom = !!state.layouts[mapKey()];
  const was = pad.classList.contains("rx-vpad-custom");
  pad.classList.toggle("rx-vpad-custom", custom);
  if (custom) {
    pinClusters();
    ensureStyleEl();
    applyStyleVars();
    applyPositions();
  } else if (was) {
    realign?.();   // hand the clusters back to the stock alignment engine
  }
}

// Pin every cluster to the viewport origin so per-control positions are
// plain viewport coordinates. Clusters hosting joystick zones keep their
// stock spot (nipplejs manages those internally).
function pinClusters() {
  for (const el of pad.querySelectorAll(
    ".ejs_virtualGamepad_left, .ejs_virtualGamepad_right, .ejs_virtualGamepad_bottom, .ejs_virtualGamepad_top")) {
    el.classList.toggle("rx-vpad-pin", !el.querySelector(".nipple"));
  }
}

// Per-control !important rules driven by CSS vars — the only way to beat
// EmulatorJS's inline styles AND player.css's own landscape !important rules.
function ensureStyleEl() {
  if (styleEl) return;
  styleEl = document.createElement("style");
  styleEl.id = "rx-vpad-style";
  let rules = "";
  for (const { id } of controls) {
    const cls = id === "dpad" ? ".ejs_dpad_main" : `.ejs_virtualGamepad_button.b_${id}`;
    rules += `.ejs_virtualGamepad_parent.rx-vpad-custom ${cls}{`
      + `left:var(--rx-x-${id},auto) !important;top:var(--rx-y-${id},auto) !important;`
      + `right:auto !important;bottom:auto !important;}`;
  }
  styleEl.textContent = rules;
  document.head.appendChild(styleEl);
}

function applyStyleVars() {
  pad.style.setProperty("--rx-vpad-scale", String(state.scale));
  pad.style.setProperty("--rx-vpad-opacity", String(state.opacity));
  pad.classList.toggle("rx-vpad-square", state.shape === "square");
}

function applyPositions() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const map = state.layouts[mapKey()] || {};
  for (const { id, el } of controls) {
    const pos = map[id];
    if (!pos) continue;
    const half = visualHalf(el);
    const { x, y } = clampCenter(pos.x / 100 * vw, pos.y / 100 * vh, half.w, half.h, vw, vh);
    setControlVars(id, el, x, y);
  }
}

function setControlVars(id, el, cx, cy) {
  pad.style.setProperty(`--rx-x-${id}`, `${(cx - el.offsetWidth / 2).toFixed(1)}px`);
  pad.style.setProperty(`--rx-y-${id}`, `${(cy - el.offsetHeight / 2).toFixed(1)}px`);
}

const visualHalf = (el) => ({
  w: el.offsetWidth * state.scale / 2,
  h: el.offsetHeight * state.scale / 2,
});

// Snapshot the current on-screen positions into the map — the moment a
// layout becomes "custom" it starts as a pixel-identical copy of stock.
function freezeLayout() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const map = {};
  for (const { id, el } of controls) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    map[id] = {
      x: Math.round((r.left + r.width / 2) / vw * 10000) / 100,
      y: Math.round((r.top + r.height / 2) / vh * 10000) / 100,
    };
  }
  state.layouts[mapKey()] = map;
}

/* ==================== editing ==================== */

function startEditing() {
  if (editing || !pad) return;
  orient = currentOrient();
  if (!state.layouts[mapKey()]) freezeLayout();
  editing = true;
  syncMode();
  wePaused = pauseGame();
  pad.classList.add("rx-vpad-editing");
  // EJS's toolbar sprawls under the controls on narrow screens and just
  // adds noise in edit mode — hide it for the session.
  const menuBar = document.querySelector(".ejs_menu_bar");
  if (menuBar) menuBar.style.visibility = "hidden";
  document.addEventListener("keydown", onEditKey, true);
  refreshPanel();
  panel.classList.remove("rx-editor--hidden");
}

function stopEditing() {
  if (!editing) return;
  editing = false;
  drag = null;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  flushServerSave();
  pad.classList.remove("rx-vpad-editing");
  const menuBar = document.querySelector(".ejs_menu_bar");
  if (menuBar) menuBar.style.visibility = "";
  document.removeEventListener("keydown", onEditKey, true);
  panel.classList.add("rx-editor--hidden");
  if (wePaused) { try { emu?.play?.(true); } catch { /* already gone */ } }
  wePaused = false;
}

function pauseGame() {
  if (emu && !emu.paused && typeof emu.pause === "function") { emu.pause(true); return true; }
  return false;
}

function onEditKey(e) {
  if (e.key !== "Escape") return;
  e.stopPropagation();   // Esc here means Done, never the game's exit shortcut
  e.preventDefault();
  stopEditing();
}

const touchBlock = (e) => {
  if (!editing) return;
  e.stopPropagation();   // keep EJS's touch→simulateInput path out of the way
  e.preventDefault();
};
const pointerBlock = (e) => {
  if (!editing) return;
  if (e.target.closest?.(".rx-vpad-control")) return;   // our drag handlers need it
  e.stopPropagation();   // freezes joystick zones etc. during editing
};

/* ---------- drag ---------- */

function onControlPointerDown(e) {
  if (!editing || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
  e.preventDefault();
  const el = e.currentTarget;
  const half = visualHalf(el);
  const pos = state.layouts[mapKey()]?.[el.dataset.rxId];
  const r = el.getBoundingClientRect();
  drag = {
    id: el.dataset.rxId, el,
    startX: e.clientX, startY: e.clientY,
    baseX: pos ? pos.x / 100 * window.innerWidth : r.left + r.width / 2,
    baseY: pos ? pos.y / 100 * window.innerHeight : r.top + r.height / 2,
    hw: half.w, hh: half.h, x: undefined, y: undefined,
  };
  try { el.setPointerCapture(e.pointerId); } catch { /* detached */ }
  el.classList.add("rx-dragging");
  try { navigator.vibrate?.(8); } catch { /* unsupported */ }
}

function onControlPointerMove(e) {
  if (!drag || drag.el !== e.currentTarget) return;
  let { x, y } = {
    x: drag.baseX + (e.clientX - drag.startX),
    y: drag.baseY + (e.clientY - drag.startY),
  };
  ({ x, y } = snapCenter(x, y, drag.hw, drag.hh, window.innerWidth, window.innerHeight));
  ({ x, y } = clampCenter(x, y, drag.hw, drag.hh, window.innerWidth, window.innerHeight));
  drag.x = x; drag.y = y;
  if (!rafId) rafId = requestAnimationFrame(flushDrag);
}

function flushDrag() {
  rafId = 0;
  if (!drag || drag.x === undefined) return;
  setControlVars(drag.id, drag.el, drag.x, drag.y);
}

function onControlPointerUp(e) {
  if (!drag || drag.el !== e.currentTarget) return;
  const d = drag;
  drag = null;
  d.el.classList.remove("rx-dragging");
  try { d.el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  if (d.x === undefined) return;
  state.layouts[mapKey()][d.id] = {
    x: Math.round(d.x / window.innerWidth * 10000) / 100,
    y: Math.round(d.y / window.innerHeight * 10000) / 100,
  };
  persist();
  try { navigator.vibrate?.(6); } catch { /* unsupported */ }
}

/* ==================== editor panel ==================== */

const ICONS = {
  sliders: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2.2"/><circle cx="10" cy="16" r="2.2"/></svg>',
  swap: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
  reset: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  circle: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>',
  square: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="4.5"/></svg>',
  chevron: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>',
};

function buildPanel() {
  panel = document.createElement("div");
  panel.className = "rx-editor rx-editor--hidden";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "Touch controls editor");
  panel.innerHTML = `
    <div class="rx-editor__main">
      <label class="rx-editor__slider">
        <span>Size</span>
        <input id="rx-scale" type="range" min="${SCALE_MIN * 100}" max="${SCALE_MAX * 100}" step="5" aria-label="Control size">
        <output id="rx-scale-out">100%</output>
      </label>
      <label class="rx-editor__slider">
        <span>Fade</span>
        <input id="rx-opacity" type="range" min="${OPACITY_MIN * 100}" max="100" step="5" aria-label="Control opacity">
        <output id="rx-opacity-out">100%</output>
      </label>
      <div class="rx-editor__seg" role="group" aria-label="Button shape">
        <button type="button" data-shape="round" title="Round buttons" aria-label="Round buttons">${ICONS.circle}</button>
        <button type="button" data-shape="square" title="Square buttons" aria-label="Square buttons">${ICONS.square}</button>
      </div>
      <button type="button" class="rx-editor__btn" id="rx-lefty" title="Swap sides (left-handed)" aria-label="Swap sides">${ICONS.swap}</button>
      <button type="button" class="rx-editor__btn" id="rx-reset" title="Reset this orientation to defaults" aria-label="Reset layout">${ICONS.reset}</button>
      <button type="button" class="rx-editor__collapse" id="rx-collapse" title="Collapse panel" aria-label="Collapse panel">${ICONS.chevron}</button>
      <button type="button" class="rx-editor__done" id="rx-done">Done</button>
    </div>
    <div class="rx-editor__hint">Drag any control to move it</div>
  `;
  document.body.appendChild(panel);
  followPillParent(panel);

  const scale = panel.querySelector("#rx-scale");
  const opacity = panel.querySelector("#rx-opacity");
  scale.addEventListener("input", () => {
    state.scale = Number(scale.value) / 100;
    panel.querySelector("#rx-scale-out").textContent = `${scale.value}%`;
    applyStyleVars();
    applyPositions();
    persist();
  });
  opacity.addEventListener("input", () => {
    state.opacity = Number(opacity.value) / 100;
    panel.querySelector("#rx-opacity-out").textContent = `${opacity.value}%`;
    applyStyleVars();
    persist();
  });
  for (const btn of panel.querySelectorAll("[data-shape]")) {
    btn.addEventListener("click", () => {
      state.shape = btn.dataset.shape;
      applyStyleVars();
      refreshPanel();
      persist();
    });
  }
  panel.querySelector("#rx-lefty").addEventListener("click", () => {
    state.lefty = !state.lefty;
    swapSides();
    applyPositions();
    refreshPanel();
    persist();
  });
  panel.querySelector("#rx-reset").addEventListener("click", resetCurrentOrientation);
  panel.querySelector("#rx-collapse").addEventListener("click", () => {
    panel.classList.toggle("rx-editor--min");
  });
  panel.querySelector("#rx-done").addEventListener("click", stopEditing);
}

function refreshPanel() {
  if (!panel) return;
  panel.querySelector("#rx-scale").value = String(Math.round(state.scale * 100));
  panel.querySelector("#rx-opacity").value = String(Math.round(state.opacity * 100));
  panel.querySelector("#rx-scale-out").textContent = `${Math.round(state.scale * 100)}%`;
  panel.querySelector("#rx-opacity-out").textContent = `${Math.round(state.opacity * 100)}%`;
  for (const btn of panel.querySelectorAll("[data-shape]")) {
    btn.classList.toggle("is-active", btn.dataset.shape === state.shape);
  }
  panel.querySelector("#rx-lefty").classList.toggle("is-active", state.lefty);
}

// Mirror all stored layouts horizontally — involutive, so the same button
// swaps back.
function swapSides() {
  for (const map of Object.values(state.layouts)) {
    for (const pos of Object.values(map)) pos.x = Math.round((100 - pos.x) * 100) / 100;
  }
}

function resetCurrentOrientation() {
  // Back to the stock layout first, snapshot it, then re-enter custom mode
  // so the sliders keep working on top of a pristine arrangement. Transitions
  // are suppressed and the stock engine re-runs so the snapshot measures
  // settled geometry.
  pad.classList.add("rx-vpad-noanim");
  pad.classList.remove("rx-vpad-custom");
  realign?.();
  void pad.offsetWidth;
  state = { ...JSON.parse(JSON.stringify(DEFAULTS)), layouts: state.layouts };
  delete state.layouts[mapKey()];
  freezeLayout();
  pad.classList.remove("rx-vpad-noanim");
  syncMode();
  refreshPanel();
  persist();
}

/* ==================== pill ==================== */

function injectPill() {
  pill = document.createElement("button");
  pill.id = "touch-layout-btn";
  pill.type = "button";
  pill.className = "player__pill";
  pill.title = "Customize touch controls";
  pill.setAttribute("aria-label", "Customize touch controls");
  pill.innerHTML = `${ICONS.sliders}<span id="touchlayout-label">Layout</span>`;
  pill.addEventListener("click", () => (editing ? stopEditing() : startEditing()));
  document.body.appendChild(pill);
  followPillParent(pill);
  positionPill();
  window.addEventListener("resize", positionPill);
  for (const evt of FS_EVENTS) {
    document.addEventListener(evt, positionPill);
    cleanups.push(() => document.removeEventListener(evt, positionPill));
  }
  cleanups.push(() => window.removeEventListener("resize", positionPill));
  observePillRow();
  // Mirror the back button's auto-fade so hidden chrome never intercepts taps.
  const back = document.getElementById("back-btn");
  if (back) {
    const syncFade = () => {
      const faded = back.classList.contains("is-faded");
      pill.style.opacity = faded ? "0" : "1";
      pill.style.pointerEvents = faded ? "none" : "auto";
    };
    const fadeObs = new MutationObserver(syncFade);
    fadeObs.observe(back, { attributes: true, attributeFilter: ["class"] });
    cleanups.push(() => fadeObs.disconnect());
    syncFade();
  }
}

// Sit to the left of the leftmost sibling pill — no anchoring chain, so a
// late-mounting or reshuffling sibling can never leave us overlapping it.
function positionPill() {
  if (!pill) return;
  const SPACER = 8, SAFE_RIGHT = 16;
  // Narrow screens: the pill lives on its own row below the others.
  if (window.innerWidth <= 480) {
    pill.style.right = `${SAFE_RIGHT}px`;
    return;
  }
  const rects = [".player__status", "#controller-bindings-btn", "#controller-pair-btn"]
    .map((s) => document.querySelector(s)?.getBoundingClientRect())
    .filter((r) => r && r.width > 0);
  const leftmost = rects.length ? Math.min(...rects.map((r) => r.left)) : null;
  pill.style.right = `${leftmost !== null
    ? Math.max(SAFE_RIGHT, window.innerWidth - leftmost + SPACER)
    : SAFE_RIGHT}px`;
}

function observePillRow() {
  // The sync pill's rotating label is what reshuffles the row; watch it
  // the same way the other pills do. Settle timers cover late mounts.
  const watchSync = () => {
    const sync = document.querySelector(".player__status");
    if (!sync) return;
    const obs = new MutationObserver(positionPill);
    obs.observe(sync, { attributes: true, childList: true, subtree: true, characterData: true });
    cleanups.push(() => obs.disconnect());
  };
  watchSync();
  for (const id of ["controller-bindings-btn", "controller-pair-btn"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const obs = new MutationObserver(positionPill);
    obs.observe(el, { attributes: true, attributeFilter: ["style"] });
    cleanups.push(() => obs.disconnect());
  }
  for (const t of [250, 900, 2200]) setTimeout(positionPill, t);
}

function syncPillVisibility() {
  if (!pill) return;
  const visible = !!pad && pad.style.display !== "none" && isTouchDevice();
  pill.style.display = visible ? "" : "none";
}

/* Keep the pill (and the panel) inside the fullscreen subtree — fixed
 * elements outside it don't render while an element is fullscreen. */
const FS_EVENTS = ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"];

function followPillParent(el) {
  const relocate = () => {
    const sync = document.querySelector(".player__status");
    const target = sync?.parentNode || document.body;
    if (el.parentNode !== target) target.appendChild(el);
  };
  relocate();
  for (const evt of FS_EVENTS) {
    document.addEventListener(evt, relocate);
    cleanups.push(() => document.removeEventListener(evt, relocate));
  }
}
