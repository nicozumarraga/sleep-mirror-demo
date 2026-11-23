#!/usr/bin/env python3
"""Consistency invariants for data/study (stdlib only). Exit code 1 on any failure."""
import csv, json, math, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent / "data"
DS, ST = ROOT / "dataset", ROOT / "study"
errs = []
def err(m):
    if len(errs) < 60:
        errs.append(m)
    else:
        errs.append(None)

TOOLS = {"goto_epoch", "pan", "zoom", "toggle_channel", "set_scale", "apply_filter", "measure", "show_hypnogram", "show_spectrogram",
         "set_label", "mark_event", "add_comment", "undo", "next_flagged"}
LABS = {"W", "N1", "N2", "N3", "R", "DISC"}

def kappa(a, b):
    n = len(a); po = sum(x == y for x, y in zip(a, b)) / n
    pe = sum((a.count(l) / n) * (b.count(l) / n) for l in set(a) | set(b))
    return (po - pe) / (1 - pe)

def main():
    idx = json.load(open(ST / "index.json"))
    assign = json.load(open(ST / "assignment.json"))
    exp = {(a, n) for a, ns in assign["assignment"].items() for n in ns}
    if {(j["annotator"], j["night"]) for j in idx} != exp or len(idx) != len(exp):
        err("index.json jobs != assignment")
    json.load(open(ST / "annotators.json"))
    cache = {}
    tot = dict(sess=0, ev=0, labels=0, flagged_unscored=0)
    for j in idx:
        a, n = j["annotator"], j["night"]
        if n not in cache:
            yr = list(csv.DictReader(open(DS / n / f"{n}_yasa.tsv"), delimiter="\t"))
            fr = list(csv.DictReader(open(DS / n / f"{n}_epoch_features.tsv"), delimiter="\t"))
            cache[n] = (yr, fr)
        yr, fr = cache[n]
        N = len(yr)
        state = {e: [yr[e]["yasa_stage"], "yasa", 0] for e in range(N)}
        hist = {}       # call_id -> (epoch, snapshot)
        calls = {}
        prev_end_reason = None
        for k, rel in enumerate(j["sessions"]):
            tag = f"{a}/{n}/s{k+1}"
            ev = [json.loads(l) for l in open(ST / rel)]
            tot["sess"] += 1; tot["ev"] += len(ev)
            if not ev or ev[0]["type"] != "session_start" or ev[-1]["type"] != "session_end":
                err(f"{tag}: bad start/end"); continue
            if ev[0]["session"] != k + 1 or ev[0]["annotator"] != a or ev[0]["night"] != n:
                err(f"{tag}: session_start fields")
            if k and prev_end_reason not in ("paused", "timeout"):
                err(f"{tag}: resumed after reason {prev_end_reason}")
            if k == len(j["sessions"]) - 1 and ev[-1]["reason"] != "done":
                err(f"{tag}: last session not done")
            prev_end_reason = ev[-1]["reason"]
            if ev[-1]["t"] > 7200 + 30:
                err(f"{tag}: session > 2h ({ev[-1]['t']})")
            last_t, last_seq = -1, -1
            ends = {"transcript": 0.0, "ui": 0.0, "pause": 0.0}
            pend = {}
            segs = set()
            for d in ev:
                if d["seq"] != last_seq + 1:
                    err(f"{tag}: seq jump at {d['seq']}")
                last_seq = d["seq"]
                if d["t"] < last_t - 1e-9:
                    err(f"{tag}: t decreasing at seq {d['seq']}")
                last_t = d["t"]
                typ = d["type"]
                if typ == "transcript":
                    if d["t_start"] < ends["transcript"] - 1e-6:
                        err(f"{tag}: transcript overlap {d['seg_id']}")
                    ends["transcript"] = d["t_end"]
                    dur = d["t_end"] - d["t_start"]
                    if dur > 15.01 or dur < 1.0:
                        err(f"{tag}: segment duration {dur:.1f} {d['seg_id']}")
                    if abs(d["t"] - d["t_start"]) > 1e-6 or d["seg_id"] in segs:
                        err(f"{tag}: seg t/id")
                    segs.add(d["seg_id"])
                    ws = d["words"]
                    if not ws or ws[0]["s"] != d["t_start"] or ws[-1]["e"] > d["t_end"] + 1e-6:
                        err(f"{tag}: words bounds {d['seg_id']}")
                    pe = -1
                    for w in ws:
                        if w["s"] < pe - 1e-6 or w["e"] < w["s"] or not (0 < w["p"] <= 1):
                            err(f"{tag}: word timing {d['seg_id']}"); break
                        pe = w["e"]
                    for r in d["redactions"]:
                        if not d["text"][r["span"][0]:r["span"][1]].startswith("["):
                            err(f"{tag}: redaction span")
                elif typ == "ui":
                    if d["t"] < ends["ui"] - 0.02:
                        err(f"{tag}: ui overlap at {d['t']}")
                    ends["ui"] = d["t"] + d.get("duration_s", 0)
                    if d["kind"] not in ("dwell", "hover_channel", "scroll", "mouse_path"):
                        err(f"{tag}: ui kind")
                elif typ == "pause":
                    if d["t"] < ends["ui"] - 1e-6 or d["t"] < ends["transcript"] - 0.5 and False:
                        err(f"{tag}: pause overlaps ui")
                    ends["ui"] = max(ends["ui"], d["t"] + d["duration_s"])
                elif typ == "tool_call":
                    if d["tool"] not in TOOLS:
                        err(f"{tag}: unknown tool {d['tool']}")
                    pend[d["call_id"]] = d
                elif typ == "tool_result":
                    c = pend.pop(d["call_id"], None)
                    if c is None or d["t"] < c["t"]:
                        err(f"{tag}: orphan result {d['call_id']}"); continue
                    t, args, res = c["tool"], c["args"], d["result"]
                    if t == "set_label":
                        e = args["epoch"]; st = state[e]
                        if args["stage"] not in LABS:
                            err(f"{tag}: bad stage")
                        if res["prev_stage"] != st[0] or res["source_prev"] != st[1]:
                            err(f"{tag}: set_label prev mismatch ep {e}: {res} vs {st}")
                        hist[d["call_id"]] = (e, tuple(st))
                        if args["stage"] != st[0]:
                            st[2] += 1
                        st[0], st[1] = args["stage"], "human"
                    elif t == "undo":
                        cid = res["undone_call_id"]
                        if cid not in hist:
                            err(f"{tag}: undo target missing")
                        else:
                            e, snap = hist.pop(cid)
                            if state[e][:2] != [snap[0], snap[1]] and False:
                                pass
                            state[e] = list(snap)
                    elif t == "measure":
                        if not (res["peak_to_peak_uv"] > 0 and res["duration_s"] > 0 and res["dominant_hz"] > 0):
                            err(f"{tag}: measure values")
                        if args["t1_s"] <= args["t0_s"]:
                            err(f"{tag}: measure interval")
                    elif t == "next_flagged":
                        e = res["epoch"]
                        if yr[e]["flagged"] != "1":
                            err(f"{tag}: next_flagged returned unflagged epoch")
                    for e_ in [args.get("epoch")]:
                        if e_ is not None and not (0 <= e_ < N):
                            err(f"{tag}: epoch out of range")
                elif typ == "session_end":
                    nl = sum(1 for s in state.values() if s[1] == "human")
                    if d["n_labels"] != nl:
                        err(f"{tag}: session_end n_labels {d['n_labels']} != {nl}")
            if pend:
                err(f"{tag}: unanswered calls")
        # annotation TSV
        rows = list(csv.DictReader(open(ST / "annotations" / f"{a}_{n}.tsv"), delimiter="\t"))
        if len(rows) != N:
            err(f"{a}/{n}: annotation rows"); continue
        fin, tru, flg = [], [], []
        for e, r in enumerate(rows):
            st = state[e]
            if r["final_stage"] != st[0] or r["source"] != st[1] or int(r["n_label_changes"]) != st[2]:
                err(f"{a}/{n}: tsv/replay mismatch ep {e}: {r['final_stage']},{r['source']},{r['n_label_changes']} vs {st}")
            if r["yasa_stage"] != yr[e]["yasa_stage"] or r["flagged"] != yr[e]["flagged"] or int(r["epoch"]) != e:
                err(f"{a}/{n}: tsv yasa cols ep {e}")
            if r["flagged"] == "1" and r["source"] != "human":
                tot["flagged_unscored"] += 1
                err(f"{a}/{n}: flagged epoch {e} never scored")
            if r["final_stage"] == "DISC" and fr[e]["stage_true"] != "DISC":
                err(f"{a}/{n}: DISC on non-disconnect epoch {e}")
            fin.append(r["final_stage"]); tru.append(fr[e]["stage_true"]); flg.append(r["flagged"] == "1")
        ok = [i for i in range(N) if tru[i] != "DISC"]
        okf = [i for i in ok if flg[i]]
        kp = kappa([fin[i] for i in ok], [tru[i] for i in ok])
        af = sum(fin[i] == tru[i] for i in okf) / len(okf)
        aa = sum(fin[i] == tru[i] for i in ok) / len(ok)
        for key, v in (("kappa_vs_consensus", kp), ("acc_flagged", af), ("acc_all", aa)):
            if abs(j[key] - v) > 1e-3:
                err(f"{a}/{n}: index {key} {j[key]} != {v:.4f}")
        if j["n_labels"] != sum(r["source"] == "human" for r in rows) or j["n_flagged"] != sum(flg):
            err(f"{a}/{n}: index counts")
        tot["labels"] += j["n_labels"]
    real = [e for e in errs if e]
    print(f"checked {len(idx)} jobs, {tot['sess']} sessions, {tot['ev']} events, {tot['labels']} human labels")
    if real:
        print(f"FAIL: {len(errs)} problems")
        for e in real[:40]:
            print(" -", e)
        sys.exit(1)
    print("OK: all invariants hold")

main()
