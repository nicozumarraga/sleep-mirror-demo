#!/usr/bin/env python3
"""Generate synthetic BOAS-like nights: consensus hypnogram, per-epoch signal descriptors,
BOAS stage_ai, and YASA pre-scoring with confidence + flags. Stdlib only. See SPEC.md."""
import json, math, random, os
from pathlib import Path

SEED = 42
ROOT = Path(__file__).resolve().parent.parent / "data"
DS = ROOT / "dataset"
STUDY = ROOT / "study"
STAGES = ["W", "N1", "N2", "N3", "R"]
CODE = {"W": 0, "N1": 1, "N2": 2, "N3": 3, "R": 4, "DISC": 8}
FLAG_THRESHOLD = 0.60
FS = 256
CHANNELS = ["PSG_F3", "PSG_F4", "PSG_C3", "PSG_C4", "PSG_O1", "PSG_O2",
            "PSG_EOG", "PSG_EMG", "PSG_THER", "PSG_THOR", "PSG_ABD"]

# BOAS has sub-1..sub-128; pick 20 for the study.
NIGHT_IDS = [3, 7, 12, 18, 21, 26, 33, 38, 41, 47, 52, 58, 64, 69, 75, 81, 88, 94, 103, 117]
SHARED = ["sub-7", "sub-41", "sub-88"]
ANNOTATORS = ["ann-01", "ann-02", "ann-03", "ann-04", "ann-05"]


def hypnogram(rng, apnea):
    n = rng.randint(840, 1010)
    seq = []
    lat = rng.randint(8, 40)                    # sleep-onset latency (epochs)
    seq += ["W"] * lat
    seq += ["N1"] * rng.randint(2, 8)
    cyc = 0
    while len(seq) < n:
        frac = len(seq) / n
        clen = rng.randint(160, 210)
        n3 = max(0, int(clen * (0.32 - 0.35 * frac) + rng.gauss(0, 6)))
        rem = int(clen * (0.08 + 0.30 * frac) + rng.gauss(0, 5))
        if cyc == 0:
            rem = max(3, rem // 2)
        n2a = rng.randint(15, 35)
        n2b = max(10, clen - n3 - rem - n2a)
        block = ["N2"] * n2a + ["N3"] * n3 + ["N2"] * n2b + ["R"] * max(rem, 0)
        seq += block
        # end-of-cycle awakening / N1 transition
        if rng.random() < 0.6:
            seq += ["W"] * rng.randint(1, 6) + ["N1"] * rng.randint(1, 4)
        else:
            seq += ["N1"] * rng.randint(1, 3)
        cyc += 1
    seq = seq[:n]
    # sprinkle fragmentation: brief W/N1 intrusions (more with apnea)
    k = int(n * (0.03 if not apnea else 0.08))
    for _ in range(k):
        i = rng.randint(lat + 20, n - 3)
        if seq[i] in ("N2", "R", "N3"):
            seq[i] = rng.choice(["N1", "W", "N1"])
    # end with wake
    seq[-rng.randint(3, 12):] = ["W"] * len(seq[-rng.randint(3, 12):])
    # optional bathroom break → disconnection (human scored 8)
    if rng.random() < 0.35:
        i = rng.randint(n // 3, 2 * n // 3)
        L = rng.randint(6, 20)
        for j in range(i, min(n, i + L)):
            seq[j] = "DISC"
        for j in range(i - 2, i):
            seq[j] = "W"
        for j in range(i + L, min(n, i + L + 3)):
            seq[j] = "W"
    return seq


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def features(rng, seq, apnea):
    n = len(seq)
    rows = []
    # artifact episodes
    art = ["none"] * n
    art_ch = [""] * n
    for _ in range(rng.randint(2, 7) + (3 if apnea else 0)):
        i = rng.randint(0, n - 1)
        kind = rng.choices(["movement", "electrode_pop", "sweat", "ecg"], [5, 3, 2, 1])[0]
        L = {"movement": rng.randint(1, 3), "electrode_pop": rng.randint(1, 6),
             "sweat": rng.randint(4, 20), "ecg": rng.randint(10, 40)}[kind]
        chs = {"movement": ["PSG_F3", "PSG_F4", "PSG_C3", "PSG_C4", "PSG_O1", "PSG_O2", "PSG_EOG", "PSG_EMG"],
               "electrode_pop": [rng.choice(CHANNELS[:6])],
               "sweat": rng.sample(CHANNELS[:6], 2),
               "ecg": rng.sample(CHANNELS[:6], 2)}[kind]
        for j in range(i, min(n, i + L)):
            if seq[j] != "DISC":
                art[j] = kind
                art_ch[j] = ",".join(chs)
    for i, s in enumerate(seq):
        trans = any(seq[j] != s for j in range(max(0, i - 2), min(n, i + 3)))
        g = lambda m, sd: max(0.0, rng.gauss(m, sd))
        if s == "DISC":
            rows.append(dict(rel_delta=0, rel_theta=0, rel_alpha=0, rel_sigma=0, rel_beta=0, slow_wave_pct=0,
                             spindles=0, k_complexes=0, vertex_waves=0, sawtooth=0, rem_count=0, sem=0,
                             emg_rms=0, arousal=0, arousal_onset_s="", artifact="disconnect",
                             artifact_channels=",".join(CHANNELS), difficulty=0.05))
            continue
        bp = {"W":  [0.15, 0.15, 0.40, 0.08, 0.22],
              "N1": [0.25, 0.38, 0.12, 0.07, 0.18],
              "N2": [0.42, 0.25, 0.08, 0.15, 0.10],
              "N3": [0.70, 0.15, 0.04, 0.06, 0.05],
              "R":  [0.28, 0.40, 0.10, 0.06, 0.16]}[s]
        bp = [max(0.01, b + rng.gauss(0, 0.04)) for b in bp]
        tot = sum(bp)
        bp = [round(b / tot, 3) for b in bp]
        r = dict(rel_delta=bp[0], rel_theta=bp[1], rel_alpha=bp[2], rel_sigma=bp[3], rel_beta=bp[4])
        r["slow_wave_pct"] = round(clamp({"N3": g(35, 12), "N2": g(8, 6), "N1": g(1, 1.5)}.get(s, 0.0), 0, 90), 1)
        r["spindles"] = int(g(2.5, 1.5)) if s == "N2" else (int(g(0.8, 0.8)) if s == "N3" else (1 if s == "N1" and rng.random() < 0.08 else 0))
        r["k_complexes"] = int(g(1.2, 1.0)) if s == "N2" else (1 if s == "N1" and rng.random() < 0.1 else 0)
        r["vertex_waves"] = int(g(1.5, 1.2)) if s == "N1" else 0
        r["sawtooth"] = 1 if s == "R" and rng.random() < 0.35 else 0
        r["rem_count"] = int(g(4, 3)) if s == "R" else (int(g(2, 2)) if s == "W" and rng.random() < 0.5 else 0)
        r["sem"] = 1 if (s == "N1" and rng.random() < 0.6) or (s == "W" and rng.random() < 0.15) else 0
        r["emg_rms"] = round({"W": g(22, 7), "N1": g(12, 4), "N2": g(9, 3), "N3": g(8, 3), "R": g(3.5, 1.2)}[s], 1)
        ar_p = {"W": 0, "N1": 0.10, "N2": 0.06, "N3": 0.02, "R": 0.05}[s] * (2.2 if apnea else 1.0)
        r["arousal"] = 1 if rng.random() < ar_p else 0
        r["arousal_onset_s"] = round(rng.uniform(2, 25), 1) if r["arousal"] else ""
        r["artifact"] = art[i]
        r["artifact_channels"] = art_ch[i]
        d = 0.08 + (0.35 if trans else 0) + (0.25 if s == "N1" else 0) + (0.3 if art[i] != "none" else 0) \
            + (0.15 if r["arousal"] else 0) + (0.12 if s == "N3" and r["slow_wave_pct"] < 25 else 0) \
            + (0.1 if s == "N2" and r["spindles"] == 0 and r["k_complexes"] == 0 else 0) + rng.gauss(0, 0.06)
        r["difficulty"] = round(clamp(d, 0.0, 1.0), 3)
        rows.append(r)
    return rows


CONFUSE = {"W": {"N1": 0.7, "R": 0.2, "N2": 0.1}, "N1": {"W": 0.45, "N2": 0.3, "R": 0.25},
           "N2": {"N1": 0.35, "N3": 0.45, "R": 0.2}, "N3": {"N2": 0.95, "N1": 0.05},
           "R": {"N1": 0.6, "W": 0.25, "N2": 0.15}}


def yasa_probs(rng, true, diff):
    if true == "DISC":  # YASA still scores disconnected segments (garbage in): spread probs
        p = [rng.random() + 0.2 for _ in STAGES]
        p[0] += 1.0
    else:
        conf = clamp(0.96 - 0.9 * diff + rng.gauss(0, 0.09), 0.25, 0.995)
        p = [0.0] * 5
        p[STAGES.index(true)] = conf
        rest = 1 - conf
        alts = CONFUSE[true]
        # with difficulty, YASA sometimes prefers the confusable neighbour
        main_alt = rng.choices(list(alts), list(alts.values()))[0]
        share = rng.uniform(0.55, 0.95) if diff > 0.45 else rng.uniform(0.4, 0.8)
        p[STAGES.index(main_alt)] += rest * share
        for k in range(5):
            p[k] += rest * (1 - share) / 5
        if (diff > 0.35 and rng.random() < 0.5) or rng.random() < 0.05:  # swap: YASA wrong (incl. confident errors)
            a, b = STAGES.index(true), STAGES.index(main_alt)
            p[a], p[b] = p[b], p[a]
    tot = sum(p)
    return [round(x / tot, 3) for x in p]


def main():
    rng = random.Random(SEED)
    DS.mkdir(parents=True, exist_ok=True)
    STUDY.mkdir(parents=True, exist_ok=True)
    parts = ["participant_id\tage\tsex\tbmi\tpid\tahi_group"]
    nights = []
    for k, nid in enumerate(NIGHT_IDS):
        sub = f"sub-{nid}"
        apnea = rng.random() < 0.3
        age = rng.randint(22, 71)
        parts.append(f"{sub}\t{age}\t{rng.choice('MF')}\t{round(rng.uniform(19, 34), 1)}\t{rng.randint(1, 100)}\t{'apnea' if apnea else 'healthy'}")
        seq = hypnogram(rng, apnea)
        feats = features(rng, seq, apnea)
        d = DS / sub
        d.mkdir(exist_ok=True)
        # BOAS-format events
        ev = ["onset\tduration\tbegsample\tendsample\toffset\tstage_hum\tstage_ai"]
        ai_match = 0
        for i, s in enumerate(seq):
            if s == "DISC":
                ai = -2
            elif rng.random() < 0.87 - 0.3 * feats[i]["difficulty"] + 0.1:
                ai = CODE[s]
            else:
                ai = CODE[rng.choices(list(CONFUSE[s]), list(CONFUSE[s].values()))[0]]
            ai_match += ai == CODE[s]
            ev.append(f"{i*30}\t30\t{i*30*FS+1}\t{(i+1)*30*FS}\t0\t{CODE[s]}\t{ai}")
        (d / f"{sub}_task-Sleep_acq-psg_events.tsv").write_text("\n".join(ev) + "\n")
        cols = ["rel_delta", "rel_theta", "rel_alpha", "rel_sigma", "rel_beta", "slow_wave_pct", "spindles",
                "k_complexes", "vertex_waves", "sawtooth", "rem_count", "sem", "emg_rms", "arousal",
                "arousal_onset_s", "artifact", "artifact_channels", "difficulty"]
        lines = ["epoch\tonset_s\tstage_true\t" + "\t".join(cols)]
        for i, (s, f) in enumerate(zip(seq, feats)):
            lines.append(f"{i}\t{i*30}\t{s}\t" + "\t".join(str(f[c]) for c in cols))
        (d / f"{sub}_epoch_features.tsv").write_text("\n".join(lines) + "\n")
        ylines = ["epoch\tyasa_stage\tp_W\tp_N1\tp_N2\tp_N3\tp_R\tconfidence\tflagged"]
        nflag = ncorrect = 0
        for i, (s, f) in enumerate(zip(seq, feats)):
            p = yasa_probs(rng, s, f["difficulty"])
            top = max(range(5), key=lambda j: p[j])
            conf = p[top]
            flag = int(conf < FLAG_THRESHOLD or f["artifact"] in ("movement", "disconnect"))
            nflag += flag
            ncorrect += STAGES[top] == s
            ylines.append(f"{i}\t{STAGES[top]}\t" + "\t".join(str(x) for x in p) + f"\t{conf}\t{flag}")
        (d / f"{sub}_yasa.tsv").write_text("\n".join(ylines) + "\n")
        nights.append(dict(night=sub, n_epochs=len(seq), hours=round(len(seq) / 120, 2),
                           lights_off=f"{rng.randint(22, 23)}:{rng.randint(0, 59):02d}",
                           ahi_group="apnea" if apnea else "healthy",
                           role="shared" if sub in SHARED else "unique",
                           n_flagged=nflag, yasa_acc=round(ncorrect / len(seq), 3),
                           stage_ai_acc=round(ai_match / len(seq), 3)))
        print(f"{sub}: {len(seq)} epochs, flagged {nflag} ({nflag/len(seq):.1%}), yasa acc {ncorrect/len(seq):.3f}")
    (DS / "participants.tsv").write_text("\n".join(parts) + "\n")
    (DS / "nights.json").write_text(json.dumps(nights, indent=1))
    unique = [n["night"] for n in nights if n["role"] == "unique"]
    rng.shuffle(unique)
    split = [4, 4, 3, 3, 3]
    assign, k = {}, 0
    for a, m in zip(ANNOTATORS, split):
        assign[a] = SHARED + sorted(unique[k:k + m], key=lambda s: int(s[4:]))
        k += m
    (STUDY / "assignment.json").write_text(json.dumps(
        {"shared_nights": SHARED, "flag_threshold": FLAG_THRESHOLD, "assignment": assign}, indent=1))


if __name__ == "__main__":
    main()
