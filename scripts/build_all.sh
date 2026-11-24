#!/usr/bin/env bash
# Rebuild everything from the real BOAS nights. Needs ~3.5 GB disk for raw EDFs and Python >= 3.10.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .venv ] || { python3 -m venv .venv; .venv/bin/pip install -q -r requirements.txt; }
# LightGBM (used by YASA) needs an OpenMP runtime on macOS; scikit-learn's wheel ships one.
SK=$(.venv/bin/python -c "import sklearn,os;print(os.path.join(os.path.dirname(sklearn.__file__),'.dylibs'))")
export DYLD_FALLBACK_LIBRARY_PATH="$SK:${DYLD_FALLBACK_LIBRARY_PATH:-}"
mkdir -p raw/boas
B=https://s3.amazonaws.com/openneuro.org/ds005555
[ -s raw/boas/participants.tsv ] || curl -sf $B/participants.tsv -o raw/boas/participants.tsv
[ -s raw/boas/selection.json ] || {
  for s in $(seq 1 128); do curl -s "$B/sub-$s/eeg/sub-${s}_task-Sleep_acq-psg_channels.tsv" | awk -v s=$s 'NR>1{c=c","$1} END{print s"\t"c}'; done > raw/boas/channels_all.tsv
  .venv/bin/python scripts/boas_select.py; }
./scripts/boas_download.sh
rm -rf data/dataset/sub-*
.venv/bin/python scripts/prepare_boas.py         # real consensus, real YASA, features from real signal
python3 scripts/gen_trajectories.py              # simulated annotators / think-aloud / tool calls
.venv/bin/python scripts/ground_measurements.py      # measure results computed from the real signal
python3 scripts/validate.py
.venv/bin/python scripts/export_signals.py       # compact display copy of the signal for the viewer
