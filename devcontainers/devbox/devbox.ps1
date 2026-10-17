# devbox for Windows (wslc). The implementation is Python (src/dotfiles/devbox), run through uv.
#   devbox.ps1 help
# Put this directory on PATH, or add a function to your profile:
#   function devbox { & "$HOME\path\to\dev-config\devcontainers\devbox\devbox.ps1" @args }
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Error 'devbox: uv not found (run scripts\bootstrap.ps1, or: winget install astral-sh.uv)'
    exit 1
}
$env:PYTHONPATH = if ($env:PYTHONPATH) { "$root\src;$env:PYTHONPATH" } else { "$root\src" }
# Pipeline input reaches a script as $input, not stdin: forward it (`"data" | devbox exec cat`)
if ($MyInvocation.ExpectingInput) {
    $input | & uv run --quiet --project $root python -m dotfiles.devbox @args
} else {
    & uv run --quiet --project $root python -m dotfiles.devbox @args
}
exit $LASTEXITCODE
