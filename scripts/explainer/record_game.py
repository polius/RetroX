#!/usr/bin/env python3
"""Record the gameplay the film shows: Pokémon FireRed, played by hand in
the real RetroX player, from the title screen to Professor Oak stopping you at
the edge of Pallet Town.

The player runs in the read-only browser (readonly.py): the game boots from
the server, but nothing is ever written back (no saves, no playtime). The
emulator canvas is recorded with MediaRecorder at 60 fps while you drive the
game with commands on stdin, one per line, checking `shot` stills as you go
(headless emulation doesn't keep exact wall-clock time, so a fixed script
drifts out of step with the dialogue):

  tap <button> [ms]       press and release (a b start select up down left right l r)
  hold <button> <sec>     hold, e.g. to walk
  mash <button> <every> <sec>
  type <TEXT>             type on FireRed's naming keyboard (cursor starts on A), then OK
  wait <sec>
  shot <name>             a still of the game -> <out>/<name>.png
  mark <label>            note the take time (printed, and kept in marks.json)
  stop                    finish the take

Then the take is cut into the four clips the film uses, at the GBA's native
240x160 (CLIPS: edit the start times to match your take's marks):

  app/gameplay/intro    the intro battle (Gengar vs Nidorino)
  app/gameplay/title    the title screen (Charizard)
  app/gameplay/naming   typing the name RETROX
  app/gameplay/town     leaving the house, Pallet Town, "OAK: Hey! Wait!"

  record_game.py                 # play + record, then cut
  record_game.py --cut-only      # re-cut app/gameplay/take.webm

The film's take: let the intro play to the title, START, A (new game), A
through the speech, `type RETROX`, A, A through the rival, `type BLUE`, A, A
until the bedroom, then walk: downstairs, out the door, north out of town.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import time

import readonly as ro

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "app", "gameplay")
GAME = "pokemon-firered-version-gba"
SLOT = 1

# EmulatorJS input indices
B, SELECT, START, UP, DOWN, LEFT, RIGHT, A = 0, 2, 3, 4, 5, 6, 7, 8

# (clip, start in the take, seconds) — the take's own clock starts when the
# core has booted
CLIPS = [("intro", 12, 20), ("title", 30, 24), ("naming", 131, 28), ("town", 328, 46)]

KEYBOARD = ["ABCDEF.", "GHIJKL,", "MNOPQRS", "TUVWXYZ"]


def keyboard_path(text):
    """D-pad moves to type `text` on FireRed's naming keyboard, from 'A'."""
    pos = {ch: (r, c) for r, row in enumerate(KEYBOARD) for c, ch in enumerate(row)}
    r0, c0, out = 0, 0, []
    for ch in text:
        r, c = pos[ch]
        out += [DOWN if r > r0 else UP] * abs(r - r0) + [RIGHT if c > c0 else LEFT] * abs(c - c0) + ["pick"]
        r0, c0 = r, c
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cut-only", action="store_true")
    ap.add_argument("--out", default=OUT, help="where the take and the clips go")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    take = os.path.join(args.out, "take.webm")
    if not args.cut_only:
        record(take)
    cut(take, args.out)


BUTTONS = {"b": B, "select": SELECT, "start": START, "up": UP, "down": DOWN, "left": LEFT,
           "right": RIGHT, "a": A, "l": 10, "r": 11}


def record(take):
    import sys

    from playwright.sync_api import sync_playwright

    log: list[str] = []
    marks = []
    out = os.path.dirname(take)
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chromium", args=["--autoplay-policy=no-user-gesture-required"])
        # 1440x960 = the GBA screen at exactly 6x
        ctx = ro.context(b, log, viewport={"width": 1440, "height": 960})
        pg = ctx.new_page()
        pg.goto(ro.base_url() + f"/play/{GAME}?slot={SLOT}")
        pg.wait_for_function("() => window.EJS_emulator && window.EJS_emulator.started", timeout=120000)
        pg.evaluate("""() => {
          const c = window.EJS_emulator.canvas;
          const rec = new MediaRecorder(c.captureStream(60), {mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 40e6});
          window.__chunks = []; rec.ondataavailable = (e) => window.__chunks.push(e.data);
          rec.start(1000); window.__rec = rec; window.__t0 = performance.now();
          const gm = window.EJS_emulator.gameManager;
          window.__set = (i, v) => gm.simulateInput(0, i, v);
          window.__now = () => (performance.now() - window.__t0) / 1000;
        }""")

        def tap(i, ms=110):
            pg.evaluate(f"window.__set({i}, 1)")
            pg.wait_for_timeout(ms)
            pg.evaluate(f"window.__set({i}, 0)")

        print("recording; commands on stdin (see --help)", flush=True)
        for line in sys.stdin:
            cmd = line.split()
            if not cmd:
                continue
            op, rest = cmd[0], cmd[1:]
            if op == "stop":
                break
            if op == "tap":
                tap(BUTTONS[rest[0]], int(rest[1]) if len(rest) > 1 else 110)
            elif op == "hold":
                pg.evaluate(f"window.__set({BUTTONS[rest[0]]}, 1)")
                pg.wait_for_timeout(int(float(rest[1]) * 1000))
                pg.evaluate(f"window.__set({BUTTONS[rest[0]]}, 0)")
            elif op == "mash":
                end = time.time() + float(rest[2])
                while time.time() < end:
                    tap(BUTTONS[rest[0]])
                    pg.wait_for_timeout(max(0, int(float(rest[1]) * 1000) - 110))
            elif op == "type":
                for step in keyboard_path(rest[0].upper()):
                    if step == "pick":
                        tap(A, 90)
                        pg.wait_for_timeout(350)
                    else:
                        tap(step, 90)
                        pg.wait_for_timeout(180)
                tap(START)                      # cursor to OK
                pg.wait_for_timeout(500)
                tap(A)
            elif op == "wait":
                pg.wait_for_timeout(int(float(rest[0]) * 1000))
            elif op == "shot":
                pg.screenshot(path=os.path.join(out, rest[0] + ".png"))
            elif op == "mark":
                marks.append([round(pg.evaluate("window.__now()"), 2), " ".join(rest)])
            else:
                print(f"? {line.strip()}", flush=True)
                continue
            print(f"ok {line.strip()}  t={pg.evaluate('window.__now()'):.2f}", flush=True)

        data = pg.evaluate("""() => new Promise(res => { window.__rec.onstop = async () => {
            const blob = new Blob(window.__chunks, {type: 'video/webm'});
            const buf = new Uint8Array(await blob.arrayBuffer()); let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            res(btoa(s)); }; window.__rec.stop(); })""")
        with open(take, "wb") as f:
            f.write(base64.b64decode(data))
        with open(os.path.join(out, "marks.json"), "w") as f:
            json.dump(marks, f, indent=1)
        ro.keep_session(ctx)
        b.close()
    print(f"take -> {take}")
    print(f"writes blocked by the read-only guard: {len(log)}" + "".join(f"\n  {x}" for x in log))


def cut(take, out=OUT):
    for name, start, sec in CLIPS:
        d = os.path.join(out, name)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        # 6x6 blocks averaged back to single pixels: clean native frames
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(sec), "-i", take,
                        "-vf", "fps=60,scale=240:160:flags=area", os.path.join(d, "%05d.png")], check=True)
        print(f"  {name:7s} {len(os.listdir(d))} frames")
    with open(os.path.join(out, "clips.json"), "w") as f:
        json.dump({n: len(os.listdir(os.path.join(out, n))) for n, *_ in CLIPS}, f)


if __name__ == "__main__":
    main()
