#!/usr/bin/env bash
# Count tokens for each calibration sample using the provider's own tokenizer,
# and print a TSV of sample / chars / bytes / tokens.
#
# Run gen_samples.py first; it writes the samples and a manifest to /tmp/belay-cal.
#
# Supply the key in the environment so this script never reads your secrets file
# and the key never lands in your shell history:
#
#     read -rs KEY && export KEY && bash tools/calibration/run_cal.sh > results.tsv
#
# MODEL defaults to gemini-3.8-flash. For a different provider, change the
# endpoint and request shape in the Python block below to that provider's own
# token-counting API; the analysis in analyse.py is provider-agnostic.
set -u

KEY="${KEY:-}"
if [ -z "$KEY" ]; then
  echo "No API key. Run:  read -rs KEY && export KEY && bash $0" >&2
  exit 1
fi

MODEL="${MODEL:-gemini-3.8-flash}"

python3 - "$KEY" "$MODEL" <<'PY'
import json, sys, urllib.request

key, model = sys.argv[1], sys.argv[2]
manifest = json.load(open("/tmp/belay-cal/manifest.json"))

print("sample\tchars\tbytes\ttokens")
for row in manifest:
    data = open(f"/tmp/belay-cal/{row['name']}.json", "rb").read()
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            tokens = json.load(response).get("totalTokens")
    except Exception as err:  # noqa: BLE001 - report and continue to the next sample
        tokens = f"ERROR {type(err).__name__}"
    print(f"{row['name']}\t{row['chars']}\t{row['bytes']}\t{tokens}", flush=True)
PY
