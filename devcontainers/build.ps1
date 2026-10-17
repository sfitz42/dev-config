# Build dev-core and dev-fullstack with wslc: the same as `devbox.ps1 build`.
#   .\build.ps1 [core|fullstack|all] [extra `wslc build` args]
& (Join-Path $PSScriptRoot 'devbox\devbox.ps1') build @args
exit $LASTEXITCODE
