# Frontend jsdom tests

Fast, server-less regression checks for the frontend modules with the most
delicate logic. Each test imports the **real** module from `js/` into a jsdom
window and drives it through realistic events; only `fetch` and `WebSocket`
are stubbed.

| File | Module | Protects |
|------|--------|----------|
| `controller-host.test.mjs` | `controller-host.js` | Phone-pill lifecycle: injection, pairing session, `.modal-backdrop` on the pair modal, and full teardown (WS closed, pill removed) on `retrox:navigated` |
| `pair.test.mjs` | `pair.js` | Phone pad: double-submit guard, socket ownership (a superseded socket's close event can't kill its replacement), server kick (4001) handling |
| `router.test.mjs` | `router.js` | Soft navigation and in-app history depth across Back/Forward popstate |

Out of scope (need a real browser): EmulatorJS integration, save sync
pipeline, visual layout. Use the Playwright suites in `/tests` for those.

## Run

```bash
cd frontend
npm test
```

Requires `npm install` once (jsdom is a devDependency). Runs in CI via the
`jsdom` job in `.github/workflows/frontend.yml`.
