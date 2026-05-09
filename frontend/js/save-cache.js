/* save-cache.js — Per-user, per-slot save cache backed by IndexedDB.
 *
 * Why this exists:
 *   - The server is the source of truth, but it isn't always reachable
 *     (offline play, plane scenario). This cache survives across page
 *     reloads so a save made offline is preserved until it can be synced.
 *   - EmulatorJS's IDBFS is per-game, not per-slot or per-user, and so
 *     leaks data across both. We ignore it on launch and use this cache
 *     instead.
 *
 * Multi-user safety:
 *   The IndexedDB store is per-origin and shared across all users on the
 *   same browser. To keep users isolated we prefix every key with the
 *   logged-in username. A second user reading the cache simply doesn't
 *   see the first user's entries.
 *
 * Schema (one record per (username, gameId, slot)):
 *   {
 *     bytes:            Uint8Array,   // current SRAM bytes
 *     hash:             number,       // FNV-1a of bytes (fast diff)
 *     updatedAt:        number,       // Date.now() at last local write
 *     syncedHash:       number|null,  // hash that was last successfully uploaded
 *     serverGeneration: number|null,  // server's monotonic generation as of last sync
 *     serverUpdatedAt:  string|null,  // server's wall-clock updated_at (display + tie-break)
 *   }
 *
 * isDirty == (hash !== syncedHash). That single comparison is the entire
 * "do we have unsynced offline edits?" check.
 */

const DB_NAME = "retrox-saves";
const STORE = "saves";
const DB_VERSION = 1;

let _dbPromise = null;

/**
 * Request that the browser treat our IndexedDB as PERSISTENT storage.
 *
 * Without this, IDB defaults to "best-effort": browsers may evict our
 * data when disk pressure mounts, the user's offline saves vanish, and
 * the next launch silently treats the slot as empty. With it granted,
 * the browser must keep the data until the user explicitly clears it
 * via site-settings.
 *
 * Behaviour by browser:
 *   - Chrome/Edge: silently grants for sites with usage history. No prompt.
 *   - Firefox: prompts the user the first time, remembers the answer.
 *   - Safari: extends the default 7-day cap on IDB; still subject to its
 *     own eviction rules but materially better than not asking.
 *
 * Idempotent — once granted, subsequent calls are no-ops. Safe to run
 * lazily on the first cache access; we don't await it because the cache
 * works either way (this just upgrades durability).
 */
let _persistAttempted = false;
function requestPersistentStorage() {
  if (_persistAttempted) return;
  _persistAttempted = true;
  try {
    if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((granted) => {
        if (!granted) {
          console.warn(
            "[save-cache] persistent storage not granted — saves may be evicted under disk pressure"
          );
        }
      }).catch(() => { /* swallow — we still work without persistence */ });
    }
  } catch { /* ignore — non-critical upgrade */ }
}

function openDB() {
  if (_dbPromise) return _dbPromise;
  // Fire-and-forget on the first DB access — by the time real saves
  // start flowing, we've already asked for the persistent grant.
  requestPersistentStorage();
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Reset the singleton on hard failure so a transient browser issue
  // (private mode toggle, quota error during init) doesn't poison every
  // future call for the lifetime of the page.
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

function makeKey(username, gameId, slot) {
  return `${username}:${gameId}:${slot}`;
}

// State-cache keys are user-prefixed first so the cross-user namespace
// invariant ("every key starts with `${username}:`") still holds.
function makeStateKey(username, gameId, slot) {
  return `${username}:state:${gameId}:${slot}`;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run `fn(store)` inside a transaction and resolve only after BOTH the
 * caller's promise AND the transaction's `oncomplete` event have fired.
 *
 * This matters because IndexedDB transactions auto-commit when there
 * are no pending requests — if the caller awaits something non-IDB
 * mid-flight, the tx silently aborts and the request appears to
 * succeed when in fact nothing was persisted. Binding to oncomplete
 * makes "the promise resolved" mean "the data is durably written".
 */
async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let payload;
    let payloadReady = false;
    let txComplete = false;
    let settled = false;

    const tryResolve = () => {
      if (settled || !payloadReady || !txComplete) return;
      settled = true;
      resolve(payload);
    };

    tx.oncomplete = () => { txComplete = true; tryResolve(); };
    tx.onerror = () => {
      if (settled) return;
      settled = true;
      reject(tx.error || new Error("transaction error"));
    };
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      reject(tx.error || new Error("transaction aborted"));
    };

    Promise.resolve()
      .then(() => fn(store))
      .then(
        (result) => { payload = result; payloadReady = true; tryResolve(); },
        (err) => {
          if (settled) return;
          settled = true;
          try { tx.abort(); } catch { /* ignore */ }
          reject(err);
        },
      );
  });
}

export const saveCache = {
  /**
   * Returns the cached entry for a (user, game, slot), or null.
   * Returns null on any IndexedDB failure — callers should treat the
   * cache as a best-effort optimization, not a hard dependency.
   */
  async get(username, gameId, slot) {
    if (!username) return null;
    try {
      const r = await withStore("readonly", (store) =>
        reqAsPromise(store.get(makeKey(username, gameId, slot))),
      );
      return r || null;
    } catch {
      return null;
    }
  },

  /** Overwrite the entry for a (user, game, slot). */
  async set(username, gameId, slot, entry) {
    if (!username) return;
    if (!entry || !(entry.bytes instanceof Uint8Array)) return;
    try {
      await withStore("readwrite", (store) =>
        reqAsPromise(store.put(entry, makeKey(username, gameId, slot))),
      );
    } catch (err) {
      // QuotaExceededError leaves the cache silently read-only; surface
      // it once so the user knows their offline safety net is gone.
      if (err && err.name === "QuotaExceededError") {
        console.warn("[save-cache] storage quota exceeded — offline cache disabled");
      }
    }
  },

  /**
   * Mark an existing entry as synced, without touching the bytes.
   * Used after a successful upload completes: cache already has the
   * latest bytes (we wrote them before attempting upload), we just
   * need to advance the sync watermark.
   */
  async markSynced(username, gameId, slot, syncedHash, serverGeneration, serverUpdatedAt) {
    if (!username) return;
    const existing = await this.get(username, gameId, slot);
    if (!existing) return;
    await this.set(username, gameId, slot, {
      ...existing,
      syncedHash,
      serverGeneration: serverGeneration ?? existing.serverGeneration ?? null,
      serverUpdatedAt: serverUpdatedAt ?? existing.serverUpdatedAt ?? null,
    });
  },

  /**
   * Remove the cached entry. Called when the user explicitly deletes a
   * slot — without this we'd "resurrect" the deleted save on next launch.
   */
  async delete(username, gameId, slot) {
    if (!username) return;
    try {
      await withStore("readwrite", (store) =>
        reqAsPromise(store.delete(makeKey(username, gameId, slot))),
      );
    } catch {
      /* swallow */
    }
  },

  /** True iff the entry exists and has unsynced bytes. */
  isDirty(entry) {
    if (!entry || !entry.bytes) return false;
    if (entry.syncedHash === null || entry.syncedHash === undefined) return true;
    return entry.hash !== entry.syncedHash;
  },
};

/**
 * Save-state cache (.state files).
 *
 * Mirrors saveCache's storage plumbing but lives under a different key
 * namespace (`${user}:state:${gameId}:${slot}`) in the same IndexedDB
 * store. State files are user-initiated snapshots, not continuous
 * autosave — so the schema is simpler than saveCache:
 *
 *   {
 *     state:         Uint8Array,   // EJS state buffer
 *     ram:           Uint8Array,   // SRAM captured alongside the state
 *     updatedAt:     number,       // Date.now() at last local write
 *     pendingUpload: boolean,      // true == never reached the server
 *   }
 *
 * `pendingUpload === true` means we have bytes that need to be flushed
 * to the server when connectivity returns. `pendingUpload === false`
 * means we're caching a server-confirmed snapshot purely so Load State
 * can work offline.
 *
 * One entry per (user, game, slot). New saves replace the previous one;
 * we never keep history (state files are 10–60× larger than SRAM, and
 * keeping them would chew quota for no functional gain).
 */
export const stateCache = {
  async get(username, gameId, slot) {
    if (!username) return null;
    try {
      const r = await withStore("readonly", (store) =>
        reqAsPromise(store.get(makeStateKey(username, gameId, slot))),
      );
      return r || null;
    } catch {
      return null;
    }
  },

  async set(username, gameId, slot, entry) {
    if (!username) return;
    if (!entry || !(entry.state instanceof Uint8Array)) return;
    try {
      await withStore("readwrite", (store) =>
        reqAsPromise(store.put(entry, makeStateKey(username, gameId, slot))),
      );
    } catch (err) {
      if (err && err.name === "QuotaExceededError") {
        console.warn("[save-cache] state quota exceeded — offline state cache disabled");
      }
    }
  },

  /** Flip an existing pending entry to synced, refresh updatedAt. */
  async markSynced(username, gameId, slot, updatedAt = null) {
    if (!username) return;
    const existing = await this.get(username, gameId, slot);
    if (!existing) return;
    await this.set(username, gameId, slot, {
      ...existing,
      pendingUpload: false,
      updatedAt: updatedAt ? new Date(updatedAt).getTime() : Date.now(),
    });
  },

  async delete(username, gameId, slot) {
    if (!username) return;
    try {
      await withStore("readwrite", (store) =>
        reqAsPromise(store.delete(makeStateKey(username, gameId, slot))),
      );
    } catch {
      /* swallow */
    }
  },
};
