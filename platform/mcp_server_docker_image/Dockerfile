# Multi-stage build for minimal final image
FROM python:3.12-alpine AS python-builder

# Install Python build dependencies
RUN apk add --no-cache \
   gcc \
   musl-dev \
   libffi-dev \
   openssl-dev \
   python3-dev

# Copy uv from the official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN chmod +x /usr/local/bin/uv

# Create virtual environment and install Python MCP dependencies
RUN uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
# CVE-2026-24049: Path Traversal vulnerability in wheel <= 0.46.1
# CVE-2025-8869: Link Following vulnerability in pip <= 25.2
RUN uv pip install --upgrade wheel>=0.46.2 pip>=25.3
RUN uv pip install --no-cache-dir \
   mcp[cli]>=1.2.0 \
   httpx \
   fastapi \
   uvicorn \
   requests>=2.31.0 \
   python-dotenv>=1.0.0

# Node.js stage - using pnpm for reproducible builds
FROM node:20-alpine AS node-builder

# Install pnpm and patch bundled tar vulnerability
# CVE-2026-23745: tar <=7.5.2 has path traversal vulnerability
# CVE-2026-23950: tar <=7.5.3 has Improper Handling of Unicode Encoding
RUN corepack enable && \
    corepack prepare pnpm@10.28.2 --activate && \
    TAR_SHA256="0a9e6154532a0fa2f0f6fa261cede2f916da7d34df68917c6f71be82dd739dce" && \
    PNPM_TAR_PATHS=$(find /root/.cache/node/corepack -path "*/pnpm/*/dist/node_modules/tar" -type d 2>/dev/null) && \
    [ -n "$PNPM_TAR_PATHS" ] || { echo "WARNING: No tar directories found to patch"; exit 0; } && \
    for PNPM_TAR_PATH in $PNPM_TAR_PATHS; do \
        echo "Patching tar in $PNPM_TAR_PATH" && \
        TMP_DIR=$(mktemp -d) && \
        wget -qO "$TMP_DIR/tar.tgz" https://registry.npmjs.org/tar/-/tar-7.5.4.tgz && \
        echo "$TAR_SHA256  $TMP_DIR/tar.tgz" | sha256sum -c - || { echo "ERROR: checksum mismatch"; rm -rf "$TMP_DIR"; exit 1; } && \
        tar -tzf "$TMP_DIR/tar.tgz" >/dev/null 2>&1 || { echo "ERROR: Downloaded tarball is corrupt"; rm -rf "$TMP_DIR"; exit 1; } && \
        rm -rf "$PNPM_TAR_PATH"/* && \
        tar -xzf "$TMP_DIR/tar.tgz" -C "$PNPM_TAR_PATH" --strip-components=1 && \
        rm -rf "$TMP_DIR"; \
    done && \
    echo "Patched tar to 7.5.4 in all pnpm corepack caches"

WORKDIR /opt/node-deps

# Copy package.json and lockfile for reproducible builds
# CVE overrides are configured in package.json:
# - cross-spawn >= 7.0.5 (CVE-2024-21538: ReDoS)
# - glob >= 11.1.0 (CVE-2025-64756: OS Command Injection)
# - tar >= 7.5.4 (CVE-2026-23745, CVE-2026-23950: Path Traversal, Unicode Handling)
# - hono >= 4.11.7 (CVE-2025-*: IP spoofing, cache deception, key read)
# - lodash >= 4.17.23 (Prototype Pollution)
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# Final stage - minimal runtime image with Python 3.12
FROM python:3.12-alpine

# Install runtime dependencies only (excluding npm - we'll use pnpm)
RUN apk add --no-cache \
   nodejs \
   libstdc++ \
   libgcc \
   openssl \
   ca-certificates \
   # Required for some Python packages
   libffi \
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
   # CVE-2025-13878: BIND vulnerability fixed in 9.20.18-r0
   # CVE-2026-22796 and 11 others: OpenSSL vulnerabilities fixed in 3.5.5-r0
   apk upgrade --no-cache nodejs bind openssl

# Install pnpm globally for runtime use and patch bundled tar
# Use npm temporarily to install pnpm, then remove npm to avoid CVE-2026-23950
# Also patch tar in pnpm's bundled dependencies (CVE-2026-23745, CVE-2026-23950)
RUN apk add --no-cache npm && \
    npm install -g pnpm@10.28.2 && \
    TAR_SHA256="0a9e6154532a0fa2f0f6fa261cede2f916da7d34df68917c6f71be82dd739dce" && \
    PNPM_TAR_PATH="/usr/local/lib/node_modules/pnpm/dist/node_modules/tar" && \
    if [ -d "$PNPM_TAR_PATH" ]; then \
        echo "Patching tar in $PNPM_TAR_PATH" && \
        TMP_DIR=$(mktemp -d) && \
        wget -qO "$TMP_DIR/tar.tgz" https://registry.npmjs.org/tar/-/tar-7.5.4.tgz && \
        echo "$TAR_SHA256  $TMP_DIR/tar.tgz" | sha256sum -c - && \
        rm -rf "$PNPM_TAR_PATH"/* && \
        tar -xzf "$TMP_DIR/tar.tgz" -C "$PNPM_TAR_PATH" --strip-components=1 && \
        rm -rf "$TMP_DIR" && \
        echo "Patched tar to 7.5.4 in pnpm"; \
    fi && \
    apk del npm && \
    rm -rf /usr/lib/node_modules/npm /root/.npm

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

# Install uv using the official installation method
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:latest /uvx /usr/local/bin/uvx

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
