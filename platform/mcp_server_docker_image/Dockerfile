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
RUN uv pip install --no-cache-dir \
   mcp[cli]>=1.2.0 \
   httpx \
   fastapi \
   uvicorn \
   requests>=2.31.0 \
   python-dotenv>=1.0.0

# Node.js stage
FROM node:20-alpine AS node-builder

# Install Node.js MCP dependencies globally
RUN npm install -g \
   @modelcontextprotocol/sdk \
   typescript@5 \
   zod \
   express

# Final stage - minimal runtime image with Python 3.12
FROM python:3.12-alpine

# Install runtime dependencies only
RUN apk add --no-cache \
   nodejs \
   npm \
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
   go

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
