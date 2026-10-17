# syntax=docker/dockerfile:1
#
# dev-fullstack: core + nvm-managed Node + uv-managed Python (zsh inherited from core).
#   container build -t dev-fullstack:0.1.0 -f dev-fullstack.Dockerfile .

ARG CORE_IMAGE=dev-core:0.1.0

FROM ${CORE_IMAGE}

ARG DEV_FULLSTACK_VERSION=0.1.0
# Pin nvm; check https://github.com/nvm-sh/nvm/releases for newer tags
ARG NVM_VERSION=0.40.3
# Default Node version installed at build time (any `nvm install` argument)
ARG NODE_VERSION=lts/*
# Pin to an exact uv release for reproducible builds (e.g. 0.9.0); empty = latest
ARG UV_VERSION=
# Default interpreter pre-installed at build time (any `uv python install` request)
ARG PYTHON_VERSION=3.14

LABEL dev-fullstack.version=$DEV_FULLSTACK_VERSION \
      dev-fullstack.nvm-version=$NVM_VERSION \
      dev-fullstack.default-node=$NODE_VERSION \
      dev-fullstack.uv-version=$UV_VERSION \
      dev-fullstack.default-python=$PYTHON_VERSION

ENV NODE_ENV=development

ENV PYTHON_ENV=development
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# nvm is incompatible with NPM_CONFIG_PREFIX, so it is deliberately NOT set.
# Global installs land in the active Node version's directory (user-owned).
ENV NVM_DIR=/home/${DEV_USER}/.nvm

# uv owns interpreters: ignore any system Python, download managed builds on demand
ENV UV_MANAGED_PYTHON=1
ENV UV_PYTHON_DOWNLOADS=automatic
# Workspaces are bind-mounted from the host, so hardlinking from the cache won't work
ENV UV_LINK_MODE=copy

# xz: nvm downloads Node as .tar.xz
# pipx: installs uv (pulls in the system python3, which also serves node-gyp)
# docker-ce + containerd.io + iptables: Docker daemon, started by devbox-entrypoint
#   when DEVBOX_DOCKER=1 (core only ships the CLI; repo is configured in core)
# openssh-server: for editors (Zed) over SSH, started by devbox-entrypoint when DEVBOX_SSHD=1
# Compilers come from core.
USER root
RUN dnf install -y --setopt=install_weak_deps=False \
        xz \
        pipx \
        docker-ce \
        containerd.io \
        iptables-nft \
        openssh-server \
    && dnf clean all \
    && rm -rf /var/cache/libdnf5 /var/cache/dnf

# '*' (not '!') so sshd treats the passwordless dev account as usable for key login
RUN usermod -p '*' ${DEV_USER}

COPY --chmod=755 images/entrypoint.sh /usr/local/bin/devbox-entrypoint

USER ${DEV_USER}

# Build steps run under bash (pipefail); the runtime shell is still zsh.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# --- Node -------------------------------------------------------------------

# Install nvm (PROFILE=/dev/null stops it editing shell rc files; wired up below)
RUN curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" \
        | PROFILE=/dev/null bash

# Install the default Node, then expose it at a stable path so direct commands
# (`container run ... npm test`) work without sourcing nvm.
RUN . "$NVM_DIR/nvm.sh" \
    && nvm install "${NODE_VERSION}" \
    && nvm alias default "${NODE_VERSION}" \
    && ln -sfn "$(dirname "$(dirname "$(nvm which default)")")" "$NVM_DIR/current" \
    && npm install -g corepack@latest \
    && corepack enable \
    && nvm cache clear

ENV PATH="${NVM_DIR}/current/bin:${PATH}"

# Hardening defaults (uncomment to taste)
# ENV NPM_CONFIG_IGNORE_SCRIPTS=true
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false

# --- Python -----------------------------------------------------------------

# Pin pipx's locations explicitly and put the bin dir on PATH, rather than
# relying on pipx defaults (which can differ by distro package)
ENV PIPX_HOME=/home/${DEV_USER}/.local/share/pipx
ENV PIPX_BIN_DIR=/home/${DEV_USER}/.local/bin
ENV PATH="${PIPX_BIN_DIR}:${PATH}"

# Installs uv and uvx into PIPX_BIN_DIR
RUN pipx install "uv${UV_VERSION:+==${UV_VERSION}}"

# Warm the cache with a default interpreter; projects can request others
# via .python-version, `requires-python`, or `uv python install 3.12`
RUN uv python install ${PYTHON_VERSION}

# --- zsh wiring -------------------------------------------------------------
# core's shared zsh modules source ~/.dotfiles/local/zshenv.local and zshrc.local, so this image
# adds its bits there instead of editing ~/.zshenv / ~/.zshrc:
#  - zshenv.local is read by every zsh (interactive or `zsh -c`), so `nvm` is always a function.
#  - zshrc.local gets nvm and uv completions, after Oh My Zsh has run compinit.
RUN printf 'export NVM_DIR="%s"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n' "$NVM_DIR" > ~/.dotfiles/local/zshenv.local \
    && printf '\n# nvm completion\nautoload -U +X bashcompinit && bashcompinit\n[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"\n' >> ~/.dotfiles/local/zshrc.local \
    && printf '\n# uv completion\neval "$(uv generate-shell-completion zsh)"\neval "$(uvx --generate-shell-completion zsh)"\n' >> ~/.dotfiles/local/zshrc.local

# --- Runtime CA bundle ------------------------------------------------------
# venvs / certifi-based clients don't use the system store by default.
# Set last: with SSL_CERT_FILE set, curl fails ("error adding trust anchors")
# on the build-time downloads above if the file is missing or unreadable.
# (/etc/pki/tls/certs/ is empty on this base image; /etc/ssl/certs/ca-bundle.crt
# links to the extracted trust store, which includes core's internal CA.)
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-bundle.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-bundle.crt

# --- Entrypoint -------------------------------------------------------------
# Starts dockerd / sshd when asked, then runs the CMD (inherited: zsh), so
# `container run -it <image>` still gives a shell and `<image> <cmd>` still works.
ENTRYPOINT ["/usr/local/bin/devbox-entrypoint"]
