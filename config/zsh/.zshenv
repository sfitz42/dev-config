# .zshenv: read by every zsh (scripts too). Keep it tiny and side-effect free.

# Where this config lives, resolved through symlinks (works when ~/.zshenv is a link to this file).
export ZSH_CONFIG_DIR="${${(%):-%x}:A:h}"
export DOTFILES="${ZSH_CONFIG_DIR:h:h}"

# User-installed tools (claude, pi, zed, uv tools, ...)
typeset -U path
path=("$HOME/.local/bin" $path)

# nvim if present, else vi (containers have no nvim)
if [[ -z $EDITOR ]]; then (( $+commands[nvim] )) && export EDITOR=nvim || export EDITOR=vi; fi
export VISUAL="${VISUAL:-$EDITOR}"

[[ -r "$DOTFILES/local/zshenv.local" ]] && source "$DOTFILES/local/zshenv.local"
