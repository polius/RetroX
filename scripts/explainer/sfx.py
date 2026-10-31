#!/usr/bin/env python3
"""Sound design: render the scenes' cue list (cues.json) into one effects track.

The scenes register every cue themselves (api.cue in web/), so a sound always
sits on the frame that causes it. Every effect is synthesized, like the score,
and most of them are 8-bit: pulse waves, a triangle, and an LFSR noise channel,
the way a handheld makes sound.

  sfx.py --cues cues.json --duration 62.6 --out sfx.wav
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import soundfile as sf
from scipy import signal

from music import SR, add, bp, env, hp, lp, nes_noise, pulse, reverb_ir, tri

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(5)


def T(sec):
    return np.arange(int(sec * SR)) / SR


def glide(f0, f1, sec, duty=0.5, curve=1.0):
    """A pulse wave sliding from f0 to f1 (exponential)."""
    t = T(sec)
    f = f0 * (f1 / f0) ** ((t / sec) ** curve)
    return pulse(f, duty)


def seq_notes(notes, step, duty=0.25, decay=0.08, last=None):
    """A quick run of pulse notes (Hz), each `step` seconds."""
    n = int((len(notes) * step + (last or decay * 3)) * SR)
    out = np.zeros(n)
    for i, f in enumerate(notes):
        d = (last if (last and i == len(notes) - 1) else step * 1.1)
        x = pulse(np.full(int(d * SR), f), duty) * env(int(d * SR), 0.002, decay if i < len(notes) - 1 else (last or decay))
        i0 = int(i * step * SR)
        out[i0:i0 + x.size] += x[: n - i0]
    return out


def coin():           # B5 -> E6, the classic pickup
    return seq_notes([987.8, 1318.5], 0.07, 0.5, 0.05, last=0.35) * 0.16


def select():         # a menu cursor
    return seq_notes([1046.5, 1568.0], 0.035, 0.25, 0.03, last=0.06) * 0.14


def blip():
    return seq_notes([1760.0], 0.05, 0.5, 0.03, last=0.05) * 0.1


def build():          # a pixel locking into place
    f = 220 * 2 ** (rng.integers(0, 12) / 12) * 2
    return seq_notes([f], 0.03, 0.125, 0.03, last=0.04) * 0.12


def pop():
    return glide(500, 1400, 0.07, 0.5) * env(int(0.07 * SR), 0.002, 0.03) * 0.13


def jump():           # the save packet hops
    return glide(300, 1100, 0.18, 0.25, 0.6) * env(int(0.18 * SR), 0.003, 0.12) * 0.12


def click():
    t = T(0.04)
    return (pulse(np.full(t.size, 2200.0), 0.5) * np.exp(-t / 0.006) * 0.12
            + hp(rng.standard_normal(t.size), 3000) * np.exp(-t / 0.003) * 0.08)


def key():
    t = T(0.05)
    click_ = hp(rng.standard_normal(t.size), 2500) * np.exp(-t / 0.004)
    thock = np.sin(2 * np.pi * (240 + rng.random() * 60) * t) * np.exp(-t / 0.012) * 0.5
    return (click_ * 0.6 + thock) * 0.14


def enter():
    t = T(0.12)
    return (hp(rng.standard_normal(t.size), 1500) * np.exp(-t / 0.006) * 0.5
            + np.sin(2 * np.pi * 170 * t) * np.exp(-t / 0.03)) * 0.24


def stamp():          # a big pixel word slams down
    t = T(0.35)
    body = tri(55 + 90 * np.exp(-t / 0.05)) * np.exp(-t / 0.16)
    crunch = nes_noise(t.size, 7) * np.exp(-t / 0.05) * 0.5
    return np.tanh(1.8 * (body + crunch)) * 0.3


def powerup():        # a rising arpeggio
    notes = [523.3, 659.3, 784.0, 1046.5, 1318.5, 1568.0, 2093.0]
    return seq_notes(notes, 0.045, 0.5, 0.05, last=0.25) * 0.12


def start():          # PRESS START: a bright two-chord jingle
    a = seq_notes([784.0, 1046.5, 1318.5, 1568.0], 0.06, 0.25, 0.08, last=0.5)
    b = seq_notes([523.3, 659.3, 784.0, 1046.5], 0.06, 0.5, 0.08, last=0.5)
    n = max(a.size, b.size)
    return (np.pad(a, (0, n - a.size)) + 0.6 * np.pad(b, (0, n - b.size))) * 0.12


def swish():
    return sweep(0.4, 900, 6000) * 0.4


def whoosh():
    x = sweep(0.7, 250, 4200) * 0.5
    t = T(0.7)
    return x + lp(rng.standard_normal(t.size), 180) * np.sin(np.pi * t / 0.7) ** 2 * 0.5


def wipe():
    """the pixel wall: a stepped noise sweep, bit-crushed like a cartridge"""
    sec = 0.6
    n = int(sec * SR)
    x = np.zeros(n)
    hop = int(0.025 * SR)
    for k, i in enumerate(range(0, n, hop)):
        period = int(2 + 40 * (1 - k / (n / hop)) ** 2)        # the noise clock speeds up
        x[i:i + hop] = nes_noise(hop, period, seed=k)
    u = np.arange(n) / n
    return lp(x, 7000) * np.sin(np.pi * u) ** 1.5 * 0.16


def hit():
    t = T(2.6)
    f = 42 + 70 * np.exp(-t / 0.05)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.6) * 0.9
    crash = nes_noise(t.size, 3) * np.exp(-t / 0.35) * 0.35
    # a C major chord on pulses, ringing out
    chord = sum(pulse(np.full(t.size, hz), 0.25) * 0.5 for hz in (523.3, 659.3, 784.0, 1046.5))
    chord *= np.minimum(1, t / 0.005) * np.exp(-t / 0.7) * 0.12
    return np.tanh(1.3 * (sub + crash)) * 0.6 + lp(chord, 6000)


def sweep(sec, f0, f1, q=0.5):
    n = int(sec * SR)
    x = rng.standard_normal(n)
    out = np.zeros(n)
    hop = int(0.02 * SR)
    for i in range(0, n, hop):
        c = f0 * (f1 / f0) ** (i / n)
        seg = bp(x[max(0, i - 4 * hop): i + hop], c * (1 - q), min(c * (1 + q), SR / 2.2))
        out[i:i + hop] = seg[-min(hop, n - i):]
    u = np.arange(n) / n
    return out * np.sin(np.pi * u) ** 1.6


FX = {"coin": coin, "select": select, "blip": blip, "build": build, "pop": pop, "jump": jump,
      "click": click, "key": key, "enter": enter, "stamp": stamp, "powerup": powerup, "start": start,
      "swish": swish, "whoosh": whoosh, "wipe": wipe, "hit": hit}
# how much of each effect goes to the reverb
SEND = {"hit": 0.5, "start": 0.4, "powerup": 0.3, "coin": 0.3, "whoosh": 0.3, "swish": 0.3,
        "stamp": 0.3, "select": 0.2, "jump": 0.2}
PAN = {"whoosh": 0.0, "wipe": 0.0, "hit": 0.0, "start": 0.0}


def render(cues, duration):
    n = int(duration * SR) + SR
    dry = np.zeros((n, 2))
    send = np.zeros((n, 2))
    for c in cues:
        x = FX[c["type"]]() * c.get("gain", 1)
        pan = PAN.get(c["type"], (rng.random() - 0.5) * 0.4)
        add(dry, c["t"], x, pan=pan)
        if c["type"] in SEND:
            add(send, c["t"], x * SEND[c["type"]], pan=pan)
    ir = reverb_ir(2.2, 0.7)
    wet = np.stack([signal.fftconvolve(send[:, ch], ir[:, ch])[:n] for ch in range(2)], axis=1)
    out = (dry + wet * 0.5)[: int(duration * SR)]
    return np.clip(out, -0.98, 0.98)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cues", default=os.path.join(HERE, "cues.json"))
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", default=os.path.join(HERE, "sfx.wav"))
    args = ap.parse_args()
    cues = json.load(open(args.cues))
    sf.write(args.out, render(cues, args.duration), SR, subtype="PCM_24")
    print(f"sfx: {len(cues)} cues -> {args.out}")


if __name__ == "__main__":
    main()
