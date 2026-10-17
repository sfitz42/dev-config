# Oh My Zsh as a plugin loader only (no theme: Starship draws the prompt).
# The installer clones Oh My Zsh to ~/.oh-my-zsh; zsh-autosuggestions and zsh-syntax-highlighting
# ship with it. Add your own under $ZSH_CUSTOM/plugins and list them below.

export ZSH="${ZSH:-$HOME/.oh-my-zsh}"
# Keep the completion dump in the cache dir, never beside the (versioned) config
export ZSH_COMPDUMP="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/zcompdump-${ZSH_VERSION}"
mkdir -p "${ZSH_COMPDUMP:h}"
ZSH_THEME=""
zstyle ':omz:update' mode reminder     # updates are driven by scripts/update.sh, not on shell start

# zsh-syntax-highlighting must stay last
plugins=(
  git
  zsh-autosuggestions
  zsh-syntax-highlighting
)

if [[ -r "$ZSH/oh-my-zsh.sh" ]]; then
  source "$ZSH/oh-my-zsh.sh"
else
  # Fallback without Oh My Zsh: bare completion init and Homebrew copies of the plugins
  autoload -Uz compinit && compinit -d "${XDG_CACHE_HOME:-$HOME/.cache}/zcompdump"
  for _p in zsh-autosuggestions zsh-syntax-highlighting; do
    for _d in "${HOMEBREW_PREFIX:-/opt/homebrew}/share/$_p" "/usr/share/$_p"; do
      [[ -r "$_d/$_p.zsh" ]] && { source "$_d/$_p.zsh"; break }
    done
  done
  unset _p _d
fi

[[ -r "$DOTFILES/local/plugins.local.zsh" ]] && source "$DOTFILES/local/plugins.local.zsh"
