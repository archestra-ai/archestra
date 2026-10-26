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
WORKDIR /app
USER node
ENTRYPOINT ["node", "/app/cli.js", "--headless", "--browser", "chromium", "--no-sandbox"]
