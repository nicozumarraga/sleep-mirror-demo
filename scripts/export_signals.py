#!/usr/bin/env python3
"""Export real BOAS signal excerpts for the viewer (keeps the repo small).

Full nights for display: EEG/EOG band-passed 0.3-22 Hz at 50 Hz, chin EMG high-passed 10 Hz at 100 Hz, respiratory at 10 Hz
(z-scored, a.u.). Each (epoch, channel) row is 8-bit mu-law encoded with its own scale (max |x| in uV). gzipped.
This is a *display* copy; use the original EDFs (scripts/boas_download.sh) for any analysis.

  data/dataset/sub-N/sub-N_signal.json    {"encoding":"mulaw8","mu":255,"n_epochs","channels":[{"name","fs","unit"}],"scale":[[per channel]...per epoch]}
  data/dataset/sub-N/sub-N_signal.bin.gz  epoch-major: for each epoch, for each channel, 30*fs int8 codes
  decode: x = sign(q) * ((1+mu)**(|q|/127) - 1) / mu * scale

Run:  .venv/bin/python scripts/export_signals.py
"""
import csv, gzip, json, math, sys
from pathlib import Path
import numpy as np
from scipy import signal as ss
sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_boas import load, DS, STUDY, EEG  # noqa: E402

FS = 100
CH = EEG + ["PSG_EOG", "PSG_EMG", "PSG_THER", "PSG_THOR", "PSG_ABD"]
RESP = {"PSG_THER", "PSG_THOR", "PSG_ABD"}


MU = 255.0


def mulaw(seg):
    """8-bit mu-law per (epoch, channel) row: returns int8 codes and per-row scale (max |x|)."""
    sc = np.maximum(np.abs(seg).max(1, keepdims=True), 1e-6)
    y = np.sign(seg) * np.log1p(MU * np.abs(seg) / sc) / np.log1p(MU)
    return np.clip(np.round(y * 127), -127, 127).astype("i1"), sc[:, 0]


def export(night):
    n = sum(1 for _ in open(DS / night / f"{night}_yasa.tsv")) - 1
    raw = load(night)
    X = raw.copy().resample(FS).get_data() * 1e6
    idx = {c: i for i, c in enumerate(raw.ch_names)}
    chans, codes, scales = [], [], []
    for c in CH:
        x = X[idx[c]]
        if c in RESP:
            b, a = ss.butter(2, 2, "lowpass", fs=FS); x = ss.filtfilt(b, a, x)[::10]
            x = (x - np.median(x)) / (np.std(x) + 1e-9) * 25; fs, unit = 10, "a.u."
        elif c == "PSG_EMG":  # standard PSG display filter: 10 Hz high-pass
            b, a = ss.butter(4, 10, "highpass", fs=FS); x = ss.filtfilt(b, a, x); fs, unit = FS, "uV"
        else:  # EEG/EOG: 0.3-22 Hz band-pass (removes DC offset / drift), then 50 Hz
            b, a = ss.butter(2, 0.3, "highpass", fs=FS); x = ss.filtfilt(b, a, x)
            b, a = ss.butter(6, 22, "lowpass", fs=FS); x = ss.filtfilt(b, a, x)[::2]; fs, unit = 50, "uV"
        L = 30 * fs
        x = np.pad(x[: n * L], (0, max(0, n * L - len(x))))
        q, sc = mulaw(x.reshape(n, L))
        chans.append({"name": c, "fs": fs, "unit": unit}); codes.append(q); scales.append(sc)
    out = bytearray()
    for e in range(n):
        for q in codes: out += q[e].tobytes()
    (DS / night / f"{night}_signal.bin.gz").write_bytes(gzip.compress(bytes(out), 9))
    S = np.stack(scales, 1)  # n x channels
    (DS / night / f"{night}_signal.json").write_text(json.dumps({"fs_display": FS, "encoding": "mulaw8", "mu": MU, "n_epochs": n,
        "channels": chans, "scale": np.round(S, 2).tolist()}))
    sz = (DS / night / f"{night}_signal.bin.gz").stat().st_size / 1e6
    print(f"{night}: {n} epochs, {sz:.1f} MB", flush=True)
    return sz


if __name__ == "__main__":
    nights = sys.argv[1:] or [m["night"] for m in json.load(open(DS / "nights.json"))]
    tot = sum(export(nt) for nt in nights)
    print(f"total {tot:.1f} MB")
