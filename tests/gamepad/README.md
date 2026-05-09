# Gamepad navigation tests

Integration smoke tests for the spatial-navigation system (D-pad / arrow
keys → focus movement). They drive a mocked Standard-mapping gamepad
against a running RetroX container and verify focus lands where the
plan says it should.

**These are NOT CI gates.** They're snapshot tests that exercise UX
guarantees, with the usual integration-test fragility (timing, selectors,
EJS load races). Run them before merging anything that touches:

- [`frontend/js/gamepad-nav.js`](../../frontend/js/gamepad-nav.js)
- [`frontend/js/play.js`](../../frontend/js/play.js) gamepad poll
- Any page with `data-nav-group` / `data-nav-{up,down,left,right}` /
  `data-gp-{first,start,y}` / `data-nav-primary` markers
- Modals (`modal.open` in `toast.js`)
- The router (`router.js`) — soft-nav stylesheet merge

## What's covered

### `audit_full.py` — broad surface
Walks every reachable page with the controller and verifies focus
movement, transitions, modals, and shortcuts:

- `/login` (form + QR mode)
- `/games` library (grid + list views, sidebar transitions, chips,
  command palette, B / Y / X / SELECT / START shortcuts)
- `/game/<slug>` (Play auto-focus, slot picker, fav button)
- `/play` (player overlay, sync-pill dialog, Select+Start exit, Select+Y
  opens chrome dialog)
- `/profile` (settings nav ↔ pane)
- `/admin/{library,users,emulators,collections,saves}`
- `modal.confirm` (focus trap, Cancel auto-focus on `danger=true`)

Pass criterion: **`Total issues: 0`** in the trailing summary.

### `audit_targeted.py` — known-bug regression tests
One numbered scenario per concrete bug we've fixed. Run this first when
investigating a regression — its tests are tighter and the failure
output is easier to read than the full audit.

Current scenarios (extend as new bugs land):

| #  | What it asserts |
|----|---|
| 1  | R1/L1 chip cycle keeps focus on the new chip (not body) |
| 2  | X opens the command palette; B closes it |
| 3  | UP from filter chips reaches the library-head sort/layout controls |
| 4  | `/game` slot grid is a nav-group; spatial pick stays within |
| 5  | `/play` sync dialog: A button dismisses it (modal-over-player exception) |
| 6  | `/games` cold-load auto-focuses the first card |
| 7  | Hold-to-repeat (Plex/Netflix-style) works on the D-pad |
| 8  | `/link` auto-focuses the OTP input |
| 9  | SELECT button jumps to first card in list view too |
| 10 | Modal close X reachable via D-pad UP from the body — currently relies on B as the canonical escape |
| 11 | RIGHT from sidebar lands on the first card (not the sort dropdown) |
| 12 | A on a card → router soft-nav → Play button auto-focused on `/game` |
| 13 | RIGHT on the sort `<select>` moves focus (does NOT cycle the value) — both gamepad and keyboard paths |
| 14 | A direction physically held during the soft-nav (intentional or stick drift) does NOT keep firing move() into the new page — Play stays focused. A fresh press after release still moves. |
| 15 | B / Circle on a Sony non-standard-mapping pad (Firefox + DualSense): goes back when there's in-app forward history, never leaves the shell to /login, never opens the command palette (Circle isn't Square). On `/game` with a dialog open, Circle closes the dialog and stays on the page. Square (West face) is fully inert — does not navigate, click, or open the palette. |

## Prerequisites

```bash
pip install -r tests/gamepad/requirements.txt
playwright install chromium
```

You also need:

- A running RetroX container at `http://localhost:8888`
  (`docker compose up -d`)
- A user `admin` / `admin1234` (the default seed)
- At least one game indexed (the demo Tobu Tobu Girl ROMs that ship
  with the image are enough for most tests; `audit_full.py` uses
  `pokemon-blue-version-gb` and `asterix-obelix-gb` slugs in some
  scenarios — substitute or skip those if the slugs differ)

If you've built an image without seed games or with different
credentials, edit the constants at the top of each script:

```python
BASE = "http://localhost:8888"
USER = "admin"; PASS = "admin1234"
SLUG_WITH_SAVE = "pokemon-blue-version-gb"
SLUG_NO_SAVE   = "asterix-obelix-gb"
```

## Running

```bash
# Full surface audit
python3 tests/gamepad/audit_full.py

# Targeted regression check
python3 tests/gamepad/audit_targeted.py
```

A clean run ends with `Total issues: 0` (full) or all scenarios
showing a `→ ✓` or equivalent (targeted).

## How the gamepad mock works

Both scripts inject a Standard-mapping pad via `add_init_script`:

```js
const pad = {
  id: '...', index: 0, connected: true, mapping: 'standard',
  buttons: Array.from({length:17}, () => ({pressed:false, value:0})),
  axes: [0, 0, 0, 0],
};
window.__rxPad = pad;
navigator.getGamepads = () => [pad, null, null, null];
```

The real `gamepad-nav.js` poll then sees rising edges and reacts
identically to a physical controller. To press a button from Python:

```python
press(page, RIGHT)        # tap (rising-edge → 1 move call)
hold_combo(page, SELECT, START)  # Select+Start (chrome combo)
```

Constants `A B X Y L1 R1 L2 R2 SELECT START LS RS UP DOWN LEFT RIGHT`
are at the top of each script.

## Adding new tests

When a new gamepad-related bug ships, add an `ISSUE N` block to
`audit_targeted.py` — the format is copy-paste from the existing ones.
Keep one browser session per scenario so a single broken test can't
poison the others.

For broader coverage (a new page, a new modal type), extend
`audit_full.py` with a new `audit_<surface>(p)` function and call it
from the bottom dispatch.
