# .zprofile: login shells. PATH-style setup that needs to happen once per login.

# Homebrew (Apple Silicon default location)
[[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv zsh)"

# Docker Desktop CLI (only if installed)
[[ -d "$HOME/.docker/bin" ]] && path+=("$HOME/.docker/bin")

[[ -r "$DOTFILES/local/zprofile.local" ]] && source "$DOTFILES/local/zprofile.local"
