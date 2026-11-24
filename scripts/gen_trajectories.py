#!/usr/bin/env python3
"""Simulate Stage-2 think-aloud annotation sessions. Stdlib only, seeded (SEED=42). See SPEC.md.
Outputs: data/study/{annotators.json,sessions/,annotations/,index.json}. Idempotent (cleans old sessions)."""
import csv, json, math, random, re, shutil, sys, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
SEED = 42
ROOT = Path(__file__).resolve().parent.parent / "data"
DS, STUDY = ROOT / "dataset", ROOT / "study"
CH = ["PSG_F3", "PSG_F4", "PSG_C3", "PSG_C4", "PSG_O1", "PSG_O2", "PSG_EOG", "PSG_EMG", "PSG_THER", "PSG_THOR", "PSG_ABD"]
DEFAULT_VIS = ["PSG_F3", "PSG_C3", "PSG_C4", "PSG_O2", "PSG_EOG", "PSG_EMG"]
STAGES = ["W", "N1", "N2", "N3", "R"]
UI_VERSION = "vacp-ui 0.9.3"
ASR_MODEL = "whisper-large-v3"

# ---------------------------------------------------------------- personas
def persona(**kw):
    return kw

PERSONAS = [
 persona(id="ann-01", role="somnologist", years_exp=12, native_language="Italian", site="[SITE_A]",
  verbosity=0.85, filler_rate=0.07, speed_s_per_epoch=[15, 32], base_accuracy=0.865, yasa_anchoring=0.22,
  favorite_tools=["zoom", "measure", "next_flagged"], biases={"N2->N3": 0.04, "N1->W": 0.05},
  style_notes="Senior Italian somnologist. Verbose, explains AASM rules aloud, measures amplitudes, zooms to 10 s often. Code-switches to Italian fillers.",
  style_tags=["verbose", "nonnative_it"], lang="it", quiet_base=0.05, zoom_rate=0.5, measure_rate=0.4, toggle_rate=0.25, spec_rate=0.1,
  filter_rate=0.08, scale_rate=0.12, nf_rate=0.45, catch_rate=0.45, false_visit=0.004, selfcorr=0.08, undo_rate=0.03,
  comment_rate=0.10, arousal_overcall=0.0, mark_rate=0.3, disc_label=0.85, run_rate=0.3, context_rate=0.4, revisit_rate=0.10,
  skip_rate=0.03, break_rate=0.05, fatigue_slope=0.5, pii_rate=0.015, mouse_rate=0.15, max_obs=2),
 persona(id="ann-02", role="sleep technologist", years_exp=8, native_language="German", site="[SITE_B]",
  verbosity=0.22, filler_rate=0.02, speed_s_per_epoch=[8, 20], base_accuracy=0.90, yasa_anchoring=0.42,
  favorite_tools=["next_flagged", "set_label"], biases={"N1->N2": 0.05},
  style_notes="Terse, fast German sleep technologist. Trusts YASA heavily, rarely zooms or measures, often silent on easy epochs, handles runs in bulk.",
  style_tags=["terse", "nonnative_de"], lang="de", quiet_base=0.42, zoom_rate=0.1, measure_rate=0.07, toggle_rate=0.05, spec_rate=0.0,
  filter_rate=0.0, scale_rate=0.03, nf_rate=0.92, catch_rate=0.13, false_visit=0.002, selfcorr=0.03, undo_rate=0.02,
  comment_rate=0.04, arousal_overcall=0.0, mark_rate=0.03, disc_label=0.6, run_rate=0.6, context_rate=0.08, revisit_rate=0.03,
  skip_rate=0.01, break_rate=0.03, fatigue_slope=0.8, pii_rate=0.003, mouse_rate=0.05, max_obs=1),
 persona(id="ann-03", role="sleep researcher", years_exp=6, native_language="English", site="[SITE_C]",
  verbosity=0.6, filler_rate=0.04, speed_s_per_epoch=[17, 34], base_accuracy=0.835, yasa_anchoring=0.12,
  favorite_tools=["toggle_channel", "show_spectrogram", "zoom"], biases={},
  style_notes="Careful postdoc researcher. Toggles channels, uses spectrogram and filters, revisits earlier epochs, reasons explicitly about AASM rules.",
  style_tags=["any", "verbose"], lang="en", quiet_base=0.08, zoom_rate=0.55, measure_rate=0.45, toggle_rate=0.7, spec_rate=0.55,
  filter_rate=0.25, scale_rate=0.3, nf_rate=0.4, catch_rate=0.5, false_visit=0.005, selfcorr=0.06, undo_rate=0.04,
  comment_rate=0.12, arousal_overcall=0.0, mark_rate=0.35, disc_label=0.9, run_rate=0.15, context_rate=0.5, revisit_rate=0.15,
  skip_rate=0.04, break_rate=0.05, fatigue_slope=0.4, pii_rate=0.01, mouse_rate=0.25, max_obs=2),
 persona(id="ann-04", role="junior scorer", years_exp=2, native_language="Portuguese", site="[SITE_A]",
  verbosity=0.5, filler_rate=0.09, speed_s_per_epoch=[14, 34], base_accuracy=0.79, yasa_anchoring=0.35,
  favorite_tools=["zoom", "goto_epoch"], biases={"N1->W": 0.12, "W->N1": 0.10, "N2->N1": 0.05},
  style_notes="About two years of scoring. Frequent N1/W confusion, many self-corrections and undos, hedges a lot, leans on YASA when unsure.",
  style_tags=["any"], lang="en", quiet_base=0.18, zoom_rate=0.3, measure_rate=0.22, toggle_rate=0.2, spec_rate=0.12,
  filter_rate=0.04, scale_rate=0.1, nf_rate=0.6, catch_rate=0.2, false_visit=0.012, selfcorr=0.20, undo_rate=0.10,
  comment_rate=0.06, arousal_overcall=0.0, mark_rate=0.08, disc_label=0.7, run_rate=0.25, context_rate=0.25, revisit_rate=0.12,
  skip_rate=0.06, break_rate=0.07, fatigue_slope=0.7, pii_rate=0.005, mouse_rate=0.2, max_obs=2),
 persona(id="ann-05", role="clinician", years_exp=20, native_language="English", site="[SITE_D]",
  verbosity=0.55, filler_rate=0.04, speed_s_per_epoch=[12, 30], base_accuracy=0.85, yasa_anchoring=0.33,
  favorite_tools=["mark_event", "add_comment"], biases={"N2->N1": 0.04},
  style_notes="Clinician with 20 years experience. Over-calls arousals, marks events and writes many comments aimed at the report; sometimes labels disconnections W with a comment.",
  style_tags=["any"], lang="en", quiet_base=0.14, zoom_rate=0.2, measure_rate=0.15, toggle_rate=0.25, spec_rate=0.05,
  filter_rate=0.05, scale_rate=0.1, nf_rate=0.5, catch_rate=0.35, false_visit=0.006, selfcorr=0.07, undo_rate=0.04,
  comment_rate=0.38, arousal_overcall=0.30, mark_rate=0.8, disc_label=0.45, run_rate=0.3, context_rate=0.3, revisit_rate=0.06,
  skip_rate=0.03, break_rate=0.05, fatigue_slope=0.5, pii_rate=0.01, mouse_rate=0.15, max_obs=2),
]

NEIGH = {"W": {"N1": .7, "R": .2, "N2": .1}, "N1": {"W": .4, "N2": .4, "R": .2},
         "N2": {"N1": .4, "N3": .35, "R": .15, "W": .1}, "N3": {"N2": .9, "N1": .1},
         "R": {"N1": .35, "W": .3, "N2": .35}}

def clamp(x, a, b):
    return max(a, min(b, x))

# ---------------------------------------------------------------- phrasebank
def load_phrasebank():
    real = STUDY / "phrasebank.json"
    if real.exists():
        return json.load(open(real)), "real"
    from _pb_stub import STUB
    json.dump(STUB, open(STUDY / "phrasebank.stub.json", "w"), indent=1, ensure_ascii=False)
    return STUB, "stub"

SPOKEN = {"W": ["wake", "wake", "W"], "N1": ["N one", "N1", "stage one"], "N2": ["N two", "N2", "stage two"],
          "N3": ["N three", "N3", "slow wave sleep"], "R": ["REM", "REM", "R"], "DISC": ["disconnection"]}
NORM_N = {"n one": "n1", "n two": "n2", "n three": "n3"}
HALL_LANG = {"it": lambda h: "Sottotitoli" in h, "de": lambda h: "Untertitel" in h}

def hms(secs):
    return secs

# ---------------------------------------------------------------- data loading
def load_night(night):
    d = DS / night
    feats = []
    for r in csv.DictReader(open(d / f"{night}_epoch_features.tsv"), delimiter="\t"):
        for k in ("epoch", "spindles", "k_complexes", "vertex_waves", "sawtooth", "rem_count", "sem", "arousal"):
            r[k] = int(r[k])
        for k in ("onset_s", "slow_wave_pct", "emg_rms", "difficulty", "rel_alpha", "rel_theta", "rel_delta", "rel_sigma", "rel_beta"):
            r[k] = float(r[k])
        r["arousal_onset_s"] = float(r["arousal_onset_s"]) if r["arousal_onset_s"] != "" else None
        r["artifact_channels"] = [c for c in r["artifact_channels"].split(",") if c]
        feats.append(r)
    # EMG thresholds relative to the night (real chin-EMG amplitude varies a lot between recordings)
    em = sorted(r["emg_rms"] for r in feats if r["emg_rms"] > 0) or [1.0]
    q25, q80 = em[int(.25 * (len(em) - 1))], em[int(.80 * (len(em) - 1))]
    for r in feats:
        r["emg_low"] = 0 < r["emg_rms"] <= q25
        r["emg_high"] = r["emg_rms"] >= q80
        r["emg_q25"], r["emg_q80"] = q25, q80
    yas = []
    for r in csv.DictReader(open(d / f"{night}_yasa.tsv"), delimiter="\t"):
        r["epoch"] = int(r["epoch"]); r["confidence"] = float(r["confidence"]); r["flagged"] = int(r["flagged"])
        yas.append(r)
    return feats, yas

def kappa(a, b):
    n = len(a)
    if not n:
        return float("nan")
    po = sum(x == y for x, y in zip(a, b)) / n
    labs = set(a) | set(b)
    pe = sum((a.count(l) / n) * (b.count(l) / n) for l in labs)
    return (po - pe) / (1 - pe) if pe < 1 else 1.0

# ---------------------------------------------------------------- measurement model
MEAS = {  # kind: (p2p range, dur range, hz range, default channel)
 "spindle": ((22, 55), (.5, 1.6), (11.5, 14.5)), "kcomplex": ((110, 230), (.5, 1.2), (.7, 1.6)),
 "slow": ((80, 190), (.6, 2.0), (.5, 1.8)), "rem": ((70, 180), (.15, .6), (1.5, 4.0)),
 "sem": ((40, 120), (.8, 2.5), (.2, .6)), "alpha": ((20, 55), (2, 5), (8.5, 11.5)),
 "theta": ((15, 40), (2, 5), (4, 7)), "vertex": ((80, 170), (.15, .35), (3, 6)),
 "sawtooth": ((30, 60), (1.5, 4), (2, 3)), "emg": (None, (2, 5), (20, 60)),
 "arousal": ((20, 50), (3, 8), (10, 20)), "movement": ((300, 900), (1, 6), (1, 8)),
 "electrode_pop": ((500, 2000), (.1, .5), (5, 30)), "sweat": ((150, 400), (3, 10), (.1, .5)),
 "ecg": ((40, 120), (.6, 1.2), (1.0, 1.5)), "background": ((15, 40), (1, 4), (3, 8)),
}
CAT_CHANS = {"obs_spindle": ["PSG_C3", "PSG_C4"], "obs_kcomplex": ["PSG_F3", "PSG_F4", "PSG_C4"], "obs_slow_waves": ["PSG_F3", "PSG_F4"],
             "obs_alpha": ["PSG_O1", "PSG_O2"], "obs_theta_low_amp": ["PSG_C3", "PSG_C4"], "obs_vertex": ["PSG_C3", "PSG_C4"],
             "obs_sawtooth": ["PSG_C3", "PSG_C4"], "obs_rem": ["PSG_EOG"], "obs_sem": ["PSG_EOG"], "obs_emg_low": ["PSG_EMG"],
             "obs_emg_high": ["PSG_EMG"], "obs_arousal": ["PSG_C3", "PSG_C4", "PSG_O2"]}
STAGE_CH = {"N2": ["PSG_C3", "PSG_C4", "PSG_F3"], "N3": ["PSG_F3", "PSG_F4", "PSG_C3"], "R": ["PSG_EOG", "PSG_EMG", "PSG_C4"],
            "W": ["PSG_O1", "PSG_O2", "PSG_EMG", "PSG_EOG"], "N1": ["PSG_O1", "PSG_O2", "PSG_C3", "PSG_EOG"], "DISC": ["PSG_C3", "PSG_EMG"]}
ART_CAT = {"movement": "obs_artifact_movement", "electrode_pop": "obs_artifact_electrode", "sweat": "obs_artifact_sweat", "ecg": "obs_artifact_ecg"}
STRONG = ("N2", "N3", "R", "W", "N1")

# ---------------------------------------------------------------- the simulator
class Job:
    def __init__(self, P, pidx, night, meta, feats, yas, PB, assign_role):
        self.P, self.pidx, self.night, self.meta, self.feats, self.yas, self.PB = P, pidx, night, meta, feats, yas, PB
        self.role = assign_role
        self.rng = random.Random(f"{SEED}:{P['id']}:{night}")
        self.n = len(feats)
        self.lab = {}            # epoch -> dict(stage, src, ch, hist)
        self.visited = []
        self.cur = 0
        self.vis = list(DEFAULT_VIS)
        self.win = 30
        self.scale = 50
        self.spec = False
        self.hyp = False
        self.sessions = []       # list of dict(path, events, reason)
        self.callno = 0
        self.stats = dict(utt=0, tools=0, halluc=0)
        self.tot_time = 0.0
        self.last_break_t = 0.0
        self.cum_work = 0.0
        self.sidx = 0
        self.date0 = datetime.datetime(2026, 12, 7 + 2 * pidx, 8 + self.rng.randint(0, 8), self.rng.randint(0, 59))
        self.flagged = [y["flagged"] == 1 for y in yas]
        self.fillers = list(PB["fillers"].get("en", []))
        if P["lang"] in PB["fillers"]:
            self.fillers = self.fillers + PB["fillers"][P["lang"]] * 2 if P["lang"] != "en" else self.fillers
        self.nonnative = P["lang"] != "en" or P["id"] == "ann-04"

    # ---- state helpers
    def L(self, e):
        if e not in self.lab:
            self.lab[e] = dict(stage=self.yas[e]["yasa_stage"], src="yasa", ch=0, hist=[])
        return self.lab[e]

    def fat(self):
        f = (0.12 * self.sidx + 0.5 * min(1.0, self.cum_work / 5400.0)) * self.P["fatigue_slope"] * 1.6
        return clamp(f, 0, 1)

    def vp(self):
        return {"start_epoch": self.cur, "window_s": self.win, "channels": list(self.vis), "scale_uv": self.scale}

    # ---- event emission
    def ev(self, t, typ, **kw):
        self.cnt += 1
        self.events.append((round(t, 2), self.cnt, typ, kw))

    def start_session(self):
        self.events, self.cnt = [], 0
        self.t = 0.0
        self.sp_end = 0.0
        self.ui_cursor = 0.0
        self.buf = []
        self.seg_n = 0
        day = self.date0 + datetime.timedelta(days=self.sidx * self.rng.choice([0, 1, 1, 2]) + (0 if self.sidx == 0 else 0),
                                              minutes=self.rng.randint(-30, 120) if self.sidx else 0)
        self.sess_wall0 = day if self.sidx == 0 else max(day, self.prev_wall_end + datetime.timedelta(minutes=self.rng.randint(25, 300)))
        self.ev(0.0, "session_start", annotator=self.P["id"], night=self.night, session=self.sidx + 1, ui_version=UI_VERSION,
                asr_model=ASR_MODEL, viewport=self.vp())
        self.t = self.rng.uniform(1.0, 3.0)
        self.sess_start_work = self.cum_work

    # ---- speech machinery
    def pick(self, cat, filt=None):
        P = self.P
        tags = set(P["style_tags"])
        for src in (self.PB["categories"],):
            tl = src.get(cat) or []
            for pool_try in (0, 1):
                cands = []
                for tp in tl:
                    st = set(tp.get("styles", ["any"]))
                    ok = ("any" in st) or (st & tags) if pool_try == 0 else True
                    if not ok:
                        continue
                    if filt and not filt(tp["text"]):
                        continue
                    w = tp.get("weight", 1.0)
                    spec = st & tags - {"any"}
                    if spec:
                        w *= 3.0 if "terse" in spec else (2.2 if "verbose" in spec else 1.6)
                    nw = len(tp["text"].split())
                    if nw > 20:
                        w *= 0.8 if "verbose" in tags else 0.3
                    if "terse" in tags and nw <= 4:
                        w *= 2.5
                    if "terse" not in tags and nw <= 2:
                        w *= 0.6
                    if cat in ("obs_slow_waves",) and False:
                        pass
                    cands.append((w, tp["text"]))
                if cands:
                    tot = sum(c[0] for c in cands)
                    r = self.rng.uniform(0, tot)
                    for w, tx in cands:
                        r -= w
                        if r <= 0:
                            return tx
                    return cands[-1][1]
        return None

    def spoken(self, st):
        return self.rng.choice(SPOKEN[st])

    def fill(self, text, sl):
        def rep(m):
            k = m.group(1)
            v = sl.get(k)
            return str(v) if v is not None else ""
        return re.sub(r"\{(\w+)\}", rep, text)

    def say(self, cat, sl=None, filt=None, text=None):
        """Speak a template of `cat`. Returns the rendered text or None."""
        raw = text or self.pick(cat, filt)
        if raw is None:
            return None
        sl = dict(sl or {})
        e = sl.get("_e", self.cur)
        conf = sl.get("conf", 0.5)
        sl.setdefault("epoch", e)
        # percent-vs-count handling
        m = re.search(r"\{conf\}\s*(%|percent)?", raw)
        sl["conf"] = int(round(conf * 100)) if (m and m.group(1)) or "{conf}" in raw else sl.get("conf")
        if "conf" in sl and m and not m.group(1) and self.rng.random() < 0.5:
            sl["conf"] = f"{conf:.2f}"
        for k in ("stage", "alt", "yasa"):
            if k in sl and sl[k] in SPOKEN:
                sl[k] = self.spoken(sl[k])
        text = self.fill(raw, sl)
        text = re.sub(r"\s+([,.!?])", r"\1", text).strip()
        self.utter(text)
        return text

    def asr(self, toks):
        conf = self.PB.get("asr_confusions", {})
        out, i = [], 0
        while i < len(toks):
            hit = False
            for ln in (2, 1):
                if i + ln > len(toks):
                    continue
                raw = " ".join(toks[i:i + ln])
                key = re.sub(r"[^\w\s\-\[\]]", "", raw.lower()).strip()
                key = NORM_N.get(key, key)
                if key in conf and (ln == 1 or True):
                    if key in NORM_N.values() and raw.lower().startswith("n") and " " in raw:
                        pass
                    if self.rng.random() < 0.08:
                        rep = self.rng.choice(conf[key])
                        tail = re.sub(r"^.*?(\W*)$", r"\1", raw) if raw[-1] in ".,;:!?" else ""
                        out.append((rep + tail, True))
                    else:
                        out.extend((t, False) for t in toks[i:i + ln])
                    i += ln
                    hit = True
                    break
            if not hit:
                out.append((toks[i], False))
                i += 1
        return out

    def make_words(self, text, start):
        P, rng = self.P, self.rng
        toks = self.asr(text.split())
        fr = P["filler_rate"] * (1 + 0.4 * self.fat())
        seq = []
        for tok, conf in toks:
            if rng.random() < fr and self.fillers:
                for ft in rng.choice(self.fillers).split():
                    seq.append((ft.lower() + ("," if rng.random() < .4 else ""), "f"))
            if rng.random() < 0.008:
                seq.append((tok, False))
            seq.append((tok, "a" if conf else False))
        words, cur = [], start
        rate = rng.uniform(0.85, 1.2) * (1 + 0.15 * self.fat())
        pbase = 0.93 - (0.04 if self.nonnative else 0)
        for tok, flag in seq:
            w = tok if re.match(r"^\W*\[", tok) else tok.lower()
            core = len(re.sub(r"\W", "", w))
            d = (0.16 + 0.04 * core) / rate * rng.uniform(0.8, 1.25)
            if flag == "f":
                p = clamp(rng.gauss(0.8, 0.1), 0.4, 0.99)
            elif flag == "a":
                p = rng.uniform(0.25, 0.7)
            else:
                p = clamp(rng.betavariate(18, 1.6) - (0.03 if self.nonnative else 0), 0.3, 0.999)
            words.append({"w": w, "s": round(cur, 2), "e": round(cur + d, 2), "p": round(p, 2)})
            gap = rng.uniform(0.0, 0.18) + (0.35 if w.endswith((",", ".", "?", "!")) else 0) * rng.random()
            cur += d + gap
        return words

    def utter(self, text):
        rng = self.rng
        start = max(self.t, self.sp_end + rng.uniform(0.2, 0.6) if self.sp_end else self.t)
        words = self.make_words(text, start)
        if not words:
            return
        end = words[-1]["e"]
        if self.buf:
            bd = self.buf[-1]["e"] - self.buf[0]["s"]
            gap = start - self.buf[-1]["e"]
            if gap > 3.5 or (bd >= 2.0 and gap > 0.9) or (end - self.buf[0]["s"]) > 14:
                self.flush(next_start=start)
        self.buf.extend(words)
        self.sp_end = end
        self.t = start + (end - start) * 0.85
        self.stats["utt"] += 1

    def flush(self, next_start=None):
        if not self.buf:
            return
        words, self.buf = self.buf, []
        pieces, cur = [], []
        for w in words:
            cur.append(w)
            dur = cur[-1]["e"] - cur[0]["s"]
            if (dur > 8 and cur[-1]["w"].endswith((".", ",", "?", "!"))) or dur > 12.5:
                pieces.append(cur); cur = []
        if cur:
            if pieces and cur[-1]["e"] - cur[0]["s"] < 1.5:
                pieces[-1].extend(cur)
            else:
                pieces.append(cur)
        for pi, pc in enumerate(pieces):
            text = " ".join(w["w"] for w in pc)
            # Whisper segment ends include trailing silence: pad short final segments to ~2 s when there is room
            t_end = pc[-1]["e"]
            if pi == len(pieces) - 1 and t_end - pc[0]["s"] < 2.0:
                room = (next_start - 0.1 - t_end) if next_start is not None else 2.0
                t_end = round(t_end + max(0.0, min(2.0 - (t_end - pc[0]["s"]) + self.rng.uniform(0, .3), room)), 2)
            reds = [{"span": [m.start(), m.end()], "kind": m.group(1)} for m in re.finditer(r"\[(NAME|INSTITUTION)\]", text)]
            lp = sum(math.log(w["p"]) for w in pc) / len(pc)
            self.seg_n += 1
            self.ev(pc[0]["s"], "transcript", seg_id=f"seg-{self.seg_n:04d}", t_start=pc[0]["s"], t_end=t_end, text=text, words=pc,
                    avg_logprob=round(clamp(lp * 0.9 - 0.04 + self.rng.gauss(0, 0.03), -1.2, -0.02), 3),
                    no_speech_prob=round(min(0.3, self.rng.betavariate(1, 40)), 3), redactions=reds)

    def hallucinate(self, t0, t1):
        rng = self.rng
        pool = self.PB.get("hallucinations", [])
        if not pool:
            return
        lang = self.P["lang"]
        pref = [h for h in pool if lang in HALL_LANG and HALL_LANG[lang](h)]
        txt = rng.choice(pref) if pref and rng.random() < 0.6 else rng.choice([h for h in pool if not any(f(h) for f in HALL_LANG.values())] or pool)
        s = max(t0 + 2, self.sp_end + 0.5) + rng.uniform(0, max(0, (t1 - t0) - 8))
        toks = txt.split()
        words, cur = [], s
        for tok in toks:
            d = rng.uniform(0.2, 0.5)
            words.append({"w": tok.lower(), "s": round(cur, 2), "e": round(cur + d, 2), "p": round(rng.uniform(0.2, 0.6), 2)})
            cur += d + rng.uniform(0, .2)
        if words[-1]["e"] - words[0]["s"] < 2.0:
            words[-1]["e"] = round(words[0]["s"] + 2.0, 2)
        self.seg_n += 1
        self.ev(words[0]["s"], "transcript", seg_id=f"seg-{self.seg_n:04d}", t_start=words[0]["s"], t_end=words[-1]["e"],
                text=" ".join(w["w"] for w in words), words=words, avg_logprob=round(rng.uniform(-1.6, -0.8), 3),
                no_speech_prob=round(rng.uniform(0.6, 0.95), 3), redactions=[], hallucination_flag=False)
        self.stats["halluc"] += 1
        self.sp_end = words[-1]["e"]

    # ---- tools
    def tool(self, name, args, result=None, ok=True, lat=None):
        self.callno += 1
        cid = f"c{self.callno:05d}"
        lat = lat if lat is not None else self.rng.uniform(0.15, 0.5)
        self.ev(self.t, "tool_call", call_id=cid, tool=name, args=args)
        self.ev(self.t + lat, "tool_result", call_id=cid, ok=ok, result=result if result is not None else {})
        self.t += lat + self.rng.uniform(0.3, 1.4) * (1 - 0.4 * self.fat())
        self.stats["tools"] += 1
        return cid

    def goto(self, e, prefer_nf=False):
        P, rng = self.P, self.rng
        if self.win != 30 and rng.random() < .6:
            self.zoom(30)
        nxt = next((i for i in range(self.cur + 1, self.n) if self.flagged[i] and self.L(i)["src"] == "yasa"), None)
        if prefer_nf and nxt == e and rng.random() < P["nf_rate"]:
            self.cur = e
            self.tool("next_flagged", {}, {"epoch": e})
        elif 0 < e - self.cur <= 3 and rng.random() < .4:
            k = e - self.cur
            self.cur = e
            self.tool("pan", {"direction": "right", "n_epochs": k}, {"viewport": self.vp()})
        elif 0 < self.cur - e <= 3 and rng.random() < .4:
            k = self.cur - e
            self.cur = e
            self.tool("pan", {"direction": "left", "n_epochs": k}, {"viewport": self.vp()})
        else:
            self.cur = e
            self.tool("goto_epoch", {"epoch": e}, {"viewport": self.vp()})

    def zoom(self, w):
        if w == self.win:
            return
        self.win = w
        self.tool("zoom", {"window_s": w}, {"viewport": self.vp()})

    def toggle(self, ch, vis):
        if (ch in self.vis) == vis:
            return
        (self.vis.append(ch) if vis else self.vis.remove(ch))
        self.vis.sort(key=CH.index)
        self.tool("toggle_channel", {"channel": ch, "visible": vis}, {"viewport": self.vp()})

    def measure(self, e, kind, ch, f):
        rng = self.rng
        pr, dr, hr = MEAS[kind]
        dur = round(rng.uniform(*dr), 2)
        t0 = round(f["onset_s"] + rng.uniform(1, max(1.5, 28 - dur)), 2)
        if kind == "emg":
            p2p = f["emg_rms"] * rng.uniform(3, 5)
        else:
            p2p = rng.uniform(*pr)
        res = {"peak_to_peak_uv": round(p2p, 1), "duration_s": dur, "dominant_hz": round(rng.uniform(*hr), 1)}
        self.tool("measure", {"channel": ch, "t0_s": t0, "t1_s": round(t0 + dur, 2)}, res)
        return res

    # ---- labelling
    def set_label(self, e, stage):
        L = self.L(e)
        snap = (L["stage"], L["src"], L["ch"])
        prev, src = L["stage"], L["src"]
        L["hist"].append((snap, None))
        L["stage"], L["src"] = stage, "human"
        if stage != prev:
            L["ch"] += 1
        cid = self.tool("set_label", {"epoch": e, "stage": stage}, {"prev_stage": prev, "source_prev": src}, lat=self.rng.uniform(0.1, 0.3))
        L["hist"][-1] = (snap, cid)
        self.last_set = (e, cid)
        return cid

    def undo(self):
        e, cid = self.last_set
        L = self.L(e)
        snap, _ = L["hist"].pop()
        L["stage"], L["src"], L["ch"] = snap
        self.tool("undo", {}, {"undone_call_id": cid})
        self.last_set = None

    # ---- decision model
    def neighbor(self, true):
        if true not in NEIGH:
            return "W"
        w = dict(NEIGH[true])
        for k, b in self.P["biases"].items():
            a, c = k.split("->")
            if a == true and c in w:
                w[c] += 4 * b
            elif a == true:
                w[c] = 4 * b
        tot = sum(w.values()); r = self.rng.uniform(0, tot)
        for k, v in w.items():
            r -= v
            if r <= 0:
                return k
        return list(w)[0]

    def decide(self, e, kind):
        P, rng = self.P, self.rng
        f, y = self.feats[e], self.yas[e]
        true = f["stage_true"]
        fat = self.fat()
        ys = y["yasa_stage"]
        if true == "DISC":
            return ("DISC" if rng.random() < P["disc_label"] else "W"), "disc"
        d = f["difficulty"]
        pc = clamp(P["base_accuracy"] + 0.20 - 0.55 * d - 0.07 * fat, 0.12, 0.985)
        if kind == "extra":
            pc = clamp(pc + 0.05, 0, .98)
            if rng.random() < pc:
                return true, "truth"
            return self.neighbor(true), "neighbor"
        anch = clamp(P["yasa_anchoring"] * (0.5 + 0.9 * y["confidence"]) * (1 + 0.8 * fat), 0, 0.92)
        if kind == "revisit":
            anch = 0
            pc = clamp(pc + 0.08, 0, .98)
        if rng.random() < anch:
            return ys, "yasa"
        if rng.random() < pc:
            return true, "truth"
        lab = self.neighbor(true)
        return lab, ("yasa" if lab == ys else "neighbor")

    # ---- observations
    def feat_obs(self, e, label):
        f, rng = self.feats[e], self.rng
        L = []
        def add(cat, kind, ch, sup, **kw):
            L.append(dict(cat=cat, kind=kind, ch=ch, sup=sup, **kw))
        pct = f["slow_wave_pct"]
        art = f["artifact"]
        if art in ART_CAT:
            chs = f["artifact_channels"] or ["PSG_C3"]
            add(ART_CAT[art], art, rng.choice(chs), set(STAGES), prio=0, sec=round(rng.uniform(2, 14), 0))
        if pct >= 8:
            add("obs_slow_waves", "slow", rng.choice(CAT_CHANS["obs_slow_waves"]), {"N3"} if pct >= 20 else {"N2"}, prio=1, pct=int(round(pct)))
        if f["rem_count"] > 0 and label == "R":
            add("obs_rem", "rem", "PSG_EOG", {"R"}, prio=1, n=f["rem_count"])
        if f["emg_low"]:
            add("obs_emg_low", "emg", "PSG_EMG", {"R"}, prio=2, uv=max(1, int(round(f["emg_rms"]))))
        if f["emg_high"]:
            add("obs_emg_high", "emg", "PSG_EMG", {"W"}, prio=2, uv=int(round(f["emg_rms"])))
        if f["spindles"] > 0:
            add("obs_spindle", "spindle", rng.choice(CAT_CHANS["obs_spindle"]), {"N2", "N3"}, prio=1, n=f["spindles"])
        if f["k_complexes"] > 0:
            add("obs_kcomplex", "kcomplex", rng.choice(CAT_CHANS["obs_kcomplex"]), {"N2"}, prio=1, n=f["k_complexes"])
        if f["rel_alpha"] >= 0.28:
            add("obs_alpha", "alpha", rng.choice(CAT_CHANS["obs_alpha"]), {"W", "N1"}, prio=2)
        if f["stage_true"] == "N1" and f["rel_theta"] >= 0.28:
            add("obs_theta_low_amp", "theta", rng.choice(CAT_CHANS["obs_theta_low_amp"]), {"N1"}, prio=2)
        if f["vertex_waves"] > 0:
            add("obs_vertex", "vertex", rng.choice(CAT_CHANS["obs_vertex"]), {"N1"}, prio=1, n=f["vertex_waves"])
        if f["sawtooth"]:
            add("obs_sawtooth", "sawtooth", rng.choice(CAT_CHANS["obs_sawtooth"]), {"R"}, prio=2)
        if f["sem"]:
            add("obs_sem", "sem", "PSG_EOG", {"N1"}, prio=2)
        if f["arousal"]:
            add("obs_arousal", "arousal", rng.choice(CAT_CHANS["obs_arousal"]), set(STAGES), prio=(1 if self.P["arousal_overcall"] else 3), sec=f["arousal_onset_s"])
        return L

    def fab_obs(self, e, label, kinds_true):
        """Plausible misreading of the epoch as `label`."""
        f, rng = self.feats[e], self.rng
        out = []
        pct = f["slow_wave_pct"]
        def under(*prefs):
            for k, ok in prefs:
                if ok:
                    return k
            return "background"
        if label == "N3":
            out.append(dict(cat="obs_slow_waves", kind=under(("kcomplex", f["k_complexes"] > 0), ("slow", pct > 5)), ch=rng.choice(CAT_CHANS["obs_slow_waves"]),
                            pct=int(max(22, pct + rng.uniform(6, 14))), prio=1))
        elif label == "N2":
            if f["stage_true"] == "N3":
                out.append(dict(cat="obs_slow_waves", kind="slow", ch="PSG_F3", pct=int(rng.uniform(10, 18)), prio=1))
            out.append(dict(cat="obs_spindle", kind=under(("spindle", f["spindles"] > 0), ("vertex", f["vertex_waves"] > 0)), ch=rng.choice(CAT_CHANS["obs_spindle"]), n=max(1, f["spindles"] or rng.randint(1, 2)), prio=2))
            if rng.random() < .5:
                out.append(dict(cat="obs_kcomplex", kind=under(("vertex", f["vertex_waves"] > 0), ("kcomplex", f["k_complexes"] > 0)), ch="PSG_F3", n=1, prio=2))
        elif label == "W":
            out.append(dict(cat="obs_alpha", kind=under(("alpha", f["rel_alpha"] > .25)), ch=rng.choice(CAT_CHANS["obs_alpha"]), prio=1))
            out.append(dict(cat="obs_emg_high", kind="emg", ch="PSG_EMG", uv=max(1, int(round(max(f["emg_rms"], f["emg_q80"] * rng.uniform(1.0, 1.4))))), prio=2))
        elif label == "N1":
            out.append(dict(cat="obs_theta_low_amp", kind="theta", ch=rng.choice(CAT_CHANS["obs_theta_low_amp"]), prio=1))
            out.append(dict(cat=rng.choice(["obs_sem", "obs_vertex"]), kind="background", ch="PSG_EOG", n=1, prio=2))
        elif label == "R":
            out.append(dict(cat="obs_rem", kind=under(("sem", f["sem"] > 0)), ch="PSG_EOG", n=f["rem_count"] or rng.randint(2, 4), prio=1))
            out.append(dict(cat="obs_emg_low", kind="emg", ch="PSG_EMG", uv=max(1, int(round(min(f["emg_rms"], f["emg_q25"])))), prio=2))
        return out

    def build_obs(self, e, label, via):
        f = self.feats[e]
        true = f["stage_true"]
        if true == "DISC":
            return []
        self._fabpct = None
        real = self.feat_obs(e, label)
        if label == true:
            obs = [o for o in real if label in o["sup"] or o["cat"].startswith("obs_artifact") or o["cat"] == "obs_arousal"]
        else:
            obs = self.fab_obs(e, label, None)
            obs += [o for o in real if o["cat"].startswith("obs_artifact")]
        if label != "N3":   # templates assert abundant slow waves; sub-threshold amounts go through the 20% rule only
            for o in obs:
                if o["cat"] == "obs_slow_waves":
                    self._fabpct = o["pct"]
            obs = [o for o in obs if o["cat"] != "obs_slow_waves"]
        obs.sort(key=lambda o: o["prio"])
        # arousal over-call
        if self.P["arousal_overcall"] and not f["arousal"] and self.rng.random() < self.P["arousal_overcall"] * (1.2 if f["difficulty"] > .4 else .5):
            obs.append(dict(cat="obs_arousal", kind="arousal", ch="PSG_C3", sup=set(STAGES), prio=3, sec=round(self.rng.uniform(4, 25), 0), fake=True))
        return obs

    # ---- UI events
    def ui_fill(self, vs, ve, e, label, window_s):
        rng, P = self.rng, self.P
        f = self.feats[e]
        rel = list(STAGE_CH.get(label, STAGE_CH["N2"]))
        if f["artifact"] != "none":
            rel = f["artifact_channels"][:2] + rel[:1]
        vis = [c for c in rel if c in self.vis] or self.vis
        cur = max(vs, self.ui_cursor)
        mouse = rng.random() < P["mouse_rate"]
        on = f["onset_s"]
        if window_s >= 120:
            x0, x1 = max(0, on - window_s / 2 + 15), on + window_s / 2 + 15
        elif window_s == 10:
            x0 = on + rng.uniform(0, 20); x1 = x0 + 10
        else:
            x0, x1 = on, on + 30
        while cur < ve - 0.9:
            r = rng.random()
            room = ve - cur
            if r < 0.10:
                d = min(room, rng.uniform(0.4, 1.4))
                ch = rng.choice(self.vis)
                self.ev(cur, "ui", kind="hover_channel", channel=ch, duration_s=round(d, 2))
            elif r < 0.17 and mouse:
                d = min(room, rng.uniform(1.0, 3.0))
                pts, tt = [], cur
                xs = rng.uniform(x0, x1); ci = rng.randrange(len(self.vis))
                while tt < cur + d:
                    xs = clamp(xs + rng.gauss(0.8, 1.5), x0, x1)
                    if rng.random() < .15:
                        ci = rng.randrange(len(self.vis))
                    pts.append([round(tt, 2), round(xs, 1), ci]); tt += 0.2
                self.ev(cur, "ui", kind="mouse_path", points=pts, duration_s=round(d, 2))
            elif r < 0.23:
                d = min(room, rng.uniform(0.3, 0.8))
                xr = [round(x0 + rng.uniform(-6, 6), 1), 0]; xr[1] = round(xr[0] + (x1 - x0), 1)
                self.ev(cur, "ui", kind="scroll", x_range_s=[max(0, xr[0]), xr[1]], duration_s=round(d, 2))
            else:
                d = min(room, rng.uniform(2.0, 8.0) * (1 - 0.3 * self.fat()))
                ch = rng.choice(vis) if rng.random() < .75 else rng.choice(self.vis)
                self.ev(cur, "ui", kind="dwell", channel=ch, x_range_s=[round(x0, 1), round(x1, 1)], duration_s=round(d, 2))
            cur += d + rng.uniform(0.05, 0.3)
        self.ui_cursor = max(self.ui_cursor, cur)

    # ---- narration of one epoch
    def slots(self, e, label, ob=None, extra=None):
        f, y = self.feats[e], self.yas[e]
        alt = self.neighbor(f["stage_true"]) if f["stage_true"] in NEIGH else "N1"
        if alt == label:
            alt = max(NEIGH.get(label, {"N1": 1}), key=lambda k: NEIGH.get(label, {"N1": 1})[k])
        s = dict(_e=e, epoch=e, stage=label, alt=alt, yasa=y["yasa_stage"], conf=y["confidence"],
                 ch=(ob or {}).get("ch", "PSG_C4").replace("PSG_", ""), n=1, uv=int(self.rng.uniform(60, 120)),
                 hz=round(self.rng.uniform(1, 12), 1), sec=int(self.rng.uniform(3, 25)))
        if extra:
            s.update(extra)
        return s

    def narrate(self, e, label, via, talk, n_obs, tools=True):
        f, rng, P = self.feats[e], self.rng, self.P
        obs = self.build_obs(e, label, via)[:n_obs]
        fat = self.fat()
        spoken_any = False
        for ob in obs:
            kind, cat = ob["kind"], ob["cat"]
            ch = ob["ch"]
            res = None
            if tools:
                if ch not in self.vis and rng.random() < P["toggle_rate"]:
                    self.toggle(ch, True)
                if cat in ("obs_spindle", "obs_kcomplex", "obs_vertex", "obs_slow_waves", "obs_rem") and self.win == 30 and rng.random() < P["zoom_rate"] * (1 - .5 * fat):
                    self.zoom(10)
                if kind != "background" or rng.random() < .3:
                    if rng.random() < P["measure_rate"] * (1 - .4 * fat):
                        if ch not in self.vis:
                            self.toggle(ch, True)
                        res = self.measure(e, kind, ch, f)
                if rng.random() < P["scale_rate"] and cat in ("obs_slow_waves", "obs_rem"):
                    uv = rng.choice([25, 50, 75, 100])
                    self.scale = uv
                    self.tool("set_scale", {"channel": "all", "uv_per_div": uv}, {"viewport": self.vp()})
                if f["artifact"] in ("sweat", "ecg") and cat.startswith("obs_artifact") and rng.random() < P["filter_rate"] * 3:
                    k, hz = ("highpass", rng.choice([0.5, 1.0])) if f["artifact"] == "sweat" else ("notch", 50)
                    self.tool("apply_filter", {"channel": ch, "kind": k, "hz": hz}, {"ok": True})
                if cat in ("obs_alpha", "obs_theta_low_amp", "obs_slow_waves") and not self.spec and rng.random() < P["spec_rate"]:
                    self.spec = True
                    self.tool("show_spectrogram", {"visible": True, "channel": "PSG_C4" if "PSG_C4" in self.vis else self.vis[0]}, {"visible": True})
            if not talk:
                continue
            sl = self.slots(e, label, ob)
            if res:
                sl["uv"] = int(round(res["peak_to_peak_uv"])); sl["hz"] = res["dominant_hz"]
            else:
                pr, dr, hr = MEAS[kind]
                if pr:
                    sl["uv"] = int(rng.uniform(*pr)); sl["hz"] = round(rng.uniform(*hr), 1)
                else:
                    sl["hz"] = round(rng.uniform(*hr), 1)
            if "uv" in ob:
                sl["uv"] = ob["uv"]
            if "n" in ob:
                sl["n"] = ob["n"]
            if "pct" in ob:
                sl["n"] = ob["pct"]
            if ob.get("sec") is not None:
                sl["sec"] = int(ob["sec"])
            if cat == "obs_arousal":
                filt = (lambda t: "still sleep" not in t) if label == "W" else None
            elif cat == "obs_slow_waves" and "pct" in ob:
                filt = (lambda t, hi=ob["pct"] >= 20: not (hi is False and False))
            else:
                filt = None
            txt = self.say(cat, sl, filt)
            spoken_any = spoken_any or bool(txt)
            if tools and kind in ("arousal",) and ob.get("sec") is not None and rng.random() < P["mark_rate"]:
                on = round(f["onset_s"] + float(ob["sec"]), 1)
                self.tool("mark_event", {"kind": "arousal", "epoch": e, "onset_s": on, "duration_s": round(rng.uniform(3, 8), 1) if not ob.get("fake") else round(rng.uniform(3, 5), 1), "channel": ch},
                          {"event_id": f"ev{self.callno:05d}"})
            elif tools and kind in ("movement", "electrode_pop") and rng.random() < P["mark_rate"] * .6:
                self.tool("mark_event", {"kind": "movement" if kind == "movement" else "artifact", "epoch": e, "onset_s": round(f["onset_s"] + rng.uniform(0, 20), 1),
                                         "duration_s": round(rng.uniform(1, 8), 1), "channel": ch}, {"event_id": f"ev{self.callno:05d}"})
        # rules
        if talk:
            pctv = None
            for o in obs:
                if "pct" in o:
                    pctv = o["pct"]
            if label == "N2":
                pctv = self._fabpct if self._fabpct is not None else (int(round(f["slow_wave_pct"])) if f["slow_wave_pct"] >= 8 else None)
            if label == "N3" or (label == "N2" and pctv is not None):
                pv = pctv if pctv is not None else int(round(f["slow_wave_pct"]))
                if label == "N3" or rng.random() < .5:
                    hi = pv >= 20
                    if rng.random() < .55 * (0.5 + P["verbosity"]):
                        self.say("rule_n3_20pct", self.slots(e, label, None, {"n": pv}), lambda t, hi=hi: (not re.search(r"under twenty|not N3|less than twenty|below twenty", t, re.I)) if hi else bool(re.search(r"under twenty|not N3|less than|below|Twenty percent rule", t, re.I)) )
            if f["arousal"] and rng.random() < .3 * P["verbosity"]:
                dur = round(rng.uniform(3, 8), 0)
                self.say("rule_arousal_3s", self.slots(e, label, None, {"sec": int(dur)}), lambda t: not re.search(r"too short|only", t, re.I))
            if label == "R" and e > 0 and self.feats[e - 1]["stage_true"] != "R" and rng.random() < .5 * P["verbosity"]:
                self.say("rule_rem_onset", self.slots(e, label))
            if label == "N2" and e > 0 and self.L(e - 1)["stage"] == "N2" and not obs and rng.random() < .6:
                self.say("rule_n2_continuation", self.slots(e, label))
            elif f["difficulty"] > .55 and rng.random() < .25 * (0.4 + P["verbosity"]):
                self.say("rule_majority_epoch", self.slots(e, label))
        return spoken_any

    # ---- one visit
    def target_time(self, e, kind):
        P = self.P
        lo, hi = P["speed_s_per_epoch"]
        base = self.rng.uniform(lo, hi) * 0.7 * (0.55 + 0.9 * self.feats[e]["difficulty"])
        return base * (1 - 0.3 * self.fat())

    def comment_text(self, e, label, final_kind):
        return None

    def visit(self, e, kind):
        P, rng = self.P, self.rng
        f, y = self.feats[e], self.yas[e]
        true = f["stage_true"]
        vs = self.t
        if kind == "revisit":
            cur_lab = self.L(e)["stage"]
        self.goto(e, prefer_nf=(kind == "flag"))
        d, fat = f["difficulty"], self.fat()
        quiet_p = clamp(P["quiet_base"] + (0.22 if d < 0.3 and kind == "flag" else 0) + 0.28 * fat, 0, .85)
        talk = rng.random() > quiet_p
        final, via = self.decide(e, kind)
        if kind == "revisit":
            cur_lab = self.L(e)["stage"]
            if cur_lab != true and true != "DISC":
                final = true if rng.random() < .65 else cur_lab
                via = "truth"
            else:
                final = cur_lab if rng.random() > .08 * (1.5 if P["id"] == "ann-04" else 1) else self.neighbor(true)
                via = "neighbor" if final != cur_lab else "keep"
        sl = self.slots(e, final)
        # self-correction setup
        sc = rng.random() < P["selfcorr"] * (1 + fat) and kind in ("flag", "extra") and true != "DISC"
        first = None
        if sc:
            first = y["yasa_stage"] if (final == true and y["yasa_stage"] != true) else (self.neighbor(true) if final == true else true)
            if first == final:
                sc = False
        # open / navigate talk
        if talk and rng.random() < 0.1 + 0.5 * P["verbosity"]:
            cat = "open_epoch" if rng.random() < .5 else "navigate"
            if kind == "revisit":
                cat = "navigate"
            self.say(cat, sl)
        if talk and kind == "flag" and rng.random() < 0.04 * fat * 3 and fat > .35:
            self.say("fatigue", sl)
        # context zoom
        if rng.random() < P["context_rate"] * (0.3 + d) or (kind == "extra" and rng.random() < .5):
            w = rng.choice([120, 120, 300])
            self.zoom(w)
            if talk:
                self.say("context_scan", sl)
            self.t += rng.uniform(3, 10)
            self.zoom(30)
        if talk and kind == "flag" and rng.random() < .35 * P["verbosity"] and y["yasa_stage"] != "":
            pass
        # observations for first pass
        n_obs = 1 if (via == "yasa" and not sc) else clamp(int(round(rng.gauss(P["max_obs"] * (0.6 + 0.6 * P["verbosity"]) - 0.5 - fat, .7))), 1 if talk else 0, P["max_obs"])
        if kind == "flag" and not talk:
            n_obs = rng.choice([0, 1]) if P["measure_rate"] > .3 else 0
        lab1 = first if sc else final
        if true != "DISC":
            if rng.random() < P["toggle_rate"] * 0.3:
                hidden = [c for c in CH[:8] if c not in self.vis]
                if hidden and (len(self.vis) < 8 and rng.random() < .6):
                    self.toggle(rng.choice(hidden), True)
                elif len(self.vis) > 4:
                    self.toggle(rng.choice([c for c in self.vis if c not in ("PSG_C3", "PSG_C4", "PSG_EOG")]), False)
            if P["id"] in ("ann-05", "ann-03") and f["arousal"] and rng.random() < .15:
                self.toggle(rng.choice(["PSG_THER", "PSG_THOR"]), True)
            if rng.random() < P["spec_rate"] * 0.25:
                self.spec = not self.spec
                self.tool("show_spectrogram", {"visible": self.spec, "channel": "PSG_C4" if "PSG_C4" in self.vis else self.vis[0]}, {"visible": self.spec})
        if true == "DISC":
            self.narrate_disc(e, final)
        else:
            self.narrate(e, lab1, via, talk, n_obs)
        # yasa remarks
        if talk and true != "DISC" and rng.random() < (0.35 + 0.35 * P["yasa_anchoring"]):
            self.say("yasa_agree" if lab1 == y["yasa_stage"] else "yasa_disagree", self.slots(e, lab1))
        # deliberation
        if talk and true != "DISC" and (d > .45 or via == "neighbor") and rng.random() < .55:
            if rng.random() < .6:
                self.say("deliberate_between", self.slots(e, lab1))
            else:
                self.say("uncertain", self.slots(e, lab1))
        # dwell padding
        tgt = self.target_time(e, kind) * (0.7 if kind == "extra" else 1.0)
        spent = self.t - vs
        if spent < tgt:
            self.t += (tgt - spent) * rng.uniform(0.6, 1.0)
        # decision
        if talk and true != "DISC" and rng.random() < .75:
            hedged = d > .5 or via == "neighbor" and rng.random() < .5
            self.say("decide_hedged" if hedged else "decide_confident", self.slots(e, lab1))
        # label
        cur_stage = self.L(e)["stage"]
        did_label = False
        if kind == "extra" and final == cur_stage:
            pass
        elif kind == "revisit" and final == cur_stage:
            pass
        else:
            did_label = True
            if sc:
                self.set_label(e, first)
                if talk:
                    self.say("self_correct", self.slots(e, final))
                self.t += rng.uniform(2, 8)
                if talk and rng.random() < .6:
                    self.narrate(e, final, "truth" if final == true else via, talk, 1, tools=False)
                if rng.random() < P["undo_rate"] / max(P["selfcorr"], .01) * .6:
                    self.undo()
                self.set_label(e, final)
            else:
                undo_flip = rng.random() < P["undo_rate"] * .6 and true != "DISC"
                if undo_flip:
                    wrong = self.neighbor(true)
                    if wrong != final:
                        self.set_label(e, wrong)
                        self.t += rng.uniform(.5, 2)
                        if talk:
                            self.say("self_correct", self.slots(e, final))
                        self.undo()
                self.set_label(e, final)
        # comments
        self.maybe_comment(e, final, via, talk, did_label)
        if kind == "flag":
            self.visited.append(e)
        return final

    def narrate_disc(self, e, final):
        pass

    def maybe_comment(self, e, label, via, talk, did_label):
        P, rng = self.P, self.rng
        f = self.feats[e]
        true = f["stage_true"]
        txt = None
        if true == "DISC":
            if label == "W" and rng.random() < .85 or (label == "DISC" and rng.random() < .25):
                txt = rng.choice(["disconnection, patient probably out of bed", "bathroom break - no signal", "disconnect, scored W", "signal lost on all channels (bathroom break?)"])
        elif rng.random() < P["comment_rate"] * (0.5 + f["difficulty"]):
            ok = []
            for tp in self.PB["categories"].get("comment_dictation", []):
                st = tp.get("styles", ["any"])[0]
                if st != "any" and st not in P["style_tags"]:
                    continue
                t = tp["text"]; lo = t.lower()
                sm = set(re.findall(r"\bN[123]\b|\bREM\b|\bwake\b", t))
                allowed = {label, self.slots(e, label)["alt"]}
                names = {"W": "wake", "R": "REM"}
                sm2 = {m if m in ("N1", "N2", "N3") else ("R" if m == "REM" else "W") for m in sm}
                if sm2 - allowed - {label}:
                    continue
                if "arousal" in lo and not f["arousal"] and not (P["arousal_overcall"] and rng.random() < .6):
                    continue
                if "slow wave" in lo and f["slow_wave_pct"] < 5:
                    continue
                if "rem onset" in lo and label != "R":
                    continue
                if "movement" in lo and f["artifact"] != "movement":
                    continue
                if "resp" in lo or "apnea" in lo:
                    continue
                ok.append(t)
            if ok:
                raw = rng.choice(ok)
                sl = self.slots(e, label)
                if f["arousal_onset_s"] is not None:
                    sl["sec"] = int(f["arousal_onset_s"])
                sl["n"] = int(round(f["slow_wave_pct"])) if f["slow_wave_pct"] > 0 else 5
                if talk:
                    self.say("comment_dictation", sl, text=raw)
                txt = self.fill(raw, sl)
        if txt:
            self.tool("add_comment", {"epoch": e, "text": txt[:1].upper() + txt[1:]}, {"comment_id": f"cm{self.callno:05d}"})

    # ---- units
    def build_units(self):
        P, rng = self.P, self.rng
        units = []
        i = 0
        while i < self.n:
            if self.flagged[i]:
                j = i
                while j + 1 < self.n and self.flagged[j + 1] and (self.feats[j + 1]["stage_true"] == "DISC") == (self.feats[i]["stage_true"] == "DISC"):
                    j += 1
                eps = list(range(i, j + 1))
                if self.feats[i]["stage_true"] == "DISC":
                    units.append(("disc", eps))
                elif len(eps) >= 3 and rng.random() < P["run_rate"]:
                    units.append(("run", eps))
                else:
                    units += [("flag", e) for e in eps]
                i = j + 1
            else:
                f, y = self.feats[i], self.yas[i]
                if f["stage_true"] != "DISC":
                    near = any(self.flagged[k] for k in range(max(0, i - 3), min(self.n, i + 4)))
                    if y["yasa_stage"] != f["stage_true"]:
                        if rng.random() < P["catch_rate"] * (1 - 0.4 * P["yasa_anchoring"]) * (1.25 if near else 0.9):
                            units.append(("extra", i))
                    elif rng.random() < P["false_visit"] * (0.3 + f["difficulty"]):
                        units.append(("extra", i))
                i += 1
        # skipping
        out = list(units)
        k = 0
        while k < len(out):
            if out[k][0] == "flag" and rng.random() < P["skip_rate"] and k + 6 < len(out):
                u = out.pop(k)
                out.insert(k + rng.randint(4, 12), u)
            k += 1
        return out

    def do_unit(self, u, queue):
        kind, x = u
        if kind in ("flag", "extra", "revisit"):
            self.visit(x, kind)
        elif kind == "disc":
            self.do_disc(x)
        else:
            self.do_run(x)

    def do_disc(self, eps):
        P, rng = self.P, self.rng
        self.goto(eps[0], prefer_nf=True)
        talk = rng.random() > P["quiet_base"] * .5
        vs = self.t
        f = self.feats[eps[0]]
        chans_all = len(f["artifact_channels"]) >= 8
        if talk:
            self.say("open_epoch", self.slots(eps[0], "DISC"))
        if rng.random() < .5 and talk:
            self.zoom(120); self.say("context_scan", self.slots(eps[0], "DISC")); self.t += rng.uniform(2, 6); self.zoom(30)
        if talk and rng.random() < .8:
            cat = "obs_artifact_electrode" if rng.random() < .25 else "obs_artifact_movement"
            # flat signal everywhere: no template for disconnection, so use own words
            self.utter(rng.choice(["the whole signal is flat on all channels here.", "flat line everywhere, this looks like a disconnection.",
                                   "no signal, all channels flat, patient probably went to the bathroom.", "disconnection from epoch %d, all channels flat." % eps[0],
                                   "flat." if "terse" in P["style_tags"] else "okay this is a disconnection, flat on everything."]))
        label_first, via = self.decide(eps[0], "flag")
        for k, e in enumerate(eps):
            if k:
                lab, _ = self.decide(e, "flag") if rng.random() < .1 else (label_first, None)
                self.cur = e
                if k % 5 == 1 or rng.random() < .3:
                    self.tool("pan", {"direction": "right", "n_epochs": 1}, {"viewport": self.vp()})
                else:
                    self.t += 0.2
            else:
                lab = label_first
            self.t += rng.uniform(0.8, 2.5)
            self.set_label(e, lab)
        self.cur = eps[-1]
        self.maybe_comment(eps[0], label_first, "disc", talk, True)
        self.ui_fill(vs, self.t, eps[0], "DISC", 30)

    def do_run(self, eps):
        P, rng = self.P, self.rng
        vs = self.t
        self.goto(eps[0], prefer_nf=True)
        talk = rng.random() > P["quiet_base"] * .7
        self.zoom(120)
        if talk:
            self.say("context_scan", self.slots(eps[0], self.feats[eps[0]]["stage_true"]))
        self.t += rng.uniform(4, 12)
        labs = []
        for k, e in enumerate(eps):
            if k:
                self.cur = e
                self.tool("pan", {"direction": "right", "n_epochs": 1}, {"viewport": self.vp()})
            fin, via = self.decide(e, "flag")
            if talk and rng.random() < .5 * (0.4 + P["verbosity"]):
                self.narrate(e, fin, via, True, 1, tools=False)
            self.t += rng.uniform(2, 9) * (1 - .3 * self.fat())
            if talk and rng.random() < .3:
                self.say("decide_hedged" if self.feats[e]["difficulty"] > .5 else "decide_confident", self.slots(e, fin))
            self.set_label(e, fin)
            labs.append(fin)
            self.visited.append(e)
        self.zoom(30)
        self.ui_fill(vs, self.t, eps[0], labs[0], 120)

    # ---- pauses
    def pause(self, reason, dur):
        self.flush()
        t0 = max(self.t, self.sp_end + 0.3, self.ui_cursor)
        t0, dur = round(t0, 2), round(dur, 2)
        self.ev(t0, "pause", reason=reason, duration_s=dur)
        if reason == "idle" and dur > 40 and self.rng.random() < .4:
            self.hallucinate(t0, t0 + dur)
        self.t = t0 + dur
        self.sp_end = max(self.sp_end, self.t - 0.01) if False else self.sp_end
        self.ui_cursor = self.t

    def end_session(self, reason):
        self.flush()
        self.t = max(self.t, self.sp_end + .5, self.ui_cursor) + self.rng.uniform(.5, 2)
        nl = sum(1 for L in self.lab.values() if L["src"] == "human")
        self.ev(self.t, "session_end", reason=reason, n_labels=nl)
        evs = sorted(self.events, key=lambda x: (x[0], x[1]))
        lines = []
        for seq, (t, _, typ, kw) in enumerate(evs):
            wall = (self.sess_wall0 + datetime.timedelta(seconds=t)).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(round((t % 1) * 1000)) % 1000:03d}Z"
            d = {"t": t, "wall": wall, "type": typ, "seq": seq}
            d.update(kw)
            if typ == "transcript":
                d.pop("hallucination_flag", None)
            lines.append(d)
        self.sessions.append(dict(events=lines, reason=reason, dur=self.t))
        self.prev_wall_end = self.sess_wall0 + datetime.timedelta(seconds=self.t)
        self.tot_time += self.t
        self.sidx += 1

    def run(self):
        P, rng = self.P, self.rng
        queue = self.build_units()
        est = sum(sum(P["speed_s_per_epoch"]) / 2 * (1 if u[0] != "run" else .35 * len(u[1]) if u[0] == "run" else 1) * (1 if u[0] != "disc" else .1) for u in queue)
        n_sess = rng.choices([1, 2, 3], weights=[.35, .45, .2])[0]
        n_sess = max(1, min(n_sess, int(est / 1800) or 1))
        target_len = est / n_sess * rng.uniform(.85, 1.2)
        while queue:
            self.start_session()
            last_planned = self.sidx >= n_sess - 1
            if self.sidx == 0 or rng.random() < .6:
                self.say("session_open", self.slots(self.cur, "N2", None, {"epoch": self.cur}))
                self.t += rng.uniform(1, 4)
            if rng.random() < .5:
                self.hyp = not self.hyp if False else True
                self.tool("show_hypnogram", {"visible": True}, {"visible": True})
            reason = "done"
            since_break_t = self.t
            while queue:
                if self.t > 7000:
                    reason = "timeout"; break
                if not last_planned and self.t > target_len * rng.uniform(.9, 1.1):
                    reason = "paused"; break
                u = queue.pop(0)
                vs = self.t
                self.do_unit(u, queue)
                self.cum_work += self.t - vs
                if u[0] in ("flag", "run") and rng.random() < P["revisit_rate"] and len(self.visited) > 8:
                    pool = self.visited[-80:]
                    wrong = [e for e in pool if self.L(e)["stage"] != self.feats[e]["stage_true"]]
                    e = rng.choice(wrong) if wrong and rng.random() < .7 else rng.choice(pool)
                    queue.insert(rng.randint(0, 3), ("revisit", e))
                # gaps
                self.t += rng.uniform(0.5, 2.5)
                fat = self.fat()
                if self.t - since_break_t > 1500 and rng.random() < P["break_rate"] * 1.2:
                    self.say("break_start", self.slots(self.cur, "N2"))
                    self.pause("break", rng.uniform(120, 900))
                    since_break_t = self.t
                    self.say("break_end", self.slots(self.cur, "N2"))
                elif rng.random() < 0.008 + 0.02 * fat:
                    if rng.random() < .25:
                        self.say("off_task", self.slots(self.cur, "N2"))
                    self.pause("idle", rng.uniform(25, 150))
                elif rng.random() < 0.01 * P["pii_rate"] * 100:
                    self.say("pii_mention", self.slots(self.cur, "N2"))
            else:
                reason = "done"
            if not queue and reason != "timeout":
                reason = "done"
            if reason == "done" or (not queue):
                if rng.random() < .6:
                    self.tool("show_hypnogram", {"visible": True}, {"visible": True})
                    self.zoom(300)
                    self.t += rng.uniform(10, 40)
                    self.zoom(30)
            if rng.random() < .7 or reason != "done":
                self.say("session_close", self.slots(self.cur, "N2"))
            # session-wide ui events are emitted continuously in visits through ui_fill
            self.end_session(reason if queue or reason == "timeout" else "done")
        return self

    # patched: UI events for visits
    def visit_ui(self):
        pass


# visits emit ui events post-hoc: wrap visit to call ui_fill
_orig_visit = Job.visit
def _visit(self, e, kind):
    vs = self.t
    lab = _orig_visit(self, e, kind)
    self.ui_fill(vs, self.t, e, lab, self.win)
    return lab
Job.visit = _visit


# ---------------------------------------------------------------- main
def main():
    for d in ("sessions", "annotations"):
        shutil.rmtree(STUDY / d, ignore_errors=True)
    (STUDY / "annotations").mkdir(parents=True)
    PB, pbkind = load_phrasebank()
    assign = json.load(open(STUDY / "assignment.json"))
    nights = {n["night"]: n for n in json.load(open(DS / "nights.json"))}
    shared = set(assign["shared_nights"])
    cache = {}
    json.dump([{k: v for k, v in p.items()} for p in PERSONAS], open(STUDY / "annotators.json", "w"), indent=1, ensure_ascii=False)
    index = []
    summary = {}
    for pidx, P in enumerate(PERSONAS):
        for night in assign["assignment"][P["id"]]:
            if night not in cache:
                cache[night] = load_night(night)
            feats, yas = cache[night]
            job = Job(P, pidx, night, nights[night], feats, yas, PB, "shared" if night in shared else "unique").run()
            sess_paths = []
            for k, s in enumerate(job.sessions):
                rel = f"sessions/{P['id']}/{night}/session-{k + 1}.jsonl"
                p = STUDY / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                with open(p, "w") as fh:
                    for d in s["events"]:
                        fh.write(json.dumps(d, ensure_ascii=False, separators=(",", ":")) + "\n")
                sess_paths.append(rel)
            # annotations
            rows, fin, tru, flg = [], [], [], []
            with open(STUDY / "annotations" / f"{P['id']}_{night}.tsv", "w") as fh:
                fh.write("epoch\tonset_s\tyasa_stage\tyasa_conf\tflagged\tfinal_stage\tsource\tn_label_changes\n")
                for e in range(job.n):
                    L = job.L(e)
                    f, y = feats[e], yas[e]
                    fh.write(f"{e}\t{int(f['onset_s'])}\t{y['yasa_stage']}\t{y['confidence']:.3f}\t{y['flagged']}\t{L['stage']}\t{L['src']}\t{L['ch']}\n")
                    fin.append(L["stage"]); tru.append(f["stage_true"]); flg.append(y["flagged"])
            ok = [i for i in range(job.n) if tru[i] != "DISC"]
            okf = [i for i in ok if flg[i]]
            acc_f = sum(fin[i] == tru[i] for i in okf) / max(1, len(okf))
            acc_a = sum(fin[i] == tru[i] for i in ok) / len(ok)
            kap = kappa([fin[i] for i in ok], [tru[i] for i in ok])
            ykap = kappa([yas[i]["yasa_stage"] for i in ok], [tru[i] for i in ok])
            nlab = sum(1 for e in range(job.n) if job.L(e)["src"] == "human")
            index.append(dict(annotator=P["id"], night=night, role=job.role, sessions=sess_paths, n_flagged=int(sum(flg)), n_labels=nlab,
                              duration_s=round(job.tot_time, 1), kappa_vs_consensus=round(kap, 4), acc_flagged=round(acc_f, 4), acc_all=round(acc_a, 4),
                              yasa_kappa=round(ykap, 4), yasa_acc_flagged=round(sum(yas[i]["yasa_stage"] == tru[i] for i in okf) / max(1, len(okf)), 4),
                              n_sessions=len(sess_paths), n_utterances=job.stats["utt"], n_tool_calls=job.stats["tools"]))
            sm = summary.setdefault(P["id"], dict(jobs=0, fl=0, cf=0, kap=[], ykap=[], hrs=0, utt=0, tools=0))
            sm["jobs"] += 1; sm["fl"] += len(okf); sm["cf"] += sum(fin[i] == tru[i] for i in okf)
            sm["kap"].append(kap); sm["ykap"].append(ykap); sm["hrs"] += job.tot_time / 3600; sm["utt"] += job.stats["utt"]; sm["tools"] += job.stats["tools"]
    json.dump(index, open(STUDY / "index.json", "w"), indent=1)
    print(f"phrasebank: {pbkind}")
    print(f"{'ann':7}{'jobs':>5}{'flagged':>8}{'acc_fl':>8}{'kappa':>7}{'yasaK':>7}{'hours':>7}{'utt':>7}{'tools':>7}")
    for a, s in summary.items():
        print(f"{a:7}{s['jobs']:>5}{s['fl']:>8}{s['cf'] / s['fl']:>8.3f}{sum(s['kap']) / len(s['kap']):>7.3f}{sum(s['ykap']) / len(s['ykap']):>7.3f}{s['hrs']:>7.2f}{s['utt']:>7}{s['tools']:>7}")


if __name__ == "__main__":
    main()
