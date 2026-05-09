/* save-indicator.js — Top-right pill that surfaces save sync state.
 *
 * Subscribes to SavePersistor state events and renders one of:
 *   - "Synced · HH:MM:SS"          green dot — last sync succeeded
 *   - "No save yet"                yellow dot — slot is fresh, no SRAM uploaded yet
 *   - "Offline · HH:MM:SS"         amber dot — server unreachable, will keep retrying
 *   - "Out of sync — reload"       amber dot — another device wrote a newer save
 *
 * Click the pill to open a dialog with the full story for the current
 * state — what's stored, what's safe, what to do next. The pill itself
 * has no tooltip; everything that's worth knowing lives in the dialog,
 * which is reachable by mouse, keyboard, and gamepad alike.
 *
 * Visibility mirrors the back button: the auto-fade controller in
 * play.js (playerChrome) fades both pills together after pointer idle.
 * Warning states (offline / conflict) override the fade so problems
 * stay glanceable without effort.
 */

import { modal, toast } from "./toast.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./util.js";

// Re-render cadence. With absolute-time format we only need to catch
// day boundaries (today → yesterday) — once per minute is plenty.
const TICK_MS = 60_000;

export class SaveIndicator {
  constructor({ mountElement, slot = null, gameName = null, persistor = null }) {
    this.lastSavedAt = null;
    this.status = "idle";
    this.slot = slot;
    this.gameName = gameName;
    // Persistor reference is optional — passed in at construction so
    // the conflict dialog can offer "Use my version" (force-push) and
    // "Download my version" (read SRAM) actions without re-plumbing
    // the whole save pipeline through the indicator. Read-only from
    // the indicator's perspective; we never mutate the persistor's
    // internal state directly.
    this.persistor = persistor;
    this.element = this._createElement();
    mountElement.appendChild(this.element);
    this._faded = false;
    this._tickTimer = setInterval(() => this._refreshRelativeTime(), TICK_MS);
  }

  /**
   * Subscriber for SavePersistor's onStateChange callback.
   * Called whenever upload state transitions.
   */
  update(state) {
    this.status = state.status || "idle";
    if (state.lastSavedAt) {
      this.lastSavedAt = state.lastSavedAt instanceof Date
        ? state.lastSavedAt
        : new Date(state.lastSavedAt);
    }
    if (typeof state.slot === "number") this.slot = state.slot;
    this._render();
  }

  /** Mirror the back button's fade. Attention-grabbing states ignore it. */
  setFaded(faded) {
    this._faded = faded;
    if (this._isWarningStatus() || this._isCriticalStatus()) {
      this.element.classList.remove("is-faded");
      return;
    }
    this.element.classList.toggle("is-faded", faded);
  }

  destroy() {
    clearInterval(this._tickTimer);
    this.element.remove();
  }

  /* -------------------- internal -------------------- */

  _isWarningStatus() {
    // Amber treatment — informational warning. The user's data is safe;
    // this is just a heads-up that something will happen later.
    return this.status === "offline";
  }

  _isCriticalStatus() {
    // Red treatment — action required. Data could be discarded if the
    // user picks the wrong path. Higher visual weight than warning.
    return this.status === "conflict";
  }

  _isEmptyStatus() {
    // "idle" + no synced timestamp = the slot has never been backed up
    // for this user. We treat it as a distinct visual state (yellow,
    // not green) so the user knows progress isn't on the server YET.
    return this.status === "idle" && !this.lastSavedAt;
  }

  _render() {
    // Pill is ALWAYS rendered now — every status (including "no save yet")
    // gets a pill. The previous version hid it for the idle state, which
    // left users wondering whether the sync system was even alive on a
    // freshly-launched slot.
    this.element.style.display = "";

    const textEl = this.element.querySelector(".player__status__text");
    if (textEl) textEl.textContent = this._statusText();

    // Visual modifier classes — drive the dot color via CSS.
    this.element.classList.toggle("is-warning",  this._isWarningStatus());
    this.element.classList.toggle("is-critical", this._isCriticalStatus());
    this.element.classList.toggle("is-empty",    this._isEmptyStatus());

    // Re-apply fade rule whenever the attention state may have flipped.
    if (this._isWarningStatus() || this._isCriticalStatus()) {
      this.element.classList.remove("is-faded");
    } else if (this._faded) {
      this.element.classList.add("is-faded");
    }
  }

  _statusText() {
    if (this.status === "conflict") return "Out of sync — reload";
    if (this.status === "offline") {
      return this.lastSavedAt
        ? `Offline · ${this._formatSavedAt(this.lastSavedAt)}`
        : "Offline";
    }
    if (this.status === "synced" && this.lastSavedAt) {
      return `Synced · ${this._formatSavedAt(this.lastSavedAt)}`;
    }
    // idle / empty / unknown → "No save yet"
    return "No save yet";
  }

  _formatSavedAt(date) {
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    // Seconds give the user a precise "this just synced" signal, not
    // just "sometime in the last minute".
    const time = date.toLocaleTimeString([], {
      hour:   "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (sameDay) return time;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const wasYesterday =
      date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate();
    if (wasYesterday) return `yesterday ${time}`;

    // Older than yesterday — show date + time so the user gets the
    // full picture without hovering for the tooltip.
    const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${dateStr} ${time}`;
  }

  _refreshRelativeTime() {
    // Re-render so "just past midnight" cleanly transitions from
    // "yesterday HH:MM" once the day rolls over. The persistor's
    // happy-path status is "synced" — there is no "saved" state.
    if (this.status === "synced" && this.lastSavedAt) this._render();
  }

  _createElement() {
    const el = document.createElement("button");
    el.className = "player__status";
    el.type = "button";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-label", "Save sync details");
    // Status dot rendered via CSS — color shifts with the warning class.
    el.innerHTML = `
      <span class="player__status__dot" aria-hidden="true"></span>
      <span class="player__status__text"></span>
    `;
    el.addEventListener("click", () => this._openDialog());
    return el;
  }

  /* -------------------- dialog -------------------- */

  _openDialog() {
    const status = this.status;
    const slot = this.slot;

    // Visual + copy choices per state. Keep titles short and the body
    // copy in the user's voice — "your save", "your progress" — so it
    // reads like RetroX is talking TO them, not ABOUT them.
    const variants = {
      synced: {
        title: "Save synced",
        modifier: "is-ok",
        iconName: "check",
        headline: "Your save is mirrored on the server.",
        body:
          "RetroX continuously mirrors your save memory to the server while " +
          "you play — every few seconds, in the background, with no input " +
          "from you. Close the tab or switch devices: your progress is safe " +
          "and you'll pick up exactly where you left off.",
      },
      empty: {
        title: "No save yet",
        modifier: "is-empty",
        iconName: "info",
        headline: "Nothing has been uploaded for this slot yet.",
        body:
          "Your progress will start syncing automatically as soon as the " +
          "game writes anything to its save memory — your first in-game save, " +
          "settings changes, the cartridge's internal clock. The pill turns " +
          "green the moment the first bytes reach the server, usually within " +
          "a few seconds of starting the game. Nothing for you to do.",
      },
      offline: {
        title: "Offline",
        modifier: "is-warn",
        iconName: "alert",
        headline: "Can't reach the server right now.",
        body:
          "Don't worry — your save is being kept safe in this browser. The " +
          "moment the connection comes back, it'll upload to the server " +
          "automatically. You can keep playing without missing a beat, or " +
          "close the game and come back later — hours, days, whenever. " +
          "Nothing will be lost.",
      },
      conflict: {
        title: "Out of sync",
        modifier: "is-critical",
        iconName: "alert",
        headline: "Another live session is also writing this slot.",
        body:
          "While this tab has been playing, another tab or device uploaded a " +
          "newer save for the same slot. This almost always means two " +
          "sessions on the same slot at the same time — RetroX has paused " +
          "syncing here so neither side silently overwrites the other. Pick " +
          "how to resolve it:",
      },
    };

    const key =
      status === "synced"   ? "synced"   :
      status === "offline"  ? "offline"  :
      status === "conflict" ? "conflict" :
      /* idle without lastSavedAt */     "empty";
    const v = variants[key];

    modal.open({
      title: v.title,
      render: (body, close, foot) => {
        body.classList.add("save-dialog");
        body.innerHTML = `
          <div class="save-dialog__hero save-dialog__hero--${v.modifier}">
            <span class="save-dialog__hero__icon" aria-hidden="true">
              ${icon(v.iconName, { size: 28 })}
            </span>
            <div class="save-dialog__hero__copy">
              <div class="save-dialog__hero__headline">${escapeHtml(v.headline)}</div>
              <div class="save-dialog__hero__sub">${this._heroSubtext(key)}</div>
            </div>
          </div>
          <p class="save-dialog__body">${escapeHtml(v.body)}</p>
          <dl class="save-dialog__facts">
            ${this._factRow("Slot", slot != null ? `Slot ${slot}` : "—")}
            ${this._factRow("Last sync", this._lastSyncFact())}
            ${this._factRow("Storage", this._storageFact(key))}
          </dl>
          ${key === "conflict" ? `
            <button type="button" class="save-dialog__advanced" data-act="download">
              ${icon("download", { size: 14 })}
              <span>Download my current save first</span>
            </button>
          ` : ""}
        `;

        if (key === "conflict") {
          // Wire the advanced "download local" action.
          const dlBtn = body.querySelector('[data-act="download"]');
          if (dlBtn) {
            dlBtn.addEventListener("click", () => this._downloadLocalSave());
          }

          // Three-way resolution footer:
          //   - Cancel (ghost): close, conflictHalted stays — user may
          //     want to look around before deciding.
          //   - Use my version (warning): force-push current SRAM,
          //     overwrites the other session's bytes. Confirms first.
          //   - Use server version (primary): reload, server wins —
          //     standard "join the consensus" path.
          const cancel = document.createElement("button");
          cancel.type = "button"; cancel.className = "btn btn--ghost";
          cancel.textContent = "Cancel";
          cancel.addEventListener("click", () => close());

          const useMine = document.createElement("button");
          useMine.type = "button"; useMine.className = "btn btn--danger";
          useMine.textContent = "Use my version";
          useMine.addEventListener("click", async () => {
            close();
            await this._resolveWithLocal();
          });

          const useServer = document.createElement("button");
          useServer.type = "button"; useServer.className = "btn btn--primary";
          useServer.textContent = "Use server version";
          useServer.addEventListener("click", () => { close(); location.reload(); });

          foot.append(cancel, useMine, useServer);
          return;
        }

        // Default footer for non-conflict states: a single Got it.
        const ok = document.createElement("button");
        ok.type = "button"; ok.className = "btn btn--primary";
        ok.textContent = "Got it";
        ok.addEventListener("click", () => close());
        foot.appendChild(ok);
      },
    });
  }

  /** Confirm + execute the force-push path. */
  async _resolveWithLocal() {
    if (!this.persistor || typeof this.persistor.resolveConflictWithLocal !== "function") {
      toast.error("Can't resolve", "Save persistor is not attached.");
      return;
    }
    const ok = await modal.confirm({
      title: "Overwrite the newer save?",
      body:
        "The other session's progress will be permanently replaced with the " +
        "save from this tab. This cannot be undone — make sure you really want " +
        "your version to win.",
      confirmLabel: "Overwrite",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    const result = await this.persistor.resolveConflictWithLocal();
    if (result.ok) {
      toast.success("Save uploaded", "Your version is now on the server.");
    } else {
      toast.error("Couldn't upload",
        result.error?.message || "Network error. Try again or reload.");
    }
  }

  /** Export current emulator SRAM as a downloadable .save file. */
  _downloadLocalSave() {
    if (!this.persistor || typeof this.persistor.readCurrentSram !== "function") {
      toast.error("Can't download", "Save persistor is not attached.");
      return;
    }
    const bytes = this.persistor.readCurrentSram();
    if (!bytes || bytes.length === 0) {
      toast.warning("No save to download",
        "The emulator has no SRAM to export yet — keep playing for a moment and try again.");
      return;
    }
    const safeName = (this.gameName || "save").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
    const filename = `${safeName}_slot${this.slot ?? "x"}_local.save`;
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success("Save downloaded",
      `Saved as ${filename}. You can re-upload it later from this game's slot list.`);
  }

  _heroSubtext(key) {
    if ((key === "synced" || key === "offline") && this.lastSavedAt) {
      return escapeHtml(`Last sync ${this._formatSavedAt(this.lastSavedAt)}`);
    }
    if (key === "empty")    return "Will sync automatically as you play";
    if (key === "conflict") return "Sync paused on this device";
    return "";
  }

  _factRow(label, value) {
    return `
      <div class="save-dialog__fact">
        <dt>${escapeHtml(label)}</dt>
        <dd>${value}</dd>
      </div>
    `;
  }

  _lastSyncFact() {
    if (!this.lastSavedAt) return "<em>Never</em>";
    return escapeHtml(this.lastSavedAt.toLocaleString());
  }

  _storageFact(key) {
    if (key === "synced")   return "Server + this browser";
    if (key === "offline")  return "This browser (queued for upload)";
    if (key === "empty")    return "Nothing stored yet";
    if (key === "conflict") return "Server has newer bytes than this tab";
    return "—";
  }
}
