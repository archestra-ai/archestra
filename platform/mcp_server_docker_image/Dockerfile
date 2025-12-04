# Multi-stage build for minimal final image
# Using Debian-slim instead of Alpine for reliable cross-platform builds
# (Alpine's musl libc has known issues with QEMU emulation for ARM64)
FROM python:3.12-slim AS python-builder

# Install Python build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
   gcc \
   libc6-dev \
   libffi-dev \
   libssl-dev \
   python3-dev \
   && rm -rf /var/lib/apt/lists/*

# Copy uv from the official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN chmod +x /usr/local/bin/uv

# Create virtual environment and install Python MCP dependencies
RUN uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN uv pip install --no-cache-dir \
   mcp[cli]>=1.2.0 \
   httpx \
   fastapi \
   uvicorn \
   requests>=2.31.0 \
   python-dotenv>=1.0.0

# Node.js stage
FROM node:20-slim AS node-builder

# Install Node.js MCP dependencies globally
RUN npm install -g \
   @modelcontextprotocol/sdk \
   typescript@5 \
   zod \
   express

# Final stage - minimal runtime image with Python 3.12
FROM python:3.12-slim

# Install runtime dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
   nodejs \
   npm \
   libstdc++6 \
   libgcc-s1 \
   openssl \
   ca-certificates \
   # Required for some Python packages
   libffi8 \
   # Process management
   tini \
   # Git for installing packages from git repositories
   git \
   # Network and SSL/TLS support
   curl \
   wget \
   # DNS resolution
   dnsutils \
   # Additional SSL/TLS libraries
   libssl-dev \
   # Go runtime for Go-based MCP servers
   golang-go \
   && rm -rf /var/lib/apt/lists/*

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

# Copy Node.js global modules from builder
COPY --from=node-builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-builder /usr/local/bin /usr/local/bin

# Create non-root user for running MCP servers
RUN groupadd -g 1000 mcp && \
   useradd -u 1000 -g mcp -d /home/mcp -m mcp

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
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default command (override when running specific MCP server)
CMD ["sh", "-c", "echo 'MCP base container ready. Override CMD to run your MCP server.'"]
