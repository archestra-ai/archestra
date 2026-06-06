# Windmill MCP Server
# Packaged as a Docker image for Archestra's K8s-based MCP server runtime.
#
# Build:  docker build -t windmill-mcp .
# Run:    docker run --rm -e WINDMILL_BASE_URL=... -e WINDMILL_TOKEN=... \
#                          -e WINDMILL_WORKSPACE=... windmill-mcp

FROM python:3.12-slim

LABEL org.opencontainers.image.title="Windmill MCP Server"
LABEL org.opencontainers.image.description="MCP server for Windmill workflow automation — create, run, and manage flows from AI agents in Archestra"
LABEL org.opencontainers.image.source="https://github.com/archestra-ai/archestra"

# Install uv for fast dependency installation
RUN pip install --no-cache-dir uv

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

# Copy package
COPY src/ ./src/
COPY pyproject.toml .

# Install the package itself
RUN uv pip install --system --no-cache -e .

# Run as non-root
RUN useradd -m -u 1000 mcp && chown -R mcp:mcp /app
USER mcp

# stdio transport — Archestra connects via stdin/stdout
ENTRYPOINT ["python", "-m", "windmill_mcp.server"]
