#!/usr/bin/env bash
# Fresh-Mac entry point. Installs just enough to run the Python installer:
#   Xcode Command Line Tools -> Homebrew -> uv, then hands over to `scripts/dotfiles install`.
#
#   ./scripts/bootstrap.sh [--dry-run] [dotfiles install options...]
#   REPO_URL=https://github.com/<you>/dev-config.git ./bootstrap.sh   # when run outside a clone
#
# Everything after uv is Python (scripts/dotfiles). Safe to re-run.
set -euo pipefail

DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] || [ "$a" = "-n" ] && DRY=1; done
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
say() { printf '\n==> %s\n' "$*"; }

[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 1; }

# 1. Command Line Tools (git, compilers)
if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing Xcode Command Line Tools (a dialog will appear)"
  run xcode-select --install || true
  [ "$DRY" = 1 ] || { echo "Re-run this script when the installation finishes." >&2; exit 1; }
fi

# 2. Homebrew
if ! command -v brew >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/brew ]; then
  say "Installing Homebrew"
  run /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"

# 3. uv (runs the installer and provides Python)
if ! command -v uv >/dev/null 2>&1; then
  say "Installing uv"
  run brew install uv
fi

# 4. Find or fetch the repo
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/dotfiles" ]; then
  REPO="$(cd "$HERE/.." && pwd)"
else
  REPO="${DOTFILES_DIR:-$HOME/.dev-config}"
  [ -n "${REPO_URL:-}" ] || { echo "Set REPO_URL to clone the repo, or run this from a clone." >&2; exit 1; }
  [ -d "$REPO/.git" ] || { say "Cloning $REPO_URL"; run git clone "$REPO_URL" "$REPO"; }
fi

say "Running installer"
if [ "$DRY" = 1 ] && [ ! -x "$REPO/scripts/dotfiles" ]; then echo "[dry-run] $REPO/scripts/dotfiles install $*"; exit 0; fi
exec "$REPO/scripts/dotfiles" install "$@"
