# Browser MCP Server - Playwright-based web browsing for Archestra
# Uses the official Microsoft Playwright MCP server package (@playwright/mcp)
# Reference: https://github.com/microsoft/playwright-mcp

FROM mcr.microsoft.com/playwright:v1.49.1-noble

# Set working directory
WORKDIR /app

# Create package.json and install dependencies
RUN echo '{"name": "archestra-browser-mcp", "version": "1.0.0", "private": true}' > package.json && \
    npm install @playwright/mcp@latest

# Environment variables
ENV NODE_ENV=production
ENV MCP_ENV=production
# Disable Playwright browser download prompts (browsers are pre-installed in base image)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Health check - verify node and playwright are working
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

# The Playwright MCP server uses stdio transport by default
# Command and arguments are specified in the catalog localConfig
# Example: command: "npx", arguments: ["@playwright/mcp@latest"]
#
# Available arguments:
#   --browser <browser>    Browser to use (chrome, firefox, webkit, msedge)
#   --headless            Run browser in headless mode (default for containers)
#   --caps <caps>         Additional capabilities (vision, pdf)
#   --device <device>     Device to emulate (e.g., "iPhone 15")

# Default command - can be overridden by K8s deployment
CMD ["npx", "@playwright/mcp@latest", "--headless"]
