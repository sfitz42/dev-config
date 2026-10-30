#!/usr/bin/env bash
# Fresh-machine entry point. Installs just enough to run the Python installer, then hands over to
# the Setup Wizard (on a terminal, with no options) or `scripts/dotfiles install`:
#   macOS:        Xcode Command Line Tools -> Homebrew -> uv
#   Linux / WSL:  git, curl, zsh (dnf or apt, with sudo) -> uv
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

bootstrap_macos() {
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
}

bootstrap_linux() {
  # 1. Base tools from the distro (the installer itself needs git; zsh is the shell it configures)
  local need=() t
  for t in git curl zsh; do command -v "$t" >/dev/null 2>&1 || need+=("$t"); done
  if [ ${#need[@]} -gt 0 ]; then
    say "Installing ${need[*]} (sudo)"
    if command -v dnf >/dev/null 2>&1; then
      run sudo dnf install -y "${need[@]}"
    elif command -v apt-get >/dev/null 2>&1; then
      run sudo apt-get update
      run sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "${need[@]}"
    else
      echo "No dnf or apt-get: install ${need[*]} yourself, then re-run." >&2; exit 1
    fi
  fi

  # 2. uv into ~/.local/bin (the vendor installer; no sudo)
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v uv >/dev/null 2>&1; then
    say "Installing uv (https://astral.sh/uv/install.sh)"
    if [ "$DRY" = 1 ]; then
      echo "[dry-run] curl -LsSf https://astral.sh/uv/install.sh | sh"
    else
      curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
    fi
  fi
}

case "$(uname -s)" in
  Darwin) bootstrap_macos ;;
  Linux)  bootstrap_linux ;;
  *)      echo "macOS or Linux (including WSL) only" >&2; exit 1 ;;
esac

# Find or fetch the repo
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/dotfiles" ]; then
  REPO="$(cd "$HERE/.." && pwd)"
else
  REPO="${DOTFILES_DIR:-$HOME/.dev-config}"
  [ -n "${REPO_URL:-}" ] || { echo "Set REPO_URL to clone the repo, or run this from a clone." >&2; exit 1; }
  [ -d "$REPO/.git" ] || { say "Cloning $REPO_URL"; run git clone "$REPO_URL" "$REPO"; }
fi
if [ -n "${WSL_DISTRO_NAME:-}" ] && [ "${REPO#/mnt/}" != "$REPO" ]; then
  echo "note: $REPO is on the Windows drive; clone into the distro (~/.dev-config) instead" >&2
fi

say "Running installer"
if [ "$DRY" = 1 ] && { [ ! -x "$REPO/scripts/dotfiles" ] || ! command -v uv >/dev/null 2>&1; }; then
  echo "[dry-run] $REPO/scripts/dotfiles install $*"; exit 0
fi
if [ $# -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
  "$REPO/scripts/dotfiles" wizard      # interactive: the wizard picks what to install
else
  "$REPO/scripts/dotfiles" install "$@"
fi

if [ "$(uname -s)" = Linux ] && [ "$(basename "${SHELL:-}")" != zsh ]; then
  echo
  echo "zsh is not your login shell yet: chsh -s \"\$(command -v zsh)\""
fi
