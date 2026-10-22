#!/usr/bin/env bash
# Download the local MLX models listed in docs/local-models/models.md into oMLX's model directory.
#
# Usage: ./pull-models.sh [model...]
#   ./pull-models.sh                          # every model below
#   ./pull-models.sh Qwen3.8-27B-4bit         # only this one (name without the org)
#
# Downloads resume and skip files already present, so re-running is safe.
set -euo pipefail

models=(
  Qwen3.6-35B-A3B-4bit
  Qwen3.8-27B-4bit
  gpt-oss-20b-MXFP4-Q8
)

org="mlx-community"
model_dir="${OMLX_MODEL_DIR:-$HOME/.omlx/models}"

command -v uvx >/dev/null || { echo "uvx not found on PATH (install uv)" >&2; exit 1; }

if [[ $# -gt 0 ]]; then
  selected=("$@")
else
  selected=("${models[@]}")
fi

for name in "${selected[@]}"; do
  echo "Pulling $org/$name"
  uvx --from huggingface_hub hf download "$org/$name" --local-dir "$model_dir/$org/$name"
done

echo "Done. Restart the server to pick up new models: omlx restart"
