# Playwright MCP Server for Archestra

This directory contains the Dockerfile for the Playwright MCP Server, enabling Web Browsing capabilities for Archestra agents.

## Implementation Details

- **Base Image**: `mcr.microsoft.com/playwright:v1.49.0-jammy` (Includes Node.js and Browsers)
- **MCP Server**: `@modelcontextprotocol/server-playwright`
- **Transport**: Stdio (Standard Input/Output)

## Building the Image

```bash
docker build -t gcr.io/archestra-ai/mcp-server-playwright:v0.0.1 .
```

## Integration with Archestra

To make this server available in the Archestra Catalog, you must add an entry to the `internal_mcp_catalog` table in the database.

### SQL Insert Example

```sql
INSERT INTO internal_mcp_catalog (
  id, 
  name, 
  description, 
  server_type, 
  docker_image, 
  is_active
) VALUES (
  'playwright-web-browser', 
  'Web Browser (Playwright)', 
  'Allows agents to browse the web, click elements, and extract content using a headless browser.', 
  'local', 
  'gcr.io/archestra-ai/mcp-server-playwright:v0.0.1', 
  true
);
```

Once added, users can install this tool from the Catalog, and Archestra's runtime manager will spawn it as a Kubernetes Deployment (or Docker container) based on the image provided.

## Capabilities

The Playwright MCP server exposes tools like:
- `input`: Type text into input fields.
- `click`: Click elements.
- `scroll`: Scroll the page.
- `navigate`: Go to a URL.
- `screenshot`: Capture a screenshot.

## Security Note

This server runs a full browser instance. Ensure it is deployed in a sandboxed environment (as Archestra's K8s runtime does) to prevent SSRF or local network access exploits.
