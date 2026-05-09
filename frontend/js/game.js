/* Game detail page: backdrop hero + action cluster + save slots
 * with download / upload per slot. */

import { api } from "./api.js";
import { mountShell, systemLabel } from "./shell.js";
import { icon } from "./icons.js";
import { toast, modal } from "./toast.js";
import { applyEarly, hydrate } from "./theme.js";
import { toggleFavorite } from "./favorites.js";
import { createFilePicker } from "./file-picker.js";
import { saveCache } from "./save-cache.js";
import { isControllerInputMode } from "./input-mode.js";
import { escapeHtml } from "./util.js";
import "./gamepad-nav.js";

applyEarly();

const id = (() => {
  // /game/<slug> path-based URL (new)
  const path = location.pathname.replace(/^\/game\/?/, "");
  if (path) return decodeURIComponent(path);
  // Legacy ?id= query param
  return new URLSearchParams(location.search).get("id");
})();
if (!id) {
  document.body.innerHTML = "<div style='padding:40px'>Missing game id.</div>";
  throw new Error("missing id");
}

const shell = await mountShell({ active: null, title: "" });
if (!shell) throw new Error("not signed in");
const { slot, me } = shell;

hydrate();

let game = null;
let isFav = false;
let selectedDisk = 1;

function relativeTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const delta = (Date.now() - t) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
function formatLocal(iso) { return iso ? new Date(iso).toLocaleString() : "—"; }
function formatPlaytime(seconds) {
  if (!seconds || seconds < 1) return "";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function coverUrl(g) { return g.has_cover ? api.url(`/games/${encodeURIComponent(g.id)}/cover`) : "/images/default-cover.svg"; }

function playUrl(slotKey) {
  const params = new URLSearchParams({ slot: String(slotKey) });
  if (selectedDisk && selectedDisk !== 1) params.set("disk", String(selectedDisk));
  return `/play/${encodeURIComponent(game.slug || id)}?${params.toString()}`;
}

/* ============ Same-document player mount ============
 *
 * Why we DON'T navigate to /play:
 *
 * Browsers create AudioContext in "suspended" state unless the
 * document has user activation. EmulatorJS's libretro core synchronizes
 * to audio sample consumption — a suspended context means no samples
 * consumed, no frames advanced, the game appears frozen until the user
 * clicks. EJS works around this with a "Click to resume Emulator" popup,
 * which is exactly the clunky UX we're trying to eliminate.
 *
 * User activation is reset on EVERY navigation, even same-origin.
 * `location.href = "/play/..."` therefore lands on a /play document with
 * no activation, the AudioContext spawns suspended, and EJS's popup
 * appears. There is no way to fix this from the /play side: the new
 * document has not been activated and resume() will be denied.
 *
 * The fix (same approach as Romm): never navigate. The click that
 * opened the slot picker grants the document sticky user activation;
 * keeping the player in the same document preserves it. EJS's
 * AudioContext is created under that activation and starts running
 * immediately. No popup, no second click, no input-mode caveats —
 * works for both mouse and gamepad-driven flows because the activation
 * is already on the document by the time we reach this code.
 *
 * Tradeoff: pressing Back tears down the player by hard-reloading
 * /game/<slug>. We could keep the same document and try to dispose of
 * the EJS instance in-place, but EJS exposes no clean teardown API,
 * and a hard reload is what Romm settled on for the same reason
 * (cross-origin isolation / WASM threads also benefit from a clean
 * slate). Direct deep-link navigation to /play still works via the
 * standalone play.html, with EJS's audio popup as a fallback. */
function startPlayInPlace(slotKey) {
  // Defensive: if the overlay is somehow already mounted (e.g. a
  // double-click before the modal closed), don't stack two players.
  if (document.querySelector(".player-host")) return;

  const url = playUrl(slotKey);

  // Update the URL so the address bar reflects /play and the user can
  // copy / share / refresh as if they had navigated. pushState does
  // NOT trigger a navigation, so the document and its activation
  // history are preserved.
  history.pushState({ retroxPlayer: true }, "", url);

  // Build the host element. Structure mirrors /play.html exactly so
  // play.js (which we'll import below) finds the elements it expects
  // — getElementById("emulator-mount"), getElementById("back-btn") —
  // regardless of where in the DOM tree they live.
  //
  // Layout-critical styles (position:fixed inset:0 background:#000)
  // are set INLINE rather than relying solely on /css/player.css. If
  // a user has /game.html cached from before this change shipped,
  // their cached HTML lacks the <link rel="stylesheet" href="/css/
  // player.css"/> tag — without inline fallbacks the overlay would
  // render as a plain block-level div pushed to the end of body
  // (below all existing /game content, requiring scroll to see).
  // The CSS file still handles the rest of the player chrome (back
  // button styling, hint pill, etc); this just makes sure the
  // viewport-cover layout is bulletproof.
  const host = document.createElement("div");
  host.className = "player-host";
  host.id = "player-host";
  host.style.cssText = "position:fixed;inset:0;background:#000;z-index:9000;overflow:hidden;";
  host.innerHTML = `
    <div id="emulator-mount" style="width:100%;height:100%;background:#000"></div>
    <button class="player__back" id="back-btn" type="button" aria-label="Back to game detail">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
      <span>Back</span>
    </button>
  `;

  // Activation-gate overlay (Firefox-with-gamepad workaround):
  //
  // Some browsers — notably Firefox — DO NOT grant user activation from
  // gamepad input. A user clicking "Play" with a controller leaves the
  // document with `navigator.userActivation.hasBeenActive === false`,
  // and EmulatorJS's audio init then stalls indefinitely on a
  // suspended AudioContext (libretro core writes audio samples but the
  // suspended Web Audio backend never drains them, the canvas never
  // gets its first frame painted, the user sees a blank player). On
  // Chromium-based browsers gamepad input does grant transient
  // activation, so this never triggers. On Firefox + mouse/keyboard,
  // hasBeenActive is true and we don't need the gate either.
  //
  // The gate is a centered click target. Pressing it (or anywhere on
  // it) with a REAL mouse/keyboard/touch event grants the document
  // sticky activation, which unblocks EJS for the rest of its
  // lifetime. We don't try to fake it; synthetic click() / dispatchEvent
  // do not satisfy the activation requirement in any browser, so the
  // user genuinely has to provide one real input. The wording makes
  // it obvious why.
  //
  // hasBeenActive can be undefined on browsers without the User
  // Activation API (Safari < 16). We treat undefined as "we don't
  // know" and skip the gate — Safari grants sticky activation from
  // any real input (mouse/keyboard/touch) just like other browsers,
  // so the audio unlock paths in play.js handle it without help.
  const alreadyActive = navigator.userActivation
    && navigator.userActivation.hasBeenActive === true;
  if (!alreadyActive && navigator.userActivation) {
    const gate = document.createElement("div");
    gate.id = "player-gate";
    gate.style.cssText = [
      "position:absolute",
      "inset:0",
      "z-index:9500",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:18px",
      "background:rgba(0,0,0,0.92)",
      "color:#fff",
      "font-family:var(--font-ui,system-ui,sans-serif)",
      "cursor:pointer",
      "-webkit-font-smoothing:antialiased",
      "user-select:none",
    ].join(";");
    gate.innerHTML = `
      <div style="font-size:18px;font-weight:600;letter-spacing:0.01em">Press any key or click to start</div>
      <div style="font-size:13px;color:#a8acb6;max-width:420px;text-align:center;line-height:1.5">
        Your browser requires a keyboard or mouse interaction before audio
        can play. After this, the controller works as expected.
      </div>
      <div style="margin-top:8px;display:inline-flex;align-items:center;gap:10px;padding:10px 20px;border-radius:999px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);font-size:13px;font-weight:500">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;animation:player__hint-pulse 1.6s ease-in-out infinite"></span>
        <span>Tap, click, or press any key</span>
      </div>
    `;
    const dismiss = (e) => {
      // Real input only — synthetic clicks (e.g. via gamepad-nav's
      // a.click()) have isTrusted=false and don't grant activation
      // in Firefox, so dismissing on them would just leave the user
      // with the same suspended-audio problem under a different UI.
      if (e && e.isTrusted === false) return;
      gate.removeEventListener("click", dismiss);
      gate.removeEventListener("keydown", dismiss);
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("touchstart", dismiss);
      gate.remove();
      // Fresh transient activation from this real click — retry the
      // fullscreen we attempted up at startPlayInPlace. For users who
      // hit the gate (typically Firefox + gamepad, where activation
      // was missing entirely on entry), this is the one and only
      // moment we get a real gesture, so it's also our only chance
      // to satisfy Firefox's transient-activation requirement for
      // requestFullscreen.
      if (!document.fullscreenElement) {
        host.requestFullscreen?.().catch(() => {});
      }
    };
    gate.addEventListener("click", dismiss);
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("touchstart", dismiss, { passive: true });
    host.appendChild(gate);
  }

  // Block interaction with the /game UI underneath. inert removes
  // children from the focus order and dispatches no events — keyboard
  // tab can't escape the player, screen readers don't see the
  // ghost UI, click handlers underneath don't fire. When the back
  // button hard-reloads the page these are restored automatically.
  for (const child of Array.from(document.body.children)) {
    if (child !== host) child.inert = true;
  }
  document.body.appendChild(host);

  // Auto-fullscreen the wrapper, NOT EmulatorJS's inner #game element.
  //
  // We do it here rather than via EJS_fullscreenOnLoaded for two
  // reasons:
  //
  //   * Activation timing — Firefox requires transient user activation
  //     for requestFullscreen, and that 5-second window has likely
  //     expired by the time EJS finishes downloading core + ROM and
  //     calls fullscreen itself. We're still inside the click handler
  //     here, so transient is unambiguously fresh.
  //
  //   * Fullscreen target — EJS would fullscreen #game, leaving the
  //     back button (a sibling of #emulator-mount, inside .player-host)
  //     outside the fullscreen element and therefore hidden until the
  //     fullscreenchange listener relocated it. Fullscreening the host
  //     itself keeps the back button (and on entry, the indicator
  //     pill, which gets relocated by play.js's listener) inside the
  //     fullscreen subtree from frame 0.
  //
  // If the request is denied (Firefox + gamepad has zero activation,
  // and the gate-dismiss path below handles it), .catch() swallows
  // it and the player stays windowed. The user can hit the EJS
  // fullscreen toolbar button manually if they want.
  host.requestFullscreen?.().catch(() => {});

  // Pop = "user wants out" (browser back, gamepad B, swipe). Hard
  // reload to /game/<slug> rather than try to dismantle EJS in-place:
  // EJS has no public destroy API, the WASM/AudioContext leaks would
  // be hard to chase, and a fresh document on return guarantees the
  // shell + gamepad-nav are in a clean state. The only side effect is
  // a brief reload — accepted, same as Romm. */
  const onPop = () => {
    window.removeEventListener("popstate", onPop);
    location.replace(`/game/${encodeURIComponent(game.slug || id)}`);
  };
  window.addEventListener("popstate", onPop);

  // The cache-bust query forces a fresh module instance — without it,
  // a second play in the same browser session would see the cached
  // module and skip its top-level boot code (URL parsing, EJS
  // configuration, save reconciliation, etc).
  import(`./play.js?_v=${Date.now()}`).catch((err) => {
    console.error("[game] failed to load player module", err);
    // Fall back to a hard nav so the standalone play.html can take
    // over — the user still gets the EJS popup but at least sees
    // something.
    location.href = url;
  });
}

function render() {
  const cover = coverUrl(game);
  const slots = game.slots || [];
  const slotMap = new Map(slots.map(s => [s.slot, s]));
  const continueSlot = [...slots].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
  const lastPlayed = game.last_played_at ? relativeTime(game.last_played_at) : null;

  const totalPlaytime = game.playtime_seconds || 0;

  document.title = `${game.name} · RetroX`;

  slot.innerHTML = `
    <article class="detail">
      <div class="detail__art" style="background-image: url('${cover}')"></div>
      <div class="detail__veil"></div>
      <div class="detail__content">
        <div class="detail__poster">
          <img src="${cover}" alt="" width="180" height="180" loading="eager"/>
        </div>
        <div class="detail__info">
          <div class="detail__system">
            <span class="pill pill--accent">${escapeHtml(systemLabel(game.system))}</span>
            ${game.disks > 1 ? `<span class="pill">${game.disks} discs</span>` : ""}
            ${game.release_date ? `<span class="pill">Released ${escapeHtml(game.release_date)}</span>` : ""}
            ${isFav ? `<span class="pill"><span style="color:var(--accent);display:inline-flex;margin-right:4px">${icon("heartFilled", { size: 12 })}</span>Favorited</span>` : ""}
          </div>
          <h1 class="detail__title">${escapeHtml(game.name)}</h1>
          <div class="detail__meta">
            ${(() => {
              const pt = formatPlaytime(totalPlaytime);
              const parts = [];
              parts.push(`<span>${icon("clock", { size: 12 })} ${pt || "Not played yet"}</span>`);
              if (lastPlayed) parts.push(`<span>Last played ${escapeHtml(lastPlayed)}</span>`);
              parts.push(`<span>${slots.length} save${slots.length === 1 ? "" : "s"}</span>`);
              return parts.join('<span class="dot"></span>');
            })()}
          </div>
          <div class="detail__actions">
            <button class="btn btn--primary btn--lg" type="button" id="play-btn" data-gp-start>
              ${icon("play", { size: 18 })}
              <span>Play</span>
            </button>
            <button class="btn ${isFav ? "btn--secondary" : "btn--ghost"}" type="button" id="fav-btn" data-gp-y>
              ${icon(isFav ? "heartFilled" : "heart", { size: 16 })}
              <span>${isFav ? "Favorited" : "Favorite"}</span>
            </button>
            ${game.disks > 1 ? `
              <span class="detail__disk-picker">
                <label for="disk-select">Disc</label>
                <select id="disk-select" class="select">
                  ${game.disk_names.map((n, i) => `<option value="${i + 1}" ${i + 1 === selectedDisk ? "selected" : ""}>${i + 1}. ${escapeHtml(n)}</option>`).join("")}
                </select>
              </span>
            ` : ""}
          </div>
        </div>
      </div>
    </article>

    <section class="slots" aria-label="Save slots">
      ${game.description ? `
        <div class="slots__head">
          <h2>Overview</h2>
        </div>
        <p style="color:var(--text-muted);font-size:var(--fs-base);line-height:1.7;margin-bottom:var(--sp-6)">${escapeHtml(game.description)}</p>
      ` : ""}
      <div class="slots__head" data-nav-group
           data-nav-down=".slots__grid"
           data-nav-up=".detail__actions, [data-gp-start]"
           data-nav-left=".sidebar">
        <h2>Save slots</h2>
        <span class="slots__count">${slots.length}/5</span>
        <button class="btn btn--ghost btn--sm" type="button" id="saves-help-btn" style="margin-left:auto">${icon("info", { size: 14 })} How saves work</button>
      </div>
      <div class="slots__grid" data-nav-group
           data-nav-up="[data-gp-start], .detail__actions"
           data-nav-left=".sidebar">
        ${[1, 2, 3, 4, 5].map(n => slotCardHTML(slotMap.get(n), n)).join("")}
      </div>
    </section>
  `;

  bindActions(continueSlot);
}

function slotCardHTML(s, n) {
  if (!s) {
    return `
      <button class="slot slot--empty" type="button" data-slot="${n}" data-act="upload-new" aria-label="Upload save to slot ${n}">
        ${icon("upload", { size: 22 })}
        <span style="margin-top:6px;font-size:var(--fs-sm);font-weight:600">Slot ${n} — empty</span>
        <span style="font-size:11px;color:var(--text-faint);margin-top:2px">Upload a save file</span>
      </button>
    `;
  }
  return `
    <div class="slot" data-slot="${n}">
      <div class="slot__head">
        <span class="slot__index">SLOT ${n}</span>
        <span class="slot__tags">
          ${s.has_save  ? `<span class="slot-tag slot-tag--save"  title="Battery save — your in-game progress">SAVE</span>`  : ""}
          ${s.has_state ? `<span class="slot-tag slot-tag--state" title="Save state — full snapshot you took with the toolbar">STATE</span>` : ""}
        </span>
      </div>
      <div class="slot__name">${escapeHtml(s.name || `Save slot ${n}`)}</div>
      <div class="slot__time">${escapeHtml(formatLocal(s.updated_at))}</div>
      <div class="slot__actions">
        <button class="btn btn--ghost" type="button" data-act="rename" title="Rename">${icon("edit", { size: 14 })}</button>
        <button class="btn btn--ghost" type="button" data-act="download" title="Download save files">${icon("download", { size: 14 })}</button>
        <button class="btn btn--ghost" type="button" data-act="upload" title="Replace with file">${icon("upload", { size: 14 })}</button>
        <button class="btn btn--danger" type="button" data-act="delete" title="Delete">${icon("trash", { size: 14 })}</button>
      </div>
    </div>
  `;
}

function bindActions(continueSlot) {
  const favBtn = document.getElementById("fav-btn");
  if (favBtn) {
    favBtn.addEventListener("click", flipFavorite);
    favBtn.addEventListener("gp:y", flipFavorite);
  }

  document.getElementById("saves-help-btn")?.addEventListener("click", () => {
    modal.open({
      title: "How saves work",
      render(body, close, foot) {
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:18px">
            <p style="color:var(--text-muted);line-height:1.6;margin:0">
              Each slot can hold two different kinds of save — they're independent, and a slot can have one, the other, or both. <strong style="color:var(--text)">For normal play, you only need to think about SAVE</strong> — RetroX handles it for you.
            </p>

            <div style="display:flex;flex-direction:column;gap:12px">
              <div style="display:flex;gap:12px;align-items:flex-start;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:14px">
                <span class="slot-tag slot-tag--save" style="flex-shrink:0;margin-top:1px">SAVE</span>
                <div style="min-width:0">
                  <div style="font-weight:600;margin-bottom:4px">In-game save</div>
                  <div style="font-size:13px;color:var(--text-muted);line-height:1.55">
                    The game's own save — what's created when you pick <strong style="color:var(--text)">Save</strong> from inside the game (Pokémon's PC, Zelda's pause menu, and so on). While you play, RetroX automatically copies it to the server in the background — so if you close the tab, your browser crashes, or you switch devices, your progress is safe. <strong style="color:var(--text)">You don't have to do anything.</strong>
                  </div>
                </div>
              </div>

              <div style="display:flex;gap:12px;align-items:flex-start;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:14px">
                <span class="slot-tag slot-tag--state" style="flex-shrink:0;margin-top:1px">STATE</span>
                <div style="min-width:0;flex:1">
                  <div style="font-weight:600;margin-bottom:4px">Save state (snapshot)</div>
                  <div style="font-size:13px;color:var(--text-muted);line-height:1.55">
                    Think of it as a bookmark you can jump back to at any moment, even in places where the game wouldn't normally let you save. Useful for retrying a tough section without losing time. Created only when you click <strong style="color:var(--text)">Save State</strong> in the in-game toolbar; restored with <strong style="color:var(--text)">Load State</strong>.
                  </div>

                  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
                    <figure style="flex:1;min-width:180px;margin:0">
                      <figcaption style="font-size:11px;color:var(--text-dim);margin-bottom:4px;letter-spacing:.04em;text-transform:uppercase;font-weight:600">To save</figcaption>
                      <img src="/images/save.png" alt="Save State button (floppy disk icon) in the EmulatorJS toolbar"
                           style="display:block;width:100%;height:auto;border-radius:6px;border:1px solid var(--border);background:#000"/>
                    </figure>
                    <figure style="flex:1;min-width:180px;margin:0">
                      <figcaption style="font-size:11px;color:var(--text-dim);margin-bottom:4px;letter-spacing:.04em;text-transform:uppercase;font-weight:600">To load</figcaption>
                      <img src="/images/load.png" alt="Load State button (open folder icon) in the EmulatorJS toolbar"
                           style="display:block;width:100%;height:auto;border-radius:6px;border:1px solid var(--border);background:#000"/>
                    </figure>
                  </div>

                  <div style="font-size:12px;color:var(--warn);margin-top:10px;line-height:1.5">
                    <strong>Heads up:</strong> loading a state rewinds your progress back to that moment. Anything you've done since will be overwritten.
                  </div>
                </div>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:8px">
              <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)">At a glance</div>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                  <tr style="color:var(--text-dim);text-align:left">
                    <th style="padding:6px 10px;font-weight:600">&nbsp;</th>
                    <th style="padding:6px 10px;font-weight:600">SAVE</th>
                    <th style="padding:6px 10px;font-weight:600">STATE</th>
                  </tr>
                </thead>
                <tbody style="color:var(--text-muted)">
                  <tr style="border-top:1px solid var(--border)">
                    <td style="padding:8px 10px;color:var(--text)">When it's stored</td>
                    <td style="padding:8px 10px">Automatically, while you play</td>
                    <td style="padding:8px 10px">Only when you press <strong style="color:var(--text)">Save State</strong></td>
                  </tr>
                  <tr style="border-top:1px solid var(--border)">
                    <td style="padding:8px 10px;color:var(--text)">How to use it later</td>
                    <td style="padding:8px 10px">Just play this slot — loaded automatically</td>
                    <td style="padding:8px 10px">Press <strong style="color:var(--text)">Load State</strong> to jump back</td>
                  </tr>
                  <tr style="border-top:1px solid var(--border)">
                    <td style="padding:8px 10px;color:var(--text)">When you'd want it</td>
                    <td style="padding:8px 10px">To pick up your game later, exactly where you saved</td>
                    <td style="padding:8px 10px">To bookmark a moment you might want to retry</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;color:var(--text-muted);line-height:1.5">
              <strong style="color:var(--text)">Gamepad shortcuts:</strong> hold <code style="background:var(--canvas);padding:1px 5px;border-radius:3px;border:1px solid var(--border)">Select</code> + press <code style="background:var(--canvas);padding:1px 5px;border-radius:3px;border:1px solid var(--border)">L1</code> to save state, <code style="background:var(--canvas);padding:1px 5px;border-radius:3px;border:1px solid var(--border)">R1</code> to load state, <code style="background:var(--canvas);padding:1px 5px;border-radius:3px;border:1px solid var(--border)">Start</code> to exit.
            </div>
          </div>
        `;
        const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn btn--primary"; ok.textContent = "Got it";
        ok.addEventListener("click", () => close());
        foot.appendChild(ok);
      },
    });
  });

  const playBtn = document.getElementById("play-btn");
  if (playBtn) {
    playBtn.addEventListener("click", () => openPlayPicker(continueSlot));
    // Auto-focus Play when shouldAutoFocusPlay() decides this arrival
    // had no other meaningful focus to preserve (a card that's now
    // gone, fresh page load, etc) AND the user is on a controller.
    if (shouldAutoFocusPlay()) {
      requestAnimationFrame(() => playBtn.focus({ preventScroll: true }));
    }
  }

  const diskSelect = document.getElementById("disk-select");
  if (diskSelect) {
    diskSelect.addEventListener("change", () => {
      selectedDisk = parseInt(diskSelect.value, 10) || 1;
    });
  }

  // Slot row actions
  slot.querySelectorAll(".slot[data-slot]").forEach(card => {
    const n = parseInt(card.dataset.slot, 10);
    card.querySelectorAll("[data-act]").forEach(btn => {
      const act = btn.dataset.act;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (act === "rename") renameSlot(n);
        else if (act === "delete") deleteSlot(n);
        else if (act === "download") downloadSlot(n);
        else if (act === "upload") uploadSlot(n);
      });
    });
  });
  // Empty-slot upload buttons
  slot.querySelectorAll(".slot--empty[data-slot]").forEach(btn => {
    const n = parseInt(btn.dataset.slot, 10);
    btn.addEventListener("click", () => uploadSlot(n));
  });
}

/* ---------- Play slot picker ---------- */

function openPlayPicker(continueSlot) {
  const slots = game.slots || [];
  const bySlot = new Map(slots.map(s => [s.slot, s]));

  modal.open({
    title: `Play ${game.name}`,
    render(body, close, foot) {
      const heading = document.createElement("div");
      heading.style.fontSize = "12px";
      heading.style.fontWeight = "600";
      heading.style.letterSpacing = "0.08em";
      heading.style.textTransform = "uppercase";
      heading.style.color = "var(--text-dim)";
      heading.style.marginBottom = "10px";
      heading.textContent = "Choose a save slot";
      body.appendChild(heading);

      const list = document.createElement("div");
      list.className = "slot-list";
      // Mark as a nav-group so D-pad navigation stays within the slot
      // column. UP/DOWN moves between slots; LEFT/RIGHT has no
      // candidates and stays put. UP at slot 1 / DOWN at slot 5 hit
      // clean dead-ends (no same-group candidate, no declared
      // transition). Without the group marker the picker falls back to
      // global mode and can drift to elements outside the modal.
      list.setAttribute("data-nav-group", "");

      for (let n = 1; n <= 5; n++) {
        const existing = bySlot.get(n);
        const row = document.createElement("button");
        row.type = "button";
        row.className = `slot-row${existing ? " slot-row--filled" : ""}`;
        if (existing) {
          const isContinue = continueSlot === n;
          const tags = `
            <span class="slot-row__tags">
              ${existing.has_save  ? `<span class="slot-tag slot-tag--save"  title="Battery save — your in-game progress">SAVE</span>`  : ""}
              ${existing.has_state ? `<span class="slot-tag slot-tag--state" title="Save state — full snapshot you took with the toolbar">STATE</span>` : ""}
            </span>
          `;
          row.innerHTML = `
            <div class="slot-row__index">${n}</div>
            <div class="slot-row__body">
              <div class="slot-row__name">
                ${escapeHtml(existing.name || `Save slot ${n}`)}
                ${isContinue ? `<span class="slot-row__continue" title="Last played slot">Continue</span>` : ""}
              </div>
              <div class="slot-row__time">${escapeHtml(formatLocal(existing.updated_at))}</div>
            </div>
            ${tags}
          `;
        } else {
          row.innerHTML = `
            <div class="slot-row__index">${n}</div>
            <div class="slot-row__body">
              <div class="slot-row__name">Empty slot</div>
              <div class="slot-row__time">Start a new game here</div>
            </div>
            <span class="slot-row__tags">
              <span class="slot-tag slot-tag--empty">NEW</span>
            </span>
          `;
        }
        // Same-document mount: see startPlayInPlace() for why we don't
        // navigate. Closing the modal first removes the backdrop from
        // the focus tree before we lay down the player overlay.
        row.addEventListener("click", () => { close(); startPlayInPlace(n); });
        list.appendChild(row);
      }

      body.appendChild(list);

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn--ghost";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close());
      foot.appendChild(cancel);
    },
  });
}

async function flipFavorite() {
  try {
    isFav = await toggleFavorite(game.id, isFav);
    render();
  } catch (err) {
    toast.fromError(err, "Couldn't update favorite");
  }
}

async function renameSlot(n) {
  const existing = (game.slots || []).find(s => s.slot === n);
  const newName = await modal.open({
    title: `Rename slot ${n}`,
    render(body, close, foot) {
      const wrap = document.createElement("div");
      wrap.className = "field";
      wrap.innerHTML = `
        <label class="field__label" for="slot-rename">Slot label</label>
        <input class="input" id="slot-rename" type="text" maxlength="60" value="${escapeHtml(existing?.name || "")}" placeholder="e.g. before final boss">
        <span class="field__hint">Leave empty to clear the label.</span>
      `;
      body.appendChild(wrap);
      const input = wrap.querySelector("#slot-rename");
      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));
      const ok = document.createElement("button");
      ok.type = "button"; ok.className = "btn btn--primary"; ok.textContent = "Save";
      ok.addEventListener("click", () => close(input.value.trim()));
      foot.append(cancel, ok);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); close(input.value.trim()); } });
    },
  });
  if (newName === undefined) return;
  try {
    const fd = new FormData();
    fd.append("name", newName);
    await api.upload(`/games/${encodeURIComponent(game.id)}/saves/${n}`, fd, { method: "PUT" });
    await reload();
    toast.success("Renamed");
  } catch (err) {
    toast.fromError(err, "Rename failed");
  }
}

async function deleteSlot(n) {
  const ok = await modal.confirm({
    title: `Delete slot ${n}?`,
    body: "The save state and battery file for this slot will be permanently removed.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/games/${encodeURIComponent(game.id)}/saves/${n}`);
    // Also clear the local cache for this slot — without this, the next
    // time the user launches the slot we'd "resurrect" the deleted save.
    if (me?.username) {
      saveCache.delete(me.username, game.id, n).catch(() => {});
    }
    await reload();
    toast.success(`Slot ${n} deleted`);
  } catch (err) {
    toast.fromError(err, "Delete failed");
  }
}

/* ---------- Download ---------- */

async function downloadSlot(n) {
  const existing = (game.slots || []).find(s => s.slot === n);
  if (!existing) return;
  if (!existing.has_save && !existing.has_state) {
    toast.warning("Empty slot", "There are no files to download for this slot.");
    return;
  }

  await modal.open({
    title: `Download slot ${n}`,
    render(body, close, foot) {
      const lead = document.createElement("p");
      lead.style.margin = "0 0 14px";
      lead.style.color = "var(--text-muted)";
      lead.style.lineHeight = "1.6";
      lead.textContent = "Pick which file you'd like to save to your device.";
      body.appendChild(lead);

      const list = document.createElement("div");
      list.className = "slot-list";
      list.setAttribute("data-nav-group", "");

      const options = [
        {
          kind: "save",
          available: !!existing.has_save,
          tagClass: "slot-tag--save",
          tagLabel: "SAVE",
          title: "Battery save",
          desc: "Your in-game progress — what the cartridge writes.",
          ext: ".save",
          path: `/games/${encodeURIComponent(game.id)}/saves/${n}/save`,
          filename: fileBaseName(n) + ".save",
        },
        {
          kind: "state",
          available: !!existing.has_state,
          tagClass: "slot-tag--state",
          tagLabel: "STATE",
          title: "Save state",
          desc: "An emulator snapshot — exact memory at a moment in time.",
          ext: ".state",
          path: `/games/${encodeURIComponent(game.id)}/saves/${n}/state`,
          filename: fileBaseName(n) + ".state",
        },
      ].filter(o => o.available);

      for (const o of options) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "slot-row slot-row--filled";
        row.innerHTML = `
          <div class="slot-row__index">${icon("download", { size: 16 })}</div>
          <div class="slot-row__body">
            <div class="slot-row__name">
              ${escapeHtml(o.title)}
              <span class="slot-row__ext">${o.ext}</span>
            </div>
            <div class="slot-row__time">${escapeHtml(o.desc)}</div>
          </div>
          <span class="slot-row__tags">
            <span class="slot-tag ${o.tagClass}">${o.tagLabel}</span>
          </span>
        `;
        // Download in-place so the user can grab the other file without
        // re-opening the dialog. Guard against double-clicks while the
        // request is in flight.
        row.addEventListener("click", async () => {
          if (row.disabled) return;
          row.disabled = true;
          try {
            await downloadFile(o.path, o.filename);
            toast.success(`Downloaded ${o.ext}`);
          } catch (err) {
            toast.fromError(err, "Download failed");
          } finally {
            row.disabled = false;
          }
        });
        list.appendChild(row);
      }

      body.appendChild(list);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "btn btn--ghost";
      closeBtn.textContent = "Close";
      closeBtn.addEventListener("click", () => close(undefined));
      foot.appendChild(closeBtn);
    },
  });
}

function fileBaseName(n) {
  const safe = (game.name || "save").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
  return `${safe}_slot${n}`;
}

// Mirrors /games's logic: only auto-focus Play if a controller user
// arrived here AND there's no existing meaningful focus to preserve.
// On soft-nav from a sidebar item that's still present, the sidebar
// item keeps focus. On soft-nav from a card click, the card is gone
// (slot replaced) so document.activeElement is body — we step in and
// land focus on Play.
function shouldAutoFocusPlay() {
  if (!isControllerInputMode()) return false;
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement) return false;
  return true;
}


async function downloadFile(path, filename) {
  const r = await api.raw(path);
  if (!r.ok) throw new Error("Slot file not found");
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Upload ---------- */

async function uploadSlot(n) {
  const existing = (game.slots || []).find(s => s.slot === n);
  const done = await modal.open({
    title: existing ? `Replace slot ${n}` : `Upload to slot ${n}`,
    render(body, close, foot) {
      const lead = document.createElement("p");
      lead.className = "lead";
      lead.style.marginBottom = "16px";
      lead.textContent = "Import a save from another device. You can upload either or both files.";
      body.appendChild(lead);

      // Battery save first — for users coming from another emulator
      // it's the more common import (the cartridge-side save survives
      // across sessions; emulator save states are usually session-local).
      const saveField = document.createElement("div");
      saveField.className = "field";
      saveField.innerHTML = `
        <label class="field__label">
          Battery save
          <span class="field__ext">.save</span>
        </label>
      `;
      const savePicker = createFilePicker({
        id: "up-save",
        accept: ".save,.srm,.sav,.bin,application/octet-stream",
        placeholder: "No battery save chosen",
        onChange: () => sync(),
      });
      saveField.appendChild(savePicker.el);
      const saveHint = document.createElement("span");
      saveHint.className = "field__hint";
      saveHint.textContent = "What the cartridge writes — your in-game progress.";
      saveField.appendChild(saveHint);
      body.appendChild(saveField);

      const stateField = document.createElement("div");
      stateField.className = "field";
      stateField.style.marginTop = "16px";
      stateField.innerHTML = `
        <label class="field__label">
          Save state
          <span class="field__ext">.state</span>
        </label>
      `;
      const statePicker = createFilePicker({
        id: "up-state",
        accept: ".state,.bin,.dat,.sav,application/octet-stream",
        placeholder: "No save state chosen",
        onChange: () => sync(),
      });
      stateField.appendChild(statePicker.el);
      const stateHint = document.createElement("span");
      stateHint.className = "field__hint";
      stateHint.textContent = "An emulator snapshot — exact memory at a moment in time.";
      stateField.appendChild(stateHint);
      body.appendChild(stateField);

      const nameField = document.createElement("div");
      nameField.className = "field";
      nameField.style.marginTop = "16px";
      nameField.innerHTML = `
        <label class="field__label" for="up-name">
          Slot label
          <span class="field__optional">optional</span>
        </label>
        <input class="input" id="up-name" type="text" maxlength="60" value="${escapeHtml(existing?.name || "")}" placeholder="e.g. Before final boss"/>
      `;
      body.appendChild(nameField);

      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "btn btn--ghost"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => close(undefined));

      const ok = document.createElement("button");
      ok.type = "button"; ok.className = "btn btn--primary";
      ok.textContent = existing ? "Replace" : "Upload";
      ok.disabled = true;

      // Hoisted so the picker's onChange can reach it before this body
      // executes — flips the primary button on as soon as the user
      // picks at least one file. No "pick a file" toast surprise.
      function sync() {
        ok.disabled = !savePicker.file && !statePicker.file;
      }

      // Run the upload INSIDE the dialog so a backend rejection
      // (file too large, validation error, transient 5xx) doesn't
      // dismiss the form and discard the user's file selections.
      ok.addEventListener("click", async () => {
        const state = statePicker.file;
        const save = savePicker.file;
        const name = nameField.querySelector("#up-name").value.trim();
        if (!state && !save) return;

        if (existing) {
          const confirmed = await modal.confirm({
            title: `Overwrite slot ${n}?`,
            body: `"${existing.name || `Save slot ${n}`}" will be replaced.`,
            confirmLabel: "Overwrite",
            danger: true,
          });
          if (!confirmed) return;
        }

        ok.disabled = true;
        const originalLabel = ok.textContent;
        ok.textContent = "Uploading...";
        try {
          const fd = new FormData();
          if (state) fd.append("state", state, "state.bin");
          if (save)  fd.append("save",  save,  "save.bin");
          if (name)  fd.append("name",  name);
          await api.upload(`/games/${encodeURIComponent(game.id)}/saves/${n}`, fd, { method: "PUT" });
          close(true);
        } catch (err) {
          toast.fromError(err, "Upload failed");
          ok.textContent = originalLabel;
          sync();
        }
      });
      foot.append(cancel, ok);
    },
  });
  if (!done) return;
  await reload();
  toast.success(`Slot ${n} updated`);
}

async function reload() {
  game = await api.get(`/games/${encodeURIComponent(id)}`);
  isFav = !!game.is_favorite;
  // Clamp selected disk to range
  if (selectedDisk > game.disks) selectedDisk = 1;
  render();
}

(async () => {
  try {
    await reload();
  } catch (err) {
    if (err && err.status === 401) return;
    toast.fromError(err, "Couldn't load game");
  }
})();
