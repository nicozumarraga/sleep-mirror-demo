#!/usr/bin/env python3
"""Build data/dataset/ from the real BOAS nights in raw/boas/ (see boas_select.py, boas_download.sh).

Per night it writes:
  sub-N_task-Sleep_acq-psg_events.tsv   real BOAS events (stage_hum consensus, stage_ai)
  sub-N_yasa.tsv                        real YASA SleepStaging probabilities, confidence, flag (conf < 0.60)
  sub-N_epoch_features.tsv              per-epoch descriptors computed from the real signal (see SPEC.md)
  sub-N_detections.json                 YASA spindle / slow-wave / REM detections (for the viewer)
plus participants.tsv, nights.json and data/study/assignment.json.

Feature notes: spindles, slow waves and REMs use YASA detectors; band powers use Welch on PSG_C4;
k_complexes, vertex_waves, sawtooth, sem, arousal and artifact are simple signal heuristics (documented
inline) — they are descriptors for the simulation, not validated clinical scoring.
Run with the project venv:  .venv/bin/python scripts/prepare_boas.py [sub-7 ...]
"""
import csv, json, sys, warnings
from pathlib import Path
import numpy as np
import mne, yasa
from scipy import signal as ss

warnings.filterwarnings("ignore")
mne.set_log_level("ERROR")
ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "boas"
DS = ROOT / "data" / "dataset"
STUDY = ROOT / "data" / "study"
STAGES = ["W", "N1", "N2", "N3", "R"]
CODE2 = {0: "W", 1: "N1", 2: "N2", 3: "N3", 4: "R", 8: "DISC"}
EEG = ["PSG_F3", "PSG_F4", "PSG_C3", "PSG_C4", "PSG_O1", "PSG_O2"]
FLAG_THRESHOLD = 0.60
FS = 100
EP = 30 * FS
ANNOTATORS = ["ann-01", "ann-02", "ann-03", "ann-04", "ann-05"]


def load(night):
    raw = mne.io.read_raw_edf(RAW / night / f"{night}_task-Sleep_acq-psg_eeg.edf", preload=True)
    chs = raw.ch_names
    if "PSG_EOG" not in chs:  # two mastoid-referenced EOGs -> one bipolar derivation (AASM-style E1-E2)
        eog = raw.get_data(picks=["PSG_EOGL"]) - raw.get_data(picks=["PSG_EOGR"])
        info = mne.create_info(["PSG_EOG"], raw.info["sfreq"], ["eog"])
        raw.add_channels([mne.io.RawArray(eog, info)], force_update_info=True)
    keep = EEG + ["PSG_EOG", "PSG_EMG", "PSG_THER", "PSG_THOR", "PSG_ABD"]
    raw.pick(keep)
    return raw


def welch_rel(x):
    f, p = ss.welch(x, FS, nperseg=4 * FS)
    tot = p[(f >= 0.5) & (f < 30)].sum() + 1e-12
    band = lambda a, b: p[(f >= a) & (f < b)].sum() / tot
    return [band(0.5, 4), band(4, 8), band(8, 12), band(12, 16), band(16, 30)]


def per_epoch_counts(starts, n):
    c = np.zeros(n, int)
    for s in starts:
        e = int(s // 30)
        if 0 <= e < n: c[e] += 1
    return c


def process(night, parts):
    raw = load(night)
    ev = list(csv.DictReader(open(RAW / night / f"{night}_task-Sleep_acq-psg_events.tsv"), delimiter="\t"))
    p = parts[night]
    # ---- YASA staging on the native-rate recording
    num = lambda v: float(v) if v not in ("", "n/a", None) else None
    md = dict(age=num(p["age"]), male=p["sex"] == "M") if num(p["age"]) is not None and p["sex"] in ("M", "F") else None
    sls = yasa.SleepStaging(raw, eeg_name="PSG_C4", eog_name="PSG_EOG", emg_name="PSG_EMG", metadata=md)
    hyp = sls.predict()
    pr = hyp.proba
    pr = pr.rename(columns={c: {"WAKE": "W", "REM": "R"}.get(str(c).upper(), str(c).upper()) for c in pr.columns})
    proba = pr[["W", "N1", "N2", "N3", "R"]].to_numpy()
    n = min(len(ev), len(proba))
    ev, proba = ev[:n], proba[:n]
    cons = [CODE2.get(int(float(r["stage_hum"])), "DISC") for r in ev]
    # ---- 100 Hz µV copy for features / export
    r100 = raw.copy().resample(FS)
    X = r100.get_data() * 1e6
    X = X[:, : n * EP]
    if X.shape[1] < n * EP:
        X = np.pad(X, ((0, 0), (0, n * EP - X.shape[1])))
    ch = {c: i for i, c in enumerate(r100.ch_names)}
    c4, c3, eog, emg = X[ch["PSG_C4"]], X[ch["PSG_C3"]], X[ch["PSG_EOG"]], X[ch["PSG_EMG"]]
    # ---- detectors (signal only, no hypnogram -> no label leakage)
    sp = yasa.spindles_detect(np.vstack([c3, c4]), FS, ch_names=["PSG_C3", "PSG_C4"])
    sp_df = sp.summary() if sp is not None else None
    sw = yasa.sw_detect(np.vstack([c3, c4]), FS, ch_names=["PSG_C3", "PSG_C4"])
    sw_df = sw.summary() if sw is not None else None
    rem = yasa.rem_detect(eog, -eog, FS)  # bipolar EOG: LOC=EOG, ROC=-EOG
    rem_df = rem.summary() if rem is not None else None
    sp_c4 = sp_df[sp_df.Channel == "PSG_C4"] if sp_df is not None else None
    spindles = per_epoch_counts(sp_c4.Start.values if sp_c4 is not None else [], n)
    sw_c4 = sw_df[sw_df.Channel == "PSG_C4"] if sw_df is not None else None
    swpct = np.zeros(n)
    swcount = np.zeros(n, int)
    if sw_c4 is not None:
        for s, d in zip(sw_c4.Start.values, sw_c4.Duration.values):
            e = int(s // 30)
            if 0 <= e < n: swpct[e] += d; swcount[e] += 1
    swpct = np.clip(swpct / 30 * 100, 0, 100)
    rems = per_epoch_counts(rem_df.Peak.values if rem_df is not None else [], n)
    # ---- per-epoch descriptors
    b_emg, a_emg = ss.butter(4, 10, "highpass", fs=FS)
    emg_hp = ss.filtfilt(b_emg, a_emg, emg)
    b_lo, a_lo = ss.butter(2, [0.2, 0.6], "bandpass", fs=FS)
    eog_lo = ss.filtfilt(b_lo, a_lo, eog)
    b_th, a_th = ss.butter(3, [2, 6], "bandpass", fs=FS)
    c4_th = ss.filtfilt(b_th, a_th, c4)
    b_ab, a_ab = ss.butter(3, [8, 30], "bandpass", fs=FS)
    hf = ss.filtfilt(b_ab, a_ab, c4) ** 2
    hf1 = hf[: n * EP].reshape(-1, FS).mean(1)  # 1-s high-frequency power
    emg_rms = np.sqrt((emg_hp[: n * EP].reshape(n, EP) ** 2).mean(1))
    emg_med = np.median(emg_rms[[c != "DISC" for c in cons]]) if n else 1.0
    rows = []
    for e in range(n):
        sl = slice(e * EP, (e + 1) * EP)
        rel = welch_rel(c4[sl])
        # vertex-wave heuristic: sharp (<0.5 s) 2–6 Hz deflections >= 60 µV on C4, in epochs without slow-wave activity
        vx = 0
        if swpct[e] < 5:
            pk, pr = ss.find_peaks(-c4_th[sl], height=40, width=(3, 25))
            vx = int(min(4, len(pk)))
        # K-complex candidates: isolated detected slow waves (1–2 per epoch, <20% slow-wave time)
        kc = int(swcount[e]) if 1 <= swcount[e] <= 2 and swpct[e] < 20 else 0
        sem = int(rems[e] == 0 and np.ptp(eog_lo[sl]) > 60)
        saw = int(rel[1] > 0.35 and emg_rms[e] < 0.6 * emg_med and rems[e] > 0)
        # arousal heuristic: >=3 s of 8–30 Hz power >= 3x the preceding 10 s median, preceded by low-HF (sleep-like) EEG
        ar, ar_on = 0, ""
        for k in range(e * 30 + 10, (e + 1) * 30 - 3):
            if k + 3 > len(hf1): break
            base = np.median(hf1[k - 10:k]) + 1e-9
            if hf1[k:k + 3].min() > 3 * base and base < np.percentile(hf1, 40):
                ar, ar_on = 1, round(k - e * 30, 1); break
        # artifact heuristics
        ptp = {c: float(np.ptp(X[ch[c], sl])) for c in EEG}
        std = {c: float(X[ch[c], sl].std()) for c in EEG}
        art, achs = "none", []
        if cons[e] == "DISC" or max(std.values()) < 0.5:
            art, achs = "disconnect", EEG + ["PSG_EOG", "PSG_EMG"]
        else:
            big = [c for c in EEG if ptp[c] > 400]
            if len(big) >= 3 or emg_rms[e] > 6 * emg_med:
                art, achs = "movement", big or ["PSG_EMG"]
            else:
                jumps = [c for c in EEG if np.abs(np.diff(X[ch[c], sl])).max() > 150]
                if len(jumps) == 1:
                    art, achs = "electrode_pop", jumps
                else:
                    sweaty = [c for c in EEG if ptp[c] > 300 and welch_rel(X[ch[c], sl])[0] > 0.93 and swpct[e] < 2]
                    if len(sweaty) == 1:
                        art, achs = "sweat", sweaty
        rows.append(dict(epoch=e, onset_s=e * 30, stage_true=cons[e],
                         rel_delta=round(rel[0], 3), rel_theta=round(rel[1], 3), rel_alpha=round(rel[2], 3),
                         rel_sigma=round(rel[3], 3), rel_beta=round(rel[4], 3), slow_wave_pct=round(float(swpct[e]), 1),
                         spindles=int(spindles[e]), k_complexes=kc, vertex_waves=vx, sawtooth=saw,
                         rem_count=int(rems[e]), sem=sem, emg_rms=round(float(emg_rms[e]), 1), arousal=ar,
                         arousal_onset_s=ar_on, artifact=art, artifact_channels=",".join(achs)))
    # ---- YASA table + difficulty (latent used only by the simulator)
    conf = proba.max(1)
    ytop = [STAGES[i] for i in proba.argmax(1)]
    flagged = [int(conf[e] < FLAG_THRESHOLD) for e in range(n)]  # protocol: YASA confidence below threshold
    for e, r in enumerate(rows):
        tr = any(cons[j] != cons[e] for j in range(max(0, e - 1), min(n, e + 2)))
        d = 0.65 * (1 - conf[e]) + 0.2 * tr + 0.2 * (r["artifact"] != "none") + 0.08 * r["arousal"] + 0.12 * (cons[e] == "N1")
        r["difficulty"] = round(float(np.clip(d, 0, 1)), 3)
    d = DS / night
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{night}_task-Sleep_acq-psg_events.tsv").write_text(
        (RAW / night / f"{night}_task-Sleep_acq-psg_events.tsv").read_text().splitlines()[0] + "\n" +
        "\n".join((RAW / night / f"{night}_task-Sleep_acq-psg_events.tsv").read_text().splitlines()[1:n + 1]) + "\n")
    cols = list(rows[0].keys())
    with open(d / f"{night}_epoch_features.tsv", "w") as f:
        f.write("\t".join(cols) + "\n")
        for r in rows: f.write("\t".join(str(r[c]) for c in cols) + "\n")
    with open(d / f"{night}_yasa.tsv", "w") as f:
        f.write("epoch\tyasa_stage\tp_W\tp_N1\tp_N2\tp_N3\tp_R\tconfidence\tflagged\n")
        for e in range(n):
            f.write(f"{e}\t{ytop[e]}\t" + "\t".join(f"{x:.3f}" for x in proba[e]) + f"\t{conf[e]:.3f}\t{flagged[e]}\n")
    det = {"spindles": [[round(float(s), 2), round(float(du), 2), c] for s, du, c in zip(sp_df.Start, sp_df.Duration, sp_df.Channel)] if sp_df is not None else [],
           "slow_waves": [[round(float(s), 2), round(float(du), 2), c] for s, du, c in zip(sw_df.Start, sw_df.Duration, sw_df.Channel)] if sw_df is not None else [],
           "rems": [round(float(x), 2) for x in rem_df.Peak] if rem_df is not None else []}
    (d / f"{night}_detections.json").write_text(json.dumps(det))
    valid = [e for e in range(n) if cons[e] != "DISC"]
    meas = raw.info.get("meas_date")
    lo = meas.strftime("%H:%M") if meas is not None and meas.year > 1990 else ""
    meta = dict(night=night, n_epochs=n, hours=round(n / 120, 2), lights_off=lo, age=int(num(p["age"])) if num(p["age"]) is not None else None, sex=p["sex"] if p["sex"] != "n/a" else None,
                bmi=p["bmi"], n_flagged=int(sum(flagged)), yasa_acc=round(float(np.mean([ytop[e] == cons[e] for e in valid])), 3),
                stage_ai_acc=round(float(np.mean([CODE2.get(int(float(ev[e]["stage_ai"])), "X") == cons[e] for e in valid])), 3),
                eog_source="PSG_EOG" if "PSG_EOG" in mne.io.read_raw_edf(RAW / night / f"{night}_task-Sleep_acq-psg_eeg.edf").ch_names else "PSG_EOGL-PSG_EOGR")
    print(f"{night}: {n} ep, flagged {meta['n_flagged']} ({meta['n_flagged']/n:.1%}), YASA acc {meta['yasa_acc']}, "
          f"spindles {int(spindles.sum())}, REMs {int(rems.sum())}, arousals {sum(r['arousal'] for r in rows)}, "
          f"artifacts {sum(r['artifact'] != 'none' for r in rows)}, emg median {emg_med:.1f} µV", flush=True)
    return meta


def main():
    sel = json.load(open(RAW / "selection.json"))
    parts = {r["participant_id"]: r for r in csv.DictReader(open(RAW / "participants.tsv"), delimiter="\t")}
    todo = sys.argv[1:] or sel["nights"]
    DS.mkdir(parents=True, exist_ok=True)
    metas = {}
    if (DS / "nights.json").exists():
        try: metas = {m["night"]: m for m in json.load(open(DS / "nights.json")) if m["night"] in sel["nights"] and "eog_source" in m}
        except Exception: metas = {}
    for night in todo:
        metas[night] = process(night, parts)
    for m in metas.values():
        m["role"] = "shared" if m["night"] in sel["shared"] else "unique"
    nights = [metas[s] for s in sel["nights"] if s in metas]
    (DS / "nights.json").write_text(json.dumps(nights, indent=1))
    with open(DS / "participants.tsv", "w") as f:
        f.write("participant_id\tage\tsex\tbmi\tpid\n")
        for s in sel["nights"]:
            r = parts[s]; f.write(f"{s}\t{r['age']}\t{r['sex']}\t{r['bmi']}\t{r['pid']}\n")
    # assignment: 3 shared nights for everyone, 17 unique split 4/4/3/3/3
    import random
    uniq = [s for s in sel["nights"] if s not in sel["shared"]]
    random.Random(42).shuffle(uniq)
    assign, k = {}, 0
    for a, m in zip(ANNOTATORS, [4, 4, 3, 3, 3]):
        assign[a] = sel["shared"] + sorted(uniq[k:k + m], key=lambda s: int(s[4:])); k += m
    STUDY.mkdir(parents=True, exist_ok=True)
    (STUDY / "assignment.json").write_text(json.dumps({"shared_nights": sel["shared"], "flag_threshold": FLAG_THRESHOLD,
                                                       "assignment": assign}, indent=1))


if __name__ == "__main__":
    main()
