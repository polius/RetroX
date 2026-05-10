/* play.js — boots EmulatorJS for the requested game and wires the slot system.
 *
 * Boot sequence:
 *   1. Load metadata in parallel: /auth/me, /games/<id>, /games/<id>/saves/<slot>/save
 *   2. Read the local IndexedDB cache for this (user, game, slot)
 *   3. Run the RECONCILIATION MATRIX to decide what bytes to inject
 *      (server, local, or empty) and whether to push pending edits
 *   4. Construct the SavePersistor with the resolved bytes
 *   5. Install a setter trap on window.EJS_emulator so attach() runs the
 *      moment EJS instantiates — no race window with the start event
 *   6. Load EmulatorJS, which boots the core
 *   7. SavePersistor handles the rest: hooks, polls, cache + uploads
 *
 * Save lifecycle:
 *   - Battery save (.save) is auto-persisted by SavePersistor
 *   - Save state (.state) is created only when the user clicks Save State
 *     in the toolbar (or the Select+L1 gamepad combo)
 */

import { api } from "./api.js";
import { toast, modal } from "./toast.js";
import { startPlaytimeTracker } from "./playtime.js";
import { saveCache, stateCache } from "./save-cache.js";
import { SavePersistor, fnv1a } from "./save-persistor.js";
import { SaveIndicator } from "./save-indicator.js";
import { codeToEjsKey } from "./key-codes.js";
import {
  GAME_INPUT_TO_EJS_SLOT,
  DPAD_TO_LEFT_STICK_SLOT,
  KEYBOARD_DEFAULTS,
} from "./bindings-defaults.js";
import { hatDpad } from "./gamepad-hat.js";

/* ============ URL parsing ============ */

const params = new URLSearchParams(location.search);
const slug = location.pathname.replace(/^\/play\/?/, "") || params.get("id");
const requestedSlot = parseInt(params.get("slot"), 10);
const requestedDisk = parseInt(params.get("disk") || "1", 10);

if (!slug) {
  document.body.textContent = "Missing game id.";
  throw new Error("missing id");
}
if (!Number.isInteger(requestedSlot) || requestedSlot < 1 || requestedSlot > 5) {
  document.body.textContent = "Invalid save slot.";
  throw new Error("invalid slot");
}

const activeSlot = requestedSlot;

/* ============ Module-scope state shared by player chrome + persistor ============
 *
 * Declared up-front so any closure that captures them — notably the
 * fullscreen-change listener installed by playerChrome below — never
 * touches an uninitialised `let` and trips a Temporal Dead Zone
 * ReferenceError. The previous version declared `playHint` only at its
 * point of use, ~400 lines below; in the in-app flow game.js calls
 * host.requestFullscreen() before importing this module, the resulting
 * fullscreenchange event fires during play.js's first `await`, and the
 * relocate listener — which closes over playHint — threw before we
 * ever reached the declaration. The thrown listener missed the initial
 * relocation, leaving the chrome unable to follow EJS into fullscreen
 * later (when the user hits the toolbar's fullscreen button) and the
 * pills disappeared from the fullscreen subtree entirely. */
let persistor = null;
let indicator = null;
let playHint  = null;

const goBack = () => {
  if (persistor) persistor.flushSync();
  // Use replace, not assign: when /play was reached via the in-app
  // pushState flow from /game, history looks like [..., /game/<slug>,
  // /play/<slug>]. assign() would push a new /game entry, leaving the
  // /play one in the back stack — pressing browser-Forward later
  // would load /play.html standalone and reintroduce the autoplay-
  // policy stall. replace() collapses /play out of history entirely.
  location.replace(`/game/${encodeURIComponent(slug)}`);
};

document.getElementById("back-btn").addEventListener("click", goBack);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") goBack(); });

/* ============ Player chrome: back button + status pill + play hint ============
 *
 * The chrome lives outside the EmulatorJS subtree and has two jobs:
 *
 *  1) Stay inside whatever element is currently fullscreen, so it remains
 *     painted under the CSS Fullscreen spec (which only renders the
 *     fullscreen element and its descendants). Targets vary across our
 *     two entry paths:
 *       - standalone /play.html: nothing is fullscreen until the user
 *         hits EJS's toolbar button, at which point #game becomes the
 *         target.
 *       - in-app via /game's startPlayInPlace: game.js fullscreens
 *         #player-host before this module loads, so we are ALREADY in
 *         fullscreen when we initialise. The chrome is born inside
 *         #player-host, so the initial relocate is a no-op — but we
 *         still call it once on init to bind the wake listener to the
 *         right element and to handle the rare case where game.js's
 *         requestFullscreen failed and we landed windowed.
 *
 *  2) Mirror EmulatorJS's bottom-bar fade: stay visible for 3 s of
 *     pointer idleness, fade out, wake on any pointer movement inside
 *     the player. Bound to the current pills home (which can change
 *     when the user toggles EJS-side fullscreen) so the wake fires for
 *     events from inside the fullscreen subtree too. */
const playerChrome = (() => {
  const backEl = document.getElementById("back-btn");
  if (!backEl) return null;

  let activeWakeTarget = null;
  let hideTimer = null;

  function fullscreenEl() {
    return document.fullscreenElement
        || document.webkitFullscreenElement
        || document.mozFullScreenElement
        || document.msFullscreenElement
        || null;
  }
  function playerHost() {
    return document.getElementById("player-host")
      || document.querySelector(".player-host")
      || document.body;
  }
  function pillsHome() {
    const fs   = fullscreenEl();
    const host = playerHost();
    // When player-host is the fullscreen target (the in-app flow), or
    // nothing is fullscreen, pills belong inside player-host. Only
    // relocate when something OTHER than player-host has fullscreen
    // (e.g. EJS's toolbar button fullscreening its inner #game).
    return (fs && fs !== host) ? fs : host;
  }

  function relocate() {
    const target = pillsHome();
    // appendChild moves an already-attached node — listeners stay
    // attached, no DOM recreation, no flicker.
    if (backEl.parentNode !== target) target.appendChild(backEl);
    const indEl = indicator?.element;
    if (indEl && indEl.parentNode !== target) target.appendChild(indEl);
    if (playHint && playHint.parentNode !== target) target.appendChild(playHint);
    bindWakeTo(target);
  }

  function bindWakeTo(target) {
    if (activeWakeTarget === target) return;
    if (activeWakeTarget) {
      activeWakeTarget.removeEventListener("mousemove",  wake);
      activeWakeTarget.removeEventListener("touchstart", wakeFromTouch);
    }
    target.addEventListener("mousemove",  wake);
    target.addEventListener("touchstart", wakeFromTouch, { passive: true });
    activeWakeTarget = target;
  }

  function wake() {
    backEl.classList.remove("is-faded");
    indicator?.setFaded?.(false);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      backEl.classList.add("is-faded");
      indicator?.setFaded?.(true);
    }, 3000);
  }

  // Touches that land on EJS's on-screen virtual gamepad (D-pad, A/B,
  // Start/Select, Fast/Slow/Rewind) are gameplay input, not "show me
  // the chrome" intent — without this filter the Back / Sync pills
  // stay visible the entire mobile session because every button
  // press bubbles a touchstart up to the wake target. Touches on
  // the game canvas or any non-gamepad area still wake normally.
  // No-op on desktop: the virtual gamepad isn't rendered there.
  function wakeFromTouch(e) {
    if (e.target?.closest?.(".ejs_virtualGamepad_parent")) return;
    wake();
  }

  // Initial bind, BEFORE any await — so we observe whatever fullscreen
  // state game.js has already entered. Without this, the in-app flow's
  // requestFullscreen call fires its fullscreenchange before this
  // module's listener can attach, and we'd never know fullscreen was
  // active until the user exited and re-entered it.
  relocate();
  wake();

  ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"]
    .forEach(evt => document.addEventListener(evt, relocate));

  return { relocate, wake };
})();

/* ============ Load metadata in parallel ============ */

let me, game, prefs;
try {
  let prefsR;
  // Preferences are best-effort: if the request fails, the keyboard
  // shortcuts fall back to their hardcoded defaults rather than blocking
  // the game launch. .catch on the inner promise keeps the outer one
  // resolved so a transient prefs error doesn't cascade.
  [me, game, prefsR] = await Promise.all([
    api.get("/auth/me"),
    api.get(`/games/${encodeURIComponent(slug)}`),
    api.get("/profile/preferences").catch(() => ({})),
  ]);
  prefs = prefsR || {};
} catch (err) {
  if (err && err.status === 401) throw err;
  toast.fromError(err, "Couldn't load the game");
  throw err;
}

if (!me || !me.username) {
  document.body.textContent = "Not signed in.";
  throw new Error("no user");
}

document.title = `${game.name} · RetroX`;

const slotMeta = (game.slots || []).find((s) => s.slot === activeSlot);
const initialSlotUpdatedAt = slotMeta?.updated_at || null;
const initialSlotGeneration = Number.isFinite(slotMeta?.generation) ? slotMeta.generation : null;

/* ============ Reconciliation: server + local cache → bytes to inject ============ */

// Cap the server fetch — on flaky LAN/VPN connections the request can
// hang indefinitely, leaving the player stuck on the loading screen.
// Treat a timeout as offline and fall back to the local cache.
const SERVER_FETCH_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Pre-fetch the server save in parallel with the local cache read.
//
// `api.raw` calls handle() internally, which throws an APIError for any
// non-2xx response — so the 404 case can ONLY surface as a thrown
// APIError, never as a returned response with `r.status === 404`. We
// branch on the thrown error's status to distinguish "no save exists
// for this slot" (which the reconcile matrix treats as a clean slate
// or an offline-only-save-coming-online signal) from "server unreachable
// / timeout" (which falls back to whatever local cache has).
const serverFetchPromise = (async () => {
  try {
    const r = await withTimeout(
      api.raw(`/games/${encodeURIComponent(game.id)}/saves/${activeSlot}/save`),
      SERVER_FETCH_TIMEOUT_MS,
    );
    // api.raw throws on non-2xx, so r is guaranteed OK here. A 304
    // would also be possible in principle, but withCredentials fetches
    // exposing 304 to JS is implementation-defined; the browser
    // resolves the cached body for us when revalidation succeeds.
    const bytes = new Uint8Array(await r.arrayBuffer());
    return {
      status: "ok",
      bytes,
      updatedAt: initialSlotUpdatedAt,
      generation: initialSlotGeneration,
    };
  } catch (err) {
    if (err && err.status === 404) return { status: "404" };
    return { status: "fail" };
  }
})();

const cachedPromise = saveCache.get(me.username, game.id, activeSlot);

const [serverResult, cached] = await Promise.all([serverFetchPromise, cachedPromise]);
const cachedDirty = saveCache.isDirty(cached);

/**
 * Returns one of:
 *   { source: "server"|"local"|"empty",
 *     bytes:  Uint8Array | null,
 *     serverGeneration: number | null,   // generation watermark to seed the persistor
 *     serverUpdatedAt:  string | null,   // wall-clock for display + tie-break
 *     shouldUpload:  boolean,            // push these bytes to server immediately
 *     conflictLost:  boolean }           // local edits superseded by server
 */
function reconcile() {
  // Server fetch failed → offline / 5xx. Cache is the only fallback.
  if (serverResult.status === "fail") {
    if (cached) {
      return {
        source: "local",
        bytes: cached.bytes,
        serverGeneration: cached.serverGeneration ?? null,
        serverUpdatedAt: cached.serverUpdatedAt ?? null,
        shouldUpload: cachedDirty,   // try to push when we get a chance
        conflictLost: false,
      };
    }
    return {
      source: "empty", bytes: null,
      serverGeneration: null, serverUpdatedAt: null,
      shouldUpload: false, conflictLost: false,
    };
  }

  // Server has no save for this slot.
  if (serverResult.status === "404") {
    if (cached && cachedDirty) {
      // Offline-created save coming online for the first time.
      return {
        source: "local",
        bytes: cached.bytes,
        serverGeneration: null,
        serverUpdatedAt: null,
        shouldUpload: true,
        conflictLost: false,
      };
    }
    return {
      source: "empty", bytes: null,
      serverGeneration: null, serverUpdatedAt: null,
      shouldUpload: false, conflictLost: false,
    };
  }

  // Server has bytes.
  if (!cached) {
    // First launch on this device.
    return {
      source: "server",
      bytes: serverResult.bytes,
      serverGeneration: serverResult.generation,
      serverUpdatedAt: serverResult.updatedAt,
      shouldUpload: false,
      conflictLost: false,
    };
  }

  if (!cachedDirty) {
    // Local was in sync. If server changed since (another device wrote),
    // those new bytes are the truth.
    return {
      source: "server",
      bytes: serverResult.bytes,
      serverGeneration: serverResult.generation,
      serverUpdatedAt: serverResult.updatedAt,
      shouldUpload: false,
      conflictLost: false,
    };
  }

  // CONFLICT: both have edits. Resolution strategy:
  //   - If we know the generation we last synced from and the server is
  //     STILL at that generation, our cache wins (server is unchanged
  //     since we synced; we just have new local edits).
  //   - Otherwise some other device wrote between our sync and now;
  //     the server's bytes are at least as new as our cache could be,
  //     so the server wins. Local offline edits are lost.
  // Generation is a reliable, server-issued monotonic counter — no
  // wall-clock skew failure modes like the old timestamp-comparison.
  const localKnowsServerGen = Number.isFinite(cached.serverGeneration);
  const serverGenUnchanged =
    localKnowsServerGen && cached.serverGeneration === serverResult.generation;

  if (serverGenUnchanged) {
    return {
      source: "local",
      bytes: cached.bytes,
      serverGeneration: serverResult.generation,
      serverUpdatedAt: serverResult.updatedAt,
      shouldUpload: true,
      conflictLost: false,
    };
  }
  // Server has advanced — our local edits are superseded.
  return {
    source: "server",
    bytes: serverResult.bytes,
    serverGeneration: serverResult.generation,
    serverUpdatedAt: serverResult.updatedAt,
    shouldUpload: false,
    conflictLost: true,
  };
}

const decision = reconcile();

if (decision.conflictLost) {
  toast.warning(
    "Server has newer progress",
    "Your offline edits made earlier were superseded.",
    8000,
  );
}

// When reconcile picks server bytes (either because we had no cache, or
// because our cache was already in sync), persist them to IndexedDB
// with `syncedHash === hash` so the cache reflects what's locally synced.
// Without this the cache could hold older bytes indefinitely — harmless
// today (subsequent reconciles still pick server when not dirty) but a
// sharp edge if the device later goes offline before doing any save:
// we'd inject empty bytes when the cache could have had a recent server
// snapshot. Failure here is non-fatal — the persistor will still operate
// with the in-memory bytes; the cache is a best-effort safety net.
if (decision.source === "server" && decision.bytes) {
  const hash = fnv1a(decision.bytes);
  saveCache.set(me.username, game.id, activeSlot, {
    bytes: new Uint8Array(decision.bytes),
    hash,
    updatedAt: Date.now(),
    syncedHash: hash,
    serverGeneration: decision.serverGeneration,
    serverUpdatedAt: decision.serverUpdatedAt,
  }).catch(() => { /* IndexedDB quota or permissions — log already in cache layer */ });
}

/* ============ EmulatorJS setup ============ */

const mount = document.getElementById("emulator-mount");
mount.innerHTML = `<div id="game" style="width:100%;height:100%"></div>`;

const diskIndex = Math.min(Math.max(requestedDisk, 1), game.disks);
const diskName = game.disk_names[diskIndex - 1] || "rom";
const emuName = diskName.replace(/\.gz$/i, "");
const romUrl = api.url(
  `/games/${encodeURIComponent(game.id)}/rom/${encodeURIComponent(emuName)}?disk=${diskIndex}`,
);

if (!game.core) {
  toast.error("Unsupported system", `No core configured for "${game.system}"`);
  throw new Error("no core");
}

// Mutate EJS's own defaultControllers in place once the emulator instance
// exists, overriding only the keyboard side of the slots we expose. We
// can't hand EJS a partial config.defaultControllers object — its
// constructor would replace the whole map, wiping analog stick slots
// (14-23), quicksave digit slots (24-26), and the gamepad mappings
// (value2) on slots 0-11. Mutating in place preserves all of that.
function applyRetroxGameInputs(emu) {
  if (!emu || !emu.defaultControllers || !emu.defaultControllers[0]) return;
  const stored = (prefs && prefs.keyboard_bindings) || {};
  const storedPad = (prefs && prefs.gamepad_bindings) || {};
  for (const [action, slot] of Object.entries(GAME_INPUT_TO_EJS_SLOT)) {
    const code = stored[action] || KEYBOARD_DEFAULTS[action];
    const ejsKey = codeToEjsKey(code);
    if (ejsKey != null) {
      const existing = emu.defaultControllers[0][slot] || {};
      emu.defaultControllers[0][slot] = { ...existing, value: ejsKey };
      // D-pad directions also drive the left analog stick (see comment
      // on DPAD_TO_LEFT_STICK_SLOT). value2 (the analog axis label) is
      // preserved so a physical analog stick on a gamepad still works.
      const stickSlot = DPAD_TO_LEFT_STICK_SLOT[action];
      if (stickSlot != null) {
        const existingStick = emu.defaultControllers[0][stickSlot] || {};
        emu.defaultControllers[0][stickSlot] = { ...existingStick, value: ejsKey };
      }
    }
    // Apply user's gamepad binding (if any). Stored values are EJS
    // GamepadHandler labels — same shape the controller-bindings dialog
    // captures and writes to /profile/preferences. Untouched action ⇒
    // fall through to EJS's own default value2 from initControlVars.
    const padLabel = storedPad[action];
    if (typeof padLabel === "string" && padLabel) {
      const existing = emu.defaultControllers[0][slot] || {};
      emu.defaultControllers[0][slot] = { ...existing, value2: padLabel };
    }
  }
  // Seed players 2-4 with player 1's gamepad button mappings so a second
  // physical controller is plug-and-play for multi-player cores (N64,
  // PSX, NES). EJS ships these slots empty, and the in-game Controls
  // menu — the only surface that could fill them — is hidden.
  //
  // Gamepad-only mirror: copying `value` (keyboard) to all players would
  // broadcast every keypress to all 4 player slots at once because EJS's
  // keyboard handler iterates ALL players and fires simulateInput on
  // every match — that would break any multi-player game where the
  // keyboard player and a gamepad player share the same controls layout.
  // Per-player keyboard rebinds aren't a real use case (co-op runs on
  // multiple gamepads, not one shared keyboard), so player 1's keyboard
  // map stays the only one set.
  for (let player = 1; player <= 3; player++) {
    if (!emu.defaultControllers[player]) emu.defaultControllers[player] = {};
    for (const slot of Object.keys(emu.defaultControllers[0])) {
      const src = emu.defaultControllers[0][slot];
      if (!src || src.value2 == null) continue;
      emu.defaultControllers[player][slot] = { value2: src.value2 };
    }
  }
}
// Hide EJS's in-game Controls menu button. Profile → Controls is the
// canonical rebind surface; allowing two parallel UIs would let users
// create per-device drift that the cross-device prefs can't see.
window.EJS_Buttons = { ...(window.EJS_Buttons || {}), gamepad: { visible: false } };

window.EJS_player        = "#game";
window.EJS_pathtodata    = "/emulatorjs/";
// Send the resolved core name (e.g. "gambatte"), not the system folder
// key (e.g. "gbc"). EmulatorJS's getCores() map keys some systems by
// generic name only — "gb" maps to gambatte, but there's no "gbc" key,
// so passing "gbc" leads it to ask for "gbc-legacy-wasm.data" which
// doesn't exist. Passing the core name directly is found in the same
// map ("gambatte" appears in the "gb" list) and respects whatever core
// the admin chose in Admin → Emulators.
window.EJS_core          = game.core;
window.EJS_gameUrl       = romUrl;
window.EJS_gameName      = emuName;
window.EJS_biosUrl       = "";
window.EJS_startOnLoaded = true;
// We DON'T let EJS auto-fullscreen — game.js fullscreens the
// .player-host wrapper synchronously inside the click handler that
// mounted us. Two reasons:
//
//   1. EJS would request fullscreen on its own #game element, which
//      is INSIDE .player-host. The back button lives outside #game
//      (sibling, in .player-host directly), and Web platform's
//      fullscreen rule says only the fullscreen element + descendants
//      render — so the pill would vanish on entry until the
//      fullscreenchange listener moved it inside, and re-vanish on
//      exit. Fullscreening the wrapper sidesteps the relocation race
//      entirely: the back button is already a descendant.
//
//   2. EJS calls requestFullscreen during its startGame() — seconds
//      after the original user click, well after Firefox's 5-second
//      transient-activation window has expired. The request was
//      silently denied for anyone whose core/ROM took >5s to load.
//      Calling it ourselves inside the click handler in game.js
//      uses the activation while it's still fresh.
window.EJS_fullscreenOnLoaded = false;
// Pin to en-US: this is the sentinel value EmulatorJS uses to skip
// localization loading entirely (English is its built-in default).
// Otherwise it auto-detects the browser locale (e.g. en-ES) and emits
// "Translation not found" warnings for every string missing from that
// locale's JSON file.
window.EJS_language      = "en-US";
window.EJS_onGameStart   = () => onGameStart();
window.EJS_onSaveState   = (e) => onSaveState(e);
window.EJS_onLoadState   = () => onLoadState();

// Rewind must be opted into BEFORE the core boots — EJS reads this in
// its constructor and the menu label says "Requires restart". Toggling
// it later has no effect on the running session.
if (game.rewind_enabled) {
  window.EJS_defaultOptions = { ...(window.EJS_defaultOptions || {}), rewindEnabled: "enabled" };
}

/* ============ Build persistor + indicator ============ */

// Mount the indicator INSIDE .player-host. The CSS Fullscreen spec only
// renders the fullscreen element + its descendants — an indicator on
// <body> would vanish whenever the player went fullscreen. Hand the
// freshly created element to playerChrome.relocate() so it ends up in
// whatever the current pills home is (player-host today, EJS's #game
// later if the user toggles toolbar fullscreen) and inherits the
// auto-fade.
const indicatorMount = document.getElementById("player-host")
  || document.querySelector(".player-host")
  || document.body;

// Construct the persistor FIRST so we can hand it to the indicator —
// the conflict dialog needs to call back into the persistor for "Use
// my version" (force-push) and "Download my version" (read SRAM).
persistor = new SavePersistor({
  username: me.username,
  gameId: game.id,
  slot: activeSlot,
  initialBytes: decision.bytes,
  initialServerGeneration: decision.serverGeneration,
  initialServerUpdatedAt: decision.serverUpdatedAt,
  // Wake the pills on every status transition so a fresh "Synced ·
  // 12:34:56" or "Out of sync — reload" surfaces immediately rather
  // than appearing already faded if the user happens to be sitting
  // still when the persistor fires.
  onStateChange: (state) => indicator?.update(state),
});

indicator = new SaveIndicator({
  mountElement: indicatorMount,
  slot: activeSlot,
  gameName: game.name,
  persistor,
});
playerChrome?.relocate();

// Seed the indicator from the persistor's initial state (single source
// of truth). If the slot already has server-side history, this paints
// "Saved · 2h ago" right away.
indicator.update(persistor.getState());

// If reconciliation said we have unsynced bytes that need to be pushed now
// (offline-created save coming online, or local-newer-wins conflict), push
// them in the background while EJS is still loading.
if (decision.shouldUpload && decision.bytes) {
  persistor.uploadInitialBytes(decision.bytes);
}

/* ============ Race-proof attach via setter trap on window.EJS_emulator ============ */

(function installSetterTrap() {
  let _emu = null;
  Object.defineProperty(window, "EJS_emulator", {
    configurable: true,
    enumerable: true,
    get() { return _emu; },
    set(v) {
      _emu = v;
      // Apply our keyboard overrides BEFORE EJS's bindListeners runs
      // (which clones defaultControllers into controls). EJS may set
      // this multiple times during init — both calls below are idempotent.
      if (v) applyRetroxGameInputs(v);
      // Re-assert rewindEnabled from the admin's emulator config. EJS's
      // preGetSetting reads localStorage first and only falls back to
      // config.defaultOptions when the per-game settings dict is entirely
      // absent. Once the user has played the game once (settings dict
      // exists, but with no rewindEnabled key) the EJS_defaultOptions
      // we set above is silently shadowed by `undefined`, the rewind
      // buffer is never allocated, and toggle_rewind no-ops. Setting
      // this here lands before GameManager construction (inside the
      // async downloadFiles), so the generated retroarch.cfg picks up
      // the override.
      if (v) v.rewindEnabled = !!game.rewind_enabled;
      if (v && persistor) persistor.attach(v);
    },
  });
})();

const script = document.createElement("script");
script.src = "/emulatorjs/loader.js";
document.body.appendChild(script);

/* ============ Audio unlock — resume the EJS audio context on first input ============
 *
 * EmulatorJS uses emscripten's OpenAL backend, which creates a WebAudio
 * AudioContext that the browser starts in "suspended" state per the
 * autoplay policy. EJS's checkStarted() polls the state every 10ms;
 * while suspended it shows a "Click to resume Emulator" popup and waits
 * for the state to flip — but it doesn't call resume() itself. The
 * popup is purely a visual prompt; what actually unlocks the audio is
 * either the BROWSER auto-resuming on user gesture (Chrome's autoplay
 * policy after sticky activation) or our explicit ctx.resume() inside
 * a user-activation context.
 *
 * Why this is harder than it looks:
 *
 *   1. Gamepad button presses don't fire DOM events — they're only
 *      visible via the polling-based Gamepad API. In Chromium that
 *      polling DOES grant transient user activation when the rising
 *      edge is observed, but only for ~5 seconds.
 *
 *   2. EJS's audio context can take several seconds to come online
 *      (core download, emscripten init). If the user pressed a button
 *      BEFORE the context exists, that grant of transient activation
 *      may have expired by the time we have a context to call
 *      resume() on.
 *
 *   3. However: once the user has interacted with the page at all,
 *      the document acquires STICKY user activation. AudioContext
 *      .resume() works thereafter without needing a fresh transient
 *      grant — we just need to call it once, when the context exists.
 *
 * The strategy:
 *
 *   - Any user input (a gamepad button's rising edge, or a real DOM
 *     event — key, pointer, touch) attempts an immediate unlock and
 *     arms a low-frequency retry poll.
 *
 *   - The poll keeps trying attemptAudioUnlock until either the audio
 *     context shows "running" (success — finalize and clean up) or a
 *     timeout elapses. This handles the wait-for-EJS case naturally.
 *
 *   - We never blindly mark "unlocked" — a previous version did this
 *     as a side effect of attempting resume(), and a silent rejection
 *     left the popup permanently up. We always re-read ctx.state
 *     after the await before deciding.
 */

let audioUnlocked = false;
let unlockPollHandle = null;
// playHint is hoisted to the module-state block at the top of this file
// alongside indicator/persistor — see the comment there for why.
let hintObserver = null;

function ensurePlayHint() {
  if (playHint) return;
  playHint = document.createElement("div");
  playHint.className = "player__hint";
  playHint.setAttribute("role", "status");
  playHint.innerHTML = `
    <span class="player__hint__pulse" aria-hidden="true"></span>
    <span>Press any button to start</span>
  `;
  // Park it on the body for the moment; playerChrome.relocate() will
  // pull it into the right pills home (the current fullscreen target,
  // or player-host if windowed) — same path as the indicator, no
  // separate fullscreen-aware mounting code needed here.
  document.body.appendChild(playHint);
  playerChrome?.relocate();
}

function teardownAudioUnlock() {
  document.removeEventListener("keydown",     onUserInputForUnlock);
  document.removeEventListener("pointerdown", onUserInputForUnlock);
  document.removeEventListener("touchstart",  onUserInputForUnlock);
  if (unlockPollHandle !== null) { clearTimeout(unlockPollHandle); unlockPollHandle = null; }
  if (hintObserver) { hintObserver.disconnect(); hintObserver = null; }
  if (playHint)     { playHint.remove();         playHint = null; }
}

function ejsAudioContext() {
  return window.EJS_emulator?.Module?.AL?.currentCtx?.audioCtx || null;
}

async function attemptAudioUnlock() {
  if (audioUnlocked) return true;

  const ctx = ejsAudioContext();
  if (!ctx) {
    // EJS hasn't created the AL context yet. Caller decides retry
    // policy (event listeners do not retry; the unlock poll does).
    return false;
  }

  if (ctx.state === "running") {
    finalizeAudioUnlock();
    return true;
  }

  if (ctx.state === "suspended" && typeof ctx.resume === "function") {
    try {
      await ctx.resume();
    } catch { /* fall through — state recheck below decides retry */ }
  }

  if (ctx.state === "running") {
    finalizeAudioUnlock();
    return true;
  }

  return false;
}

function finalizeAudioUnlock() {
  audioUnlocked = true;
  // Hand keyboard focus to the EJS player so subsequent key presses
  // reach the emulator. Real clicks already do this via EJS's own
  // mousedown handler in bindListeners; keydown/gamepad don't.
  try {
    const parent = window.EJS_emulator?.elements?.parent;
    if (parent && typeof parent.focus === "function") {
      parent.focus({ preventScroll: true });
    }
  } catch { /* parent not yet present */ }
  teardownAudioUnlock();
}

/**
 * The single entry point for "user did something." Called from real
 * DOM events on the document AND from the gamepad poll on the rising
 * edge of any button press (see noteGamepadInteraction below).
 *
 * Attempts an immediate unlock (in case ctx is already available
 * with fresh transient activation) and arms the retry poll for the
 * slow-load case.
 */
function onUserInputForUnlock() {
  if (audioUnlocked) return;
  attemptAudioUnlock();
  ensureUnlockPolling();
}

/**
 * Arms (idempotently) a low-frequency poll that retries unlock for
 * up to UNLOCK_POLL_DEADLINE_MS after the user's first interaction.
 * Necessary because EJS's audio context may not exist at the moment
 * the user pressed — we have to wait for it, and once we have it,
 * the document's sticky activation lets resume() succeed even if
 * the original press's transient activation has long since expired.
 */
const UNLOCK_POLL_INTERVAL_MS = 200;
const UNLOCK_POLL_DEADLINE_MS = 30_000;
function ensureUnlockPolling() {
  if (unlockPollHandle !== null || audioUnlocked) return;
  const start = performance.now();
  const tick = async () => {
    unlockPollHandle = null;
    if (audioUnlocked) return;
    if (performance.now() - start > UNLOCK_POLL_DEADLINE_MS) return;
    // Try unconditionally. Each call is cheap; calls made without
    // current activation just no-op, and the next tick
    // will pick up activation as soon as it's granted (a held button,
    // a fresh gamepad press, a mouse move, anything).
    await attemptAudioUnlock();
    if (audioUnlocked) return;
    unlockPollHandle = setTimeout(tick, UNLOCK_POLL_INTERVAL_MS);
  };
  unlockPollHandle = setTimeout(tick, UNLOCK_POLL_INTERVAL_MS);
}

document.addEventListener("keydown",     onUserInputForUnlock);
document.addEventListener("pointerdown", onUserInputForUnlock);
document.addEventListener("touchstart",  onUserInputForUnlock, { passive: true });

// Watch for the EJS popup so we only show the hint when input is
// actually required. If audio is already unlocked (popup never appears),
// the hint never shows and the observer self-cleans after a few seconds.
hintObserver = new MutationObserver(() => {
  if (audioUnlocked) return;
  const btn = document.querySelector(".ejs_popup_container button.ejs_menu_button");
  if (btn && btn.offsetParent !== null) ensurePlayHint();
});
hintObserver.observe(document.body, { childList: true, subtree: true });
// Stop observing eventually even if the popup never appears — keeps
// the page free of long-running observers.
setTimeout(() => {
  if (audioUnlocked) return;
  if (hintObserver) { hintObserver.disconnect(); hintObserver = null; }
}, 30_000);

/* ============ Gamepad combos (Select + button) ============ */

(function () {
  let prev = {};
  function pressed(gp, idx) {
    const v = gp.buttons[idx];
    const cur = !!(v && (typeof v === "object" ? v.pressed : v > 0.5));
    const was = prev[idx] || false;
    prev[idx] = cur;
    return cur && !was;
  }
  function held(gp, idx) {
    const v = gp.buttons[idx];
    return !!(v && (typeof v === "object" ? v.pressed : v > 0.5));
  }
  // libretro standard button indices for D-pad. We send these via
  // gameManager.simulateInput() to mirror left-stick movement onto the
  // D-pad — most 2D games (GB/GBC/GBA/NES/etc.) read only D-pad input,
  // so without this the analog stick would do nothing in those games.
  // Existing analog-stick mapping inside the core (axes 16-19 in
  // libretro) still works for 3D games that read the analog stick
  // natively (N64, PSX). Worst case for a game that reads BOTH:
  // movement may register twice, but no input is dropped.
  const RETRO_UP = 4, RETRO_DOWN = 5, RETRO_LEFT = 6, RETRO_RIGHT = 7;
  const stickPressed = { up: false, down: false, left: false, right: false };

  function setStickButton(name, btnIdx, isDown) {
    if (stickPressed[name] === isDown) return;
    stickPressed[name] = isDown;
    try {
      const gm = window.EJS_emulator?.gameManager;
      if (gm && typeof gm.simulateInput === "function") {
        gm.simulateInput(0, btnIdx, isDown ? 1 : 0);
      }
    } catch {}
  }

  /* Direction state is built from two independent sources, OR-merged:
   *
   *   - Left analog stick (axes 0/1). Continuous, spring-loaded,
   *     present on every controller.
   *   - Hat axis (axes 2+). Discrete D-pad encoding used by Sony
   *     non-standard mappings (Firefox + DualShock/DualSense). Without
   *     this branch the D-pad is dead in-game on those pads because
   *     EJS's defaults for D-pad slots target buttons 12-15 which
   *     don't exist there.
   *
   * The two states live in separate buckets and are OR-merged through
   * setStickButton, which carries the edge-detection guard. Each
   * source can independently drive RETRO_UP/DOWN/LEFT/RIGHT.
   *
   * --- Analog-stick double-tap detection ---
   *
   * A fast "up up" on the analog stick traces a trajectory like
   * −1 → −0.6 → −1 because the spring can't return to neutral before
   * the user pushes again. A simple |value| > 0.5 threshold leaves
   * the direction held continuously through the dip, so the second
   * press never fires (no rising edge). Polling faster doesn't help
   * — the stick literally never crosses below 0.5.
   *
   * The fix tracks peak magnitude per direction during a held press
   * and fires release when:
   *   (a) magnitude drops below an absolute floor (0.3) — the user
   *       fully released, OR
   *   (b) magnitude drops to less than RETRACT_RATIO (0.7) of the
   *       peak — a meaningful retraction even if the stick didn't
   *       reach neutral (the −1 → −0.6 → −1 case).
   *
   * Hat axes don't have spring physics — they snap through a sentinel
   * on release — so the retraction logic only applies to analog input.
   * Hat state is plain on/off via hatDpad's existing edge handling. */
  const ANALOG_PRESS_THRESHOLD   = 0.5;
  const ANALOG_RELEASE_FLOOR     = 0.3;
  const ANALOG_RETRACT_RATIO     = 0.7;

  const stickAnalog = { up: false, down: false, left: false, right: false };
  const stickHat    = { up: false, down: false, left: false, right: false };
  const stickPeak   = { up: 0,     down: 0,     left: 0,     right: 0 };

  /** Update analog-stick state for one direction given that
   *  direction's positive-only magnitude (0..1). */
  function updateAnalog(name, mag) {
    if (!stickAnalog[name]) {
      if (mag > ANALOG_PRESS_THRESHOLD) {
        stickAnalog[name] = true;
        stickPeak[name]   = mag;
      }
      return;
    }
    if (mag > stickPeak[name]) stickPeak[name] = mag;
    if (mag < ANALOG_RELEASE_FLOOR || mag < stickPeak[name] * ANALOG_RETRACT_RATIO) {
      stickAnalog[name] = false;
      stickPeak[name]   = 0;
    }
  }

  function applyDir(name, btnIdx) {
    setStickButton(name, btnIdx, stickAnalog[name] || stickHat[name]);
  }

  function pollDirections(gp) {
    const x = gp.axes[0] || 0;
    const y = gp.axes[1] || 0;
    // Per-direction signed → unsigned magnitude.
    updateAnalog("up",    y < 0 ? -y : 0);
    updateAnalog("down",  y > 0 ?  y : 0);
    updateAnalog("left",  x < 0 ? -x : 0);
    updateAnalog("right", x > 0 ?  x : 0);

    const hat = hatDpad(gp);
    stickHat.up    = !!(hat && hat.up);
    stickHat.down  = !!(hat && hat.down);
    stickHat.left  = !!(hat && hat.left);
    stickHat.right = !!(hat && hat.right);

    applyDir("up",    RETRO_UP);
    applyDir("down",  RETRO_DOWN);
    applyDir("left",  RETRO_LEFT);
    applyDir("right", RETRO_RIGHT);
  }

  // Hold L2/R2 for trick-play. Wiring depends on the per-emulator
  // flags carried in `game`:
  //   fast_forward_enabled=false → both triggers are inert (system uses
  //     them as native game inputs, e.g. PSX).
  //   rewind_enabled=true        → R2 fast-forwards, L2 rewinds.
  //   rewind_enabled=false       → L2 and R2 both fast-forward.
  // Each is edge-detected so we only call toggle on changes. Rewind
  // calls toggleRewind directly rather than simulateInput(0,28,v) —
  // simulateInput only fires on value===1, but hold-to-rewind needs
  // both the rising and falling edge.
  const triggersBound = game.fast_forward_enabled !== false;
  const rewindBound   = triggersBound && !!game.rewind_enabled;
  let fastForwardOn = false;
  let rewindOn = false;
  function setFastForward(on) {
    if (on === fastForwardOn) return;
    fastForwardOn = on;
    try { window.EJS_emulator?.gameManager?.toggleFastForward?.(on ? 1 : 0); } catch {}
  }
  function setRewind(on) {
    if (on === rewindOn) return;
    rewindOn = on;
    try { window.EJS_emulator?.gameManager?.functions?.toggleRewind?.(on ? 1 : 0); } catch {}
  }
  /* Edge-detect L2 / R2. Calling setFastForward/setRewind every frame
   * with the trigger's CURRENT state would clobber any keyboard fast
   * forward / rewind the user just initiated: keydown sets it true,
   * the next rAF tick reads "trigger not held" and immediately calls
   * setFastForward(false). With a controller plugged in this happens
   * every frame, which is why Space and Backspace appeared to "stop
   * working" the moment the controller was detected. Only firing on
   * transitions makes the keyboard and gamepad paths coexist cleanly:
   * each owns the state until the OTHER actively changes it. */
  let prevLTrig = false;
  let prevRTrig = false;
  function pollTriggers(gp) {
    if (!triggersBound) return;
    const lt = gp.buttons[6];
    const rt = gp.buttons[7];
    const lDown = !!(lt && (typeof lt === "object" ? lt.pressed : lt > 0.5));
    const rDown = !!(rt && (typeof rt === "object" ? rt.pressed : rt > 0.5));
    if (rewindBound) {
      if (lDown !== prevLTrig) setRewind(lDown);
      if (rDown !== prevRTrig) setFastForward(rDown);
    } else {
      // Both triggers fold into fast forward when rewind isn't enabled.
      // Track the OR-state edge so a release of one trigger while the
      // other is still held doesn't spuriously turn fast forward off.
      const combined     = lDown || rDown;
      const prevCombined = prevLTrig || prevRTrig;
      if (combined !== prevCombined) setFastForward(combined);
    }
    prevLTrig = lDown;
    prevRTrig = rDown;
  }

  // Keyboard parity with the gamepad meta shortcuts. EmulatorJS leaves
  // fast forward / rewind unbound by default and routes 1/2 to its own
  // (un-synced) quicksave file, so we wire the user-facing actions
  // ourselves and the slot system stays the source of truth.
  //
  // Bindings are KeyboardEvent.code values (layout-independent) coming
  // from the user's preferences. Defaults are imported from
  // bindings-defaults.js so this code path agrees with the rebind UI
  // about what "default" means.
  const userBindings = (prefs && prefs.keyboard_bindings) || {};
  const KB = {
    fast_forward: userBindings.fast_forward || KEYBOARD_DEFAULTS.fast_forward,
    rewind:       userBindings.rewind       || KEYBOARD_DEFAULTS.rewind,
    save_state:   userBindings.save_state   || KEYBOARD_DEFAULTS.save_state,
    load_state:   userBindings.load_state   || KEYBOARD_DEFAULTS.load_state,
    exit_game:    userBindings.exit_game    || KEYBOARD_DEFAULTS.exit_game,
  };
  function isPlayerModalOpen() {
    return !!document.querySelector(".modal-backdrop, .palette-backdrop");
  }
  /* Capture-phase listeners — keep player shortcuts working regardless of
   * what currently has focus. Without `useCapture=true` here, if focus
   * has drifted onto a `<button>` (e.g. the Controls pill, or a focused
   * element left over from controller-mode navigation), the browser's
   * default Space-activates-button behaviour fires before this bubble
   * listener and the rebind dialog re-opens. Capture phase puts us
   * ahead of every focused-element default, and preventDefault on the
   * matching keys suppresses both the button-click default AND any
   * other native key behaviour (browser back on Backspace, etc.).
   *
   * EJS's own keyChange listener is on `elements.parent` and runs in
   * the bubble phase regardless — game-input keys (KeyX, KeyZ, etc.)
   * still reach it because we only call preventDefault on the keys we
   * actually consume here, never stopPropagation.
   *
   * `triggersBound` (gating for gamepad L2/R2) is intentionally NOT
   * applied to the keyboard branch. The flag exists because L2/R2 are
   * real game inputs on PSX/N64 — hijacking those buttons for fast
   * forward would clobber gameplay. Space and Backspace have no such
   * conflict (they're not bound as game inputs on any system), so the
   * keyboard shortcuts stay functional even when the per-emulator
   * `fast_forward_enabled` flag is off. `rewindBound` still gates the
   * rewind direction — when the core doesn't have rewind compiled in,
   * Backspace falls back to fast forward to match the L2 fallback. */
  document.addEventListener("keydown", (e) => {
    if (isPlayerModalOpen()) return;
    if (e.code === KB.fast_forward) {
      e.preventDefault();
      setFastForward(true);
      return;
    }
    if (e.code === KB.rewind) {
      e.preventDefault();
      if (rewindBound) setRewind(true); else setFastForward(true);
      return;
    }
    if (e.repeat) return;  // one-shots only fire on initial press
    if (e.code === KB.save_state) {
      e.preventDefault();
      try { window.EJS_emulator?.elements?.bottomBar?.saveState?.[0]?.click(); } catch {}
      return;
    }
    if (e.code === KB.load_state) {
      e.preventDefault();
      try { window.EJS_emulator?.elements?.bottomBar?.loadState?.[0]?.click(); } catch {}
      return;
    }
    // exit_game: only fire here if the user has rebound it to something
    // other than Escape — Escape→goBack is wired unconditionally near
    // the back button as a universal escape hatch (works even if the
    // user binds something exotic to exit_game).
    if (KB.exit_game !== "Escape" && e.code === KB.exit_game) {
      e.preventDefault();
      goBack();
      return;
    }
  }, true);
  document.addEventListener("keyup", (e) => {
    if (e.code === KB.fast_forward) {
      e.preventDefault();
      setFastForward(false);
      return;
    }
    if (e.code === KB.rewind) {
      e.preventDefault();
      if (rewindBound) setRewind(false); else setFastForward(false);
      return;
    }
  }, true);

  // Edge-triggered "any button" detector for the audio-unlock path.
  // We only want to fire onUserInputForUnlock on the rising edge of
  // a press, not every frame the button is held — Chromium grants
  // user activation at the moment the polling reads the rising
  // edge, and re-firing each held frame just burns CPU.
  let prevAnyButtonDown = false;
  function gamepadHasAnyButtonDown(gp) {
    return gp.buttons.some(b => b && (typeof b === "object" ? b.pressed : b > 0.5));
  }

  function poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    // When a modal is open atop the player (sync dialog, conflict
    // resolver, command palette, etc.), gamepad-nav.js takes over —
    // we'd otherwise both fight for the same buttons AND the in-game
    // D-pad would react to inputs the user is using to navigate the
    // modal. Stop driving the emulator and reset our edge state.
    const modalOpen = !!document.querySelector(".modal-backdrop, .palette-backdrop");
    for (const gp of pads) {
      if (!gp) continue;
      // Audio unlock — only on the rising edge of any button. The
      // unlock poll handles the case where AL isn't ready yet.
      if (!audioUnlocked) {
        const downNow = gamepadHasAnyButtonDown(gp);
        if (downNow && !prevAnyButtonDown) onUserInputForUnlock();
        prevAnyButtonDown = downNow;
      }
      if (modalOpen) {
        // Release any held in-game inputs and clear edge state so we
        // don't fire a delayed rising edge when the modal closes.
        for (const name of ["left","right","up","down"]) {
          if (stickPressed[name]) {
            const idx = name==="up"?RETRO_UP:name==="down"?RETRO_DOWN:name==="left"?RETRO_LEFT:RETRO_RIGHT;
            setStickButton(name, idx, false);
          }
        }
        setFastForward(false);
        setRewind(false);
        prev = {};
        continue;
      }
      // Mirror left analog stick onto the D-pad while the game is running.
      pollDirections(gp);
      // L2 / R2 hold → fast-forward / rewind, gated by per-emulator flags.
      pollTriggers(gp);
      if (!held(gp, 8)) { prev = {}; continue; }
      // Select-modifier combos. With Select held, the Y-axis buttons
      // become CHROME shortcuts (sync pill / back) and the shoulder
      // buttons become save-state shortcuts. Without Select, these
      // buttons all reach the emulator normally.
      if (pressed(gp, 9)) { goBack(); return; }                              // Select + Start
      if (pressed(gp, 3)) {                                                  // Select + Y
        // Open the sync-status dialog. After this fires the modal is
        // up; gamepad-nav handles A/B/D-pad from there (see the
        // exception above poll-skip in gamepad-nav.js).
        document.querySelector(".player__status")?.click();
      }
      if (pressed(gp, 4)) {
        const emu = window.EJS_emulator;
        if (emu?.elements?.bottomBar?.saveState) emu.elements.bottomBar.saveState[0].click();
      }
      if (pressed(gp, 5)) {
        const emu = window.EJS_emulator;
        if (emu?.elements?.bottomBar?.loadState) emu.elements.bottomBar.loadState[0].click();
      }
    }
    requestAnimationFrame(poll);
  }
  // Always start polling — don't gate on `gamepadconnected` or
  // `getGamepads()` having data at script load. The browser hides
  // already-connected controllers from a freshly-loaded page until it
  // sees post-load input on the page (security policy), so the
  // gamepadconnected event often does NOT fire when navigating from
  // /games to /play with a controller already plugged in. Polling
  // unconditionally is cheap (one rAF that no-ops when the array is
  // empty) and guarantees we react the instant the user presses any
  // button.
  requestAnimationFrame(poll);
})();

/* ============ Game start callback ============ */

async function onGameStart() {
  startPlaytimeTracker(game.id);
  // Re-assert our defaultControls AFTER EJS's loadSettings() has run.
  // loadSettings restores controls from per-device localStorage (left over
  // from EJS's now-hidden in-game Controls menu, or from a prior version
  // of this app), which would otherwise shadow the user's RetroX prefs
  // — silently rebinding game inputs on a per-device basis. Re-cloning
  // the defaults and re-running setupKeys keeps Profile → Controls as
  // the single source of truth across devices. saveSettings persists the
  // override so subsequent loads agree on the same values.
  try {
    const ejs = window.EJS_emulator;
    if (ejs && ejs.defaultControllers) {
      ejs.controls = JSON.parse(JSON.stringify(ejs.defaultControllers));
      ejs.setupKeys?.();
      ejs.checkGamepadInputs?.();
      ejs.saveSettings?.();
    }
    // Recover from EJS's gamepad-connection race.
    //
    // EJS's GamepadHandler polls navigator.getGamepads() every 10ms and
    // dispatches a single "connected" event the first frame a pad shows
    // up. EJS's listener fills gamepadSelection (the array gamepadEvent
    // uses to map button presses to a player slot) ONLY if it finds an
    // empty-string entry — and gamepadSelection is populated with empty
    // strings later, while the Controls popup is built.
    //
    // In a fresh /play hard-load this is fine: browsers gate gamepad
    // visibility until the user presses something ON that document, by
    // which point EJS is fully initialized. But when /play is mounted
    // in-place from /game (after the user navigated there with the
    // gamepad), the pad is already visible the moment EJS starts
    // polling. The connected event fires before gamepadSelection has
    // any slots; the handler no-ops; the pad is never associated with
    // a player; gamepadEvent's `gamepadSelection.indexOf(id_index)`
    // returns -1 and every subsequent buttondown returns early —
    // emulator-bound buttons (A/B/X/Y/Start/Select) silently fail to
    // reach the core. RetroX's own play.js poll still drives L2/R2 →
    // fast-forward / rewind directly, which is why those work.
    //
    // Recover here: now that EJS is fully attached, walk the live
    // GamepadHandler.gamepads and fill any empty selection slots with
    // their `id_index` strings, then nudge the labels UI. Idempotent —
    // if the handler already populated successfully we skip.
    if (ejs?.gamepadSelection && Array.isArray(ejs.gamepadSelection)
        && ejs.gamepad?.gamepads?.length) {
      for (const gp of ejs.gamepad.gamepads) {
        if (!gp) continue;
        const tag = `${gp.id}_${gp.index}`;
        if (ejs.gamepadSelection.includes(tag)) continue;
        const empty = ejs.gamepadSelection.indexOf("");
        if (empty >= 0) ejs.gamepadSelection[empty] = tag;
      }
      try { ejs.updateGamepadLabels?.(); } catch { /* labels UI may not be mounted */ }
    }
  } catch (err) {
    console.warn("Could not reapply RetroX game-input bindings", err);
  }
  // Fire-and-forget drain of any state queued during a previous offline
  // session. The persistor is attached by this point, so a successful
  // drain will correctly advance its X-Slot-Generation watermark.
  _drainPendingState();
  // Wire the virtual-gamepad alignment before any branch that might
  // early-return (e.g. successful audio unlock below). Otherwise the
  // landscape-mobile layout is left in its CSS-fallback state on the
  // happy path where audio unlocks immediately. Rewire the speed
  // buttons first so the alignment math measures the final (post-
  // rewire) layout.
  customizeSpeedButtons();
  installVirtualGamepadAlignment();
  // The audio context is now live. Try unlocking once immediately —
  // if the user already interacted while EJS was loading (sticky
  // activation acquired), this succeeds with no popup, no hint.
  if (await attemptAudioUnlock()) return;
  // Otherwise: arm the retry poll unconditionally. Gamepad-only users
  // never grant sticky activation (only transient), so by the time
  // we get here the original click's activation may have expired —
  // gating on a "have we seen input?" flag would skip the retry path
  // for them and leave the game silently stalled. The poll is cheap
  // (200ms interval, 30s deadline) and self-cancels once unlock
  // succeeds; it will pick up any subsequent input that refreshes
  // activation.
  ensurePlayHint();
  ensureUnlockPolling();
  // Everything else (late-inject if needed, baseline capture, polling)
  // is handled by SavePersistor's own "start" event listener installed
  // during attach().
}

/* ============ Virtual-gamepad speed-button rewire ============
 *
 * EmulatorJS renders three speed-control buttons in the virtual
 * gamepad's center slot — Fast (input 27), Slow Motion (input 29),
 * and Rewind (input 28, only when rewindEnabled).
 *
 * Slow Motion is rarely useful on touch devices; we replace it with
 * a Rewind button (rewiring its touch handler to send input 28 and
 * relabeling it "Rewind") and hide the original Rewind so the speed
 * row settles at a clean two-button "[Rewind] [Fast]" layout. We
 * also swap the inline left positions so Rewind ends up on the left
 * (where the original Fast button was) and Fast on the right (where
 * the original Slow button was) — the conventional media-player
 * order. Idempotent, runs once after the gamepad has rendered. */
function customizeSpeedButtons() {
  const ejs = window.EJS_emulator;
  const parent = ejs?.elements?.parent;
  const gm = ejs?.gameManager;
  if (!parent || !gm) return;

  const slow = parent.querySelector(".ejs_virtualGamepad_button.b_speed_slow");
  const fast = parent.querySelector(".ejs_virtualGamepad_button.b_speed_fast");
  if (!slow || !fast || slow.dataset.rxRewired) return;

  // cloneNode wipes every addEventListener handler EJS attached, so we
  // can re-bind the button to a different libretro input value.
  const rewind = slow.cloneNode(true);
  rewind.innerText = "Rewind";
  rewind.dataset.rxRewired = "1";

  const REWIND = 28;
  const release = () => {
    rewind.classList.remove("ejs_virtualGamepad_button_down");
    setTimeout(() => gm.simulateInput(0, REWIND, 0));
  };
  rewind.addEventListener("touchstart", (e) => {
    e.preventDefault();
    rewind.classList.add("ejs_virtualGamepad_button_down");
    gm.simulateInput(0, REWIND, 1);
  });
  rewind.addEventListener("touchend",    (e) => { e.preventDefault(); release(); });
  rewind.addEventListener("touchcancel", (e) => { e.preventDefault(); release(); });

  slow.parentNode.replaceChild(rewind, slow);

  // Swap the inline left positions so the row reads [Rewind] [Fast].
  // Landscape mode ignores these via @media in player.css and lays the
  // pair out under Select/Start instead.
  rewind.style.left = "-35px";
  fast.style.left   = "95px";
}

/* ============ Virtual gamepad alignment (phone landscape) ============
 *
 * The CSS in player.css positions each gamepad cluster from a set of
 * custom properties. We compute those properties here from the actual
 * rendered geometry so the layout works for every control scheme:
 *
 *   - Canvas margins depend on the core's aspect ratio (NES 4:3, Genesis
 *     16:9, GB 10:9...) so the side gutters can't be a static value.
 *
 *   - Inside .ejs_virtualGamepad_right, the visible button extent isn't
 *     centered for every scheme. GB places A at left:81 / top:40 and B
 *     at left:10 / top:70 — content is biased right and down within the
 *     130×130 container. SNES uses a symmetric diamond. Centering the
 *     CONTAINER would be wrong for GB; we want the visible CONTENT
 *     centered.
 *
 * Strategy: for each cluster, measure the bounding box of all visible
 * children (in pre-transform offset coords, idempotent across re-runs),
 * then emit:
 *
 *   --vpad-left-x / -y      d-pad container position
 *   --vpad-right-x / -y     A/B cluster container position
 *   --vpad-bottom-x / -y    Select/Start row position
 *   --vpad-right-shift      translateX so right-cluster content centers
 *                           in the canvas's right margin
 *
 * Vertical centering treats the right cluster + Select/Start row as a
 * single stack. The stack's combined visible content height is centered
 * around the viewport's vertical midline. */
function installVirtualGamepadAlignment() {
  const ejs = window.EJS_emulator;
  const parent = ejs?.elements?.parent;
  const canvas = ejs?.canvas;
  if (!parent || !canvas) return;

  // Reference gap between the A/B cluster's bottom-most button and the
  // Select/Start row, used in the centering math to derive A/B's
  // vertical position. Independent of scheme.
  const STACK_GAP = 20;
  // Extra px the Select/Start + Rewind/Fast block is dropped past its
  // centered position, to give A/B more breathing room above. A/B's
  // own vertical position is unaffected — it stays where the centered-
  // stack math (with STACK_GAP only) places it; only the bottom block
  // moves further down. The result is intentionally not symmetrically
  // centered in the viewport, since pushing the meta buttons closer to
  // the device's bottom edge is more thumb-friendly than aesthetic
  // symmetry.
  const BOTTOM_EXTRA_DROP = 16;
  // Target distance, in px, from the viewport edge to the closest visible
  // button. For landscape phone play the controls hug the device edges
  // (where the thumbs naturally rest) — centering them in the canvas
  // gutters wastes the ergonomic real estate even on cores with wide
  // pillarbox bars. 30 px clears the bezel curve / safe-area on rounded-
  // edge phones and lands the buttons squarely under the resting thumb
  // pad. This sits at the top of the ergonomically useful range — much
  // beyond ~35 px and the user starts stretching toward the buttons,
  // which defeats the purpose.
  const EDGE_INSET = 30;
  // Hard floor: never let a cluster's right offset go below this, in
  // case a quirky scheme would otherwise push the container past the
  // viewport edge by a fraction of a pixel.
  const MIN_GUTTER = 4;

  const measureContent = (el) => {
    if (!el) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    // .ejs_dpad_main is the d-pad zone (fills the container at 100%/100%);
    // .ejs_virtualGamepad_button covers face buttons + shoulder buttons.
    const items = el.querySelectorAll(".ejs_virtualGamepad_button, .ejs_dpad_main");
    for (const it of items) {
      if (!it.offsetWidth || !it.offsetHeight) continue;          // display:none
      if (getComputedStyle(it).visibility === "hidden") continue;
      minX = Math.min(minX, it.offsetLeft);
      maxX = Math.max(maxX, it.offsetLeft + it.offsetWidth);
      minY = Math.min(minY, it.offsetTop);
      maxY = Math.max(maxY, it.offsetTop + it.offsetHeight);
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, maxX, minY, maxY,
             width:  maxX - minX,
             height: maxY - minY,
             cx: (minX + maxX) / 2,
             cy: (minY + maxY) / 2 };
  };

  const apply = () => {
    const pad    = parent.querySelector(".ejs_virtualGamepad_parent");
    const left   = pad?.querySelector(".ejs_virtualGamepad_left");
    const right  = pad?.querySelector(".ejs_virtualGamepad_right");
    const bottom = pad?.querySelector(".ejs_virtualGamepad_bottom");
    if (!pad || !left || !right || !bottom) return;

    const leftBox   = measureContent(left);
    const rightBox  = measureContent(right);
    const bottomBox = measureContent(bottom);
    if (!leftBox || !rightBox || !bottomBox) return;

    const parentRect = parent.getBoundingClientRect();
    const parentH    = parentRect.height;

    /* ----- Horizontal: anchor each cluster's CONTENT to the device edge -----
     *
     * For thumb-comfort in landscape, the visible buttons sit ~EDGE_INSET
     * px from the viewport edge, regardless of canvas pillarbox width.
     *
     * Left cluster — solve for the container's `left` such that the
     * cluster's leftmost visible content lands at EDGE_INSET:
     *     container.left + leftBox.minX  =  EDGE_INSET
     *
     * Right cluster — the cluster receives a translateX of
     * (offsetWidth/2 − rightBox.cx) to center its content within the
     * container box (so A/B and Select/Start share a vertical column).
     * Solve for `right` such that the rightmost visible content lands
     * at EDGE_INSET from the parent's right:
     *     (parentW − right) − (offsetWidth − rightBox.maxX) + shift
     *                                  =  parentW − EDGE_INSET
     *     right = EDGE_INSET + rightBox.maxX − offsetWidth + shift
     *
     * Bottom row reuses `right` from the right cluster so Select/Start
     * sits in the same column. After the player.css override, its
     * content is symmetric (cx = offsetWidth/2), so it doesn't need a
     * shift of its own. */
    const rightShift = right.offsetWidth / 2 - rightBox.cx;
    const leftCx  = Math.max(MIN_GUTTER,
                             Math.round(EDGE_INSET - leftBox.minX));
    const rightCx = Math.max(MIN_GUTTER,
                             Math.round(EDGE_INSET + rightBox.maxX
                                        - right.offsetWidth + rightShift));
    const bottomCx = rightCx;

    /* ----- Vertical: position A/B by stack-centering, drop the rest ----------
     *
     * `stackTop` is the top edge a perfectly-centered (A/B + STACK_GAP +
     * bottom block) stack would occupy. We use it to place A/B —
     * keeping the face buttons at the spot the prior centered layout
     * put them. The bottom block (Select/Start + Rewind/Fast) is then
     * dropped BOTTOM_EXTRA_DROP px past its centered slot so the gap to
     * A/B widens without A/B itself shifting. This breaks visual
     * symmetry in exchange for thumb-friendly separation between the
     * face buttons and the meta row beneath them. */
    const stackH = rightBox.height + STACK_GAP + bottomBox.height;
    const stackTop = (parentH - stackH) / 2;
    const rightCy  = Math.round(stackTop - rightBox.minY);
    const bottomCy = Math.round(stackTop + rightBox.height + STACK_GAP
                                + BOTTOM_EXTRA_DROP - bottomBox.minY);
    // The d-pad's content is centered on its own — just match its content
    // center to the viewport's vertical midline.
    const leftCy = Math.round(parentH / 2 - leftBox.cy);

    pad.style.setProperty("--vpad-left-x",     leftCx + "px");
    pad.style.setProperty("--vpad-left-y",     leftCy + "px");
    pad.style.setProperty("--vpad-right-x",    rightCx + "px");
    pad.style.setProperty("--vpad-right-y",    rightCy + "px");
    pad.style.setProperty("--vpad-right-shift", rightShift.toFixed(2) + "px");
    pad.style.setProperty("--vpad-bottom-x",   bottomCx + "px");
    pad.style.setProperty("--vpad-bottom-y",   bottomCy + "px");
  };

  apply();
  // Canvas dimensions change on resize, orientation flip, and EJS's
  // own fullscreen toggles. ResizeObserver catches all three with a
  // single listener.
  try {
    const ro = new ResizeObserver(apply);
    ro.observe(canvas);
    ro.observe(parent);
  } catch { /* very old browsers — fall back to window resize */
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
  }
}

/* ============ Exit handlers ============ */

// Hidden-but-alive: regular upload path (no keepalive cap → handles
// 128KB+ saves cleanly on tab background or close-precursor).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistor?.flush();
});

// True unload: keepalive PUT as last-ditch fallback.
document.addEventListener("pagehide", () => persistor?.flushSync());

/* ============ Manual save/load state (toolbar buttons) ============ */

/* ---------------- State sync helpers ----------------
 *
 * Save State (.state) has a much narrower lifecycle than SRAM (.save):
 *   - User-initiated only — no continuous autosave.
 *   - One snapshot per (user, game, slot); new saves replace the previous.
 *   - No 409/conflict logic — manual saves always win on the server.
 *
 * The offline guarantee is: bytes the user clicked "Save state" for
 * MUST survive an offline browser session. We achieve that by writing
 * the state to stateCache BEFORE attempting the upload, identical
 * cache-first ordering to the SRAM persistor. On reconnect, the
 * `online` listener below drains any pending state for the active slot.
 */

async function _putState(stateBytes, ramBytes) {
  const fd = new FormData();
  fd.append("state", new Blob([stateBytes]), "state.bin");
  if (ramBytes) fd.append("save", new Blob([ramBytes]), "save.bin");
  // Manual save is user-initiated; always wins, no X-Slot-Generation sent.
  return api.upload(
    `/games/${encodeURIComponent(game.id)}/saves/${activeSlot}`,
    fd,
    { method: "PUT" },
  );
}

async function onSaveState(stateEvent) {
  // Capture the bytes SYNCHRONOUSLY at callback entry — before any
  // await — so they survive whatever the modal.confirm dialog does
  // to JS scheduling. EJS hands us a reference to a Uint8Array it
  // produced internally; the constructor copy below makes us the
  // sole owner. Without this, we observed the typed array reading
  // as length-0 by the time control returned from modal.confirm.
  const stateBytes = stateEvent?.state ? new Uint8Array(stateEvent.state) : null;
  let ramBytes = null;
  try {
    const r = window.EJS_emulator?.gameManager?.getSaveFile?.();
    if (r) ramBytes = new Uint8Array(r);
  } catch { /* core may not have SRAM */ }

  if (!stateBytes || stateBytes.length === 0) {
    toast.error("Save failed", "EmulatorJS produced no state bytes.");
    return;
  }

  // Confirm before overwriting — Save State is an irreversible
  // replace, and it's easy to hit the toolbar button by accident
  // (especially since Select+L1 is the gamepad combo). Mirrors the
  // prompt on Load State for symmetry. We always confirm rather than
  // gating on `slot.has_state` from the cached game payload because
  // that flag is from the initial fetch — after the first Save State
  // it would be stale and silently let the user clobber a slot they
  // just created.
  const ok = await modal.confirm({
    title: "Overwrite save state?",
    body: "Saving to this slot will replace the current snapshot. The previous one cannot be recovered.",
    confirmLabel: "Save state",
    danger: true,
  });
  if (!ok) return;

  // Cache first — guarantees the bytes survive even if the upload
  // fails or the tab dies mid-flight. If we're offline this is the
  // only place the snapshot lives until the drainer flushes it.
  const username = me?.username;
  if (username) {
    await stateCache.set(username, game.id, activeSlot, {
      state: stateBytes,
      ram: ramBytes ? new Uint8Array(ramBytes) : null,
      updatedAt: Date.now(),
      pendingUpload: true,
    });
  }

  try {
    const result = await _putState(stateBytes, ramBytes);
    if (username) {
      await stateCache.markSynced(username, game.id, activeSlot, result?.updated_at || null);
    }
    persistor?.acknowledgeExternalUpload(
      ramBytes,
      Number.isFinite(result?.generation) ? result.generation : null,
      result?.updated_at || null,
    );
    toast.success(`Saved to slot ${activeSlot}`);
  } catch (err) {
    // Cache already holds the bytes. Distinguish "server rejected" from
    // "no server reachable" — the former will keep failing on every
    // retry until the underlying issue is fixed, so promising a sync on
    // reconnect would be a lie.
    if (err && err.status) {
      toast.error(
        "Save state upload failed",
        err.message || `Server rejected the request (${err.status}).`,
      );
    } else {
      toast.warning(
        "Saved locally",
        "We couldn't reach the server. We'll sync this state when you're back online.",
      );
    }
  }
}

// Pause the core's frame loop around a state restore. mupen64plus_next
// throws "index out of bounds" intermittently if load_state lands during
// certain frame phases — the dynarec needs to be quiescent. toggleMainLoop
// is a synchronous cwrap, so by the time pause() returns the loop has
// stopped. dontUpdate=true skips the toolbar play/pause icon flip we'd
// just have to undo.
function _safeLoadState(bytes) {
  const emu = window.EJS_emulator;
  const wasPaused = !!emu?.paused;
  if (!wasPaused) emu?.pause?.(true);
  try {
    emu.gameManager.loadState(bytes);
  } finally {
    if (!wasPaused) emu?.play?.(true);
  }
}

async function onLoadState() {
  const username = me?.username;
  const cached = username ? await stateCache.get(username, game.id, activeSlot) : null;

  // Pending bytes are strictly newer than whatever the server has
  // (we cached them before the upload that hasn't happened yet).
  // Always prefer them, online or not.
  if (cached && cached.pendingUpload && cached.state) {
    const ok = await _confirmLoadState();
    if (!ok) return;
    try {
      _safeLoadState(cached.state);
      toast.info(
        `Loaded local snapshot from slot ${activeSlot}`,
        "This snapshot hasn't synced yet — it will when you're back online.",
      );
    } catch (err) {
      toast.fromError(err, "Load failed");
    }
    return;
  }

  // Otherwise prefer the server, then fall back to a synced cache copy.
  let serverBytes = null;
  try {
    const r = await api.raw(`/games/${encodeURIComponent(game.id)}/saves/${activeSlot}/state`);
    if (r.ok) serverBytes = new Uint8Array(await r.arrayBuffer());
  } catch {
    /* network failure → serverBytes stays null and we fall through to cache */
  }

  if (serverBytes) {
    const ok = await _confirmLoadState();
    if (!ok) return;
    try {
      _safeLoadState(serverBytes);
      // Cache the state bytes for offline reload. Deliberately don't
      // grab SRAM here: getSaveFile() forces a saveSaveFiles() into the
      // core, and on N64 (mupen64plus_next) flushing SRAM while the core
      // is still settling from a state restore freezes the emulator.
      // The persistor's own poll loop captures SRAM on its next tick,
      // and the loaded state already contains the matching SRAM internally.
      if (username) {
        await stateCache.set(username, game.id, activeSlot, {
          state: serverBytes,
          ram: null,
          updatedAt: Date.now(),
          pendingUpload: false,
        });
      }
      toast.success(`Loaded snapshot from slot ${activeSlot}`);
    } catch (err) {
      toast.fromError(err, "Load failed");
    }
    return;
  }

  if (cached && cached.state) {
    const ok = await _confirmLoadState();
    if (!ok) return;
    try {
      _safeLoadState(cached.state);
      toast.warning(
        `Loaded local snapshot from slot ${activeSlot}`,
        "Server unreachable — using the snapshot stored on this device.",
      );
    } catch (err) {
      toast.fromError(err, "Load failed");
    }
    return;
  }

  toast.warning("No snapshot", "This slot doesn't have a state snapshot yet.");
}

async function _confirmLoadState() {
  // Loading a state restores the core's full memory snapshot, which
  // includes SRAM. Continuous sync would then push that older SRAM to
  // the server and overwrite any progress made since the snapshot was
  // taken. Make the user explicitly accept that trade-off.
  return modal.confirm({
    title: "Load this state?",
    body: "Your in-game progress will rewind to the moment this state was created. Anything you've done since then will be lost.",
    confirmLabel: "Load state",
    danger: true,
  });
}

/* ---------------- Pending-state drainer ----------------
 *
 * If the user clicks Save State while offline, the state lives only in
 * stateCache until the network returns. Drain it then. Triggered:
 *   - On the `online` window event (transition signal).
 *   - Once at boot if navigator.onLine is already true (the event only
 *     fires on transitions, not on a fresh tab that opens already-online
 *     while a previous tab queued a state).
 *
 * Single in-flight guard, no exponential backoff: state drain is rare
 * and a failed attempt simply waits for the next `online` transition.
 */
let _draining = false;
async function _drainPendingState() {
  if (_draining) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const username = me?.username;
  if (!username) return;
  const cached = await stateCache.get(username, game.id, activeSlot);
  if (!cached || !cached.pendingUpload || !cached.state) return;
  _draining = true;
  try {
    const result = await _putState(cached.state, cached.ram);
    await stateCache.markSynced(username, game.id, activeSlot, result?.updated_at || null);
    persistor?.acknowledgeExternalUpload(
      cached.ram,
      Number.isFinite(result?.generation) ? result.generation : null,
      result?.updated_at || null,
    );
    toast.success(`Snapshot synced to slot ${activeSlot}`);
  } catch {
    /* leave pendingUpload=true; the next `online` event will retry */
  } finally {
    _draining = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", _drainPendingState);
}
