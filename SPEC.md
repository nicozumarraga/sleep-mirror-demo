# Sleep-Mirror synthetic study — data spec

Synthetic stand-in for what Stage 2 of the Project Mirror study (think-aloud annotation) would produce,
built on top of the BOAS dataset (OpenNeuro ds005555, CC0). Everything here is **simulated**; no real
signals or real participants. All randomness is seeded (`SEED=42`) so the dataset is reproducible.

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
  dataset/                          # stand-in for the BOAS files we use
    participants.tsv                # participant_id age sex bmi pid ahi_group
    nights.json                     # per-night metadata (n_epochs, lights_off, role shared/unique)
    sub-<N>/
      sub-<N>_task-Sleep_acq-psg_events.tsv   # BOAS format: onset duration begsample endsample offset stage_hum stage_ai
      sub-<N>_epoch_features.tsv    # simulated per-epoch signal descriptors (what the signal "looks like")
      sub-<N>_yasa.tsv              # YASA pre-scoring: epoch yasa_stage p_W p_N1 p_N2 p_N3 p_R confidence flagged
  study/
    annotators.json                 # personas (see below) — ground truth for simulation, NOT shipped to model
    assignment.json                 # {ann-01: [sub-..], ...}, shared nights list
    phrasebank.json                 # think-aloud template bank (see below)
    sessions/<ann>/<sub>/session-<k>.jsonl    # raw trajectory event log (one JSON object per line)
    annotations/<ann>_<sub>.tsv     # final per-epoch scoring for that job
    index.json                      # [{annotator, night, role, sessions:[relative paths], n_flagged, n_labels,
                                    #   duration_s, kappa_vs_consensus, acc_flagged, acc_all}] — viewer entry point
```

Regenerate everything: `python3 scripts/gen_nights.py && python3 scripts/gen_trajectories.py`.
View: `python3 -m http.server 8000` from `demo/`, open http://localhost:8000/viewer/

### `sub-<N>_epoch_features.tsv` columns
`epoch onset_s stage_true` then descriptors (all floats unless noted):
- `rel_delta rel_theta rel_alpha rel_sigma rel_beta` — relative EEG band power (sum≈1)
- `slow_wave_pct` — % of epoch with ≥75 µV 0.5–2 Hz waves (N3 if ≥20)
- `spindles` (int), `k_complexes` (int), `vertex_waves` (int), `sawtooth` (0/1)
- `rem_count` (int, rapid eye movements), `sem` (0/1, slow eye movements)
- `emg_rms` (µV)
- `arousal` (0/1, ≥3 s abrupt frequency shift inside the epoch), `arousal_onset_s` (sec into epoch or blank)
- `artifact` — `none|movement|electrode_pop|sweat|ecg|disconnect`
- `artifact_channels` — comma list of affected channels, e.g. `PSG_C4,PSG_O2`
- `difficulty` — 0..1 latent ambiguity (transitions, artifacts, mixed features)

`stage_true` == consensus (`stage_hum`). There are no individual BOAS scorer labels (the dataset only
publishes the consensus), so annotator agreement is measured against `stage_hum`.

### Channels (BOAS PSG names)
`PSG_F3 PSG_F4 PSG_C3 PSG_C4 PSG_O1 PSG_O2 PSG_EOG PSG_EMG PSG_THER PSG_THOR PSG_ABD`, 256 Hz.

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
- `measure {channel, t0_s, t1_s}` → result `{peak_to_peak_uv, duration_s, dominant_hz}`
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
