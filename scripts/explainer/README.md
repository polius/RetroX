# RetroX film

The RetroX promo: a **~63-second, 1920×1080, 60 fps MP4** with a neural
voice-over, an original chiptune score, and 8-bit sound design cued from the
picture.

It is built from scratch, like the fsend, Vault and FileSync films: a small web
"video engine" (HTML/CSS/JS) rendered deterministically by headless Chromium,
one frame at a time. What's on the screens is the real thing: the library,
search, game page and touch controls are captured from a live RetroX, and the
gameplay is Pokémon FireRed recorded from RetroX's own player.

Design rules the film follows, so any future edit stays on-model:

- **It looks like a console, not a slide deck.** Every cut is a wall of pixels
  that builds and breaks; the background is an LCD dot field that light runs
  through; the logo builds itself sprite-style from its own geometry; labels
  use a 5x7 pixel font drawn dot by dot; the screen powers on and off like a
  CRT. Each scene is a "stage" with an arcade HUD.
- **The palette is the product's.** The app's near-black canvas and amber, and
  the logo's handheld colours (peach, slate, berry, pale LCD).
- **Show the real app.** No mock-ups: real screenshots, real scroll passes,
  real touch controls with real gameplay underneath them.
- **Mobile is a headline, not a footnote.** A whole stage: the phone library,
  touch controls, then the phone turns sideways into a handheld.
- **Every sound has a cause on screen.** Pixels lock in, menus blip, words
  stamp, save packets hop and land with a coin. Scenes register their own cues.
- **The film ends on a promise:** the logo plays the game; install it, and start playing.

This folder holds **only the source**. Footage, frames, audio, model weights and
the MP4 are generated and git-ignored.

---

## Setup

Needs **Python 3.10+**, **ffmpeg**, and a network connection for the first run.

```sh
cd scripts/explainer
./setup.sh --models        # venv + deps + chromium + Kokoro weights (~340 MB)
```

## Footage (from a live RetroX, read-only)

The film needs a signed-in RetroX with games, covers, and Pokémon FireRed on
slot 1 (with no in-game save, so it starts a new adventure).

```sh
.venv/bin/python login.py https://retrox.example.com   # sign in by hand, once
.venv/bin/python capture_app.py                        # stills, scroll passes, overlays -> app/
.venv/bin/python record_game.py                        # play by hand (stdin commands) -> app/gameplay/
```

`login.py` opens a real browser window: you sign in yourself, and only the
session cookie is kept (`.auth/`, git-ignored, mode 600). The instance's
address is never shown in the film: there is no address bar on screen.

**Nothing is ever written to that server.** `readonly.py` enforces it twice:
the browser context aborts every request that isn't `GET`/`HEAD` (except the
session refresh), and an init script refuses writes in the page itself
(`fetch`, XHR, `sendBeacon`) and disables WebSockets. The player's playtime
beacon and preferences save are blocked, and so is every save upload. Each
run prints what was blocked. Covers are downloaded once, one at a time, and
served to the capture browser from a local cache, so a page of 80 cards never
hits the server at once.

## Build

```sh
./make.sh                                   # the whole pipeline
./make.sh --output ~/Desktop/retrox.mp4
./make.sh --skip-narration --skip-capture   # re-mix / re-encode only
```

Stages (`build.py` prints them as `[n/7]`): narration (Kokoro + faster-whisper
word onsets) → cues → frames (2× supersampled, parallel) → audio (8-bit sfx,
chiptune score ducked under the voice, −14 LUFS) → encode (BT.709, x264) →
captions (`captions/retrox-video.srt`) → mux.

Stills while iterating on the visuals:

```sh
.venv/bin/python capture.py --preview 2.6,12.0,30.5    # -> preview/*.png
.venv/bin/python capture.py --poster 58.8              # -> landing/images/video-poster.png
```

## Files

| File | Role |
|---|---|
| `narration.py` | the script + pacing. **Start here** to change the wording. `PHONEMES` fixes how the voice reads a word: "RetroX" is one word, RET-roh-ks. |
| `web/engine.js` | the renderer: `render(t)`, scene layers + cameras, the pixel-wall cuts, the LCD dot field, CRT power on/off, the HUD, awaited image swaps, the pixel font, the cue registry |
| `web/scenes.js` | the eight scenes: open, library, play, mobile, sync, features, selfhost, outro |
| `web/style.css` | palette, type, browser / phone / terminal frames |
| `capture.py` | http server + Playwright frame loop (`--preview`, `--poster`, `--cues`) |
| `music.py` | the chiptune: 150 BPM, C–G–Am–F; pulse lead and arpeggio (PolyBLEP), 4-bit triangle bass and kick, noise snare and hats, risers |
| `sfx.py` | coin, select, blip, build, pop, jump, stamp, power-up, start, wipe, hit, keys |
| `build.py` | orchestrates the seven stages |
| `readonly.py` | the read-only browser for the live instance |
| `login.py` / `capture_app.py` / `record_game.py` | footage |

## Notes

- A frame that swaps an image (gameplay, scroll positions) returns a promise
  from `__render`; the harness waits for the decode before the screenshot.
- Gameplay is kept at the GBA's native 240×160 and scaled up with
  `image-rendering: pixelated`, so pixels stay square at any size.
- Hidden scene layers use `display: none`, not `visibility: hidden`.
- **Do not commit** `app/`, `.auth/`, `frames/`, `preview/`, `audio/`,
  `captions/`, `timeline.json`, `cues.json`, `*.wav`, `*.mp4`, `models/` or
  `.venv/`. Pokémon FireRed footage and the game covers are not ours to
  redistribute; the film only shows them.
