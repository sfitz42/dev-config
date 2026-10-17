# Neovim

> Config: [`sfitz42/nvim-config`](https://github.com/sfitz42/nvim-config), cloned to `~/.config/nvim` by the installer
> (see `external_repos` in `packages.yaml`). This page is a review of it at commit `3708e14`.
> **Last reviewed: 2026-10-16.** Suggestions only: nothing here has been applied to that repo.

**Platform:** any Unix (macOS and Linux).

> [!NOTE]
> **Beyond macOS**
>
> The config and the review apply on Linux unchanged. Install prerequisites (a C compiler, git,
> `ripgrep`, `fd`, Node) with your package manager instead of Homebrew.

## What it is today

About 300 lines of Lua. lazy.nvim (with a committed `lazy-lock.json`), the native Neovim LSP setup
(`lsp/*.lua` + `vim.lsp.enable`, no `nvim-lspconfig`), and a few plugins: blink.cmp, telescope,
nvim-tree, tokyonight, zen-mode, mason, treesitter, copilot.vim. Language servers: Lua, TypeScript,
Python (pylsp + ruff), Dockerfile and docker-compose.

Good choices worth keeping: the native `vim.lsp.config` layout, the lockfile, blink.cmp, and a
small plugin count.

> [!WARNING]
> **Things to fix (likely to bite)**
>
> 1. **`lua/lazy/` collides with lazy.nvim's own `lua/lazy/` module.** `require("lazy")` only works
>    because your directory has no `init.lua`. Rename it (for example `lua/config/` for `lazy_init`
>    and the standard `lua/plugins/` for specs, and `import = "plugins"`).
> 2. **nvim-treesitter is on the `master` branch** and uses `require("nvim-treesitter.configs")`.
>    Upstream has moved to a rewritten `main` branch for current Neovim; check whether `master` still
>    gets fixes for 0.12 and plan a migration. `ensure_installed` only has lua, javascript and
>    python: add at least `typescript`, `tsx`, `json`, `yaml`, `bash`, `dockerfile`, `markdown`,
>    `markdown_inline`, `vim`, `vimdoc`.
> 3. **Language servers are never installed for you.** Mason is set up but has no list, so a fresh
>    machine gets "command not found" for `lua-language-server`, `typescript-language-server`,
>    `pylsp`, `docker-langserver` and `docker-compose-langserver`. Either declare them
>    (`mason-tool-installer.nvim`) or install them from `packages.yaml`. Also, mason.nvim moved
>    from `williamboman/` to `mason-org/`.
> 4. **Telescope only maps `find_files`, and it needs `ripgrep`/`fd`** for the rest. `ripgrep` and
>    `fd` are now in `packages.yaml`; add `live_grep`, `buffers` and `help_tags` keymaps.

> [!TIP]
> **Suggestions, reviewed 2026-10-16 (taste, in rough priority order)**
>
> - **Match the rest of the setup.** Ghostty and Starship use Catppuccin Frappe; nvim uses
>   tokyonight-moon. `catppuccin/nvim` with `catppuccin-frappe` would make the terminal consistent.
> - **Replace the emoji icons** in blink.cmp and nvim-tree with Nerd Font glyphs (you install
>   MesloLGS NF) via `nvim-web-devicons`; emoji widths vary between terminals and misalign columns.
> - **Python tooling overlaps.** `pylsp` with ruff, flake8 and pyflakes lints the same things three
>   times. Consider ruff's own server (`ruff server`) for lint and format, plus one type-aware server
>   (`basedpyright`, or `ty`) instead of pylsp.
> - **Formatting for TypeScript is missing.** Add `conform.nvim` (prettier/ruff) with format-on-save
>   or a `<leader>f` mapping.
> - **Use the defaults Neovim 0.11+ already gives you.** `K` (hover), `grn`/`gra`/`grr`/`gri`
>   (rename, code action, references, implementation), `gO` (symbols) and `<C-s>` (signature) exist
>   with no config. Add only `gd` (definition) and diagnostic mappings (`vim.diagnostic.config` for
>   virtual text/float) on top.
> - **Sensible options in `set.lua`:** `undofile`, `ignorecase` + `smartcase`, `scrolloff`,
>   `signcolumn = "yes"`, `splitright`/`splitbelow`, `updatetime`, `clipboard = "unnamedplus"` if you
>   want the system clipboard, and `termguicolors`. `relativenumber` is a preference.
> - **Quieter plugin updates:** `checker = { enabled = true }` pops update notices; use
>   `checker = { enabled = true, notify = false }` or turn it off and update on purpose.
> - **File navigation:** you have both `<leader>pv` (netrw) and nvim-tree, with no keymap for the tree.
>   Pick one (`oil.nvim` is a popular third option) and map it.
> - **Small, high-value plugins to consider:** `gitsigns.nvim`, `which-key.nvim` (learn the keymaps),
>   a statusline (`lualine` or mini.statusline), `trouble.nvim` for diagnostics.
> - **Copilot:** `copilot.vim` needs a recent Node (mise provides it) and its ghost text can fight
>   blink.cmp's. Check the two together before keeping both.
> - **Write the README** (it is empty): prerequisites (git, a C compiler, Node, ripgrep, fd, a Nerd
>   Font), install, and the keymap list.

## Prerequisites on a fresh Mac

`neovim`, `git`, Xcode Command Line Tools (treesitter compiles parsers), Node (via mise; copilot and
the TypeScript/Docker servers), `ripgrep`, `fd`, and MesloLGS NF set as the terminal font.
