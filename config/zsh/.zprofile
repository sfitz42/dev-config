# .zprofile: login shells. PATH-style setup that needs to happen once per login.

# Homebrew (Apple Silicon default location)
[[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv zsh)"

# Docker Desktop CLI (only if installed)
[[ -d "$HOME/.docker/bin" ]] && path+=("$HOME/.docker/bin")

[[ -r "$DOTFILES/local/zprofile.local" ]] && source "$DOTFILES/local/zprofile.local"

# MacPorts Installer addition on 2026-10-23_at_02:25:20: adding an appropriate PATH variable for use with MacPorts.
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
# Finished adapting your PATH environment variable for use with MacPorts.

