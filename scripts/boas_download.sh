#!/usr/bin/env bash
# Download the selected BOAS PSG nights (EDF + events + channels) from OpenNeuro's public S3 bucket into raw/boas/.
# ~160-200 MB per night, 5 parallel downloads; files are written to *.part and renamed when complete.
set -euo pipefail
cd "$(dirname "$0")/../raw/boas"
B=https://s3.amazonaws.com/openneuro.org/ds005555
fetch() {
  s=$1; B=$2; mkdir -p "$s"
  for f in psg_events.tsv psg_channels.tsv psg_eeg.edf; do
    out="$s/${s}_task-Sleep_acq-$f"
    [ -s "$out" ] || { curl -sfL --retry 3 -o "$out.part" "$B/$s/eeg/${s}_task-Sleep_acq-$f" && mv "$out.part" "$out"; }
  done
  echo "$s done"
}
export -f fetch
python3 -c "import json;print('\n'.join(json.load(open('selection.json'))['nights']))" | xargs -P 5 -I{} bash -c 'fetch {} '"$B"
