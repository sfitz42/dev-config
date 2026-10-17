# Windows host setup: checks WSL (2.9.3+ for wslc), installs uv for devbox.ps1, and points you at
# the Linux side. Everything else (shell, packages, agents) is installed inside a WSL distro by
# scripts/bootstrap.sh.
#
#   .\scripts\bootstrap.ps1 [-DryRun]
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

function Say($msg) { Write-Host "`n==> $msg" }
function Run([string]$cmd, [string[]]$argv) {
    if ($DryRun) { Write-Host "[dry-run] $cmd $($argv -join ' ')"; return }
    & $cmd @argv
    if ($LASTEXITCODE -ne 0) { throw "$cmd failed (exit $LASTEXITCODE)" }
}

# 1. WSL with container support
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    Say 'Installing WSL (needs admin; reboot afterwards, then re-run this script)'
    Run wsl @('--install', '--no-distribution')
    exit 0
}
# `wsl --version` prints UTF-16; strip NULs before matching
$ver = ((wsl --version) -join "`n") -replace "`0", ''
$m = [regex]::Match($ver, 'WSL[^:]*:\s*([0-9.]+)')
if (-not $m.Success -or [version]$m.Groups[1].Value -lt [version]'2.9.3') {
    Say "Updating WSL (wslc needs 2.9.3+; found $($m.Groups[1].Value))"
    Run wsl @('--update')
} else {
    Write-Host "WSL $($m.Groups[1].Value): ok"
}
if (Get-Command wslc -ErrorAction SilentlyContinue) { Write-Host "wslc: $((wslc version) -join ' ')" }

# 2. uv (runs devbox.ps1 and the tests on Windows)
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Say 'Installing uv'
    Run winget @('install', '--id', 'astral-sh.uv', '--exact', '--accept-source-agreements', '--accept-package-agreements')
    Write-Host 'Open a new terminal so uv is on PATH.'
}

# 3. A distro for the dotfiles
$distros = ((wsl --list --quiet) -join "`n") -replace "`0", '' -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch '^docker-desktop' }
if (-not $distros) {
    Say 'No WSL distro yet. Install one, for example:'
    Write-Host '  wsl --install -d FedoraLinux-43     # or Ubuntu-24.04'
} else {
    Write-Host "distros: $(($distros | ForEach-Object { $_.Trim() }) -join ', ')"
}

Say 'Next'
Write-Host @'
  Inside the distro (clone onto the Linux filesystem, not /mnt/c):
    git clone <this repo> ~/.dev-config && cd ~/.dev-config
    ./scripts/bootstrap.sh --dry-run
    ./scripts/bootstrap.sh
  devbox on Windows (projects on the Windows drive are faster under wslc than distro paths):
    .\devcontainers\build.ps1
    cd C:\path\to\project; <repo>\devcontainers\devbox\devbox.ps1 up
'@
