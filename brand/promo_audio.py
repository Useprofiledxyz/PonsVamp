"""Original soundtrack + SFX for the Pons Vamp promo (19 s), synthesized from scratch.

Synced to brand/promo.html: intro 0-3.2s, demo 3.2-9.0s, features 9.0-14.2s, CTA 14.2-19s.
Run:  python3 promo_audio.py out.wav
"""
import sys
import wave

import numpy as np

SR = 44100
DUR = 19.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)


def t_(d):
    return np.arange(int(SR * d)) / SR


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    R[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))


def env(n, a=0.005, r=0.2, total=None):
    """Attack / exponential release envelope of length n samples."""
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    return e * np.exp(-t / r)


def hz(note):
    return 440.0 * 2 ** ((note - 69) / 12)


def lowpass(x, cutoff):
    """One-pole low-pass (cutoff may be an array)."""
    a = np.exp(-2 * np.pi * np.asarray(cutoff) / SR) * np.ones_like(x)
    y = np.zeros_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a[i]) * x[i] + a[i] * acc
        y[i] = acc
    return y


# ── instruments ─────────────────────────────────────────────────────────────
def kick(d=0.45):
    t = t_(d)
    f = 45 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 7) + 0.25 * np.tanh(4 * np.sin(ph)) * np.exp(-t * 30)


def clap(d=0.25):
    t = t_(d)
    n = rng.standard_normal(len(t))
    e = np.exp(-t * 22) + 0.6 * np.exp(-np.maximum(t - 0.012, 0) * 30) * (t > 0.012)
    return np.diff(np.concatenate([[0], n]), 1) * e * 0.6


def hat(d=0.06, open_=False):
    t = t_(0.22 if open_ else d)
    n = rng.standard_normal(len(t))
    hp = np.diff(np.concatenate([[0], n]))
    return hp * np.exp(-t * (14 if open_ else 70)) * 0.35


def sub(note, d):
    t = t_(d)
    s = np.sin(2 * np.pi * hz(note) * t) + 0.3 * np.tanh(3 * np.sin(2 * np.pi * hz(note) * t))
    e = np.minimum(1, t / 0.01) * np.minimum(1, (d - t) / 0.05)
    return s * e


def saw(f, t):
    return 2 * ((f * t) % 1) - 1


def pad(notes, d):
    t = t_(d)
    s = sum(saw(hz(n) * (1 + dt), t) for n in notes for dt in (-0.004, 0.004))
    s = lowpass(s, 900 + 500 * np.sin(2 * np.pi * 0.25 * t) ** 2)
    e = np.minimum(1, t / 0.6) * np.minimum(1, (d - t) / 0.6)
    return s * e / (len(notes) * 2)


def pluck(note, d=0.35):
    t = t_(d)
    s = saw(hz(note), t) * 0.6 + np.sin(2 * np.pi * hz(note) * t)
    s = lowpass(s, 600 + 5000 * np.exp(-t * 12))
    return s * env(len(t), 0.002, 0.12)


def bell(note, d=1.2):
    t = t_(d)
    f = hz(note)
    s = np.sin(2 * np.pi * f * t + 1.5 * np.sin(2 * np.pi * f * 3.5 * t) * np.exp(-t * 4))
    return s * env(len(t), 0.002, 0.35)


def boom(d=2.0):
    t = t_(d)
    f = 30 + 80 * np.exp(-t * 6)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.6)
    n = lowpass(rng.standard_normal(len(t)), 400) * np.exp(-t * 5) * 0.8
    return s + n


def whoosh(d=1.0, rise=True):
    t = t_(d)
    x = t / d if rise else 1 - t / d
    n = rng.standard_normal(len(t))
    s = lowpass(n, 300 + 7000 * x ** 2)
    e = np.sin(np.pi * np.minimum(1, t / d)) ** 2 if not rise else x ** 2 * np.minimum(1, (d - t) / 0.03)
    return s * e


def click():
    t = t_(0.03)
    n = rng.standard_normal(len(t))
    return np.diff(np.concatenate([[0], n])) * np.exp(-t * 300) * 0.5 + np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 400) * 0.3


def pop(note=84):
    t = t_(0.18)
    f = hz(note) * (1 + 0.6 * np.exp(-t * 40))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(len(t), 0.001, 0.05)


# ── arrangement ─────────────────────────────────────────────────────────────
BEAT = 0.5           # 120 BPM
GRID0 = 3.2          # the beat drops with scene 2
PROG = [(57, [57, 60, 64]), (53, [53, 57, 60]), (48, [55, 60, 64]), (55, [55, 59, 62])]  # Am F C G

# Intro: dark Am pad, logo boom, shimmering bells, riser into the drop.
add(pad([45, 57, 60, 64], 3.6), 0.0, 0.55)
add(boom(2.2), 0.12, 0.9)
for i, nt in enumerate([81, 84, 88, 93, 88, 84]):
    add(bell(nt, 0.9), 0.75 + i * 0.25, 0.10, pan=-0.4 + 0.16 * i)
add(whoosh(1.1, rise=True), 2.1, 0.35)

# Groove from 3.2s to 17.2s (7 bars of 2s).
bars = 7
for b in range(bars):
    t0 = GRID0 + b * 2.0
    root, chord = PROG[b % 4]
    add(sub(root - 24, 1.9), t0, 0.55)
    add(pad([n for n in chord], 2.0), t0, 0.32)
    for k in range(4):
        tb = t0 + k * BEAT
        if k in (0, 2) or (b % 2 == 1 and k == 3):
            add(kick(), tb + (0.25 if (b % 2 == 1 and k == 3) else 0), 0.95)
        if k in (1, 3):
            add(clap(), tb, 0.45)
        for h in range(2 if b < 3 else 4):
            step = BEAT / (2 if b < 3 else 4)
            add(hat(open_=(h == 1 and b < 3 and k == 3)), tb + h * step, 0.5 if h % 2 == 0 else 0.3, pan=0.3)
    # plucky arpeggio from bar 3 (features section) onward
    if b >= 2:
        arp = chord + [chord[0] + 12, chord[1] + 12]
        for j in range(8):
            add(pluck(arp[(j * 2) % len(arp)] + 12, 0.3), t0 + j * 0.25, 0.16, pan=0.5 if j % 2 else -0.5)

# Outro: final chord rings out after the groove stops.
add(pad([45, 57, 60, 64, 69], 2.4), 16.6, 0.5)
add(bell(81, 2.0), 17.2, 0.18)
add(bell(88, 2.0), 17.25, 0.12, pan=0.3)
add(boom(1.8), 17.2, 0.5)

# ── SFX synced to the visuals ───────────────────────────────────────────────
for i in range(14):                      # typing the CA (4.2-5.4s)
    add(click(), 4.2 + i * 0.085 + rng.uniform(0, 0.02), 0.35, pan=rng.uniform(-0.3, 0.3))
add(pop(79), 5.6, 0.35)                  # token card lands
add(kick(0.3), 6.85, 0.6)                # Enter press
add(click(), 6.85, 0.6)
add(bell(88, 1.0), 7.2, 0.28)            # launched chime
add(bell(93, 1.0), 7.32, 0.22, pan=0.2)
for c in (9.0, 14.2):                    # scene transitions
    add(whoosh(0.7, rise=False), c - 0.2, 0.45)
add(boom(1.6), 14.2, 0.7)                # CTA impact
for i, at in enumerate((9.5, 9.75, 10.0)):
    add(pop(76 + i * 4), at, 0.3, pan=-0.4 + 0.4 * i)
add(pop(88), 15.4, 0.4)                  # URL pops in

# ── master ──────────────────────────────────────────────────────────────────
mix = np.stack([L, R], axis=1)
mix = np.tanh(mix * 1.6) / np.tanh(1.6)            # gentle saturation / glue
fade_in = np.minimum(1, np.arange(N) / (SR * 0.05))
fade_out = np.minimum(1, (N - np.arange(N)) / (SR * 1.2))
mix *= (fade_in * fade_out)[:, None]
mix /= np.max(np.abs(mix)) + 1e-9
mix *= 0.89                                         # ~-1 dBFS peak

out = sys.argv[1] if len(sys.argv) > 1 else "promo_audio.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype(np.int16).tobytes())
print("wrote", out)
