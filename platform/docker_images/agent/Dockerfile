# Curated Agent catalog images. The build context is platform/ so every native
# CLI shares one hardened execution base.
FROM ghcr.io/astral-sh/uv:0.9.17@sha256:5cb6b54d2bc3fe2eb9a8483db958a0b9eebf9edff68adedb369df8e7b98711a2 AS uv

# One Rust toolchain both builds the review engine and ships in the runtime, so
# projects with native code (Archestra's addons included) compile in place.
FROM rust:1.93.0-bookworm AS rust

# Build the review engine once for each native architecture. Skills supply the
# review procedure and configuration; the runtime needs only this executable.
FROM rust AS nitpicker-build
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/* \
 && cargo install --git https://github.com/arsenyinfo/nitpicker.git \
      --rev 3530f2e0a2c2678f892f43b938a4f2516d94e8b9 \
      nitpicker --locked --features otel

FROM node:24-bookworm-slim AS agent-base
ARG TARGETARCH

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl ffmpeg fonts-dejavu-core git jq less libssl-dev libssl3 \
      openssh-client pkg-config procps python3 python3-pip python3-venv ripgrep tmux \
 && rm -rf /var/lib/apt/lists/*

# A local PostgreSQL with pgvector for projects that need a database. Debian's
# own postgresql-common enables the PGDG repository: bookworm's pgvector
# predates HNSW indexes. No cluster ships; the agent runs initdb under HOME,
# and the shared socket directory lets local clients connect without flags.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && sed -i 's/^#*\s*create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf \
 && apt-get install -y --no-install-recommends postgresql-18 postgresql-18-pgvector \
 && chmod 1777 /var/run/postgresql \
 && rm -rf /var/lib/apt/lists/*

# The toolchain stays read-only; downloaded crates and `cargo install` go to
# the persistent HOME, as do `uv tool` and `pip --user` commands.
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/home/node/.cargo
ENV PATH=/home/node/.local/bin:/home/node/.cargo/bin:/usr/local/cargo/bin:/usr/lib/postgresql/18/bin:$PATH

# Keep the real CLI at /usr/bin/gh: /usr/local/bin/gh is the managed credential
# reader, including when Git invokes its credential helper. Debian's old CLI
# queries retired Projects fields during PR edits.
RUN case "$TARGETARCH" in \
      amd64) checksum=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be ;; \
      arm64) checksum=ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 3 \
      "https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_linux_${TARGETARCH}.tar.gz" \
      -o /tmp/gh.tar.gz \
 && echo "$checksum  /tmp/gh.tar.gz" | sha256sum -c - \
 && tar -xzOf /tmp/gh.tar.gz "gh_2.100.0_linux_${TARGETARCH}/bin/gh" > /usr/bin/gh \
 && chmod 0755 /usr/bin/gh \
 && rm /tmp/gh.tar.gz

COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=nitpicker-build /usr/local/cargo/bin/nitpicker /usr/local/bin/nitpicker

# Tool environments and browsers stay outside HOME so a workspace mount cannot
# hide them. Skills are loaded at run time; no workflow or credentials ship here.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY docker_images/agent/requirements.lock /opt/agent-tools-requirements.lock
RUN uv venv --python /usr/bin/python3 /opt/agent-tools \
 && uv pip sync --python /opt/agent-tools/bin/python --require-hashes /opt/agent-tools-requirements.lock \
 && ln -s /opt/agent-tools/bin/shot-scraper /usr/local/bin/shot-scraper \
 && ln -s /opt/agent-tools/bin/playwright /usr/local/bin/playwright \
 && playwright install --with-deps chromium \
 && chmod -R a+rX /opt/agent-tools /opt/playwright \
 && rm -rf /var/lib/apt/lists/* /root/.cache

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
ENV COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

# npm's separately bundled Undici is not covered by application lockfiles.
# 6.29.1 fixes CVE-2026-109869 and has cleared the seven-day release-age window.
# Fetch the replacement before removing the copy npm itself uses to fetch it.
RUN cd /usr/local/lib/node_modules/npm/node_modules \
 && npm pack undici@6.29.1 \
 && rm -rf undici \
 && tar -xzf undici-6.29.1.tgz \
 && mv package undici \
 && rm undici-6.29.1.tgz

COPY docker_images/agent/bin /usr/local/bin
# The maintained launchers append this description of the machine to the
# Agent's instructions, so a run knows where to work and what is installed.
COPY docker_images/agent/environment.md /etc/archestra/agent-environment.md
# The backend sends this program to the workspace inline, so the image needs no
# copy to serve file transfers. One is installed anyway: it keeps the image's
# own test honest and gives anyone debugging inside a pod the same tool.
COPY backend/src/static/workspace-files.py /usr/local/bin/archestra-workspace-files
RUN chmod 0755 /usr/local/bin/archestra-*

ENV HOME=/home/node
RUN mkdir -p /home/node/workspace /var/run/archestra \
 && chown -R 1000:1000 /home/node /var/run/archestra
USER 1000:1000
WORKDIR /home/node/workspace

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/workspace-files.py \
 && python3 /tmp/agent-image-tests/interactive-resume.py \
 && python3 /tmp/agent-image-tests/development-tools.py \
 && node /tmp/agent-image-tests/npm-http.cjs

FROM agent-base AS agent-claude-code
USER root
RUN pnpm --config.ignore-scripts=false add --global @anthropic-ai/claude-code@2.1.285 \
 && CLAUDE_PACKAGE_DIR=$(pnpm list --global --json @anthropic-ai/claude-code | jq -r '.[0].dependencies["@anthropic-ai/claude-code"].path') \
 && node "$CLAUDE_PACKAGE_DIR/install.cjs" \
 && claude --version \
 && mkdir -p /home/node/.claude \
 && printf '%s\n' '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.285","theme":"dark","shiftEnterKeyBindingInstalled":true,"projects":{"/home/node/workspace":{"allowedTools":[],"hasTrustDialogAccepted":true}}}' > /home/node/.claude.json \
 && printf '%s\n' '{"skipDangerousModePermissionPrompt":true}' > /home/node/.claude/settings.json \
 && chmod 0600 /home/node/.claude.json /home/node/.claude/settings.json \
 && chown -R 1000:1000 /home/node
ENV DISABLE_AUTOUPDATER=1
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/claude-tui-start.py \
 && python3 /tmp/agent-image-tests/claude-auth.py

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py claude-code

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/claude-background-agents.py \
 && python3 /tmp/agent-image-tests/claude-background-work.py

FROM agent-base AS agent-codex
USER root
RUN pnpm add --global @openai/codex@0.153.0 \
 && codex --version \
 && chown -R 1000:1000 /home/node
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/codex-failure.py

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py codex

FROM agent-base AS agent-opencode
USER root
RUN pnpm add --global opencode-ai@1.18.23 \
 && OPENCODE_PACKAGE_DIR="$(pnpm list --global --json opencode-ai | jq -r '.[0].dependencies["opencode-ai"].path')" \
 && node "${OPENCODE_PACKAGE_DIR}/postinstall.mjs" \
 && opencode --version \
 && chown -R 1000:1000 /home/node
ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV OPENCODE_DISABLE_PROJECT_CONFIG=1
USER 1000:1000

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py opencode

FROM agent-base AS agent-hermes
USER root
RUN python3 -m venv /opt/hermes \
 && /opt/hermes/bin/pip install --no-cache-dir 'hermes-agent[mcp]==0.19.0' \
 && HERMES_SITE_PACKAGES=$(/opt/hermes/bin/python -c 'import site; print(site.getsitepackages()[0])') \
 && printf '%s\n' docker > "${HERMES_SITE_PACKAGES}/.install_method" \
 && ln -s /opt/hermes/bin/hermes /usr/local/bin/hermes \
 && hermes --version \
 && chown -R 1000:1000 /home/node
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    /opt/hermes/bin/python /tmp/agent-image-patches/hermes-tui-mcp-discovery.py
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/hermes-startup.py

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py hermes

FROM agent-base AS agent-openclaw
USER root
RUN pnpm add --global openclaw@2026.7.1-2 \
 && openclaw --version \
 && chown -R 1000:1000 /home/node
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    python3 /tmp/agent-image-patches/openclaw-mcp-required.py
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py openclaw

# The npm package's postinstall only unpacks the platform binary into
# ~/.grok/bin, under the persisted HOME, and writes ~/.grok/config.toml. Unpack
# the pinned, checksummed binary into the image instead; the launcher writes
# Grok's configuration at run time.
FROM agent-base AS agent-grok
ARG TARGETARCH
# Set before the version check below so no Grok process looks for updates.
ENV GROK_DISABLE_AUTOUPDATER=1
USER root
RUN case "$TARGETARCH" in \
      amd64) grok_arch=x64; checksum=297c002381f4d80246343aef5837c89fd69a759fccc15e549c9adeddd2b0aa52 ;; \
      arm64) grok_arch=arm64; checksum=05f62db666c802eea7f5aba1c1b3112a28bf345677ff36cb6f69a91ff9e1d02a ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && mkdir -p /tmp/grok /opt/grok/bin \
 && cd /tmp/grok \
 && npm pack --silent "@xai-official/grok-linux-${grok_arch}@1.0.67" \
 && tar -xzf "xai-official-grok-linux-${grok_arch}-1.0.67.tgz" \
 && echo "$checksum  package/bin/grok.br" | sha256sum -c - \
 && node -e 'const fs = require("fs"), zlib = require("zlib"); fs.writeFileSync("/opt/grok/bin/grok", zlib.brotliDecompressSync(fs.readFileSync("package/bin/grok.br")));' \
 && chmod 0755 /opt/grok/bin/grok \
 && ln -s /opt/grok/bin/grok /usr/local/bin/grok \
 && cd / && rm -rf /tmp/grok /root/.npm \
 && HOME=/tmp/grok-version grok --version \
 && rm -rf /tmp/grok-version \
 && chown -R 1000:1000 /home/node
USER 1000:1000

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py grok
