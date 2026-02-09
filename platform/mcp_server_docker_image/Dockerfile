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

# Node.js stage
FROM node:20-alpine AS node-builder

# Upgrade npm to 11.8.0 to get patched bundled dependencies (tar, glob, cross-spawn)
# CVE-2026-23950, CVE-2026-23745, CVE-2026-24842: tar vulnerabilities
# CVE-2025-64756: glob vulnerability
# CVE-2024-21538: cross-spawn vulnerability
RUN npm install -g npm@11.8.0 && \
    # Patch tar to 7.5.7 inside npm's bundled node_modules to fix CVE-2026-24842
    TAR_SHA256="87355a4cb10e7e7cdb4326e3e3c89232eaf5266d0792b998a396ddf6c11502bb" && \
    NPM_TAR_PATH="/usr/local/lib/node_modules/npm/node_modules/tar" && \
    if [ -d "$NPM_TAR_PATH" ]; then \
        TMP_DIR=$(mktemp -d) && \
        wget -qO "$TMP_DIR/tar.tgz" https://registry.npmjs.org/tar/-/tar-7.5.7.tgz && \
        echo "$TAR_SHA256  $TMP_DIR/tar.tgz" | sha256sum -c - && \
        rm -rf "$NPM_TAR_PATH"/* && \
        tar -xzf "$TMP_DIR/tar.tgz" -C "$NPM_TAR_PATH" --strip-components=1 && \
        rm -rf "$TMP_DIR" && \
        echo "Patched tar to 7.5.7 in npm"; \
    fi && \
    # Patch @isaacs/brace-expansion to 5.0.1 inside npm's bundled node_modules to fix GHSA-7h2j-956f-4vf2 (ReDoS)
    BRACE_SHA256="c908309f6735b002952f2b02563e68d98cba0375322a189ebc4f6f47637ee95b" && \
    NPM_BRACE_PATH="/usr/local/lib/node_modules/npm/node_modules/@isaacs/brace-expansion" && \
    if [ -d "$NPM_BRACE_PATH" ]; then \
        TMP_DIR=$(mktemp -d) && \
        wget -qO "$TMP_DIR/brace-expansion.tgz" https://registry.npmjs.org/@isaacs/brace-expansion/-/brace-expansion-5.0.1.tgz && \
        rm -rf "$NPM_BRACE_PATH"/* && \
        tar -xzf "$TMP_DIR/brace-expansion.tgz" -C "$NPM_BRACE_PATH" --strip-components=1 && \
        rm -rf "$TMP_DIR" && \
        echo "Patched @isaacs/brace-expansion to 5.0.1 in npm"; \
    fi

WORKDIR /opt/node-deps

# Copy package.json with dependencies and overrides to fix CVEs in transitive dependencies
# CVE-2024-21538: ReDoS in cross-spawn < 7.0.5
# CVE-2025-64756: OS Command Injection in glob < 11.1.0
# CVE-2026-23745: Path Traversal in tar <= 7.5.2
# CVE-2026-23950: Improper Unicode Handling in tar <= 7.5.3
# CVE-2026-24842: Path Traversal in tar <= 7.5.6
COPY package.json package-lock.json ./

RUN npm ci

# Final stage - minimal runtime image with Python 3.12
FROM python:3.12-alpine

# Install runtime dependencies only (npm copied from node-builder stage to avoid Alpine CVE)
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
   # CVE-2025-61732: Go vulnerability fixed in 1.25.7-r0
   apk upgrade --no-cache nodejs bind openssl go

# Copy npm from node-builder stage to avoid Alpine's vulnerable npm package (CVE-2026-23950)
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
