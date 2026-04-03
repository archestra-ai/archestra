ARG PYTHON_IMAGE=python:3.12-alpine@sha256:7747d47f92cfca63a6e2b50275e23dba8407c30d8ae929a88ddd49a5d3f2d331
ARG NODE_IMAGE=node:20-alpine@sha256:b88333c42c23fbd91596ebd7fd10de239cedab9617de04142dde7315e3bc0afa
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.26@sha256:9a23023be68b2ed09750ae636228e903a54a05ea56ed03a934d00fe9fbeded4b

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

# Create virtual environment and install Python MCP dependencies from a locked manifest
RUN uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY pyproject.toml requirements.lock /tmp/python-deps/
# CVE-2026-24049: wheel path traversal fixed in wheel >= 0.46.2
# CVE-2025-8869: pip link-following issue fixed in pip >= 25.3
RUN uv pip install --upgrade wheel>=0.46.2 pip>=25.3
RUN uv pip sync \
   --no-cache \
   --require-hashes \
   --python-version 3.12 \
   --python-platform x86_64-unknown-linux-musl \
   /tmp/python-deps/requirements.lock

# Node.js stage
FROM ${NODE_IMAGE} AS node-builder

# Upgrade npm to a version whose bundled dependencies already include the tar/minimatch fixes
RUN npm install -g npm@11.12.0

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
   openssl-dev \
   # Go runtime for Go-based MCP servers
   go && \
   # CVE-2025-55130, CVE-2025-55131: Node.js vulnerabilities fixed in 24.13.0-r0
   # CVE-2026-21637: Node.js vulnerability
   # CVE-2025-13878: BIND vulnerability fixed in 9.20.18-r0
   # CVE-2026-22796 and 11 others: OpenSSL vulnerabilities fixed in 3.5.5-r0
   # CVE-2025-61732: Go vulnerability fixed in 1.25.7-r0
   # CVE-2026-22184: zlib vulnerability fixed in 1.3.2-r0
   # CVE-2026-32767: expat XML parser vulnerability
   apk upgrade --no-cache nodejs bind openssl go zlib expat

# Copy npm from node-builder stage to avoid Alpine's vulnerable npm package
# node:20-alpine has npm in /usr/local/lib/node_modules/npm
COPY --from=node-builder /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Upgrade system pip to fix CVE-2025-8869 (Link Following vulnerability in pip <= 25.2)
RUN pip install --upgrade pip>=25.3

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
