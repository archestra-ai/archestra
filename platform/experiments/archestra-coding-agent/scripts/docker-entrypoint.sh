#!/bin/bash
# Archestra Coding Agent Docker Entrypoint
# Configures git and starts the MCP server with custom tools

# If GITHUB_TOKEN is set, configure git to use it for HTTPS
if [ -n "$GITHUB_TOKEN" ]; then
    git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'
fi

# Configure git with safe defaults
git config --global init.defaultBranch main
git config --global --add safe.directory "*"
git config --global user.email "coding-agent@archestra.ai"
git config --global user.name "Archestra Coding Agent"

# Run the Python entrypoint which registers tools and starts Serena
exec python /app/custom_tools/src/entrypoint.py "$@"
