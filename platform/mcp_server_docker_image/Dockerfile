ARG PYTHON_IMAGE=python:3.12-alpine@sha256:236173eb74001afe2f60862de935b74fcbd00adfca247b2c27051a70a6a39a2d
ARG NODE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.26@sha256:9a23023be68b2ed09750ae636228e903a54a05ea56ed03a934d00fe9fbeded4b
# Go toolchain is sourced from the official golang:alpine image because Alpine's
# community repo lags upstream Go patch releases. Stays binary-compatible since
# both images share the Alpine base.
ARG GOLANG_IMAGE=golang:1.25.11-alpine@sha256:c05ba4b73604069d376c4f41346b05374335b5ca0c46fb6dfede5a59f5196931

FROM ${GOLANG_IMAGE} AS go-bin

FROM ${UV_IMAGE} AS uv-bin

# Multi-stage build for minimal final image
FROM ${PYTHON_IMAGE} AS python-builder

# Install Python build dependencies
RUN apk add --no-cache \
   gcc \
   musl-dev \
   libffi-dev \
   openssl-dev \
   python3-dev

# Copy uv from a pinned upstream image to avoid floating build dependencies
COPY --from=uv-bin /uv /usr/local/bin/uv
RUN chmod +x /usr/local/bin/uv

# Create virtual environment and install Python MCP dependencies from a locked manifest.
# The venv stays bare (uv venv installs no pip/setuptools/wheel, and uv
# performs the sync from outside it): the pip+wheel previously installed
# here existed only to patch their own CVEs, and pip additionally VENDORS
# setuptools 70.3.0 and msgpack 1.1.2 copies (CVE-2025-47273,
# GHSA-6v7p-g79w-8964) that scanners flag and pip upstream has not bumped.
RUN uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY pyproject.toml requirements.lock /tmp/python-deps/
RUN uv pip sync \
   --no-cache \
   --require-hashes \
   --python-version 3.12 \
   --python-platform x86_64-unknown-linux-musl \
   /tmp/python-deps/requirements.lock

# Node.js stage
FROM ${NODE_IMAGE} AS node-builder

# Upgrade npm to a version whose bundled dependencies already include the fixes for
# tar CVE-2026-59873/CVE-2026-59874 (bundle ships tar 7.5.19), picomatch
# CVE-2026-33671, sigstore CVE-2026-48815, and undici CVE-2026-12151 (bundle
# ships 6.27.0, which previously required a manual bundle swap on 11.17.0).
# npm 11.18.0 was published 2026-06-29 and has cleared the 7-day release-age practice.
# Overwrite bundled brace-expansion to patch CVE-2026-14257 and then CVE-2026-69152
# (both uncontrolled resource consumption): the bundle ships 5.0.7 via minimatch 10.2.5,
# and no npm release carries the fixed 5.0.9 — 11.18.0 is the last 11.x, while
# 12.0.0/12.0.1 still bundle 5.0.7 and require Node >=22 (this stage is node:20-alpine).
# Same-major swap, API compatible: minimatch 10.2.5 asks for ^5.0.5, and 5.0.9 keeps
# 5.0.7's `balanced-match: ^4.0.2`, already satisfied by the bundled balanced-match 4.0.4,
# and still declares `node: 20 || >=22`. `npm pack` must run BEFORE the old copy is
# removed: npm reaches brace-expansion through minimatch/glob, so deleting it first leaves
# npm unable to run the very command that fetches the replacement.
RUN npm install -g npm@11.18.0 && \
    cd /usr/local/lib/node_modules/npm/node_modules && \
    npm pack brace-expansion@5.0.9 && \
    rm -rf brace-expansion && \
    tar -xzf brace-expansion-5.0.9.tgz && \
    mv package brace-expansion && \
    rm brace-expansion-5.0.9.tgz

WORKDIR /opt/node-deps

# Copy package manifests for the MCP Node.js runtime dependencies.
# Security-sensitive transitive packages are constrained in package.json overrides
# where they still affect the resolved dependency graph.
COPY package.json package-lock.json ./

RUN npm ci

# Final stage - minimal runtime image with Python 3.12
FROM ${PYTHON_IMAGE}

# Install runtime dependencies only (npm copied from node-builder stage to avoid Alpine CVE)
RUN apk add --no-cache \
   nodejs \
   libstdc++ \
   libgcc \
   openssl \
   ca-certificates \
   # Required for some Python packages
   libffi \
   zlib \
   # Process management
   tini \
   # Git for installing packages from git repositories
   git \
   # Network and SSL/TLS support
   curl \
   wget \
   # DNS resolution
   bind-tools \
   # Additional SSL/TLS libraries
   openssl-dev && \
   # CVE-2025-55130, CVE-2025-55131: Node.js vulnerabilities fixed in 24.13.0-r0
   # CVE-2026-21637: Node.js vulnerability
   # CVE-2025-13878: BIND vulnerability fixed in 9.20.18-r0
   # CVE-2026-22796 and 11 others: OpenSSL vulnerabilities fixed in 3.5.5-r0
   # CVE-2026-22184: zlib vulnerability fixed in 1.3.2-r0
   # CVE-2026-32767: expat XML parser vulnerability
   # CVE-2026-40200 (musl 1.2.5-r23) is covered by the pinned base image digest
   # CVE-2026-6276, CVE-2026-5773: curl/libcurl vulnerabilities (HIGH) fixed in 8.20.0-r0.
   # The base image ships 8.19.0-r0; the explicit `apk add curl` above installs it, so
   # curl/libcurl must be listed here to be upgraded to the fixed version.
   # Go runtime is copied from the golang:1.25.11-alpine image below to pick up the
   # Go stdlib HIGH CVEs fixed in 1.25.10 (CVE-2026-42499/39836/39820/33814/33811) and
   # 1.25.11 (CVE-2026-42504) that Alpine's apk index has not yet shipped.
   apk upgrade --no-cache nodejs bind openssl zlib expat curl libcurl

# Go toolchain sourced from upstream Alpine-based image (Alpine apk currently ships go-1.25.9-r0)
COPY --from=go-bin /usr/local/go /usr/local/go

# Copy npm from node-builder stage to avoid Alpine's vulnerable npm package
# node:20-alpine has npm in /usr/local/lib/node_modules/npm
COPY --from=node-builder /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Remove pip and setuptools from the system interpreter instead of chasing
# their CVEs: the base image ships setuptools 70.3.0 (CVE-2025-47273) and a
# pip whose _vendor tree carries setuptools 70.3.0 and msgpack 1.1.2
# (GHSA-6v7p-g79w-8964) — versions pip upstream still vendors, so no
# upgrade fixes them. Nothing in this image installs with pip: uv is the
# installer, and the skill sandbox already shims pip off (see
# sandbox-core's dagger backend). The shim left behind gives a clear error
# instead of "command not found".
RUN python -m pip uninstall -y setuptools pip && \
    printf '%s\n' '#!/bin/sh' 'echo "error: pip is not available in this image. Use uv instead." >&2' 'exit 1' > /usr/local/bin/pip && \
    chmod +x /usr/local/bin/pip && \
    ln -sf pip /usr/local/bin/pip3 && \
    ln -sf pip /usr/local/bin/pip3.12

# Copy Python environment from builder
COPY --from=python-builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

# Set up Go environment
ENV GOPATH=/home/mcp/go
ENV PATH=$GOPATH/bin:/usr/local/go/bin:$PATH

# Update CA certificates and configure git to use system certificates
RUN update-ca-certificates && \
    git config --global http.sslCAInfo /etc/ssl/certs/ca-certificates.crt

# Install uv from the same pinned upstream image in the runtime stage
COPY --from=uv-bin /uv /usr/local/bin/uv
COPY --from=uv-bin /uvx /usr/local/bin/uvx

# Make sure uv and uvx are executable
RUN chmod +x /usr/local/bin/uv /usr/local/bin/uvx

# Copy Node.js modules from builder and set up NODE_PATH for module resolution
COPY --from=node-builder /opt/node-deps/node_modules /opt/node-deps/node_modules
ENV NODE_PATH=/opt/node-deps/node_modules

# Set up TypeScript compiler binary
RUN ln -s /opt/node-deps/node_modules/.bin/tsc /usr/local/bin/tsc && \
    ln -s /opt/node-deps/node_modules/.bin/tsserver /usr/local/bin/tsserver

# Create non-root user for running MCP servers
RUN addgroup -g 1000 mcp && \
   adduser -u 1000 -G mcp -D -h /home/mcp mcp

# Set up working directory
WORKDIR /home/mcp

# Configure git for the mcp user before switching
RUN git config --system http.sslVerify true && \
    git config --system http.postBuffer 524288000 && \
    git config --system http.timeout 180 && \
    git config --system core.compression 0

USER mcp

# Common environment variables for MCP servers
ENV MCP_ENV=production
ENV NODE_ENV=production

# Health check for container monitoring
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
   CMD node -e "process.exit(0)" && python3 -c "exit(0)" && go version

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Default command (override when running specific MCP server)
CMD ["sh", "-c", "echo 'MCP base container ready. Override CMD to run your MCP server.'"]
