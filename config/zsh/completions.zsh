# Completions. Sourced before compinit, so only fpath changes belong here.
# Drop `_name` completion files into completions/ to have them picked up.
typeset -U fpath
fpath=("$ZSH_CONFIG_DIR/completions" $fpath)
