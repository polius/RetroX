#!/usr/bin/env python3
"""Generate the score: an original chiptune, arranged to the film.

Written for a handheld's sound chip: two pulse channels (lead and arpeggio), a
4-bit triangle (bass, and the kick), and a noise channel (snare, hats, risers).
Synthesized from scratch (no samples, no licensing), band-limited with
PolyBLEP so the pulses stay bright without aliasing. The arrangement is read
from timeline.json and cues.json: the beat grid is anchored on the opening logo
hit, every section change snaps to that grid, and a riser lands on both hits.
The voice is ducked over it later, in build.py.

  open      arpeggio speeds up + noise riser  ->  hit  ->  bass, arp, hats
  library   + kick and snare
  play      + the lead melody (the game starts, so does the tune)
  mobile .. features   full band
  selfhost  breakdown: half-time bass, arp only, riser into the end card
  outro     hit, a ringing C major chord, the arp winds down

  music.py --timeline timeline.json --cues cues.json --out music.wav
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import soundfile as sf
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 48000
BPM = 150
BEAT = 60 / BPM
BAR = 4 * BEAT

# C – G – Am – F, a bar each: (bass root, chord tones) as MIDI notes
CHORDS = [(36, [60, 64, 67]), (43, [59, 62, 67]), (45, [60, 64, 69]), (41, [60, 65, 69])]

# the lead: eight bars of eighth notes over the progression (None = rest, "-" = hold)
LEAD = [
    [76, 79, 84, 79, 76, 79, 81, 79],
    [74, 79, 83, 79, 74, 79, 81, 83],
    [84, 83, 81, 76, 81, 83, 84, 88],
    [86, 84, 81, 77, 79, 81, 84, 86],
    [88, "-", 86, 84, 79, "-", 76, 79],
    [86, "-", 83, 79, 83, 84, 86, None],
    [84, "-", 81, 76, 81, 84, 88, 86],
    [84, "-", "-", 81, 79, "-", "-", None],
]

rng = np.random.default_rng(11)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def lp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(signal.butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def add(buf, start, x, pan=0.0):
    """Mix mono `x` into stereo `buf` at `start` seconds, equal-power pan."""
    i = int(round(start * SR))
    if i >= buf.shape[0] or i + x.size <= 0:
        return
    if i < 0:
        x, i = x[-i:], 0
    x = x[: buf.shape[0] - i]
    a = (pan + 1) * np.pi / 4
    buf[i:i + x.size, 0] += x * np.cos(a)
    buf[i:i + x.size, 1] += x * np.sin(a)


def env(n, a, d, r=None):
    """attack/decay envelope over n samples (exponential decay, linear attack)."""
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / d)
    if r:
        e *= np.clip((n / SR - t) / r, 0, 1)
    return e


# ---- the sound chip --------------------------------------------------------------
def _blep(t, dt):
    out = np.zeros_like(t)
    m = t < dt
    x = t[m] / dt[m]
    out[m] = x + x - x * x - 1
    m = t > 1 - dt
    x = (t[m] - 1) / dt[m]
    out[m] = x * x + x + x + 1
    return out


def pulse(f, duty=0.5):
    """Band-limited pulse wave; `f` is a per-sample frequency array (Hz)."""
    f = np.asarray(f, dtype=float)
    dt = f / SR
    p = np.cumsum(dt) % 1.0
    q = (p + duty) % 1.0
    saw1 = 2 * p - 1 - _blep(p, dt)
    saw2 = 2 * q - 1 - _blep(q, dt)
    return (saw1 - saw2) * 0.5


def tri(f):
    """The 4-bit stepped triangle."""
    f = np.asarray(f, dtype=float)
    p = np.cumsum(f / SR) % 1.0
    x = 4 * np.abs(p - 0.5) - 1
    return np.round(x * 7.5) / 7.5


def nes_noise(n, period=2, seed=0):
    """Noise held for `period` samples per step, like a noise channel's clock."""
    r = np.random.default_rng(1000 + seed)
    steps = r.choice([-1.0, 1.0], size=n // max(1, period) + 2)
    return np.repeat(steps, max(1, period))[:n]


def reverb_ir(seconds=1.6, decay=0.5):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-t / decay)[:, None]
    ir[:, 0] = lp(ir[:, 0], 6000); ir[:, 1] = lp(ir[:, 1], 6000)
    ir[: int(0.01 * SR)] = 0
    return ir / np.sqrt((ir ** 2).sum(axis=0))


# ---- instruments --------------------------------------------------------------------
def note(m, dur, duty=0.25, vib=0.0, decay=0.35):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m) * (1 + vib * np.sin(2 * np.pi * 5.5 * t) * np.minimum(1, t / 0.15))
    e = np.minimum(1, t / 0.004) * (0.55 + 0.45 * np.exp(-t / decay)) * np.clip((dur - t) / 0.02, 0, 1)
    return pulse(f, duty) * e


def bass(m, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return tri(np.full(n, hz(m))) * np.clip((dur - t) / 0.01, 0, 1) * np.minimum(1, t / 0.002)


def kick():
    t = np.arange(int(0.22 * SR)) / SR
    return tri(60 + 220 * np.exp(-t / 0.025)) * np.exp(-t / 0.09) * 1.1


def snare():
    t = np.arange(int(0.2 * SR)) / SR
    body = tri(180 + 120 * np.exp(-t / 0.02)) * np.exp(-t / 0.04) * 0.6
    return body + nes_noise(t.size, 3) * np.exp(-t / 0.07) * 0.7


def hat(open_=False):
    t = np.arange(int((0.12 if open_ else 0.04) * SR)) / SR
    return hp(nes_noise(t.size, 1), 6000) * np.exp(-t / (0.05 if open_ else 0.012)) * 0.5


def riser(dur, peak=0.3):
    n = int(dur * SR)
    out = np.zeros(n)
    hop = int(0.02 * SR)
    for k, i in enumerate(range(0, n, hop)):
        u = i / n
        out[i:i + hop] = nes_noise(min(hop, n - i), int(1 + 24 * (1 - u) ** 2), seed=50 + k)
    t = np.arange(n) / SR
    sweep = pulse(220 * 8 ** (t / dur), 0.5) * 0.35
    return (lp(out, 9000) * 0.6 + sweep) * (t / dur) ** 2 * peak


# ---- arrangement --------------------------------------------------------------------
def build(timeline, cues):
    dur = timeline["video_end"]
    n = int(dur * SR) + SR
    lead_b = np.zeros((n, 2))
    mus = np.zeros((n, 2))
    drums = np.zeros((n, 2))
    send = np.zeros((n, 2))

    starts = {s["name"]: s["start"] for s in timeline["scenes"]}
    hits = sorted(c["t"] for c in cues if c["type"] == "hit")
    h0, h1 = hits[0], hits[-1]
    snap = lambda t: h0 + round((t - h0) / BAR) * BAR
    lib, play, brk = snap(starts["library"]), snap(starts["play"]), snap(starts["selfhost"])
    bars = [h0 + i * BAR for i in range(int((h1 - h0) / BAR) + 1)]

    # the intro: an arpeggio on C that speeds up into the hit
    t, step = 0.25, 0.22
    k = 0
    while t < h0 - 0.05:
        m = [60, 64, 67, 72][k % 4] + (12 if t > h0 - 0.8 else 0)
        x = note(m, min(step, 0.12), 0.125, decay=0.06) * (0.15 + 0.35 * t / h0)
        add(mus, t, x, pan=0.3 if k % 2 else -0.3)
        add(send, t, x * 0.5)
        t += step
        step = max(0.06, step * 0.93)
        k += 1
    r = riser(h0 - 0.3, 0.35)
    add(mus, 0.3, r)

    for bi, b0 in enumerate(bars):
        if b0 >= h1 - 1e-6:
            break
        root, tones = CHORDS[bi % 4]
        full = lib <= b0 < brk
        lead_on = play <= b0 < brk
        breakdown = b0 >= brk
        # bass: driving eighths (half-time in the breakdown)
        if breakdown:
            for s in range(2):
                add(mus, b0 + s * 2 * BEAT, bass(root + 12, 2 * BEAT * 0.9) * 0.5)
        else:
            for s in range(8):
                m = root + (12 if s % 2 else 0)
                add(mus, b0 + s * BEAT / 2, bass(m, BEAT / 2 * 0.85) * 0.55)
        # arpeggio: 16ths up and down the chord, 12.5% duty
        pat = tones + [tones[0] + 12, tones[2], tones[1]]
        for s in range(16):
            m = pat[s % len(pat)] + 12
            x = note(m, BEAT / 4 * 0.9, 0.125, decay=0.05) * (0.11 if full or breakdown else 0.13)
            pan = 0.35 if s % 2 else -0.35
            add(mus, b0 + s * BEAT / 4, x, pan=pan)
            add(send, b0 + s * BEAT / 4, x * 0.35, pan=-pan)
        # drums
        for s in range(8):
            tt = b0 + s * BEAT / 2
            if not breakdown:
                add(drums, tt, hat(open_=(s == 7)) * (0.35 if s % 2 else 0.22), pan=0.25)
            if full:
                if s in (0, 4) or (s == 5 and bi % 2):
                    add(drums, tt, kick())
                if s in (2, 6):
                    add(drums, tt, snare() * 0.8, pan=-0.05)
                    add(send, tt, snare() * 0.2)
        # the lead
        if lead_on:
            phrase = LEAD[(bi - int(round((play - h0) / BAR))) % len(LEAD)]
            s = 0
            while s < 8:
                m = phrase[s]
                if m is None or m == "-":
                    s += 1
                    continue
                d = 1
                while s + d < 8 and phrase[s + d] == "-":
                    d += 1
                x = note(m, d * BEAT / 2 * 0.92, 0.25, vib=0.004 * (d > 1), decay=0.3) * 0.2
                add(lead_b, b0 + s * BEAT / 2, x, pan=0.05)
                # a dotted-eighth echo, the 8-bit way: a quieter copy on the other pulse
                add(send, b0 + s * BEAT / 2 + BEAT * 0.75, x * 0.35, pan=-0.4)
                s += d

    # into the end card: riser, then the hit and a ringing chord
    r = riser(2 * BAR, 0.4)
    add(mus, h1 - 2 * BAR, r)
    tail = dur - h1
    for m, pan in ((60, -0.3), (64, 0.3), (67, -0.15), (72, 0.15)):
        x = note(m + 12, tail - 0.3, 0.25, vib=0.003, decay=0.6) * 0.08
        x *= np.exp(-np.arange(x.size) / SR / 1.6)
        add(mus, h1, x, pan=pan)
        add(send, h1, x * 0.5, pan=pan)
    add(mus, h1, bass(36, 1.2) * 0.6 * np.exp(-np.arange(int(1.2 * SR)) / SR / 0.5))
    for k in range(12):
        tt = h1 + 0.3 + k * BEAT / 2
        x = note([72, 76, 79, 84][k % 4] + 12, 0.1, 0.125, decay=0.05) * 0.1 * np.exp(-k / 5)
        add(mus, tt, x, pan=0.4 if k % 2 else -0.4)
        add(send, tt, x * 0.6)

    ir = reverb_ir()
    wet = np.stack([signal.fftconvolve(send[:, c], ir[:, c])[:n] for c in range(2)], axis=1)
    out = lead_b + mus + drums * 0.8 + wet * 0.5
    out = out[: int(dur * SR)]
    t = np.arange(out.shape[0]) / SR
    out *= np.clip((dur - t) / 2.0, 0, 1)[:, None]
    out = lp(out.T, 12000).T                       # tame the top end a touch
    out = np.tanh(out * 1.3) / 1.3
    return out / max(1e-9, np.abs(out).max()) * 0.6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", default=os.path.join(HERE, "timeline.json"))
    ap.add_argument("--cues", default=os.path.join(HERE, "cues.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "music.wav"))
    args = ap.parse_args()
    data = build(json.load(open(args.timeline)), json.load(open(args.cues)))
    sf.write(args.out, data, SR, subtype="PCM_24")
    print(f"music: {args.out}  {data.shape[0] / SR:.1f}s")


if __name__ == "__main__":
    main()
