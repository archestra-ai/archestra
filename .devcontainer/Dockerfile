ARG NODE_IMAGE=node:20@sha256:a4545fc6f4f1483384ad5f4c71d34d71781c3779da407173ec6058079a718520
FROM ${NODE_IMAGE}

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=2.1.83
ARG CLAUDE_CODE_TARBALL_SHA512_BASE64=DrYl2aA0vOj157waWu/AUbBQNbekSB/yRXlEti92eY/vBCdVxw8rdubWjEYVtqZK36icdam73fokXCi7shs3aw==

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude && \
  chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
ARG GIT_DELTA_SHA256_AMD64=1658c7b61825d411b50734f34016101309e4b6e7f5799944cf8e4ac542cebd7f
ARG GIT_DELTA_SHA256_ARM64=937781aa7788e1510858743fff6c9a8b4a69fe0a22a7c8a69493e633227939a9
RUN ARCH=$(dpkg --print-architecture) && \
  if [ "${ARCH}" = "amd64" ]; then GIT_DELTA_SHA256="${GIT_DELTA_SHA256_AMD64}"; \
  elif [ "${ARCH}" = "arm64" ]; then GIT_DELTA_SHA256="${GIT_DELTA_SHA256_ARM64}"; \
  else echo "Unsupported architecture: ${ARCH}"; exit 1; fi && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  echo "${GIT_DELTA_SHA256}  git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" | sha256sum -c - && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
ARG ZSH_IN_DOCKER_SHA256=f74e5b08c295b6c3886654bb63c688e5ea16c58a4209435c4ddbab2c42fe9b41
RUN wget -O /tmp/zsh-in-docker.sh "https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh" && \
  echo "${ZSH_IN_DOCKER_SHA256}  /tmp/zsh-in-docker.sh" | sha256sum -c - && \
  sh /tmp/zsh-in-docker.sh -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x && \
  rm -f /tmp/zsh-in-docker.sh

# Install Claude from a pinned tarball and verify its published integrity hash first.
RUN CLAUDE_CODE_TARBALL_URL="https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${CLAUDE_CODE_VERSION}.tgz" && \
  wget -O /tmp/claude-code.tgz "${CLAUDE_CODE_TARBALL_URL}" && \
  CLAUDE_CODE_SHA512=$(openssl dgst -sha512 -binary /tmp/claude-code.tgz | openssl base64 -A) && \
  test "${CLAUDE_CODE_SHA512}" = "${CLAUDE_CODE_TARBALL_SHA512_BASE64}" && \
  npm install -g /tmp/claude-code.tgz && \
  rm -f /tmp/claude-code.tgz


# Copy and set up firewall script
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall
USER node
