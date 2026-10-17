#!/usr/bin/env bash
# Build dev-core and dev-fullstack with Apple `container`.
# Optional: route downloads through a host-side tinyproxy (for networks that block the container
# VM, e.g. a corporate TLS-inspecting proxy). Enabled when local/proxy/tinyproxy.conf exists
# (copy proxy/tinyproxy.conf.example there), or with USE_PROXY=1/0. Internal CA certificates in
# local/certificates/*.crt are copied into the build context and trusted by the image.
#
# Usage: ./build.sh [core|fullstack|all] [extra `container build` args]
#   ./build.sh                 # core, then fullstack
#   ./build.sh fullstack --no-cache
#   CORE_TAG=dev-core:0.1.0 FULLSTACK_TAG=dev-fullstack:0.1.0 ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd .. && pwd)"
LOCAL_PROXY_CONF="$REPO_ROOT/local/proxy/tinyproxy.conf"

CORE_TAG="${CORE_TAG:-dev-core:0.1.0}"
FULLSTACK_TAG="${FULLSTACK_TAG:-dev-fullstack:0.1.0}"

TARGET=all
case "${1:-}" in core|fullstack|all) TARGET="$1"; shift ;; esac
PROXY_HOST=192.168.64.1
PROXY_PORT=8888
PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
PIDFILE=/tmp/tinyproxy.pid

USE_PROXY="${USE_PROXY:-$([ -f "$LOCAL_PROXY_CONF" ] && echo 1 || echo 0)}"

# Stage shared config from the repo root into the (git-ignored) build context
rm -rf config && mkdir -p config
cp "$REPO_ROOT/config/starship/starship.toml" config/starship.toml
cp -R "$REPO_ROOT/config/zsh" config/zsh

# Sync private CA certificates into the build context
mkdir -p certificates
rm -f certificates/*.crt
for c in "$REPO_ROOT"/local/certificates/*.crt; do [ -e "$c" ] && cp "$c" certificates/; done

container system start
# The bridge address only exists while a VM is running; the builder provides one.
container builder start

PROXY_ARGS=()
if [ "$USE_PROXY" = 1 ]; then
  command -v tinyproxy >/dev/null || { echo "tinyproxy not found: brew install tinyproxy" >&2; exit 1; }
  [ -f "$LOCAL_PROXY_CONF" ] || { echo "USE_PROXY=1 needs $LOCAL_PROXY_CONF" >&2; exit 1; }
  for _ in $(seq 1 30); do
    ifconfig bridge100 2>/dev/null | grep -q "inet ${PROXY_HOST} " && break
    sleep 1
  done
  ifconfig bridge100 2>/dev/null | grep -q "inet ${PROXY_HOST} " \
    || { echo "bridge100 never got ${PROXY_HOST}" >&2; exit 1; }
  if ! { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }; then
    tinyproxy -c "$LOCAL_PROXY_CONF"
    sleep 1
  fi
  PROXY_ARGS=(
    --build-arg HTTP_PROXY="$PROXY" --build-arg HTTPS_PROXY="$PROXY"
    --build-arg http_proxy="$PROXY" --build-arg https_proxy="$PROXY"
    --build-arg NO_PROXY=localhost,127.0.0.1 --build-arg no_proxy=localhost,127.0.0.1
  )
fi

build() {  # build <tag> <dockerfile> [extra args]
  local tag="$1" file="$2"; shift 2
  container build ${PROXY_ARGS[@]+"${PROXY_ARGS[@]}"} \
    -t "$tag" -f "$file" "$@" .
}

case "$TARGET" in core|all)       build "$CORE_TAG" images/core.Dockerfile "$@" ;; esac
case "$TARGET" in fullstack|all)  build "$FULLSTACK_TAG" images/dev-fullstack.Dockerfile \
                                    --build-arg "CORE_IMAGE=$CORE_TAG" "$@" ;; esac
