# LightRAG MCP Server Dockerfile
FROM python:3.11-slim AS base

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast package installation
RUN pip install uv

# Copy project files
COPY pyproject.toml README.md ./
COPY src/ src/

# Install dependencies
RUN uv pip install --system -e .

# Create data directory
RUN mkdir -p /app/data/input

# Set default environment variables
ENV LIGHTRAG_WORKING_DIR=/app/data \
    LIGHTRAG_HOST=0.0.0.0 \
    LIGHTRAG_PORT=8080 \
    LIGHTRAG_MCP_PATH=/mcp

# Expose MCP port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080${LIGHTRAG_MCP_PATH} || exit 1

# Run server
CMD ["python", "-m", "light_rag_mcp.server"]
