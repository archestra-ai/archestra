# Curated Agent catalog images. The build context is platform/ so the built-in
# Archestra loop and every native CLI share one hardened execution base.
FROM node:24-bookworm-slim AS agent-base

ARG TARGETARCH

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git gh jq less openssh-client \
      procps python3 python3-pip python3-venv ripgrep \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
ENV COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /opt/archestra
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY runtime-agent/package.json ./runtime-agent/package.json
RUN pnpm install --filter @archestra/runtime-agent --frozen-lockfile \
      --ignore-scripts
COPY runtime-agent/tsconfig.json ./runtime-agent/tsconfig.json
COPY runtime-agent/src ./runtime-agent/src
RUN pnpm --filter @archestra/runtime-agent build \
 && chmod +x /opt/archestra/runtime-agent/dist/index.js \
 && ln -s /opt/archestra/runtime-agent/dist/index.js /usr/local/bin/archestra-runtime-agent

COPY agent_images/bin /usr/local/bin
RUN chmod 0755 /usr/local/bin/archestra-*

# Herdr is pinned to the immutable v0.9.0 Linux release at source commit
# b99002ac99b09e00b4ca692436cb15a6b0d676f1. Docker's automatic architecture
# name is translated to the upstream asset name and checked against both the
# release digest and its independently recorded byte count.
COPY agent_images/herdr/notices/herdr-v0.9.0-linux-notices.tar.gz /tmp/herdr-v0.9.0-linux-notices.tar.gz
RUN set -eux; \
    printf '%s  %s\n' \
      18e645c79df2e049bdecea3fa6fc6e099068e41d8f695f848ffcca5bb7e0fa0e \
      /tmp/herdr-v0.9.0-linux-notices.tar.gz | sha256sum --check --status; \
    case "${TARGETARCH}" in \
      amd64) \
        HERDR_ASSET=herdr-linux-x86_64; \
        HERDR_SHA256=4fa1a01158dd8043da92d31b270780b0dcc10603038d9b61cac4d81ab63fb71f; \
        HERDR_BYTES=24644488; \
        ;; \
      arm64) \
        HERDR_ASSET=herdr-linux-aarch64; \
        HERDR_SHA256=9c8db20fb7e7427b138d5367113f1621ffd319f2f65d6f009e2594029115f0d2; \
        HERDR_BYTES=22697240; \
        ;; \
      *) \
        echo "unsupported Herdr architecture: ${TARGETARCH}" >&2; \
        exit 1; \
        ;; \
    esac; \
    curl --fail --silent --show-error --location --retry 3 \
      --output "/tmp/${HERDR_ASSET}" \
      "https://github.com/herdrdev/herdr/releases/download/v0.9.0/${HERDR_ASSET}"; \
    printf '%s  %s\n' "${HERDR_SHA256}" "/tmp/${HERDR_ASSET}" | sha256sum --check --status; \
    test "$(wc -c < "/tmp/${HERDR_ASSET}")" -eq "${HERDR_BYTES}"; \
    install -D -m 0755 "/tmp/${HERDR_ASSET}" /usr/local/bin/herdr; \
    /usr/local/bin/herdr --version; \
    mkdir -p /usr/share/licenses/herdr; \
    tar --extract --gzip --file /tmp/herdr-v0.9.0-linux-notices.tar.gz \
      --strip-components=1 --directory /usr/share/licenses/herdr; \
    test -s /usr/share/licenses/herdr/README.md; \
    find /usr/share/licenses/herdr -type f -exec chmod 0644 {} +; \
    find /usr/share/licenses/herdr -type d -exec chmod 0755 {} +; \
    rm -f "/tmp/${HERDR_ASSET}" /tmp/herdr-v0.9.0-linux-notices.tar.gz

ENV HOME=/home/node
RUN mkdir -p /home/node/workspace /var/run/archestra \
 && chown -R 1000:1000 /home/node /var/run/archestra
USER 1000:1000
WORKDIR /home/node/workspace

# Every catalog target must pass the shared contract using its packaged
# terminal helpers, without network access or persistent test runtime state.
RUN --network=none \
    --mount=type=bind,source=agent_images/tests,target=/opt/agent-image-tests \
    --mount=type=tmpfs,target=/tmp \
    python3 /opt/agent-image-tests/pty-record.py \
 && python3 /opt/agent-image-tests/terminal.py \
 && find /var/run/archestra -mindepth 1 -delete

FROM agent-base AS agent-archestra

FROM agent-base AS agent-claude-code
USER root
RUN pnpm --config.ignore-scripts=false add --global @anthropic-ai/claude-code@2.1.247 \
 && CLAUDE_PACKAGE_DIR=$(pnpm list --global --json @anthropic-ai/claude-code | jq -r '.[0].dependencies["@anthropic-ai/claude-code"].path') \
 && node "$CLAUDE_PACKAGE_DIR/install.cjs" \
 && claude --version \
 && mkdir -p /home/node/.claude \
 && printf '%s\n' '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.247","theme":"dark","shiftEnterKeyBindingInstalled":true,"projects":{"/home/node/workspace":{"allowedTools":[],"hasTrustDialogAccepted":true}}}' > /home/node/.claude.json \
 && printf '%s\n' '{"skipDangerousModePermissionPrompt":true}' > /home/node/.claude/settings.json \
 && chmod 0600 /home/node/.claude.json /home/node/.claude/settings.json \
 && chown -R 1000:1000 /home/node
ENV DISABLE_AUTOUPDATER=1
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=agent_images/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/claude-account.py \
 && python3 /tmp/agent-image-tests/claude-auth.py

FROM agent-base AS agent-codex
USER root
RUN pnpm add --global @openai/codex@0.153.0 \
 && codex --version \
 && chown -R 1000:1000 /home/node
USER 1000:1000

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

FROM agent-base AS agent-hermes
USER root
RUN python3 -m venv /opt/hermes \
 && /opt/hermes/bin/pip install --no-cache-dir 'hermes-agent[mcp]==0.19.0' \
 && HERMES_SITE_PACKAGES=$(/opt/hermes/bin/python -c 'import site; print(site.getsitepackages()[0])') \
 && printf '%s\n' docker > "${HERMES_SITE_PACKAGES}/.install_method" \
 && ln -s /opt/hermes/bin/hermes /usr/local/bin/hermes \
 && hermes --version \
 && chown -R 1000:1000 /home/node
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=agent_images/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/hermes-startup.py

FROM agent-base AS agent-openclaw
USER root
RUN pnpm add --global openclaw@2026.7.1-2 \
 && openclaw --version \
 && chown -R 1000:1000 /home/node
USER 1000:1000
