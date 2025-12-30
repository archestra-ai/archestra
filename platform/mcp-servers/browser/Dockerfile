# Browser MCP Server - Playwright-based web browsing for Archestra
# Uses the official Microsoft Playwright MCP server package (@playwright/mcp)
# Reference: https://github.com/microsoft/playwright-mcp

# Use official Playwright image with all browser dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.49.1-noble

# Set working directory
WORKDIR /app

# Install @playwright/mcp (version compatible with Playwright 1.49.1)
RUN echo '{"name": "archestra-browser-mcp", "version": "1.0.0", "private": true}' > package.json && \
    npm install @playwright/mcp@0.0.32

# Environment variables
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

# Default command - uses stdio transport
# --headless: run browser without display
# --isolated: allow multiple browser instances
# --no-sandbox: required for Docker containers
# --executable-path: use pre-installed Chromium from the image
CMD ["npx", "@playwright/mcp@0.0.32", "--headless", "--isolated", "--no-sandbox", "--executable-path", "/ms-playwright/chromium-1148/chrome-linux/chrome"]
