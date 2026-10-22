#!/usr/bin/env bash
# Install the audited Pi extensions in this workspace into Pi's settings.
#
# Usage: ./install.sh [-l] [package...]
#   ./install.sh                  # every package, globally
#   ./install.sh -l               # every package, into the current project's .pi/settings.json
#   ./install.sh todo-list rewind # only these packages
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

local_flag=()
if [[ "${1:-}" == "-l" ]]; then
  local_flag=(-l)
  shift
fi

command -v pi >/dev/null || { echo "pi not found on PATH" >&2; exit 1; }

if [[ $# -gt 0 ]]; then
  packages=("$@")
else
  packages=()
  for dir in "$root"/packages/*/; do
    packages+=("$(basename "$dir")")
  done
fi

for name in "${packages[@]}"; do
  [[ -f "$root/packages/$name/package.json" ]] || { echo "unknown package: $name" >&2; exit 1; }
done

# ignore-scripts is on in .npmrc, so dependency build scripts never run.
(cd "$root" && pnpm install)

for name in "${packages[@]}"; do
  echo "Installing $name"
  # Absolute path, so the settings entry does not depend on the working directory.
  # The ${arr[@]+...} form keeps an empty array safe under `set -u` on bash 3.2 (macOS).
  pi install ${local_flag[@]+"${local_flag[@]}"} "$root/packages/$name"
done

pi list
