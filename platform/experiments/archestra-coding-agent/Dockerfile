# Archestra Coding Agent
# A custom MCP server combining Serena with Git/GitHub operations
#
# Build: docker build -t archestra-coding-agent .
# Run:   docker run -it --rm -e GITHUB_TOKEN=<token> archestra-coding-agent

FROM ghcr.io/oraios/serena:latest

# Set labels for the image
LABEL org.opencontainers.image.title="Archestra Coding Agent"
LABEL org.opencontainers.image.description="MCP server combining Serena semantic code operations with Git/GitHub tools"
LABEL org.opencontainers.image.source="https://github.com/archestra-ai/archestra"

# Install system dependencies
# - git: for git operations
# - gh: GitHub CLI (optional, for advanced operations)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Set up workspace directory (this will be the default project)
ENV WORKSPACE_DIR=/workspace
RUN mkdir -p /workspace && chmod 777 /workspace

# Copy requirements and install Python dependencies into Serena's venv using uv
COPY requirements.txt /app/custom_tools/requirements.txt
RUN uv pip install --python /workspaces/serena/.venv/bin/python -r /app/custom_tools/requirements.txt

# Copy custom tools
COPY src/ /app/custom_tools/src/

# Copy Serena configuration to the proper location
# This includes our custom tools in included_optional_tools
RUN mkdir -p /root/.serena/prompt_templates
COPY src/config/serena_config.yml /root/.serena/serena_config.yml
COPY src/config/prompt_templates/ /root/.serena/prompt_templates/

# Set up Python path to include custom tools
ENV PYTHONPATH="/app/custom_tools"
ENV SERENA_CUSTOM_TOOLS_PATH="/app/custom_tools"

# Copy and setup entrypoint script
COPY scripts/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set the entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]

# Default command: no additional args (entrypoint.py handles starting the MCP server)
CMD []
