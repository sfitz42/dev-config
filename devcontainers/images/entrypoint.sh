#!/usr/bin/env bash
# Container entrypoint: optionally starts dockerd and sshd, then runs the command
# (default: the image CMD) as a child so SIGTERM/SIGINT can shut the services
# down cleanly before the container stops.
#
# Controlled by environment variables (normally set by the `devbox` launcher):
#   DEVBOX_DOCKER=1          start the Docker daemon (needs --cap-add NET_ADMIN,SYS_ADMIN)
#   DEVBOX_SSHD=1            start sshd on DEVBOX_SSHD_PORT (default 2222), key-only
#   DEVBOX_SSH_PUBKEY        public key allowed to log in over SSH
#   DEVBOX_PROXY_INJECT=off  (default) leave docker containers/builds alone;
#                  =all    make the docker CLI inject HTTP(S)_PROXY/NO_PROXY into
#                          every build and container (breaks apps that ignore NO_PROXY)
# The daemon always pulls through HTTP(S)_PROXY when set.
set -uo pipefail

log() { echo "[devbox] $*" >&2; }

READY=/tmp/devbox-ready
rm -f "$READY"

SSHD_DIR="$HOME/.sshd"
SSHD_PORT="${DEVBOX_SSHD_PORT:-2222}"

# Named volumes are created root-owned; make the mount points usable by dev.
for d in "$HOME/.cache" "$HOME/.cache/uv" "$HOME/.npm" "$HOME/.zed_server"; do
  [ -d "$d" ] && [ "$(stat -c %U "$d")" != "$(id -un)" ] && sudo chown "$(id -un):$(id -gn)" "$d"
done

start_docker() {
  log "starting dockerd"
  # /proc/sys is mounted read-only; dockerd needs to enable IP forwarding
  sudo mount -o remount,rw /proc/sys
  sudo rm -f /var/run/docker.pid /var/run/docker.sock
  sudo env \
    "HTTP_PROXY=${HTTP_PROXY:-}" "HTTPS_PROXY=${HTTPS_PROXY:-}" "NO_PROXY=${NO_PROXY:-}" \
    sh -c 'nohup dockerd >>/var/log/dockerd.log 2>&1 &'

  local i
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  docker info >/dev/null 2>&1 || { log "dockerd failed to start; see /var/log/dockerd.log"; return 1; }

  # Client-side proxy injection is opt-in (see header)
  mkdir -p "$HOME/.docker"
  local cfg="$HOME/.docker/config.json" tmp
  tmp="$(mktemp)"
  [ -s "$cfg" ] || echo '{}' > "$cfg"
  if [ "${DEVBOX_PROXY_INJECT:-off}" = all ] && [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}" ]; then
    jq --arg h "${HTTP_PROXY:-}" --arg s "${HTTPS_PROXY:-}" --arg n "${NO_PROXY:-}" \
      '.proxies.default = {httpProxy: $h, httpsProxy: $s, noProxy: $n}' "$cfg" > "$tmp"
  else
    jq 'del(.proxies)' "$cfg" > "$tmp"
  fi
  mv "$tmp" "$cfg"
}

start_sshd() {
  log "starting sshd on port $SSHD_PORT"
  if [ -z "${DEVBOX_SSH_PUBKEY:-}" ]; then
    log "DEVBOX_SSHD=1 but DEVBOX_SSH_PUBKEY is empty; not starting sshd"
    return 1
  fi
  mkdir -p -m 700 "$HOME/.ssh" "$SSHD_DIR"
  printf '%s\n' "$DEVBOX_SSH_PUBKEY" > "$HOME/.ssh/authorized_keys"
  chmod 600 "$HOME/.ssh/authorized_keys"

  # Host key persists with the container, so clients can verify it across restarts
  [ -f "$SSHD_DIR/ssh_host_ed25519_key" ] \
    || ssh-keygen -q -t ed25519 -N '' -f "$SSHD_DIR/ssh_host_ed25519_key"

  # sshd sessions don't inherit the container's ENV; hand over what the
  # toolchain (node, uv, proxy, CA bundle) needs via ~/.ssh/environment.
  env | grep -E '^(PATH|NVM_DIR|PIPX_.*|UV_.*|PYTHON.*|NODE_.*|NPM_CONFIG_.*|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|[Hh][Tt][Tt][Pp][Ss]?_[Pp][Rr][Oo][Xx][Yy]|[Nn][Oo]_[Pp][Rr][Oo][Xx][Yy]|TZ|LANG|LC_ALL|DEV_USER)=' \
    > "$HOME/.ssh/environment" || true
  chmod 600 "$HOME/.ssh/environment"

  cat > "$SSHD_DIR/sshd_config" <<CONF
Port $SSHD_PORT
ListenAddress 0.0.0.0
HostKey $SSHD_DIR/ssh_host_ed25519_key
PidFile $SSHD_DIR/sshd.pid
AuthorizedKeysFile $HOME/.ssh/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
PermitUserEnvironment yes
Subsystem sftp internal-sftp
CONF
  rm -f "$SSHD_DIR/sshd.pid"
  /usr/sbin/sshd -f "$SSHD_DIR/sshd_config" -E "$SSHD_DIR/sshd.log"
}

stop_services() {
  if [ -f "$SSHD_DIR/sshd.pid" ]; then
    kill "$(cat "$SSHD_DIR/sshd.pid")" 2>/dev/null || true
  fi
  if pgrep -x dockerd >/dev/null 2>&1; then
    log "stopping dockerd"
    sudo pkill -TERM -x dockerd || true
    local i
    for i in $(seq 1 30); do
      pgrep -x dockerd >/dev/null 2>&1 || break
      sleep 1
    done
  fi
}

[ "${DEVBOX_DOCKER:-0}" = 1 ] && { start_docker || true; }
[ "${DEVBOX_SSHD:-0}" = 1 ] && { start_sshd || true; }
touch "$READY"

[ $# -gt 0 ] || set -- zsh

# Run the command as a child (stdin kept for interactive use) and forward signals.
"$@" <&0 &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' TERM INT HUP
wait "$child"
rc=$?
while kill -0 "$child" 2>/dev/null; do wait "$child"; rc=$?; done
stop_services
exit "$rc"
