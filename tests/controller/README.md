# Phone-as-controller end-to-end test

Single-file Playwright script that drives the full phone-controller
lifecycle: pair, connect, input forwarding, auto-release on disconnect,
clean teardown. Two browser contexts simulate the host (TV / desktop)
and the pad (phone) within one Playwright session.

The real `/play` page can't run in headless CI — EmulatorJS needs WebGL2,
WASM threading, and a real ROM. Instead, the test serves a tiny HARNESS
HTML on a synthetic same-origin URL via `page.route()`. The harness
mirrors `/play`'s DOM contract (`.player-page` body class, `#back-btn`,
`.player__status`) and stubs `window.EJS_emulator.gameManager.simulateInput`
with a recorder. The host module (`controller-host.js`) itself is fetched
from the real server, so the test exercises production bytes of the
client and the **real** WebSocket pipeline end-to-end.

## What's covered

| Step | Asserts |
|---|---|
| 1. Harness boots | Phone pill is injected and visible; sits left of `.player__status` |
| 2. `/api/controller/start` | Modal renders, code is a 6-char alphabet-restricted string, status starts as "Waiting…" |
| 3-4. Pad joins + `pad-state` push | Pad WS upgrade succeeds; host modal flips to "Connected" *before* any input arrives |
| 5. Input pipeline | A-button press → host records `simulateInput(0, 0, 1)`; release → records `simulateInput(0, 0, 0)` |
| 6. Held-button auto-release | START pressed and pad disconnected mid-hold → server synthesizes the up-event the host receives |
| 7. Pad-state on disconnect | Host modal flips back to "Waiting…" |
| 8. Clean teardown | Host clicks Close → modal removed, no error toast surfaced |

## What ISN'T covered

- **Real EmulatorJS integration.** The test stubs `simulateInput` because
  the real engine isn't viable headless. The host module's call shape is
  identical for the stub and the real engine — if the call lands at the
  recorder, it would land at the real `gameManager.simulateInput`.
- **Cross-network latency.** Both contexts share the test machine's
  loopback. Real LAN behavior is verified manually.
- **PWA / wake-lock / vibration.** Browser APIs that need real device
  hardware. The pad code calls them defensively; failure modes are
  comments in `pair.js`, not assertions.
- **2-player setups.** The `pad-state.count` plumbing is wired for it,
  but the assertion suite covers count=0 and count=1 only. Add a second
  pad context if 2-player ever ships as a supported feature.

## Prerequisites

```bash
pip install -r tests/controller/requirements.txt
playwright install chromium
```

You also need a working Docker daemon — the test runs

```
docker compose up -d --build --force-recreate
```

at the start of every run, so the container always reflects the current
source tree. This was a deliberate choice over a local-uvicorn shortcut:
on the very first run we caught a stale-frontend bug that a "just point
at localhost:8888" approach would have silently masked.

The first run takes ~30s (image build); subsequent runs are ~5s
(Docker layer cache hits everything except the `COPY backend/frontend`
layers). The `data/` directory at the repo root is reused — the test
assumes the default `admin` / `admin1234` bootstrap user exists.

## Running

```bash
python3 tests/controller/test_pairing_e2e.py
```

Pass criterion: every assertion line ends with ✓ and the script exits
with code 0. On any failure the script prints `✗ N assertion(s) failed`
followed by a list, and exits with code 1.

## Iterating

Edit code → re-run the test. The container rebuild picks up your
changes automatically. No `docker compose down` needed between runs;
`--force-recreate` already handles it.
