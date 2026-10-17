# Functions.

# Edit this repo's config files: ez (zsh), es (starship), ess (ssh)
ez()  { ${EDITOR:-nvim} "$ZSH_CONFIG_DIR/${1:-.zshrc}"; }
es()  { ${EDITOR:-nvim} "$DOTFILES/config/starship/starship.toml"; }
ess() { ${EDITOR:-nvim} "$DOTFILES/config/ssh/config"; }

# Reload zsh in place
reload() { exec zsh -l }

# Recover a wedged Apple `container` runtime by killing its helper processes (asks first)
(( $+commands[container] )) && container-reset() {
  local pat='container-(runtime-linux|network-vmnet|core-images|apiserver)'
  local pids; pids="$(pgrep -f "$pat")"
  [[ -z "$pids" ]] && { echo "no container helper processes running"; return 0 }
  echo "$pids" | xargs ps -o pid,command -p
  read -q "REPLY?Kill these? [y/N] " || { echo; return 1 }
  echo
  pkill -f "$pat"
  echo "done; run 'container system start' to bring it back"
}
