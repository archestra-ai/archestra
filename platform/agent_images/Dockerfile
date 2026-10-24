# Curated Agent catalog images. The build context is platform/ so the built-in
# Archestra loop and every native CLI share one hardened execution base.
FROM node:24-bookworm-slim AS agent-base

ARG TARGETARCH
ARG GH_VERSION=2.103.2

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git jq less openssh-client \
      procps python3 python3-venv ripgrep tmux \
 && rm -rf /var/lib/apt/lists/*

# Debian Bookworm still ships gh 2.23.0, built with Go 1.19.6. Install the
# official release built with patched Go, checking each architecture's archive.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) checksum=62ccf747115ddc61237efffdde66a3c8f70ba249433dc64f70801089b59c59c8 ;; \
      arm64) checksum=4c3e99a50bd8b181a3fe9d69b25dd978bac768148d88f01507c6b4d1ef61a443 ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" -o "${archive}"; \
    echo "${checksum}  ${archive}" | sha256sum -c -; \
    tar -xzf "${archive}" -C /tmp "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh; \
    rm -rf "${archive}" "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}"; \
    gh --version

# python3-venv on Bookworm bootstraps setuptools from a bundled 66.1.1 wheel.
# Replace that wheel so newly created environments start with a fixed version.
RUN curl -fsSL \
      "https://files.pythonhosted.org/packages/95/9c/c510029fc6ef33a6275cd2c5d3cecd6613dfd6aa401d57c54f1c18852ccf/setuptools-84.0.0-py3-none-any.whl" \
      -o /usr/share/python-wheels/setuptools-84.0.0-py3-none-any.whl \
 && echo "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670  /usr/share/python-wheels/setuptools-84.0.0-py3-none-any.whl" | sha256sum -c - \
 && rm /usr/share/python-wheels/setuptools-66.1.1-py3-none-any.whl \
 && python3 -m venv /tmp/agent-python-check \
 && /tmp/agent-python-check/bin/python -c "import setuptools; assert setuptools.__version__ == '84.0.0'" \
 && rm -rf /tmp/agent-python-check

# Keep system pip available to agents without Debian's vulnerable setuptools
# package, which python3-pip would pull back into the image.
RUN curl -fsSL \
      "https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl" \
      -o /tmp/pip-25.3-py3-none-any.whl \
 && echo "9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd  /tmp/pip-25.3-py3-none-any.whl" | sha256sum -c - \
 && mkdir -p /usr/local/lib/python3.11/dist-packages \
 && python3 -m zipfile -e /tmp/pip-25.3-py3-none-any.whl /usr/local/lib/python3.11/dist-packages \
 && rm /tmp/pip-25.3-py3-none-any.whl \
 && printf '%s\n' '#!/bin/sh' 'exec python3 -m pip "$@"' > /usr/local/bin/pip \
 && chmod 0755 /usr/local/bin/pip \
 && ln -s pip /usr/local/bin/pip3 \
 && python3 -m pip --version

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
RUN corepack disable \
 && npm install --global --ignore-scripts pnpm@11.28.7 \
 && rm -rf /usr/local/lib/node_modules/corepack \
 && pnpm --version

# npm in the Node base carries older vendored Undici and brace-expansion copies.
# pnpm has its own fixed copies; patch npm's separate bundle by verified tarballs.
RUN set -eu; \
    for spec in \
      'undici:6.29.1:29c4b8e0b2d86cb8795571c1959012ce057a14ecfd34858335f47c31e770a04f' \
      'brace-expansion:5.0.12:ef8448ec78f20b692f04fa6d01f39b5ab34c66404bea3429f5a39c6c9e0be8b4'; do \
      name="${spec%%:*}"; version_and_hash="${spec#*:}"; \
      version="${version_and_hash%%:*}"; checksum="${version_and_hash#*:}"; \
      directory="$(mktemp -d)"; archive="${directory}/${name}-${version}.tgz"; \
      curl -fsSL "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz" -o "${archive}"; \
      echo "${checksum}  ${archive}" | sha256sum -c -; \
      tar -xzf "${archive}" -C "${directory}"; \
      rm -rf "/usr/local/lib/node_modules/npm/node_modules/${name}"; \
      mv "${directory}/package" "/usr/local/lib/node_modules/npm/node_modules/${name}"; \
      rm -rf "${directory}"; \
    done; \
    node -e "const p='/usr/local/lib/node_modules/npm/node_modules/'; if (require(p+'undici/package.json').version !== '6.29.1' || require(p+'brace-expansion/package.json').version !== '5.0.12') process.exit(1)"

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
# Hermes 0.19.0 pins vulnerable versions; override its transitive packages
# until upstream publishes a fixed release. The startup test below exercises
# the resulting runtime.
RUN python3 -m venv /opt/hermes \
 && /opt/hermes/bin/pip install --no-cache-dir 'hermes-agent[mcp]==0.19.0' \
 && /opt/hermes/bin/pip install --no-cache-dir \
      Pillow==13.0.0 PyJWT==2.14.0 certifi==2026.10.19 \
      cryptography==50.0.0 mcp==1.28.1 starlette==1.3.1 \
      jaraco-context==6.1.0 wheel==0.46.2 \
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
COPY agent_images/openclaw /opt/agent-openclaw
RUN pnpm --dir /opt/agent-openclaw install --frozen-lockfile \
 && ln -s /opt/agent-openclaw/node_modules/.bin/openclaw /usr/local/bin/openclaw \
 && openclaw --version \
 && chown -R 1000:1000 /home/node
USER 1000:1000
