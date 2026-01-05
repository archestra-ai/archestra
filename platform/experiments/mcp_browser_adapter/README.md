# MCP Browser Adapter (Minimal)

A minimalist Model Context Protocol (MCP) server that provides a tool for extracting text content from web pages using Playwright.

## Features

- **Stateless Execution**: Each request launches a clean browser instance. No session data is persisted.
- **Interoperability**: Designed to be easily replaceable by alternative MCP-compatible browser tools.
- **SSRF Protection**: Built-in URL verification limits access to `http` and `https` protocols.
- **Predictable Performance**: Fixed 30s navigation timeout and deterministic text truncation (8000 characters) to ensure stable tool execution.
- **Structured Error Handling**: Returns descriptive error payloads for navigation failures, timeouts, and invalid inputs.

## Non-Goals

- This tool does **not** handle persistent authentication or cookies.
- This tool does **not** guarantee JavaScript execution completion beyond DOM load.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Install Playwright browsers:
   ```bash
   npx playwright install chromium
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Configuration

Add the server to your MCP client configuration:

```json
{
  "mcpServers": {
    "mcp-browser-adapter": {
      "command": "node",
      "args": ["path/to/build/server.js"]
    }
  }
}
```

## Tools

### `fetch_page_text`
Extracts all text from the `<body>` of a specified URL.
- **Arguments**:
  - `url` (string, required): The URL to browse (must be http/https).
- **Output**:
  - Returns a truncated text string (max 8000 chars). Truncation is intentional to bound tool output size.
