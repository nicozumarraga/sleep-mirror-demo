# Sleep-Mirror demo: simulated think-aloud scoring sessions on real BOAS nights

**Project Mirror** is building an LLM co-pilot for sleep scoring that learns *how* experts score PSG recordings, not just the final labels.
Sleep experts score nights from a public dataset in a web annotation tool while thinking aloud. We log their speech, every interface action and their final labels.
The plan is to use these recordings to:

- **evaluate** LLM agents on the same task
- **train** them, with SFT on the reasoning traces, RL against the labels, or both

The agents would act through the same tools as the human experts.

The real study hasn't run yet. This repository shows what its data will look like:

- **Real:** 20 real PSG nights from BOAS, with the real expert consensus labels and the real YASA pre-scoring that decides which epochs the experts must review.
- **Simulated:** the annotation sessions on top of those nights, from 5 annotators: speech, tool calls, UI events and labels.

## Quick start

```bash
git clone https://github.com/nicozumarraga/sleep-mirror-demo && cd sleep-mirror-demo
python3 -m http.server 8000
# open http://localhost:8000/viewer/
```

No dependencies beyond Python 3 and a recent browser. The repository is about 260 MB, mostly the compressed signal.

The viewer has four levels:

| View | What you see |
|---|---|
| **Overview** | Nights ranked by how much YASA left to the annotators, per-annotator agreement, confusion matrix, inter-rater agreement on the shared nights |
| **Night** | YASA uncertainty profile (hypnodensity, confidence vs. flag threshold, flagged share over the night), every annotator's hypnogram against the consensus, why epochs were flagged |
| **Trajectory** | One annotator × night: hypnograms, session timeline (speech / tools / UI / pauses), the real PSG signal, and the raw event log as a chat-like feed |
| **▶ Replay** | A simulated annotation app replaying one session on the real signal: viewport, toolbar actions, cursor, labels being set, and the transcript as speech bubbles |

## What is real and what is simulated

| Real (BOAS, OpenNeuro ds005555, CC0) | Simulated |
|---|---|
| PSG signals of 20 nights from 20 different participants (EEG F3–O2, EOG, chin EMG, respiration) | 5 annotator personas |
| 3-scorer consensus labels per 30-second epoch (`stage_hum`) and BOAS's own model labels (`stage_ai`) | Think-aloud speech as Whisper transcripts, including ASR errors, fillers, non-native speech, hallucinations and redactions |
| **YASA** pre-scoring: per-epoch probabilities and confidence; the 12.7% of epochs below 0.60 confidence are flagged | VACP tool calls and UI dwell/mouse events, with timings, breaks, fatigue, YASA anchoring and undo |
| Per-epoch descriptors computed from the signal: band powers, plus YASA's spindle, slow-wave and REM detectors | Each annotator's final labels |
| `measure` results in the logs, computed from the real signal | |
| Participant age, sex and BMI | |

**Study setup** (scaled down from the protocol):

- 5 annotators and 20 nights.
- 3 nights are shared, so all five annotators score them and inter-rater agreement can be measured.
- The other 17 nights are split across the annotators.
- That gives 32 scoring jobs and about 37 h of simulated sessions.
- The simulated annotators score every flagged epoch and sometimes correct a confident YASA error.

**Some numbers from the real data:**

- Real YASA agrees with the consensus 79% of the time on average. That ranges from 54% to 90% depending on the night.
- Many of YASA's errors are *confident* ones, so they are never flagged for review.
- For comparison, BOAS's own model reaches 87% agreement.

```
SPEC.md                  schema of every file
data/dataset/            20 real BOAS nights
  sub-N/…_events.tsv       BOAS consensus (stage_hum) + BOAS model (stage_ai)
  sub-N/…_yasa.tsv         YASA probabilities, confidence, flag
  sub-N/…_epoch_features.tsv  per-epoch descriptors from the real signal
  sub-N/…_detections.json  YASA spindle / slow-wave / REM detections
  sub-N/…_signal.*         compact display copy of the PSG (see SPEC.md)
data/study/              simulated annotation study
  assignment.json          who scored which night
  sessions/<ann>/<night>/session-<k>.jsonl   raw event logs
  annotations/<ann>_<night>.tsv              final per-epoch labels
  index.json               job list + summary metrics
  annotators.json          simulated personas = the generator's hidden variables
  phrasebank.json          think-aloud template bank used by the generator
scripts/                 data pipeline (see below)
viewer/                  static viewer (vanilla JS)
```

### Data: what's in the repo and what you download

**In the repo: the shared reference, so we all work on the same thing.**

- the BOAS consensus labels
- the **YASA scores and flags**
- the epoch features and detections
- all simulated sessions and annotations
- a display copy of the signal (8-bit, downsampled)

Use these as they are.

**Download the original full-resolution signal** (EDF, 256 Hz) for any signal work:

```bash
./scripts/boas_download.sh            # the 20 nights → raw/boas/ (~3.8 GB, public OpenNeuro bucket, no account needed)
./scripts/boas_download.sh sub-16     # or just some nights
```

The scripts in `scripts/` document how `data/` was generated: night selection, YASA, features, the session simulator and the signal export. They are there for provenance, and you don't need to run them.

## The open question

Suppose this kind of data existed for about 88 real nights. **How would you turn it into evaluations and training for LLM agents?**

We're deliberately not prescribing an approach. We're interested in how you'd frame the problem, which decisions you'd make and why. Examples of decisions:

- what a task is
- what counts as ground truth
- how to split the data
- what to train on, with SFT, RL or both
- how you'd judge reasoning rather than only labels
- what you'd want us to log differently in the real study

A short write-up, sketches or a small prototype are all welcome.

## Caveats

- **The annotators are simulated.** Their speech is templated. It refers to features computed from the real epoch, but it is not always the true reason for the label, and it is no substitute for real expert reasoning.
- **Some feature columns are heuristics, not validated scoring.** This applies to K-complex and vertex-wave candidates, sawtooth, slow eye movements, arousals and artifacts (see `scripts/prepare_boas.py`).
- **`annotators.json` holds the simulation's latent parameters**, such as accuracy and YASA anchoring. A real study would not have them, so treat them as hidden.

## References

- Bitbrain (2026). *The Bitbrain Open Access Sleep (BOAS) dataset*, OpenNeuro ds005555, CC0.
- Esparza-Iaizzo et al. (2026). *Automatic sleep scoring for real-time monitoring and stimulation in individuals with and without sleep apnea.* Comput. Biol. Med.
- Vallat & Walker (2021). *An open-source, high-performance tool for automated sleep staging (YASA).* eLife.
- Stähle et al. (2026). *VACP: Visual Analytics Context Protocol.* IEEE VIS.
- Zumarraga et al. (2026). *TimeRLM: Recursive language models enable precise anomaly localization in long-context time-series.* arXiv:2608.03391.
- Langer et al. (2026). *OpenTSLM.* ICML.
