# Sleep-Mirror demo — data spec

A mock of what Stage 2 of the Project Mirror study (think-aloud annotation) will produce. The **nights are real**
(20 PSG recordings from BOAS, OpenNeuro ds005555, CC0: signals, consensus labels, real YASA pre-scoring); the
**annotation sessions are simulated** (annotators, speech, tool calls, labels). Simulation randomness is seeded
(`SEED=42`), so rerunning the pipeline reproduces the data.

## Study design (demo scale)

- 5 annotators (`ann-01` … `ann-05`), 20 BOAS nights.
- 3 nights are **shared** (scored by all 5 → inter-rater agreement), 17 are **unique** (split 4/4/3/3/3).
  → 32 (annotator, night) scoring jobs.
- Each night is pre-scored by YASA. Epochs with `yasa_conf < 0.60` are **flagged**; the annotator must
  score every flagged epoch and may correct any other epoch.
- Annotators think aloud; audio → Whisper transcript (on ETH servers), de-identified.
- The interface (VACP-based) logs every tool call and UI interaction with timestamps.

Stage codes follow BOAS: `0=W, 1=N1, 2=N2, 3=N3, 4=R, 8=disconnection`. In JSON/TSV written by us we use
the string labels `W N1 N2 N3 R` and `DISC` (disconnection) for readability; `stage_hum`/`stage_ai` in
`events.tsv` keep BOAS integer codes.

## Directory layout

```
data/
  dataset/                          # 20 real BOAS nights (scripts/prepare_boas.py)
    selection.json                  # which BOAS recordings (unique participants, full channel set) + shared nights
    participants.tsv                # BOAS participants.tsv rows: participant_id age sex bmi pid
    nights.json                     # per-night metadata (n_epochs, hours, age, sex, n_flagged, yasa_acc, stage_ai_acc, role)
    sub-<N>/
      sub-<N>_task-Sleep_acq-psg_events.tsv   # original BOAS file: onset duration begsample endsample offset stage_hum stage_ai
      sub-<N>_yasa.tsv              # real YASA SleepStaging (C4/EOG/EMG + age/sex): epoch yasa_stage p_W p_N1 p_N2 p_N3 p_R confidence flagged
      sub-<N>_epoch_features.tsv    # per-epoch descriptors computed from the real signal (below)
      sub-<N>_detections.json       # YASA detections: spindles [[start_s, dur_s, ch]], slow_waves [[...]], rems [peak_s]
      sub-<N>_signal.json / .bin.gz # display copy of the PSG (below)
  study/
    annotators.json                 # personas (see below) — ground truth for simulation, NOT shipped to model
    assignment.json                 # {ann-01: [sub-..], ...}, shared nights list
    phrasebank.json                 # think-aloud template bank (see below)
    sessions/<ann>/<sub>/session-<k>.jsonl    # raw trajectory event log (one JSON object per line)
    annotations/<ann>_<sub>.tsv     # final per-epoch scoring for that job
    index.json                      # [{annotator, night, role, sessions:[relative paths], n_flagged, n_labels,
                                    #   duration_s, kappa_vs_consensus, acc_flagged, acc_all}] — viewer entry point
```

Original EDFs: `./scripts/boas_download.sh` (~3.8 GB into `raw/`, git-ignored). The other scripts document how `data/` was generated.
View: `python3 -m http.server 8000` from `demo/`, open http://localhost:8000/viewer/

### `sub-<N>_epoch_features.tsv` columns
`epoch onset_s stage_true` then descriptors computed from the real signal at 100 Hz (no hypnogram used, so no
label leakage, except `difficulty`). [D] = YASA detector, [H] = simple heuristic (not validated scoring):
- `rel_delta rel_theta rel_alpha rel_sigma rel_beta` — relative band power on PSG_C4 (Welch, 0.5–30 Hz)
- `slow_wave_pct` [D] — % of epoch covered by YASA-detected slow waves on C4 (`yasa.sw_detect`)
- `spindles` [D] — YASA spindles on C4 (`yasa.spindles_detect`)
- `k_complexes` [H] — isolated detected slow waves (1–2 in an epoch with <20% slow-wave time)
- `vertex_waves` [H] — sharp 2–6 Hz deflections on C4 in epochs without slow-wave activity
- `rem_count` [D] — `yasa.rem_detect` on the bipolar EOG (LOC=EOG, ROC=−EOG); also catches blinks in wake
- `sem` [H], `sawtooth` [H] — slow eye movements (0.2–0.6 Hz EOG) / theta bursts with low EMG and REMs
- `emg_rms` — chin EMG RMS after a 10 Hz high-pass (µV; absolute level varies a lot between recordings)
- `arousal` [H], `arousal_onset_s` — ≥3 s of 8–30 Hz power ≥3× the preceding 10 s
- `artifact` [H] — `none|movement|electrode_pop|sweat|disconnect` (disconnect = BOAS stage 8), `artifact_channels`
- `difficulty` — simulator latent: 0.65·(1−YASA conf) + transition + artifact + arousal + N1 terms (uses consensus)

### Signal display copy (`sub-<N>_signal.json` + `.bin.gz`)
Full night; EEG/EOG band-passed 0.3–22 Hz at 50 Hz, chin EMG high-passed 10 Hz at 100 Hz, respiration
low-passed 2 Hz at 10 Hz and z-scored (a.u.). Each (epoch, channel) row is 8-bit µ-law with its own scale:
`x = sign(q)·((1+μ)^(|q|/127) − 1)/μ · scale[epoch][channel]`, μ = 255. Bytes are epoch-major, then channel
order as in `channels`. This copy is for viewing only; use the EDFs for analysis. If EOGL/EOGR were recorded,
`PSG_EOG` = EOGL − EOGR.

`stage_true` == consensus (`stage_hum`). There are no individual BOAS scorer labels (the dataset only
publishes the consensus), so annotator agreement is measured against `stage_hum`.

### Channels (BOAS PSG names)
`PSG_F3 PSG_F4 PSG_C3 PSG_C4 PSG_O1 PSG_O2 PSG_EOG PSG_EMG PSG_THER PSG_THOR PSG_ABD`, 256 Hz in the EDFs.

## Trajectory event log (`session-<k>.jsonl`)

One JSON object per line, sorted by `t`. Common fields: `t` (seconds since session start, float, 2dp),
`wall` (ISO-8601 UTC), `type`, `seq` (int, monotonically increasing within session).

| type | fields |
|---|---|
| `session_start` | `annotator, night, session, ui_version, asr_model, viewport:{start_epoch, window_s, channels:[...], scale_uv}` |
| `transcript` | `seg_id, t_start, t_end, text` (raw Whisper output, lowercase-ish, disfluencies, ASR errors), `words:[{w,s,e,p}]`, `avg_logprob, no_speech_prob, redactions:[{span, kind}]` |
| `tool_call` | `call_id, tool, args{}` (see tools) |
| `tool_result` | `call_id, ok, result{}` (e.g. new viewport, previous label) |
| `ui` | `kind: dwell|hover_channel|scroll|mouse_path`, `channel?`, `x_range_s?`, `duration_s?`, `points?:[[t,x_s,ch_idx],...]` |
| `pause` | `reason: break|idle`, `duration_s` |
| `session_end` | `reason: done|paused|timeout`, `n_labels` |

### VACP tools (the action space)
- `goto_epoch {epoch}`
- `pan {direction: left|right, n_epochs}`
- `zoom {window_s}` (30 = one epoch, 10 = detail, 120/300 = context)
- `toggle_channel {channel, visible}`
- `set_scale {channel|"all", uv_per_div}`
- `apply_filter {channel, kind: lowpass|highpass|notch, hz}`
- `measure {channel, t0_s, t1_s}` → result `{peak_to_peak_uv, duration_s, dominant_hz}` (computed from the real signal, `scripts/ground_measurements.py`)
- `show_hypnogram {visible}` / `show_spectrogram {visible, channel}`
- `set_label {epoch, stage}` → result `{prev_stage, source_prev: yasa|human}`
- `mark_event {kind: arousal|artifact|movement, epoch, onset_s, duration_s, channel?}`
- `add_comment {epoch, text}`
- `undo {}` → result `{undone_call_id}`
- `next_flagged {}` → result `{epoch}`

The trajectory must be **internally consistent**: `set_label` stages match `annotations/<ann>_<sub>.tsv`;
transcript content refers to features that actually exist in `epoch_features` for the epoch on screen
(except when the annotator misreads, which is how errors arise); timestamps never overlap within a stream.

### `annotations/<ann>_<sub>.tsv`
`epoch onset_s yasa_stage yasa_conf flagged final_stage source(yasa|human) n_label_changes`

## `annotators.json` (persona)
```json
{"id":"ann-01","role":"somnologist","years_exp":12,"native_language":"Italian","site":"[SITE_A]",
 "verbosity":0.8, "filler_rate":0.06, "speed_s_per_epoch":[20,45], "base_accuracy":0.86,
 "yasa_anchoring":0.3, "favorite_tools":["zoom","measure"], "biases":{"N1->W":0.1},
 "style_notes":"..."}
```

## `phrasebank.json` (template bank for think-aloud)

```json
{
 "version": 1,
 "slots": ["{epoch}","{stage}","{alt}","{yasa}","{conf}","{ch}","{n}","{uv}","{hz}","{sec}"],
 "categories": {
   "<category>": [ {"text": "...{ch}...", "styles": ["any"|"terse"|"verbose"|"nonnative_it"|"nonnative_de"], "weight": 1.0}, ... ]
 },
 "asr_confusions": {"n2": ["in two","and two","n to"], ...},
 "hallucinations": ["thank you for watching.", ...],
 "fillers": {"en": ["uh","um","so","okay"], "it": ["allora","eh"], "de": ["also","äh"]}
}
```
Categories (minimum): `navigate, open_epoch, context_scan, obs_spindle, obs_kcomplex, obs_slow_waves,
obs_alpha, obs_theta_low_amp, obs_vertex, obs_sawtooth, obs_rem, obs_sem, obs_emg_low, obs_emg_high,
obs_arousal, obs_artifact_movement, obs_artifact_electrode, obs_artifact_sweat, obs_artifact_ecg,
rule_n3_20pct, rule_n2_continuation, rule_rem_onset, rule_arousal_3s, rule_majority_epoch,
yasa_agree, yasa_disagree, uncertain, deliberate_between, decide_confident, decide_hedged,
self_correct, comment_dictation, fatigue, off_task, break_start, break_end, session_open, session_close,
pii_mention` (contains `[NAME]`/`[INSTITUTION]` redaction tokens).
