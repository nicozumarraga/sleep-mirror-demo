#!/usr/bin/env bash
# Rebuild data/ from the original BOAS recordings. NOTE: this overwrites the committed YASA scores, features,
# sessions and signal copy. You do NOT need it to use the repo; the committed files are the shared reference.
# Use it to audit or extend the pipeline. Needs ~3.8 GB disk and Python >= 3.10.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .venv ] || { python3 -m venv .venv; .venv/bin/pip install -q -r requirements.txt; }
# LightGBM (used by YASA) needs an OpenMP runtime on macOS; scikit-learn's wheel ships one.
SK=$(.venv/bin/python -c "import sklearn,os;print(os.path.join(os.path.dirname(sklearn.__file__),'.dylibs'))")
export DYLD_FALLBACK_LIBRARY_PATH="$SK:${DYLD_FALLBACK_LIBRARY_PATH:-}"
./scripts/boas_download.sh
rm -rf data/dataset/sub-*
.venv/bin/python scripts/prepare_boas.py          # real consensus, real YASA, features from real signal
python3 scripts/gen_trajectories.py               # simulated annotators / think-aloud / tool calls
.venv/bin/python scripts/ground_measurements.py   # measure results computed from the real signal
python3 scripts/validate.py
.venv/bin/python scripts/export_signals.py        # compact display copy of the signal for the viewer
