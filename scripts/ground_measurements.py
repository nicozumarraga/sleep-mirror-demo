#!/usr/bin/env python3
"""Replace simulated `measure` tool results in the session logs with values computed from the real BOAS signal.

For every measure {channel, t0_s, t1_s} call: peak_to_peak_uv, duration_s and dominant_hz are computed on the
display-filtered signal (EEG/EOG 0.3-35 Hz, EMG >10 Hz) at 100 Hz. Run after gen_trajectories.py:
  .venv/bin/python scripts/ground_measurements.py
"""
import json, sys
from pathlib import Path
import numpy as np
from scipy import signal as ss
sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_boas import load, DS, STUDY  # noqa: E402

FS = 100


def main():
    nights = [m["night"] for m in json.load(open(DS / "nights.json"))]
    tot = 0
    for night in nights:
        files = sorted((STUDY / "sessions").glob(f"*/{night}/session-*.jsonl"))
        if not files: continue
        raw = load(night).resample(FS)
        X = raw.get_data() * 1e6
        idx = {c: i for i, c in enumerate(raw.ch_names)}
        filt = {}
        for c, i in idx.items():
            if c == "PSG_EMG": b, a = ss.butter(4, 10, "highpass", fs=FS)
            else: b, a = ss.butter(2, [0.3, 35], "bandpass", fs=FS)
            filt[c] = ss.filtfilt(b, a, X[i])
        for f in files:
            ev = [json.loads(l) for l in open(f)]
            calls = {e["call_id"]: e for e in ev if e.get("type") == "tool_call" and e.get("tool") == "measure"}
            for e in ev:
                if e.get("type") != "tool_result" or e.get("call_id") not in calls: continue
                a = calls[e["call_id"]]["args"]; ch = a.get("channel")
                if ch not in filt: continue
                i0, i1 = int(a["t0_s"] * FS), max(int(a["t1_s"] * FS), int(a["t0_s"] * FS) + 2)
                seg = filt[ch][i0:i1]
                if len(seg) < 2: continue
                n = max(256, len(seg))
                sp = np.abs(np.fft.rfft((seg - seg.mean()) * np.hanning(len(seg)), n))
                fr = np.fft.rfftfreq(n, 1 / FS); band = fr >= 0.3
                e["result"] = {"peak_to_peak_uv": round(float(np.ptp(seg)), 1), "duration_s": round((i1 - i0) / FS, 2),
                               "dominant_hz": round(float(fr[band][sp[band].argmax()]), 1)}
                tot += 1
            f.write_text("".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n" for e in ev))
        print(f"{night}: grounded measurements in {len(files)} session files", flush=True)
    print("total measure results grounded:", tot)


if __name__ == "__main__":
    main()
