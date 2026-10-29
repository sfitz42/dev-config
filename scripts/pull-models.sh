#!/usr/bin/env bash
# Pull the local models in models.yaml (oMLX on Apple silicon, Ollama anywhere; under WSL, Ollama
# on Windows). Now part of the Python installer; same usage as before:
#   ./pull-models.sh                          # every model, every runtime found here
#   ./pull-models.sh Qwen3.8-27B-4bit         # only this one
# For one runtime: scripts/dotfiles models --runtime ollama
set -euo pipefail
models="$(IFS=,; echo "$*")"
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dotfiles" models ${models:+"$models"}
