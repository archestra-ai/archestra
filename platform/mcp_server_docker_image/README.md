# MCP Server Base Image

This is the base Docker image for running Model Context Protocol (MCP) servers in Archestra.

## Overview

The MCP Server Base Image provides a minimal, secure runtime environment for MCP servers written in Python or Node.js. It includes:

- Python 3.12 with MCP SDK and common dependencies
- Node.js 20 with TypeScript and MCP SDK
- Non-root user for enhanced security
- Health checks and proper signal handling
- Multi-stage build for minimal image size

## Usage

This image is used as the base for all MCP server containers in Archestra. MCP servers are run with dynamic command and arguments:

```bash
docker run gcr.io/archestra-ai/mcp-server-base:v0.0.1 <command> <args>
```

## Building locally

```bash
docker build -t mcp-server-base .
```

## Dependencies Included

### Python

- mcp[cli]>=1.2.0
- httpx
- fastapi
- uvicorn
- requests>=2.31.0
- python-dotenv>=1.0.0

### Node.js

- @modelcontextprotocol/sdk
- typescript@5
- zod
- express

## Security

- Runs as non-root user (uid: 1000, gid: 1000)
- Minimal Alpine Linux base
- Only essential runtime dependencies included
