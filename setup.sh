#!/usr/bin/env bash
# Setup: download the original BOAS recordings (EDF + events + channels) for the 20 nights in this repo from
# OpenNeuro's public S3 bucket into raw/boas/ (~160-200 MB per night, ~3.8 GB for all 20). Nights come from data/dataset/selection.json.
# Everything else (YASA scores, features, sessions, viewer data) is already committed; this only fetches the raw signal.
#   ./setup.sh            # all 20 nights
#   ./setup.sh sub-16     # specific nights
# Files are written to *.part and renamed when complete; rerunning skips finished files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/raw/boas" && cd "$ROOT/raw/boas"
B=https://s3.amazonaws.com/openneuro.org/ds005555
[ -s participants.tsv ] || curl -sfL --retry 3 -o participants.tsv "$B/participants.tsv"
cp "$ROOT/data/dataset/selection.json" selection.json
fetch() {
  s=$1; B=$2; mkdir -p "$s"
  for f in psg_events.tsv psg_channels.tsv psg_eeg.edf; do
    out="$s/${s}_task-Sleep_acq-$f"
    [ -s "$out" ] || { curl -sfL --retry 3 -o "$out.part" "$B/$s/eeg/${s}_task-Sleep_acq-$f" && mv "$out.part" "$out"; }
  done
  echo "$s done"
}
export -f fetch
if [ $# -gt 0 ]; then printf '%s\n' "$@"; else python3 -c "import json;print('\n'.join(json.load(open('selection.json'))['nights']))"; fi \
  | xargs -P 5 -I{} bash -c 'fetch {} '"$B"
