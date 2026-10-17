# syntax=docker/dockerfile:1
#
# dev-core: stack-agnostic base. Fedora + non-root user + CA + build tools +
# git/ssh + Docker CLI + zsh (Oh My Zsh, Starship). No language runtimes; those
# live in the stack images.
#
# Build context is devcontainers/ (it must contain certificates/ and config/; build.sh stages
# config/zsh and starship.toml there from the repo's shared ../config/):
#   container build -t dev-core:0.1.0 -f images/core.Dockerfile .
# or just run ./build.sh

ARG FEDORA_VERSION=44

FROM fedora:${FEDORA_VERSION}

ARG DEV_BASE_VERSION=0.1.0
ARG FEDORA_VERSION
ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=1000
ARG TIMEZONE=Europe/London
ARG LOCALE=en_GB.UTF-8

LABEL org.opencontainers.image.title="dev-core" \
      org.opencontainers.image.description="Core dev image: Fedora, zsh (Oh My Zsh + Starship), git/ssh, Docker CLI" \
      org.opencontainers.image.version=$DEV_BASE_VERSION \
      org.opencontainers.image.authors="Shaun Fitzsimmons" \
      dev-core.fedora-version=$FEDORA_VERSION

# Child images use DEV_USER to build paths and switch back after `USER root`
ENV DEV_USER=${USERNAME}

# Timezone + locale (override at runtime with -e TZ=... -e LANG=...)
ENV TZ=${TIMEZONE} \
    LANG=${LOCALE} \
    LC_ALL=${LOCALE}

# Optional: internal CA certificates for a firewall / proxy. Any *.crt in certificates/ is trusted;
# the directory is empty in git (build.sh syncs certs from local/certificates/).
COPY certificates/ /tmp/certs/
RUN for c in /tmp/certs/*.crt; do \
      [ -e "$c" ] && install -m 644 "$c" /etc/pki/ca-trust/source/anchors/; \
    done; \
    update-ca-trust; rm -rf /tmp/certs

# Base tooling + upgrades
RUN dnf upgrade -y --setopt=install_weak_deps=False \
    && dnf install -y --setopt=install_weak_deps=False \
        @development-tools \
        ca-certificates \
        curl \
        openssh-clients \
        jq \
        less \
        procps-ng \
        sudo \
        findutils \
        which \
        zsh \
        git \
        glibc-langpack-en \
        tzdata \
        tar \
        gzip \
    && ln -sf /usr/share/zoneinfo/${TIMEZONE} /etc/localtime \
    && dnf clean all \
    && rm -rf /var/cache/libdnf5 /var/cache/dnf

# Docker CLI + buildx + compose from Docker's official Fedora repo.
# Daemon is NOT installed: point the CLI at a daemon via DOCKER_HOST at runtime.
RUN curl -fsSL https://download.docker.com/linux/fedora/docker-ce.repo \
        -o /etc/yum.repos.d/docker-ce.repo \
    && dnf install -y --setopt=install_weak_deps=False \
        docker-ce-cli \
        docker-buildx-plugin \
        docker-compose-plugin \
    && dnf clean all \
    && rm -rf /var/cache/libdnf5 /var/cache/dnf

# Non-root user with passwordless sudo (local dev container), plus a docker
# group for socket access
RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} --create-home --shell /usr/bin/zsh ${USERNAME} \
    && (getent group docker || groupadd docker) \
    && usermod -aG docker ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME} \
    && mkdir -p /home/${USERNAME}/workspace \
    && chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

# Starship prompt (system-wide binary)
RUN curl -fsSL -o /tmp/starship.tar.gz \
        "https://github.com/starship/starship/releases/latest/download/starship-$(uname -m)-unknown-linux-musl.tar.gz" \
    && tar -xzf /tmp/starship.tar.gz -C /usr/local/bin starship \
    && rm /tmp/starship.tar.gz \
    && starship --version

ENV PATH="/home/${USERNAME}/.local/bin:${PATH}"

USER ${USERNAME}
WORKDIR /home/${USERNAME}/workspace

# Oh My Zsh (zsh-autosuggestions and zsh-syntax-highlighting are bundled with it)
RUN git clone --depth 1 https://github.com/ohmyzsh/ohmyzsh.git ~/.oh-my-zsh

# Shell config: the same zsh modules as the Mac (config/zsh), installed as a mini dotfiles tree so the
# modules find their siblings. Per-image additions go in ~/.dotfiles/local/{zshenv,zshrc}.local.
# Starship palette is Catppuccin Frappe, matching the Ghostty theme.
COPY --chown=${USERNAME}:${USERNAME} config/zsh/ /home/${USERNAME}/.dotfiles/config/zsh/
RUN mkdir -p ~/.dotfiles/local \
    && ln -sf ~/.dotfiles/config/zsh/.zshenv ~/.zshenv \
    && ln -sf ~/.dotfiles/config/zsh/.zshrc ~/.zshrc
COPY --chown=${USERNAME}:${USERNAME} config/starship.toml /home/${USERNAME}/.config/starship.toml

ENV COLORTERM=truecolor

# No ENTRYPOINT so `container run <image> <cmd>` works directly
CMD ["zsh"]
