# Curated Agent catalog images. The build context is platform/ so every native
# CLI shares one hardened execution base.
FROM ghcr.io/astral-sh/uv:0.9.17@sha256:5cb6b54d2bc3fe2eb9a8483db958a0b9eebf9edff68adedb369df8e7b98711a2 AS uv
# The uv release Hermes locks its environment with.
FROM ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc AS uv-hermes

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

# CVE-2026-84782: require the fixed OpenSSL packages and refresh cached apt layers.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl ffmpeg fonts-dejavu-core git jq less libssl-dev libssl3 \
      openssh-client openssl pkg-config procps python3 python3-venv ripgrep tmux \
 && for package in openssl libssl3 libssl-dev; do \
      dpkg --compare-versions "$(dpkg-query -W -f='${Version}' "$package")" ge '3.0.22-1~deb12u2' || exit 1; \
    done \
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
      amd64) checksum=62ccf747115ddc61237efffdde66a3c8f70ba249433dc64f70801089b59c59c8 ;; \
      arm64) checksum=4c3e99a50bd8b181a3fe9d69b25dd978bac768148d88f01507c6b4d1ef61a443 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 3 \
      "https://github.com/cli/cli/releases/download/v2.103.2/gh_2.103.2_linux_${TARGETARCH}.tar.gz" \
      -o /tmp/gh.tar.gz \
 && echo "$checksum  /tmp/gh.tar.gz" | sha256sum -c - \
 && tar -xzOf /tmp/gh.tar.gz "gh_2.103.2_linux_${TARGETARCH}/bin/gh" > /usr/bin/gh \
 && chmod 0755 /usr/bin/gh \
 && rm /tmp/gh.tar.gz

COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=nitpicker-build /usr/local/cargo/bin/nitpicker /usr/local/bin/nitpicker

# Bookworm seeds new venvs from an old setuptools wheel. Keep the bootstrap
# wheel and system pip on fixed, checksum-verified versions.
RUN curl -fsSL \
      "https://files.pythonhosted.org/packages/95/9c/c510029fc6ef33a6275cd2c5d3cecd6613dfd6aa401d57c54f1c18852ccf/setuptools-84.0.0-py3-none-any.whl" \
      -o /usr/share/python-wheels/setuptools-84.0.0-py3-none-any.whl \
 && echo "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670  /usr/share/python-wheels/setuptools-84.0.0-py3-none-any.whl" | sha256sum -c - \
 && rm /usr/share/python-wheels/setuptools-66.1.1-py3-none-any.whl \
 && curl -fsSL \
      "https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl" \
      -o /tmp/pip-25.3-py3-none-any.whl \
 && echo "9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd  /tmp/pip-25.3-py3-none-any.whl" | sha256sum -c - \
 && mkdir -p /usr/local/lib/python3.11/dist-packages \
 && python3 -m zipfile -e /tmp/pip-25.3-py3-none-any.whl /usr/local/lib/python3.11/dist-packages \
 && rm /tmp/pip-25.3-py3-none-any.whl \
 && printf '%s\n' '#!/bin/sh' 'exec python3 -m pip "$@"' > /usr/local/bin/pip \
 && chmod 0755 /usr/local/bin/pip \
 && ln -s pip /usr/local/bin/pip3 \
 && python3 -m venv /tmp/agent-python-check \
 && /tmp/agent-python-check/bin/python -c "import setuptools; assert setuptools.__version__ == '84.0.0'" \
 && rm -rf /tmp/agent-python-check

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
RUN corepack disable \
 && rm -rf /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/npm \
 && curl -fsSL https://registry.npmjs.org/npm/-/npm-11.21.1.tgz -o /tmp/npm.tgz \
 && echo 'dd77c48eb845f4856c2cdba347cfb52bd877a2655a1ea48ff0c4796e3df9dd7b  /tmp/npm.tgz' | sha256sum -c - \
 && mkdir -p /usr/local/lib/node_modules/npm \
 && tar -xzf /tmp/npm.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm \
 && curl -fsSL https://registry.npmjs.org/undici/-/undici-6.29.1.tgz -o /tmp/undici.tgz \
 && echo '29c4b8e0b2d86cb8795571c1959012ce057a14ecfd34858335f47c31e770a04f  /tmp/undici.tgz' | sha256sum -c - \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
 && mkdir -p /usr/local/lib/node_modules/npm/node_modules/undici \
 && tar -xzf /tmp/undici.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/undici \
 && rm /tmp/npm.tgz /tmp/undici.tgz \
 && npm install --global --ignore-scripts pnpm@11.28.7 \
 && node --version && npm --version && pnpm --version

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
 && python3 /tmp/agent-image-tests/tui-exec.py \
 && python3 /tmp/agent-image-tests/development-tools.py \
 && node /tmp/agent-image-tests/npm-http.cjs

FROM agent-base AS agent-claude-code
USER root
RUN pnpm --config.ignore-scripts=false add --global @anthropic-ai/claude-code@2.1.308 \
 && CLAUDE_PACKAGE_DIR=$(pnpm list --global --json @anthropic-ai/claude-code | jq -r '.[0].dependencies["@anthropic-ai/claude-code"].path') \
 && node "$CLAUDE_PACKAGE_DIR/install.cjs" \
 && claude --version \
 && mkdir -p /home/node/.claude \
 && printf '%s\n' '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.308","theme":"dark","shiftEnterKeyBindingInstalled":true,"projects":{"/home/node/workspace":{"allowedTools":[],"hasTrustDialogAccepted":true}}}' > /home/node/.claude.json \
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
RUN pnpm add --global @openai/codex@0.164.0 \
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
RUN pnpm add --global opencode-ai@1.19.4 \
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
ARG TARGETARCH
USER root
# Hermes ships only from source (PyPI stopped at 0.19.0): build the release
# commit the way upstream's own image does. Python, uv, and every Python
# package come from the hash-locked versions in the checkout. Pillow, PyJWT,
# certifi, and urllib3 are raised past the lock's vulnerable versions; the startup
# tests below exercise the resulting runtime, including gateway discovery.
# Keep 0.22.2 until the persistent gateway used by 0.22.4 supports the
# required MCP startup guard and refreshes runtime bindings on session resume.
COPY --from=uv-hermes /uv /usr/local/bin/uv-hermes
RUN --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    hermes_version=0.22.2 \
 && hermes_commit=d923a5eb487a17c0a68801bba9ef0f56c81040a8 \
 && git clone --quiet --depth 1 --branch "v${hermes_version}" https://github.com/NousResearch/hermes-agent /opt/hermes \
 && test "$(git -C /opt/hermes rev-parse HEAD)" = "${hermes_commit}" \
 && case "${TARGETARCH}" in amd64) python_target=linux-x64 ;; arm64) python_target=linux-arm64 ;; *) exit 1 ;; esac \
 && set -- $(python3 -c 'import json, sys; a = json.load(open("/opt/hermes/pm/lock.json"))["packages"]["python"]["artifacts"][sys.argv[1]]; print(a["url"], a["sha256"])' "${python_target}") \
 && curl -fsSL "$1" -o /tmp/hermes-python.tgz \
 && echo "$2  /tmp/hermes-python.tgz" | sha256sum -c - \
 && mkdir -p /opt/hermes-python \
 && tar -xzf /tmp/hermes-python.tgz -C /opt/hermes-python --strip-components=1 \
 && rm /tmp/hermes-python.tgz \
 && /opt/hermes-python/bin/python3 -c 'import sqlite3, sys; assert sys.version_info[:2] == (3, 14); assert sqlite3.sqlite_version_info >= (3, 51, 3), sqlite3.sqlite_version' \
 && cd /opt/hermes \
 # Upstream's source package uses 0.0.0; stamp the verified release into its metadata.
 && python3 /tmp/agent-image-patches/hermes-release-version.py /opt/hermes "${hermes_version}" \
 && UV_NO_CONFIG=1 UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy uv-hermes sync --quiet --frozen --no-default-groups --extra mcp \
      --python /opt/hermes-python/bin/python3 --compile-bytecode \
 && UV_NO_CONFIG=1 uv-hermes pip install --quiet --python /opt/hermes/.venv/bin/python \
      Pillow==13.0.0 PyJWT==2.14.0 certifi==2026.10.19 urllib3==2.8.0 \
 && LEFTHOOK=0 npm_config_install_links=false node scripts/build/node-deps.mjs --source /opt/hermes --workspace ui-tui \
 && node scripts/build/tui.mjs --source /opt/hermes --out /opt/hermes-tui \
 && rm -rf node_modules ui-tui/node_modules /root/.npm /root/.cache \
      website apps tests tests-js evals \
 && .venv/bin/python scripts/write_install_stamp.py --output install-stamp.json \
      --commit "${hermes_commit}" --base-version "${hermes_version}" --distance 0 \
      --source docker --distribution docker --update-mechanism external \
 && printf '%s\n' docker > .install_method \
 # Discard superseded wheels and build-only installers, including pip's vendored packages.
 && rm -rf .git /home/node/.cache/uv /usr/local/bin/uv-hermes \
      /opt/hermes-python/lib/python3.14/site-packages/pip \
      /opt/hermes-python/lib/python3.14/site-packages/pip-*.dist-info \
      /opt/hermes-python/lib/python3.14/ensurepip \
      /opt/hermes-python/bin/pip* \
 && ln -s /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes \
 && hermes --version \
 && chown -R 1000:1000 /home/node
ENV HERMES_TUI_DIR=/opt/hermes-tui
ENV HERMES_NODE=/usr/local/bin/node
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    /opt/hermes/.venv/bin/python /tmp/agent-image-patches/hermes-tui-mcp-discovery.py \
 && /opt/hermes/.venv/bin/python /tmp/agent-image-patches/hermes-mcp-sdk-import.py \
 && /opt/hermes/.venv/bin/python /tmp/agent-image-patches/hermes-no-first-contact-note.py
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/hermes-startup.py

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py hermes

FROM agent-base AS agent-openclaw
USER root
COPY docker_images/agent/openclaw /opt/agent-openclaw
# The image pins OpenClaw; skip its startup update checks and notices.
ENV OPENCLAW_NO_AUTO_UPDATE=1
RUN pnpm --dir /opt/agent-openclaw install --frozen-lockfile \
 && ln -s /opt/agent-openclaw/node_modules/.bin/openclaw /usr/local/bin/openclaw \
 && openclaw --version \
 && chown -R 1000:1000 /home/node
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    # npm 12.2.1 fixes its bundled brace-expansion, but still bundles undici 6.29.0.
    # Reuse the checksummed 6.29.1 copy already installed for the global npm CLI.
    npm_dir=/opt/agent-openclaw/node_modules/.pnpm/npm@12.2.1/node_modules/npm && \
    test "$(node -p "require('${npm_dir}/package.json').version")" = 12.2.1 && \
    test "$(node -p "require('/usr/local/lib/node_modules/npm/node_modules/undici/package.json').version")" = 6.29.1 && \
    rm -rf "${npm_dir}/node_modules/undici" && \
    cp -a /usr/local/lib/node_modules/npm/node_modules/undici "${npm_dir}/node_modules/undici" && \
    node /tmp/agent-image-tests/npm-http.cjs "${npm_dir}/node_modules/undici" && \
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
      amd64) grok_arch=x64; checksum=3443e402a2dcaaa1dce0877fa61ee72d3a4a59e309762b0cc6860579b608cf96 ;; \
      arm64) grok_arch=arm64; checksum=9064136edf4ad7eadb0debc9e54832d05e66692dc0d1e69f36d9baaf1d0217bf ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && mkdir -p /tmp/grok /opt/grok/bin \
 && cd /tmp/grok \
 && npm pack --silent "@xai-official/grok-linux-${grok_arch}@1.0.69" \
 && tar -xzf "xai-official-grok-linux-${grok_arch}-1.0.69.tgz" \
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

# The npm package's postinstall only renames a previous Python kimi shim on
# global installs. Install the checksummed tarball without lifecycle scripts.
# Kimi finds ripgrep and fd on PATH instead of downloading its own copies.
FROM agent-base AS agent-kimi
USER root
# Set before the version check below so no Kimi process looks for updates.
ENV KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CLI_NO_AUTO_UPDATE=1 KIMI_DISABLE_TELEMETRY=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends fd-find \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/kimi \
 && cd /tmp/kimi \
 && mv "$(npm pack --silent @moonshot-ai/kimi-code@2.3.3)" kimi-code.tgz \
 && echo "dd5f1bc9cb9c7fd2a03d11f6ed2f037b6bb48a9f38fd1cb7169367ea08b9cfd266a041edf6fc626071d9aa231dc837f99cf9b86eff98286c0a1102f8a18a514f  kimi-code.tgz" | sha512sum -c - \
 && npm install --global --prefix /opt/kimi --ignore-scripts --no-audit --no-fund ./kimi-code.tgz \
 && ln -s /opt/kimi/bin/kimi /usr/local/bin/kimi \
 && cd / && rm -rf /tmp/kimi /root/.npm \
 && HOME=/tmp/kimi-version KIMI_CODE_HOME=/tmp/kimi-version kimi --version \
 && rm -rf /tmp/kimi-version \
 && chown -R 1000:1000 /home/node
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    python3 /tmp/agent-image-patches/kimi-user-mcp-only.py \
 && python3 /tmp/agent-image-patches/kimi-long-tool-call-ids.py
USER 1000:1000

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py kimi

# Redistribute the unmodified native binary and its license/notices together.
# No package lifecycle scripts or automatic updates run in this image.
FROM agent-base AS agent-copilot
USER root
ENV COPILOT_AUTO_UPDATE=false
RUN case "$TARGETARCH" in \
      amd64) copilot_arch=x64; copilot_checksum=f6a36bceb79c0d32f837de2d3ecc687170b5049f82ca45c68b029039d558ce9cb6e89778dea2ed19f60d22baebe22422f6502140fa7ae10e540c0910dc966057 ;; \
      arm64) copilot_arch=arm64; copilot_checksum=40afab4a82f1183efda96a4f19906157ff4a07fc803a77d3916b0001c44174544ede5a1214efdb90a0dbf3c695ad2318fe0b9ed7aee04ce4a947605674539b8e ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && mkdir -p /opt/copilot \
 && cd /tmp \
 && mv "$(npm pack --silent @github/copilot-linux-${copilot_arch}@1.0.103)" copilot.tgz \
 && echo "$copilot_checksum  copilot.tgz" | sha512sum -c - \
 && tar -xzf copilot.tgz --strip-components=1 -C /opt/copilot \
 && test -s /opt/copilot/LICENSE.md \
 && ln -s /opt/copilot/copilot /usr/local/bin/copilot \
 && COPILOT_HOME=/tmp/copilot-version COPILOT_OFFLINE=true copilot --no-auto-update --version \
 && rm -rf /tmp/copilot.tgz /tmp/copilot-version /root/.npm \
 && chown -R 1000:1000 /home/node
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/copilot.py
