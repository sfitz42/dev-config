# .zshrc: interactive shells. Thin on purpose: each concern lives in its own file so you can
# adopt pieces. Order matters: completions (fpath) -> plugins/Oh My Zsh -> everything else.

source "$ZSH_CONFIG_DIR/completions.zsh"   # fpath additions, must precede compinit
source "$ZSH_CONFIG_DIR/plugins.zsh"       # Oh My Zsh + plugins (runs compinit)
source "$ZSH_CONFIG_DIR/options.zsh"
source "$ZSH_CONFIG_DIR/aliases.zsh"
source "$ZSH_CONFIG_DIR/functions.zsh"

# Prompt: Starship with a transient prompt (collapses finished prompts to just the character)
if (( $+commands[starship] )); then
  eval "$(starship init zsh)"
  transient-accept-line() {
    local saved=$PROMPT
    PROMPT="$(starship module character --status="${STARSHIP_CMD_STATUS:-0}")"
    zle .reset-prompt
    PROMPT=$saved
    zle .accept-line
  }
  zle -N accept-line transient-accept-line
fi

# Language runtimes (Node, Python, ...) come from mise; global versions are in config/mise/config.toml
(( $+commands[mise] )) && eval "$(mise activate zsh)"

[[ -r "$DOTFILES/local/zshrc.local" ]] && source "$DOTFILES/local/zshrc.local"
true
