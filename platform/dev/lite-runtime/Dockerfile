# syntax=docker/dockerfile:1
# Lite Agent Runtime image for Archestra work: the dev stack as plain
# processes (platform/scripts/dev-lite.sh), no Docker, kind, Helm or Tilt, so
# the pod needs no privilege and no Docker volume. See README.md.
#
# The public agent image already carries Node, pnpm, Rust, PostgreSQL 18 with
# pgvector, Playwright and tmux. This image adds the Rust components the
# repository's toolchain file asks for, warm dependency caches, and WireMock
# for the Playwright lite projects. Native addons are not baked in: dev-lite.sh
# installs the ones published for the checkout's archestra-rs tree.
#
# Build (from this directory):
#   docker build -t archestra-lite-runtime:dev .
ARG BASE_IMAGE=europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-claude-code:f80e33a1706019c355a80efb7343173f581ce042
FROM ${BASE_IMAGE}

# The commit whose dependency set is warmed into the image.
ARG WORKSPACE_REF=24d32b5e130a02cf5ed61fab7bc65dcded5807de
ARG WIREMOCK_VERSION=3.13.1
ARG WIREMOCK_SHA256=bdf4c705e7fd61c778e59a19f75396eac4520efeabfac97643a53979bd4d5716

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# lsof: dev-lite.sh frees stale listeners on :9000/:9050/:3000 with it.
# iproute2: `ss` for diagnostics. A headless JRE runs WireMock, the LLM
# provider stub the Playwright suite uses (the same version as the e2e chart).
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends lsof iproute2 openjdk-17-jre-headless \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/archestra-lite \
 && curl -fsSL --retry 3 \
      "https://repo1.maven.org/maven2/org/wiremock/wiremock-standalone/${WIREMOCK_VERSION}/wiremock-standalone-${WIREMOCK_VERSION}.jar" \
      -o /opt/archestra-lite/wiremock-standalone.jar \
 && echo "${WIREMOCK_SHA256}  /opt/archestra-lite/wiremock-standalone.jar" | sha256sum -c -

# platform/rust-toolchain.toml asks rustup for rustfmt, rust-analyzer and the
# musl targets. The toolchain home is read-only for the workspace user, so a
# task's first cargo command would fail trying to download them; add them here.
RUN rustup component add rustfmt rust-analyzer --toolchain 1.93.0-x86_64-unknown-linux-gnu \
 && rustup target add aarch64-unknown-linux-musl x86_64-unknown-linux-musl --toolchain 1.93.0-x86_64-unknown-linux-gnu \
 && chmod -R a+rX /usr/local/rustup

# Warm what is checkout-independent, in one layer that ends by deleting the
# throwaway checkout: the pnpm content-addressable store (task installs become
# hard links) and the frontend's pinned Playwright Chromium next to the shared
# browser. pnpm 11 ignores store-dir settings here and keeps the store in the
# HOME that contains the project (/home/node/.pnpm-store for a checkout under
# /home/node/workspace), so the warm checkout lives under HOME too.
RUN su node -s /bin/bash -c ' \
      set -euo pipefail; \
      export PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"; \
      git init -q /home/node/warm; \
      git -C /home/node/warm remote add origin https://github.com/archestra-ai/archestra.git; \
      git -C /home/node/warm fetch -q --depth 1 origin '"${WORKSPACE_REF}"'; \
      git -C /home/node/warm checkout -q --detach FETCH_HEAD; \
      cd /home/node/warm/platform; \
      CI=true pnpm install --frozen-lockfile; \
      du -sh "$(pnpm store path)"; \
    ' \
 && cd /home/node/warm/platform \
 && PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH" pnpm --filter @frontend exec playwright install chromium \
 && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" \
 && rm -rf /home/node/warm /root/.cache

COPY --chmod=0755 bin/archestra-dev-lite /usr/local/bin/archestra-dev-lite
RUN printf '%s\n' \
      '- Archestra dev stack without Docker or Kubernetes: `archestra-dev-lite up` in a checkout (PostgreSQL, backend on :9000, frontend on :3000); `archestra-dev-lite status|logs|down`. The backend does not watch for changes here: after editing backend code run `archestra-dev-lite reload backend` (rebuild and restart, about 15 s). The frontend dev server picks up its own changes.' \
      >> /etc/archestra/agent-environment.md

ENV ARCHESTRA_DEV_BACKEND_WATCH=false \
    ARCHESTRA_DEV_LITE_WIREMOCK_JAR=/opt/archestra-lite/wiremock-standalone.jar
USER 1000:1000
WORKDIR /home/node/workspace
