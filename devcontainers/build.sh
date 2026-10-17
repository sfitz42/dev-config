#!/usr/bin/env bash
# Build dev-core and dev-fullstack. Kept for muscle memory: this is `devbox build`
# (src/dotfiles/devbox/build.py), which picks Apple `container` or wslc.
#
# Usage: ./build.sh [core|fullstack|all] [extra `build` args]
#   ./build.sh                 # core, then fullstack
#   ./build.sh fullstack --no-cache
#   CORE_TAG=dev-core:0.1.0 FULLSTACK_TAG=dev-fullstack:0.1.0 ./build.sh
exec "$(dirname "$0")/devbox/devbox" build "$@"
