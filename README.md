# Sleep-Mirror demo: synthetic think-aloud sleep-scoring sessions

**Project Mirror** is building an LLM co-pilot for sleep scoring that learns *how* experts score PSG recordings, not just the final labels.
Sleep experts score nights from a public dataset in a web annotation tool while thinking aloud. We log their speech, every interface action and their final labels.
The plan is to use these recordings to:

- **evaluate** LLM agents on the same task
- **train** them, with SFT on the reasoning traces, RL against the labels, or both

The agents would act through the same tools as the human experts.

This repository is a **fully synthetic mock** of what that study will produce. It exists so you can get a feel for the data before any real recordings exist. No real participants, voices or EEG are included.

## Quick start

```bash
git clone https://github.com/nicozumarraga/sleep-mirror-demo && cd sleep-mirror-demo
python3 -m http.server 8000
# open http://localhost:8000/viewer/
```

No dependencies beyond Python 3 and a browser.

The viewer has four levels:

| View | What you see |
|---|---|
| **Overview** | Nights ranked by how much YASA left to the annotators, per-annotator agreement, confusion matrix, inter-rater agreement on the shared nights |
| **Night** | YASA uncertainty profile (hypnodensity, confidence vs. flag threshold, flagged share over the night), every annotator's hypnogram against the consensus, why epochs were flagged |
| **Trajectory** | One annotator × night: hypnograms, session timeline (speech / tools / UI / pauses), synthetic signal, and the raw event log as a chat-like feed |
| **▶ Replay** | A simulated annotation app replaying one session: viewport, toolbar actions, cursor, labels being set, and the Whisper transcript as speech bubbles |

## The simulated study

- **Dataset:** [BOAS](https://openneuro.org/datasets/ds005555/versions/1.1.3) (OpenNeuro ds005555, CC0). It contains 128 PSG nights with a 3-scorer consensus label per 30-second epoch (`stage_hum`).
- **Pre-scoring:** YASA scores every epoch. Epochs with confidence below **0.60** are **flagged**, and the expert must score them. They may also correct any other epoch.
- **Scale:** **5 annotators × 20 nights**. 3 nights are scored by all five, for inter-rater agreement. The other 17 are split across the annotators, giving **32 scoring jobs** and about 46 h of sessions.
- **What gets logged per session:**
  - Whisper transcript segments with word timestamps, ASR confidences and redaction tokens
  - VACP tool calls and their results (`goto_epoch`, `zoom`, `toggle_channel`, `measure`, `set_label`, `undo`, …)
  - UI dwell and mouse events
  - breaks
  - the final labels
- **Built-in messiness:** the data is deliberately imperfect in the ways we expect real data to be:
  - ASR errors, fillers and non-native speech
  - silence hallucinations
  - fatigue and anchoring on YASA
  - self-corrections and revisits
  - epochs scored without speaking
  - speech that doesn't line up exactly with what is on screen

```
SPEC.md                  full schema of every file
data/dataset/            20 BOAS-like nights: consensus + BOAS-AI labels, per-epoch signal descriptors, YASA probs + flags
data/study/
  assignment.json        who scored which night
  sessions/<ann>/<night>/session-<k>.jsonl   raw event logs
  annotations/<ann>_<night>.tsv              final per-epoch labels
  index.json             job list + summary metrics
  annotators.json        simulated personas = the generator's hidden variables (see caveats)
  phrasebank.json        think-aloud template bank used by the generator
scripts/                 generators + consistency checks (stdlib Python, seeded)
viewer/                  static viewer (vanilla JS)
```

To regenerate everything, run:

```bash
python3 scripts/gen_nights.py && python3 scripts/gen_trajectories.py && python3 scripts/validate.py
```

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

- **The data is synthetic.** The schema is realistic, but the clinical and statistical realism is only approximate. Don't draw clinical conclusions from it.
- **There are no raw signals.** Each epoch has a set of feature descriptors (`*_epoch_features.tsv`), and the viewer renders a synthetic waveform from them. In the real study, agents see the BOAS EDF signals through tools.
- **`annotators.json` holds the simulation's latent parameters**, such as accuracy and YASA anchoring. A real study would not have them, so treat them as hidden when designing anything.
- **The think-aloud text is templated.** It refers to features that really are in the epoch, but it is not always the true reason for the label.

## References

- Bitbrain (2026). *BOAS dataset*, OpenNeuro ds005555.
- Vallat & Walker (2021). *An open-source, high-performance tool for automated sleep staging (YASA).* eLife.
- Stähle et al. (2026). *VACP: Visual Analytics Context Protocol.* IEEE VIS.
- Zumarraga et al. (2026). *TimeRLM: Recursive language models enable precise anomaly localization in long-context time-series.* arXiv:2608.03391.
- Langer et al. (2026). *OpenTSLM.* ICML.
