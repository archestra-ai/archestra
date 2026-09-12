ARG MCP_BASE_IMAGE=node:22.14.0-bookworm-slim
FROM ${MCP_BASE_IMAGE}

ARG MCP_SDK_VERSION=1.27.1
ARG ZOD_VERSION=4.3.6
RUN mkdir -p /opt/fixture \
  && npm install --omit=dev --no-audit --no-fund --prefix /opt/fixture "@modelcontextprotocol/sdk@${MCP_SDK_VERSION}" "zod@${ZOD_VERSION}"
COPY --chown=1001:1002 native-live-fixture-sdk.cjs /opt/fixture/native-live-fixture-sdk.cjs
