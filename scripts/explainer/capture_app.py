#!/usr/bin/env python3
"""Record the real app for the film: stills, scroll passes and overlays.

Everything is read from a live, signed-in RetroX (see login.py) through the
read-only browser in readonly.py, so recording never changes the server. The
output lands in app/ (git-ignored) and the film loads it from /app/.

  capture_app.py                 # every shot
  capture_app.py library game    # just these shots

Shots
  desktop   library.png, library_gba.png, game.png, collection.png,
            search_<n>.png, scroll/NNN.png  (1920x1080 at 2x / scroll at 1x)
  phone     m_library.png, m_game.png, m_scroll/NNN.png  (iPhone 15 Pro, 3x)
  overlays  m_play_land.png, m_play_port.png: the player's own touch controls
            on a transparent background, plus where the game screen sits, so
            the film can put recorded gameplay underneath them.
  shots.json  sizes and game-screen rectangles for the film
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from urllib.parse import quote, unquote

from playwright.sync_api import sync_playwright

import readonly as ro

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "app")
GAME = "pokemon-firered-version-gba"
COLLECTION = "Pokémon"
SEARCH = "fire"
META: dict = {}


# headless Chromium never starts loading="lazy" images: load every cover eagerly
EAGER = """new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) {
  if (n.nodeType !== 1) continue;
  for (const i of n.tagName === 'IMG' ? [n] : n.querySelectorAll('img[loading=lazy]')) i.loading = 'eager';
} }).observe(document, { childList: true, subtree: true });"""


COVERS = os.path.join(OUT, "covers")


def cache_covers(b, log):
    """Download every cover once, one at a time, so a page full of cards never
    hits the server with eighty requests at once."""
    os.makedirs(COVERS, exist_ok=True)
    ctx = ro.context(b, log)
    games = ctx.request.get(ro.base_url() + "/api/games?page_size=200").json()["items"]
    fetched = 0
    for g in games:
        path = os.path.join(COVERS, g["id"].replace("/", "_").replace(":", "__"))
        if os.path.exists(path) or not g.get("has_cover"):
            continue
        r = ctx.request.get(ro.base_url() + f"/api/games/{quote(g['id'], safe='')}/cover")
        if r.ok:
            with open(path, "wb") as f:
                f.write(r.body())
            with open(path + ".type", "w") as f:
                f.write(r.headers.get("content-type", "image/jpeg"))
            fetched += 1
    ctx.close()
    # 480 px thumbnails for the film: some covers are 6000 px scans
    thumbs = os.path.join(OUT, "thumbs")
    os.makedirs(thumbs, exist_ok=True)
    index = []
    for g in games:
        name = g["id"].replace("/", "_").replace(":", "__")
        src, dst = os.path.join(COVERS, name), os.path.join(thumbs, name + ".jpg")
        if not os.path.exists(src):
            continue
        if not os.path.exists(dst):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf",
                            "scale=480:480:force_original_aspect_ratio=increase,crop=480:480",
                            "-q:v", "3", dst], check=True)
        index.append({"id": g["id"], "name": g["name"], "system": g["system"],
                      "cover": f"thumbs/{name}.jpg"})
    with open(os.path.join(OUT, "games.json"), "w") as f:
        json.dump(index, f, indent=1)
    print(f"covers: {len(games)} games, {fetched} downloaded, {len(index)} indexed")


def serve_cover(route):
    gid = unquote(route.request.url.split("/api/games/")[1].split("/cover")[0])
    path = os.path.join(COVERS, gid.replace("/", "_").replace(":", "__"))
    if os.path.exists(path):
        return route.fulfill(path=path, content_type=open(path + ".type").read(),
                             headers={"Cache-Control": "max-age=3600"})
    return route.continue_()


def context(b, log, **kw):
    ctx = ro.context(b, log, **kw)
    ctx.add_init_script(EAGER)
    ctx.route("**/api/games/*/cover*", serve_cover)
    return ctx


def settle(page, sel=".gcard__cover", timeout=90000):
    """Wait for `sel`, then for every image in view to finish loading (lazy
    covers below the fold don't start until they're scrolled to)."""
    page.wait_for_selector(sel, timeout=timeout)
    page.wait_for_function("""() => [...document.images].every((i) => {
        const r = i.getBoundingClientRect();
        const seen = r.bottom > 0 && r.top < innerHeight && r.width > 0;
        return !seen || i.complete;
      })""", timeout=timeout)
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(500)


def quiet(page):
    """No caret, no hover states, no transitions mid-frame."""
    page.add_style_tag(content="*,*::before,*::after{caret-color:transparent!important;"
                               "transition:none!important;animation-duration:0s!important}")
    page.mouse.move(-10, -10)


def preload_lazy(page, scroller):
    """Walk the scroller to the bottom so every lazy cover is fetched, then back."""
    h = page.evaluate(f"document.querySelector('{scroller}').scrollHeight")
    for y in range(0, h, 500):
        page.evaluate(f"document.querySelector('{scroller}').scrollTop = {y}")
        page.wait_for_timeout(120)
    page.evaluate(f"document.querySelector('{scroller}').scrollTop = 0")
    settle(page)


def scroll_pass(page, scroller, folder, frames, distance):
    """`frames` screenshots, `distance` px apart in total; the film eases between them."""
    os.makedirs(folder, exist_ok=True)
    for i in range(frames):
        y = round(distance * i / (frames - 1))
        page.evaluate(f"document.querySelector('{scroller}').scrollTop = {y}")
        page.wait_for_timeout(40)
        page.screenshot(path=os.path.join(folder, f"{i:03d}.png"))
    page.evaluate(f"document.querySelector('{scroller}').scrollTop = 0")


def desktop(b, log, only):
    base = ro.base_url()
    ctx = context(b, log, viewport={"width": 1920, "height": 1080}, device_scale_factor=2)
    page = ctx.new_page()
    page.goto(base + "/games")
    settle(page)
    quiet(page)
    if want(only, "library"):
        page.screenshot(path=os.path.join(OUT, "library.png"))
        page.locator(".chip", has_text="Game Boy Advance").first.click()
        settle(page)
        page.mouse.move(-10, -10)
        page.screenshot(path=os.path.join(OUT, "library_gba.png"))
        page.goto(base + "/games")
        settle(page)
        quiet(page)
    if want(only, "search"):
        page.locator("#topbar-search").click()
        page.wait_for_timeout(400)
        for n in range(len(SEARCH) + 1):
            if n:
                page.keyboard.type(SEARCH[n - 1])
                page.wait_for_timeout(700)
                settle(page, "body")
            page.screenshot(path=os.path.join(OUT, f"search_{n}.png"))
        page.keyboard.press("Escape")
        page.goto(base + "/games")
        settle(page)
        quiet(page)
    if want(only, "game"):
        page.goto(base + f"/game/{GAME}")
        settle(page, ".slots__grid, .game-hero, main img")
        quiet(page)
        page.screenshot(path=os.path.join(OUT, "game.png"))
    if want(only, "collection"):
        page.goto(base + f"/games?collection={quote(COLLECTION)}")
        settle(page)
        quiet(page)
        page.screenshot(path=os.path.join(OUT, "collection.png"))
    # last: the scroll pass runs at 1x in a context of its own
    if want(only, "scroll"):
        ctx.close()
        ctx = context(b, log, viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        page = ctx.new_page()
        page.goto(base + "/games")
        settle(page)
        quiet(page)
        preload_lazy(page, ".main")
        scroll_pass(page, ".main", os.path.join(OUT, "scroll"), 150, 2200)
    ro.keep_session(ctx)
    ctx.close()


def phone(b, p, log, only):
    base = ro.base_url()
    # the whole 393x852 screen, as when RetroX is added to the home screen
    dev = dict(p.devices["iPhone 15 Pro"], viewport={"width": 393, "height": 852},
               screen={"width": 393, "height": 852})
    ctx = context(b, log, **dev)
    page = ctx.new_page()
    if want(only, "m_library"):
        page.goto(base + "/games")
        settle(page)
        quiet(page)
        page.screenshot(path=os.path.join(OUT, "m_library.png"))
        preload_lazy(page, ".main")
        scroll_pass(page, ".main", os.path.join(OUT, "m_scroll"), 120, 1800)
    if want(only, "m_game"):
        page.goto(base + f"/game/{GAME}")
        settle(page, ".slots__grid, main img")
        quiet(page)
        page.screenshot(path=os.path.join(OUT, "m_game.png"))
    ctx.close()

    for name, vp in (("m_play_land", {"width": 852, "height": 393}),
                     ("m_play_port", {"width": 393, "height": 852})):
        if not want(only, name):
            continue
        d = dict(dev)
        d["viewport"] = vp
        d["screen"] = vp
        ctx = context(b, log, **d)
        page = ctx.new_page()
        page.goto(base + f"/play/{GAME}?slot=1")
        page.wait_for_function("() => window.EJS_emulator && window.EJS_emulator.started", timeout=90000)
        page.wait_for_timeout(4000)
        quiet(page)
        page.wait_for_timeout(400)
        # where the 3:2 game picture sits in the canvas: EmulatorJS centres it
        # across and pins it to the top (so portrait leaves room for the pad)
        rect = page.evaluate("""() => {
          const c = window.EJS_emulator.canvas.getBoundingClientRect();
          const s = Math.min(c.width / 240, c.height / 160), w = 240 * s, h = 160 * s;
          return [c.x + (c.width - w) / 2, c.y, w, h];
        }""")
        # the controls alone: no canvas, no backgrounds
        page.evaluate("""() => {
          window.EJS_emulator.canvas.style.visibility = 'hidden';
          for (const n of document.querySelectorAll('*')) {
            const cs = getComputedStyle(n);
            if (cs.backgroundColor === 'rgb(0, 0, 0)' || n === document.body || n === document.documentElement)
              n.style.setProperty('background', 'transparent', 'important');
          }
        }""")
        page.screenshot(path=os.path.join(OUT, f"{name}.png"), omit_background=True)
        META[name] = {"viewport": [vp["width"], vp["height"]], "screen": [round(v, 2) for v in rect]}
        ctx.close()


DESKTOP = {"library", "search", "scroll", "game", "collection"}
PHONE = {"m_library", "m_game", "m_play_land", "m_play_port"}


def want(only, name):
    group = "phone" if name in PHONE else "desktop"
    return not only or name in only or group in only


def main():
    only = set(sys.argv[1:])
    os.makedirs(OUT, exist_ok=True)
    meta_path = os.path.join(OUT, "shots.json")
    if os.path.exists(meta_path):
        META.update(json.load(open(meta_path)))
    log: list[str] = []
    t0 = time.time()
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chromium", args=["--autoplay-policy=no-user-gesture-required",
                                    "--force-color-profile=srgb", "--hide-scrollbars"])
        cache_covers(b, log)
        if not only or only & (DESKTOP | {"desktop"}):
            desktop(b, log, only)
        if not only or only & (PHONE | {"phone"}):
            phone(b, p, log, only)
        b.close()
    with open(meta_path, "w") as f:
        json.dump(META, f, indent=1)
    print(f"done in {time.time() - t0:.0f}s -> {OUT}")
    print(f"writes blocked by the read-only guard: {len(log)}" + "".join(f"\n  {x}" for x in log))


if __name__ == "__main__":
    main()
