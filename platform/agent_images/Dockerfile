# Curated Agent catalog images. The build context is platform/ so the built-in
# Archestra loop and every native CLI share one hardened execution base.
FROM node:24-bookworm-slim AS agent-base

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git gh jq less openssh-client \
      procps python3 python3-pip python3-venv ripgrep tmux \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
ENV COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /opt/archestra
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY runner-agent/package.json ./runner-agent/package.json
RUN pnpm install --filter @archestra/runner-agent --frozen-lockfile \
      --ignore-scripts
COPY runner-agent/tsconfig.json ./runner-agent/tsconfig.json
COPY runner-agent/src ./runner-agent/src
RUN pnpm --filter @archestra/runner-agent build \
 && chmod +x /opt/archestra/runner-agent/dist/index.js \
 && ln -s /opt/archestra/runner-agent/dist/index.js /usr/local/bin/archestra-runner-agent

COPY agent_images/bin /usr/local/bin
RUN chmod 0755 /usr/local/bin/archestra-*

ENV HOME=/home/node
RUN mkdir -p /home/node/workspace /var/run/archestra \
 && chown -R 1000:1000 /home/node /var/run/archestra
USER 1000:1000
WORKDIR /home/node/workspace

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

FROM agent-base AS agent-codex
USER root
RUN pnpm add --global @openai/codex@0.149.1 \
 && codex --version \
 && chown -R 1000:1000 /home/node
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

FROM agent-base AS agent-openclaw
USER root
RUN pnpm add --global openclaw@2026.7.1-2 \
 && openclaw --version \
 && chown -R 1000:1000 /home/node
USER 1000:1000
