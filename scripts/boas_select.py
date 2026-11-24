#!/usr/bin/env python3
"""Pick 20 BOAS PSG nights (unique participants, full EEG/EOG/EMG + respiratory channels). Writes raw/boas/selection.json."""
import csv, json, random, sys
from pathlib import Path
RAW = Path(__file__).resolve().parent.parent / "raw" / "boas"
parts = {r["participant_id"]: r for r in csv.DictReader(open(RAW / "participants.tsv"), delimiter="\t")}
ok = []
for line in open(RAW / "channels_all.tsv"):
    s, chs = line.rstrip("\n").split("\t"); chs = set(chs.strip(",").split(","))
    need = {"PSG_F3", "PSG_F4", "PSG_C3", "PSG_C4", "PSG_O1", "PSG_O2", "PSG_EMG", "PSG_THER", "PSG_THOR", "PSG_ABD"}
    if need <= chs and ("PSG_EOG" in chs or {"PSG_EOGL", "PSG_EOGR"} <= chs):
        ok.append(f"sub-{s}")
rng = random.Random(42); rng.shuffle(ok)
seen, pick = set(), []
for s in ok:
    pid = parts[s]["pid"]
    if pid in seen: continue
    seen.add(pid); pick.append(s)
    if len(pick) == 20: break
pick.sort(key=lambda s: int(s[4:]))
json.dump({"nights": pick, "shared": pick[:3] if False else [pick[i] for i in (2, 9, 16)]}, open(RAW / "selection.json", "w"), indent=1)
print(len(ok), "eligible ->", pick)
