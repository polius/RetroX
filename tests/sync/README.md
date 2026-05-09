# Cross-device sync tests

Integration tests for the save-synchronization pipeline. **These are
NOT CI gates** — they're snapshot-style integration tests with the
usual fragility (timing, EJS load races, route interception).

## What's covered

| File | Layer | What it actually proves |
|---|---|---|
| [`test_sync_pipeline.py`](test_sync_pipeline.py) | **Protocol / sync logic** | The auto-sync loop does its job — SRAM change → debounced PUT, `X-Slot-Generation` header sent, cache committed BEFORE upload, `syncedHash` advances after success, offline + reconnect uploads queued bytes |
| [`test_offline_resume.py`](test_offline_resume.py) | **Protocol / sync logic** | Reconciliation matrix — Case B (local edits win when server unchanged) AND Case C (server advanced → local lost + "Server has newer progress" toast surfaces). The two paths a multi-device user can hit on resume |
| [`test_conflict_resolution.py`](test_conflict_resolution.py) | **Protocol + UI** | 409 from server → `conflictHalted` → red "Out of sync" pill → dialog with 3 buttons + advanced download → "Use my version" force-pushes WITHOUT `X-Slot-Generation` (real header inspection) |
| [`test_storage_durability.py`](test_storage_durability.py) | **Browser durability** | `navigator.storage.persist()` granted (saves can't be evicted under disk pressure), cache survives a hard reload, IDB quota is reasonable, `QuotaExceededError` doesn't crash the page |
| [`test_state_offline.py`](test_state_offline.py) | **Protocol / sync logic** | Save State (.state) offline path — clicking Save State while offline queues the bytes in stateCache with `pendingUpload=true`, Load State falls back to that cache when the server is unreachable, and the `online` event drains the pending state to the server automatically |
| [`test_user_isolation.py`](test_user_isolation.py) | **Security / namespacing** | Every IDB key is prefixed with the username — proves user A's bytes can't surface for user B on the same browser. Includes a foreign-key injection test verifying the persistor doesn't read across users |
| [`test_pill_states.py`](test_pill_states.py) | **UI snapshot only** | All four pill states render with the right dot color, classes, and dialog title. Catches CSS / wording regressions, NOT sync regressions. Lower load-bearing than the others. |
| [`screenshots.py`](screenshots.py) | **Utility, NOT a test** | Re-generates the four `landing/images/sync-*.png` screenshots used in the project README. Run when dialog copy / colors change |

If you only have time to run one, run **`test_sync_pipeline.py`** — it's
the one that catches silent save-corruption regressions.

## Pass criteria

Each script ends with a clear summary line:

```
✓ all sync-pipeline assertions pass
✓ Case B: local bytes won AND were uploaded to the server
✓ all assertions pass
✓ all 4 states pass
```

If any line shows ✗, the test failed and the surrounding output
explains where.

## Prerequisites

```bash
pip install -r tests/gamepad/requirements.txt   # same deps as gamepad
playwright install chromium
```

You also need:

- A running RetroX container at `http://localhost:8888`
  (`docker compose up -d`)
- A user `admin` / `admin1234` (the default seed)
- At least these games indexed:
  - `pokemon-blue-version-gb` — used as the "slot 1 has a save" subject
  - `asterix-obelix-gb` — used as the "slot 1 is empty" subject

If your dev container has different slugs, edit the `SLUG_*` constants
at the top of each script.

## Running

```bash
# the primary correctness test — run this first
python3 tests/sync/test_sync_pipeline.py

# reconciliation matrix (Case B + Case C)
python3 tests/sync/test_offline_resume.py

# 409 conflict + force-push protocol
python3 tests/sync/test_conflict_resolution.py

# IDB persistence + quota + reload survival
python3 tests/sync/test_storage_durability.py

# Save State offline queue + reconnect drain
python3 tests/sync/test_state_offline.py

# cross-user namespace enforcement
python3 tests/sync/test_user_isolation.py

# UI snapshot of all 4 states
python3 tests/sync/test_pill_states.py

# regenerate README dialog screenshots (utility, not a test)
python3 tests/sync/screenshots.py
```

Each script runs in headless Chromium with its own browser sessions —
one broken scenario can't poison the others.

## What ISN'T covered

- **Reconciliation Case A** (server unreachable on resume) —
  `ctx.set_offline` during navigation breaks the next page fetch,
  making the test brittle. Verified manually during the original
  audit; covered indirectly by `test_sync_pipeline.py` #4.
- **Manual save state path** (Save State button → upload without
  generation header → `acknowledgeExternalUpload` re-seeds the
  generation watermark) — the offline branch is covered by
  `test_state_offline.py`; the online happy path is covered by
  inline code comments and manual testing.
- **Multi-tab races on the same storage** — Playwright contexts
  have separate IndexedDB; a true same-storage two-tab race needs
  two `Page` objects in one context, which is finicky. The 409
  conflict path (which is what a real multi-tab race would trigger)
  is covered by `test_conflict_resolution.py`.
- **Real eviction under disk pressure** — browsers won't let us
  trigger this programmatically. Mitigated at the implementation
  level by `navigator.storage.persist()` (`test_storage_durability.py`
  asserts the grant).
- **Long-duration offline backoff** (the 30 s cap kicking in after
  multiple failures) — would require waiting minutes per assertion;
  the retry mechanism itself is covered by code review and the
  `online`-event reconnect path in `test_sync_pipeline.py` #4.
- **Browsers other than headless Chromium** — Safari/Firefox could
  surface different IDB or fullscreen behaviour; treat as manual
  smoke-test before a release.

If a regression suggests one of these gaps matters, extend the
relevant file or open a new one.

## Adding new tests

When a new sync-related bug ships, add a numbered scenario to
[`test_sync_pipeline.py`](test_sync_pipeline.py) (for pipeline behavior)
or a new file (for substantially different concerns). Keep one browser
session per scenario — don't rely on state carrying across.
