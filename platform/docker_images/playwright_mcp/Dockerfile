# Microsoft owns the browser dependencies; Archestra pins the complete image and
# replaces its vulnerable Node runtime. Keep both digests in versions.json.
# CVE-2026-111497: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG MCP_IMAGE=mcr.microsoft.com/playwright/mcp@sha256:690763cbb437ee7233f538a953bb5390bf03791eb5c965b471e59d17a6132fcb
FROM ${NODE_IMAGE} AS patched-node
FROM ${MCP_IMAGE}
# Node's official Linux binary bundles Brotli. Copy the binary, not a second
# OS/npm installation; inherited browser libraries and the unprivileged user stay.
COPY --from=patched-node /usr/local/bin/node /usr/local/bin/node
ENV NODE_VERSION=24.22.1
ARG PERL_BASE_VERSION=5.36.0-7+deb12u4
ARG EXPAT_VERSION=2.5.0-1+deb12u5
ARG OPENSSL_VERSION=3.0.22-1~deb12u2
USER root
# Signed Debian repositories provide the exact patches tracked in versions.json.
# The server uses preinstalled browsers, not npm/npx, Corepack or Yarn. Remove
# those build-time tools and their vulnerable transitive packages from runtime.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade --no-install-recommends \
      "perl-base=${PERL_BASE_VERSION}" \
      "libexpat1=${EXPAT_VERSION}" \
      "libssl3=${OPENSSL_VERSION}" \
 && rm -rf /var/lib/apt/lists/* \
      /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /opt/yarn-* /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
USER node
ENTRYPOINT ["node", "/app/cli.js", "--headless", "--browser", "chromium", "--no-sandbox"]
