/* save-persistor.js — Continuously syncs in-game battery saves (.save).
 *
 * Model: the in-memory SRAM is the source of truth, and we mirror it to
 * the server whenever it changes. EmulatorJS exposes no real "user saved
 * in-game" hook, so we don't try to distinguish a user save from any
 * other SRAM change — RTC ticks, default-state init, and real saves all
 * sync. The only filter is a fast hash dedup: if the bytes haven't
 * changed since our last successful upload, no PUT is sent.
 *
 * Three-layer write detection:
 *   a) "saveSaveFiles" event — fires after JS callers invoke
 *      gameManager.saveSaveFiles() (the EJS toolbar, the save-save-interval
 *      timer, our own periodic poll).
 *   b) FS.writeFile hook — catches JS-side writes to /data/saves.
 *   c) FS.write hook (low-level syscall) — catches RetroArch's C-side
 *      autosave_interval=60s, which goes through fwrite, not writeFile.
 *
 * Plus a 3-second poll calling saveSaveFiles() so even cores that buffer
 * SRAM internally flush within ~4 seconds of a user save.
 *
 * Pipeline:
 *   any signal → debounce 1s → read SRAM → fast-hash dedup
 *               → write to local cache (offline-safe, fast)
 *               → PUT to server with X-Slot-Generation (optimistic concurrency)
 *               → on success, mark cache synced
 *
 * Multi-user / per-slot isolation:
 *   The cache key includes the username; IDBFS (which is shared per-game,
 *   per-origin and leaks across slots and users) is overwritten at boot
 *   with whatever the reconciliation step decided to inject.
 *
 * Things that bit us — DO NOT regress
 * ------------------------------------
 *   1. Cache-first ordering MUST stay. _maybeUpload writes to IndexedDB
 *      BEFORE it tries the network — that's the offline-safety
 *      guarantee. If the upload fails or the tab dies mid-flight, the
 *      bytes are already durable. Reordering "upload first, write cache
 *      on success" would silently lose offline saves. tests/sync/
 *      test_sync_pipeline.py asserts this by reading the cache from
 *      inside an intercepted PUT.
 *
 *   2. X-Slot-Generation on every auto-sync PUT MUST stay. The header
 *      is what makes 409 detection work; without it two devices race
 *      and silently overwrite each other. The ONLY exception is
 *      resolveConflictWithLocal() which is the user-driven force-push
 *      and explicitly omits the header. Manual save-state uploads from
 *      play.js also omit it (they always win) but call back into
 *      acknowledgeExternalUpload to re-seed the local generation so
 *      the next auto-sync doesn't false-409.
 *
 *   3. _handleFailure is INFINITE retry, not bounded. Capped backoff
 *      at 30s — never gives up. Don't add a "retryCount > N → stop"
 *      guard; an offline laptop that's closed for hours and reopened
 *      MUST resume uploading on its own. The `online` window event
 *      short-circuits the backoff for snappier reconnect.
 *
 *   4. conflictHalted halts NETWORK PUTs only — IDB cache writes still
 *      occur so a user who keeps playing past the conflict toast doesn't
 *      lose progress on tab close. _scheduleFlush bails to avoid timer
 *      churn; _maybeUpload, flush, and flushSync all cache the latest
 *      dirty bytes and skip the PUT. Resolution paths (location.reload
 *      OR resolveConflictWithLocal) clear the flag. Any other code path
 *      that mutates conflictHalted is suspect.
 *
 *   5. The reconciliation matrix in play.js (NOT here) decides what
 *      bytes the persistor is constructed with. Case B (local edits +
 *      server unchanged) MUST inject local; Case C (server advanced)
 *      MUST inject server with conflictLost toast. tests/sync/
 *      test_offline_resume.py exercises Case B end-to-end. Don't
 *      collapse the two cases — silent overwrites are exactly what
 *      X-Slot-Generation exists to prevent.
 *
 *   6. flushSync (pagehide path) uses keepalive fetch up to a 60 KiB
 *      cap; oversize falls back to a non-keepalive fetch (best-effort,
 *      may abort if the page closes too fast). Either way the cache
 *      write happens FIRST so the next launch's reconcile picks the
 *      bytes up if the network attempt fails.
 */

import { api } from "./api.js";
import { toast } from "./toast.js";
import { saveCache } from "./save-cache.js";

const SAVE_DIR = "/data/saves/";
const DEBOUNCE_MS = 1000;
const POLL_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;
const FAILURE_TOAST_AFTER = 5;

// Keepalive PUT body cap. The Fetch spec says aggregate keepalive bodies
// per-origin are 64 KiB; FormData adds boundary + multipart overhead, so
// we play it safe with 60 KiB. Bytes within the cap go out keepalive on
// pagehide; oversize falls back to a non-keepalive fetch which may abort
// if the page closes too fast — the IDB cache + reconciliation matrix
// is the durable backstop in either case.
const KEEPALIVE_BYTE_LIMIT = 60 * 1024;

// FNV-1a 32-bit. Fast, no allocation, plenty good for change-detection.
// Exported so play.js can compute a matching hash when seeding the
// cache from a fresh server fetch (the persistor and the cache must
// agree on the hash formula, otherwise dirty-detection would diverge).
export function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Toggle for verbose diagnostic logging. Flip to true to trace every
// hook fire, scheduled flush, and upload decision in the browser
// console — useful when investigating "did my save get uploaded?".
const DEBUG = false;
function dlog(...args) {
  if (DEBUG) console.debug("[save-persistor]", ...args);
}

class ConflictError extends Error {
  constructor() { super("conflict"); this.name = "ConflictError"; }
}

/* --------------------------------------------------------------------
 * FS-hook registry
 *
 * EmulatorJS hands us its emscripten FS object on the saveDatabaseLoaded
 * event. We patch FS.writeFile and FS.write once per FS, and dispatch
 * to every Persistor that has registered an interest. The previous
 * design installed a closure capturing a single Persistor — fine today
 * (one persistor per page), but fragile against any future scenario
 * with more than one (multi-slot, picture-in-picture, etc.). The
 * registry pattern is correct by construction.
 * ------------------------------------------------------------------ */

const FS_HOOKED = new WeakMap();   // FS → Set<Persistor>

function registerFsHooks(FS, persistor) {
  let subscribers = FS_HOOKED.get(FS);
  if (subscribers) {
    subscribers.add(persistor);
    return;
  }
  subscribers = new Set([persistor]);
  FS_HOOKED.set(FS, subscribers);

  if (typeof FS.writeFile === "function") {
    const origWriteFile = FS.writeFile.bind(FS);
    FS.writeFile = function (path, data, opts) {
      const result = origWriteFile(path, data, opts);
      try {
        for (const p of subscribers) {
          if (p._isSavePath(path)) {
            dlog("FS.writeFile hooked", path);
            p._scheduleFlush();
          }
        }
      } catch { /* never let a hook reorder a real write */ }
      return result;
    };
  }

  if (typeof FS.write === "function") {
    const origWrite = FS.write.bind(FS);
    FS.write = function (stream, buffer, offset, length, position, canOwn) {
      const result = origWrite(stream, buffer, offset, length, position, canOwn);
      try {
        let path = stream && stream.path;
        if (!path && stream && stream.node && typeof FS.getPath === "function") {
          path = FS.getPath(stream.node);
        }
        if (path) {
          for (const p of subscribers) {
            if (p._isSavePath(path)) {
              dlog("FS.write hooked", path, length);
              p._scheduleFlush();
            }
          }
        }
      } catch { /* never let a hook reorder a real write */ }
      return result;
    };
  }
}

function unregisterFsHooks(FS, persistor) {
  const subscribers = FS_HOOKED.get(FS);
  if (subscribers) subscribers.delete(persistor);
}

export class SavePersistor {
  constructor({
    username,
    gameId,
    slot,
    initialBytes = null,           // bytes resolved by the reconciliation step
    initialServerGeneration = null, // server's generation as of last sync
    initialServerUpdatedAt = null, // server's wall-clock updated_at (display only)
    onStateChange = null,          // (state) => void — UI subscription
  }) {
    if (!username) throw new Error("SavePersistor: username is required for cache isolation");

    this.username = username;
    this.gameId = gameId;
    this.slot = slot;
    this.onStateChange = onStateChange;

    // Server-generation watermark for X-Slot-Generation (optimistic concurrency).
    // Integer; survives clock skew and timezone drift, unlike the
    // wall-clock timestamps we used to send.
    this.generation = Number.isFinite(initialServerGeneration)
      ? initialServerGeneration
      : null;

    // Dedup state. Pre-seeded from initialBytes so the inject FS-write
    // doesn't re-trigger an upload of what we just downloaded.
    this.lastHash = initialBytes ? fnv1a(initialBytes) : null;
    this.lastLength = initialBytes ? initialBytes.length : -1;

    // Inject state.
    this.initialBytes = initialBytes;
    this.bootInjectPath = null;     // path injectAtBoot wrote to
    this.savePath = null;           // canonical path from getSaveFilePath()

    // Lifecycle flags.
    this.emulator = null;
    this.hookedFs = null;           // remembered for unregisterFsHooks on detach
    this.startEventSeen = false;    // suppresses pipeline before the core has started
    this.detached = false;
    this.conflictHalted = false;

    // Upload pipeline state.
    this.inFlight = false;
    this.dirty = false;
    this.retryCount = 0;
    this.failureNotified = false;
    // Tripped when fetchWithRefresh's silent /auth/refresh + retry also
    // 401s — the user is genuinely signed out and saves can't reach the
    // server until they reload. Surfaced via toast (one-shot, mirrors
    // failureNotified) and the "offline" pill state.
    this.authFailed = false;
    this.authFailedNotified = false;

    // Timers.
    this.debounceTimer = null;
    this.retryTimer = null;
    this.pollTimer = null;

    // When the slot was most recently saved (any source: server-side
    // history, our auto-uploads, manual save state). Seeded from the
    // server-side updated_at if we have it, so the indicator can show
    // "Saved · 2h ago" the moment the page loads, before the user
    // has done anything.
    this.lastSavedAt = initialServerUpdatedAt
      ? new Date(initialServerUpdatedAt)
      : null;
  }

  /* ====================================================================
   * Public API
   * ==================================================================== */

  /**
   * Wire to an EmulatorJS instance. Idempotent. Should be called the
   * moment window.EJS_emulator is set — play.js installs a setter trap
   * to guarantee zero-race attachment.
   */
  attach(emulator) {
    if (this.emulator) return;
    this.emulator = emulator;
    dlog("attach: emulator wired");

    // Ask for durable IDB storage proactively — without it, browsers
    // may evict our offline cache under disk pressure. Idempotent;
    // saveCache also requests it lazily on first DB access, but doing
    // it here means the prompt (Firefox) appears before the user has
    // any in-game progress to lose.
    try {
      if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }
    } catch { /* non-critical upgrade */ }

    emulator.on("saveSaveFiles", () => {
      dlog("event: saveSaveFiles fired");
      this._scheduleFlush();
    });

    emulator.on("saveDatabaseLoaded", (FS) => {
      dlog("event: saveDatabaseLoaded — installing FS hooks + injecting at boot");
      this.hookedFs = FS;
      registerFsHooks(FS, this);
      this._injectAtBoot(FS);
    });

    emulator.on("start", () => {
      dlog("event: start — injecting after start (if needed) + starting poll");
      this._injectAfterStart();
      this._startPolling();
      this.startEventSeen = true;
      // Surface initial state to the indicator so it shows "Synced · X" for
      // an existing save right from the start.
      this._emitState();
    });

    // Track real network state. The browser's online/offline events let
    // us flip the indicator to "Offline" the moment the OS reports loss
    // of connectivity (no need to wait for retry backoff to expire), and
    // retry pending uploads the instant connectivity returns.
    this._onOnline = () => {
      dlog("network: online");
      if (this.failureNotified || this.retryCount > 0) {
        this.failureNotified = false;
        this.retryCount = 0;
        clearTimeout(this.retryTimer);
        this._scheduleFlush();
      }
      this._emitState();
    };
    this._onOffline = () => {
      dlog("network: offline");
      this._emitState();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online",  this._onOnline);
      window.addEventListener("offline", this._onOffline);
    }
  }

  /**
   * Push the cached bytes to the server immediately, before the user
   * has done anything. Used at launch when the cache has unsynced
   * offline edits that we want on the server ASAP.
   *
   * Always sends the X-Slot-Generation header so a third device that
   * wrote between our sync and now triggers a 409 instead of a silent
   * overwrite.
   */
  async uploadInitialBytes(bytes) {
    if (!bytes || bytes.length === 0) return;
    dlog("uploadInitialBytes: length", bytes.length);
    try {
      const result = await this._upload(bytes, /*sendGeneration=*/true);
      this.lastHash = fnv1a(bytes);
      this.lastLength = bytes.length;
      if (result.generation != null) this.generation = result.generation;
      this.lastSavedAt = result.updatedAt ? new Date(result.updatedAt) : new Date();
      // Update cache so it knows these bytes are now synced.
      await saveCache.markSynced(
        this.username, this.gameId, this.slot,
        this.lastHash, this.generation, result.updatedAt,
      );
      this._emitState();
    } catch (err) {
      // Offline at launch is the expected case — leave cache dirty,
      // normal pipeline will retry once we detect any write later.
      dlog("uploadInitialBytes: failed", err && err.message);
    }
  }

  /**
   * Update local dedup state after a manual Save State (which uploads
   * bytes through play.js, not through us). Prevents a redundant
   * follow-up auto-upload.
   */
  acknowledgeExternalUpload(bytes, generation, updatedAt) {
    if (bytes && bytes.length > 0) {
      this.lastHash = fnv1a(bytes);
      this.lastLength = bytes.length;
      this.lastSavedAt = updatedAt ? new Date(updatedAt) : new Date();
      // Mirror to cache so offline state stays consistent.
      saveCache.set(this.username, this.gameId, this.slot, {
        bytes: new Uint8Array(bytes),
        hash: this.lastHash,
        updatedAt: Date.now(),
        syncedHash: this.lastHash,
        serverGeneration: generation ?? this.generation,
        serverUpdatedAt: updatedAt || null,
      }).catch(() => {});
    }
    if (Number.isFinite(generation)) this.generation = generation;
    this.conflictHalted = false;
    this.retryCount = 0;
    this._emitState();
  }

  /**
   * "Use my version" — explicit user-driven conflict resolution.
   *
   * Force-uploads the emulator's current SRAM with NO X-Slot-Generation
   * header, so the server accepts unconditionally and our bytes
   * permanently replace whatever the other session uploaded. Resets
   * conflictHalted so normal sync resumes.
   *
   * The user reaches this path only via the conflict dialog and only
   * after a second confirm — see save-indicator.js.
   *
   * Returns { ok: true, generation, updatedAt } on success or
   * { ok: false, error } on failure (network, auth, etc.). The caller
   * surfaces the error in the UI; we don't toast here because the
   * dialog has its own success/failure presentation.
   */
  async resolveConflictWithLocal() {
    const gm = this.emulator?.gameManager;
    if (!gm) return { ok: false, error: new Error("emulator not ready") };
    let bytes;
    try { bytes = gm.getSaveFile?.(false); }
    catch (e) { return { ok: false, error: e }; }
    if (!bytes || bytes.length === 0) {
      return { ok: false, error: new Error("no SRAM to upload") };
    }
    try {
      // sendGeneration=false → no X-Slot-Generation header → server
      // skips the optimistic-concurrency check and accepts our bytes
      // unconditionally.
      const result = await this._upload(bytes, /*sendGeneration=*/false);
      this.lastHash = fnv1a(bytes);
      this.lastLength = bytes.length;
      if (result.generation != null) this.generation = result.generation;
      this.lastSavedAt = result.updatedAt ? new Date(result.updatedAt) : new Date();
      await saveCache.markSynced(
        this.username, this.gameId, this.slot,
        this.lastHash, this.generation, result.updatedAt,
      );
      this.conflictHalted = false;
      this.retryCount = 0;
      this.failureNotified = false;
      this._emitState();
      return { ok: true, generation: this.generation, updatedAt: this.lastSavedAt };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  /**
   * Read the emulator's current SRAM bytes — used by the conflict
   * dialog when the user wants to download their version before
   * deciding what to do. Returns null if the core isn't ready.
   */
  readCurrentSram() {
    try { return this.emulator?.gameManager?.getSaveFile?.(false) || null; }
    catch { return null; }
  }

  /**
   * Hidden-but-alive flush (visibilitychange). No keepalive cap — we
   * have time for a normal PUT, even for 128KB+ saves.
   */
  flush() {
    if (this.detached || !this.startEventSeen) return Promise.resolve();
    clearTimeout(this.debounceTimer);
    try { this.emulator?.gameManager?.saveSaveFiles?.(); } catch { /* not yet started */ }
    // _maybeUpload itself will cache-only when conflictHalted.
    return this._maybeUpload();
  }

  /**
   * Unload-time flush (pagehide). Uses keepalive — bound by the
   * Fetch-spec 64 KiB body cap. Saves over that limit skip the PUT
   * entirely; the cache + boot-time reconciliation matrix will sync
   * them next launch. In normal operation the periodic poll has
   * already uploaded the bytes well before this fires.
   */
  flushSync() {
    if (this.detached || !this.startEventSeen) return;
    try {
      const gm = this.emulator?.gameManager;
      if (!gm) return;
      gm.saveSaveFiles();
      const bytes = this._readBytes(gm);
      if (!bytes || bytes.length === 0) return;
      const hash = fnv1a(bytes);
      if (hash === this.lastHash && bytes.length === this.lastLength) return;

      // Always write to the cache — that's our offline safety net,
      // including the conflict-halted path (the cache survives the
      // reload that resolves the conflict).
      saveCache.set(this.username, this.gameId, this.slot, {
        bytes: new Uint8Array(bytes),
        hash,
        updatedAt: Date.now(),
        syncedHash: this.lastHash,
        serverGeneration: this.generation,
        serverUpdatedAt: this.lastSavedAt ? this.lastSavedAt.toISOString() : null,
      }).catch(() => {});

      // Conflict-halted: cache only, never PUT (the user must resolve
      // the conflict before further uploads can happen).
      if (this.conflictHalted) return;

      const fd = new FormData();
      fd.append("save", new Blob([bytes]), "save.bin");
      const headers = {};
      if (this.generation != null) headers["X-Slot-Generation"] = String(this.generation);
      const url = api.url(`/games/${encodeURIComponent(this.gameId)}/saves/${this.slot}`);

      // Keepalive PUT for payloads within the per-origin aggregate cap.
      // Best chance of completing past page unload.
      if (bytes.length <= KEEPALIVE_BYTE_LIMIT) {
        fetch(url, {
          method: "PUT", body: fd, keepalive: true, credentials: "include", headers,
        }).catch(() => {});
        return;
      }

      // Oversize: keepalive isn't allowed by the spec, but a regular
      // fetch can still succeed if the browser doesn't tear the page
      // down before the request flushes. The cache write above remains
      // the safety net if it doesn't.
      // Route through api.rawPut so an expired access token gets one
      // silent /auth/refresh + retry — costs ~50–100ms on pagehide but
      // means an oversize save isn't silently dropped on a 401.
      dlog("flushSync: oversize (", bytes.length, "); attempting non-keepalive PUT");
      api.rawPut(
        `/games/${encodeURIComponent(this.gameId)}/saves/${this.slot}`,
        fd,
        headers,
      ).catch(() => {});
    } catch { /* unload path: never throw */ }
  }

  detach() {
    this.detached = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    if (this.hookedFs) {
      unregisterFsHooks(this.hookedFs, this);
      this.hookedFs = null;
    }
    if (typeof window !== "undefined") {
      if (this._onOnline)  window.removeEventListener("online",  this._onOnline);
      if (this._onOffline) window.removeEventListener("offline", this._onOffline);
    }
  }

  /** Snapshot of current state, used by the indicator's initial render. */
  getState() {
    return {
      status: this._currentStatus(),
      lastSavedAt: this.lastSavedAt,
      slot: this.slot,
    };
  }

  /* ====================================================================
   * Internal: boot/inject
   * ==================================================================== */

  _injectAtBoot(FS) {
    // ALWAYS unlink any IDBFS-restored bytes for this game, regardless of
    // whether we have initialBytes to write. This is the key step in the
    // server-as-truth design — IDBFS leaks bytes across slots and users
    // and we must never trust what it restored.
    const base = this._guessBaseName();
    if (!base) return;
    const path = `${SAVE_DIR}${base}.srm`;
    try {
      if (FS.analyzePath(path).exists) {
        dlog("injectAtBoot: unlinking IDBFS leftover at", path);
        FS.unlink(path);
      }
    } catch (e) {
      dlog("injectAtBoot: unlink failed", e && e.message);
    }

    if (!this.initialBytes) {
      dlog("injectAtBoot: no initialBytes, FS left empty");
      return;
    }

    try {
      this._writeBytes(FS, path, this.initialBytes);
      this.bootInjectPath = path;
      dlog("injectAtBoot: wrote", this.initialBytes.length, "bytes to", path);
    } catch (e) {
      dlog("injectAtBoot: write failed", e && e.message);
    }
  }

  _injectAfterStart() {
    const gm = this.emulator?.gameManager;
    if (!gm) return;
    let path;
    try { path = gm.getSaveFilePath?.(); } catch { return; }
    if (!path) return;
    this.savePath = path;

    // If injectAtBoot wrote to the canonical path already, the core read
    // it on start — nothing to do.
    if (this.bootInjectPath === path) {
      dlog("injectAfterStart: canonical path matches boot-inject path; no-op");
      return;
    }

    // Different canonical path — make sure THAT path is correct too.
    if (!this.initialBytes) {
      // No bytes to inject; ensure no stale bytes at canonical path.
      try {
        if (gm.FS.analyzePath(path).exists) {
          dlog("injectAfterStart: no bytes; unlinking stale at canonical", path);
          gm.FS.unlink(path);
        }
      } catch { /* path may not be writable yet */ }
      return;
    }

    try {
      this._writeBytes(gm.FS, path, this.initialBytes);
      gm.loadSaveFiles();
      dlog("injectAfterStart: wrote", this.initialBytes.length, "bytes to canonical", path);
    } catch (e) {
      dlog("injectAfterStart: write failed", e && e.message);
    }
  }

  /* ====================================================================
   * Internal: pipeline
   * ==================================================================== */

  _isSavePath(path) {
    if (!path || typeof path !== "string") return false;
    if (this.savePath && path === this.savePath) return true;
    return path.startsWith(SAVE_DIR);
  }

  _startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.detached) return;
      try {
        // Keep polling during conflict so dirty bytes still reach the
        // IDB cache via the saveSaveFiles → _scheduleFlush → _maybeUpload
        // chain (the network PUT is the only thing that's gated).
        this.emulator?.gameManager?.saveSaveFiles?.();
      } catch { /* core may have torn down between ticks */ }
    }, POLL_INTERVAL_MS);
  }

  _scheduleFlush() {
    if (this.detached) return;
    if (!this.startEventSeen) {
      // Suppress everything before the core has finished init. Boot writes
      // (RTC reset, default-state init, IDBFS leftover that we'll unlink)
      // would otherwise be uploaded as if they were user saves.
      return;
    }
    // Cancel a pending retry — fresh activity supersedes it. Without
    // this both the retry timer and the debounce timer can fire at
    // overlapping moments, double-uploading the same bytes (caught by
    // the hash dedup but wasteful).
    clearTimeout(this.retryTimer);
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this._maybeUpload(), DEBOUNCE_MS);
  }

  async _maybeUpload() {
    if (this.detached) return;
    if (this.inFlight) {
      // Coalesce: re-trigger when the in-flight upload completes.
      this.dirty = true;
      return;
    }
    const gm = this.emulator?.gameManager;
    if (!gm) return;

    const bytes = this._readBytes(gm);
    if (!bytes || bytes.length === 0) return;
    const hash = fnv1a(bytes);

    // The hash dedup is the only filter: if SRAM bytes differ from what
    // we last uploaded, sync them. Boot-time and RTC writes get synced
    // alongside real in-game saves — we treat the SRAM as the source of
    // truth and continuously mirror it to the server. See "How saves
    // work" in the UI for the user-facing framing.
    if (hash === this.lastHash && bytes.length === this.lastLength) {
      dlog("_maybeUpload: hash unchanged, skip");
      return;
    }

    // Snapshot — protects us from the FS being mutated mid-upload.
    const snapshot = new Uint8Array(bytes);

    // Conflict-halted: cache the dirty bytes locally so a tab close
    // doesn't lose progress, but skip the network PUT (the user must
    // resolve via reload or resolveConflictWithLocal first).
    if (this.conflictHalted) {
      dlog("_maybeUpload: conflictHalted; cache only, skip PUT");
      try {
        await saveCache.set(this.username, this.gameId, this.slot, {
          bytes: snapshot,
          hash,
          updatedAt: Date.now(),
          syncedHash: this.lastHash,
          serverGeneration: this.generation,
          serverUpdatedAt: this.lastSavedAt ? this.lastSavedAt.toISOString() : null,
        });
      } catch { /* cache best-effort */ }
      return;
    }

    this.inFlight = true;
    this.dirty = false;
    dlog("_maybeUpload: uploading", snapshot.length, "bytes (hash", hash, ")");

    try {
      // Step 1: write to local cache FIRST. This is the offline-safety
      // guarantee — if the upload below fails or the user closes the tab
      // during it, the cache already has these bytes for recovery on
      // next launch.
      await saveCache.set(this.username, this.gameId, this.slot, {
        bytes: snapshot,
        hash,
        updatedAt: Date.now(),
        // Sync watermarks reflect the LAST successful upload, not this
        // attempt. They get advanced after success.
        syncedHash: this.lastHash,
        serverGeneration: this.generation,
        serverUpdatedAt: this.lastSavedAt ? this.lastSavedAt.toISOString() : null,
      });

      // Step 2: try to upload.
      const result = await this._upload(snapshot, /*sendGeneration=*/true);

      // Step 3: advance dedup + sync watermarks on success.
      this.lastHash = hash;
      this.lastLength = snapshot.length;
      if (result.generation != null) this.generation = result.generation;
      this.lastSavedAt = result.updatedAt ? new Date(result.updatedAt) : new Date();
      await saveCache.markSynced(
        this.username, this.gameId, this.slot,
        hash, this.generation, result.updatedAt,
      );

      if (this.failureNotified) {
        this.failureNotified = false;
        toast.success("Save synced", "Your in-game progress is now safe.");
      }
      // A successful PUT means auth is healthy again — reset both the
      // flag and the one-shot notifier so a future expiry re-toasts.
      this.authFailed = false;
      this.authFailedNotified = false;
      this.retryCount = 0;
      this._emitState();
    } catch (err) {
      this._handleFailure(err);
    } finally {
      this.inFlight = false;
      if (!this.detached && !this.conflictHalted && this.dirty) {
        this._scheduleFlush();
      }
    }
  }

  _readBytes(gm) {
    try {
      // Pass false so getSaveFile doesn't recursively call saveSaveFiles().
      return gm.getSaveFile?.(false);
    } catch {
      return null;
    }
  }

  /**
   * PUT the slot. Returns `{ generation, updatedAt }` where generation
   * is the server's NEW (post-write) value, ready to be sent back as
   * the X-Slot-Generation token next time.
   */
  async _upload(bytes, sendGeneration) {
    const fd = new FormData();
    fd.append("save", new Blob([bytes]), "save.bin");
    const headers = {};
    if (sendGeneration && this.generation != null) {
      headers["X-Slot-Generation"] = String(this.generation);
    }
    // Goes through fetchWithRefresh: a 401 transparently triggers
    // /auth/refresh + retry once before surfacing here.
    const r = await api.rawPut(
      `/games/${encodeURIComponent(this.gameId)}/saves/${this.slot}`,
      fd,
      headers,
    );
    if (r.status === 409) {
      this._notifyConflict();
      throw new ConflictError();
    }
    if (r.status === 401) {
      // Refresh failed too — leave the legacy "unauthorized" sentinel
      // so _handleFailure stays a no-op (the user is genuinely signed
      // out; nothing to retry against).
      throw new Error("unauthorized");
    }
    if (!r.ok) throw new Error(`PUT failed: ${r.status}`);
    let data = null;
    try { data = await r.json(); } catch { /* response might be empty */ }
    return {
      generation: Number.isFinite(data?.generation) ? data.generation : null,
      updatedAt: data?.updated_at || null,
    };
  }

  _handleFailure(err) {
    if (err instanceof ConflictError) {
      this._emitState();
      return;
    }
    // Only reachable if fetchWithRefresh's silent /auth/refresh retry
    // also 401'd — the user is genuinely signed out, no point retrying.
    // Surface it: the pill flips to "offline" and a one-shot toast
    // tells them to reload. Without this the indicator stayed green
    // while every PUT silently 401'd.
    if (err && err.message === "unauthorized") {
      this.authFailed = true;
      if (!this.authFailedNotified) {
        this.authFailedNotified = true;
        toast.warning("Session expired", "Please reload to log back in.");
      }
      this._emitState();
      return;
    }
    this.retryCount += 1;
    if (this.retryCount >= FAILURE_TOAST_AFTER && !this.failureNotified) {
      this.failureNotified = true;
      toast.warning("Save not synced", "We'll keep retrying in the background.");
    }
    this._emitState();
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, this.retryCount - 1));
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._maybeUpload(), delay);
  }

  _notifyConflict() {
    this.conflictHalted = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    toast.warning(
      "Save updated elsewhere",
      "Another session uploaded a newer save for this slot. Reload to pull the latest copy.",
      8000,
    );
  }

  /* ====================================================================
   * Internal: state events for the indicator
   * ==================================================================== */

  _currentStatus() {
    if (this.conflictHalted) return "conflict";
    // Three paths to "offline":
    //   - The browser/OS reports no network (immediate)
    //   - We've burned through enough retries to surface failure (~30s)
    //   - Session expired and silent refresh failed (authFailed)
    // All three look the same to the user, and the cache-first write
    // order guarantees no progress is lost in any case.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
    if (this.failureNotified) return "offline";
    if (this.authFailed) return "offline";
    if (this.lastSavedAt) return "synced";
    return "idle";
  }

  _emitState() {
    if (!this.onStateChange) return;
    try {
      this.onStateChange({
        status: this._currentStatus(),
        lastSavedAt: this.lastSavedAt,
        slot: this.slot,
      });
    } catch (e) {
      console.warn("[save-persistor] onStateChange threw", e);
    }
  }

  /* ====================================================================
   * Internal: FS helpers
   * ==================================================================== */

  _writeBytes(FS, path, bytes) {
    this._mkdirP(FS, path);
    if (FS.analyzePath(path).exists) FS.unlink(path);
    FS.writeFile(path, bytes);
  }

  _mkdirP(FS, path) {
    const parts = path.split("/");
    let cp = "";
    for (let i = 0; i < parts.length - 1; i++) {
      if (!parts[i]) continue;
      cp += "/" + parts[i];
      if (!FS.analyzePath(cp).exists) FS.mkdir(cp);
    }
  }

  _guessBaseName() {
    const raw = window.EJS_gameName;
    if (!raw) return null;
    return raw.replace(/\.[^.]+$/, "");
  }
}
