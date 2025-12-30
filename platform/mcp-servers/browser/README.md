# Browser MCP Server

Web browsing capabilities for Archestra agents using Playwright.

## Overview

This MCP server provides browser automation tools that allow agents to:
- Navigate to web pages
- Take screenshots
- Click elements
- Fill forms
- Extract page content
- Execute JavaScript

## Package

Uses the official Microsoft Playwright MCP package: [@playwright/mcp](https://github.com/microsoft/playwright-mcp)

## Building

```bash
docker build -t archestra-browser-mcp:latest .
```

## Available Tools

The Playwright MCP server provides these tools:

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_screenshot` | Take a screenshot of the current page |
| `browser_click` | Click an element on the page |
| `browser_fill` | Fill a form field |
| `browser_select` | Select an option from a dropdown |
| `browser_hover` | Hover over an element |
| `browser_evaluate` | Execute JavaScript in the browser |
| `browser_snapshot` | Get accessibility snapshot of the page |

## Configuration Options

| Argument | Description |
|----------|-------------|
| `--browser <browser>` | Browser to use: chrome, firefox, webkit, msedge |
| `--headless` | Run in headless mode (recommended for containers) |
| `--caps <caps>` | Additional capabilities: vision, pdf |
| `--device <device>` | Device to emulate (e.g., "iPhone 15") |

## Catalog Entry

To add this to Archestra's internal MCP catalog:

```json
{
  "name": "Browser",
  "description": "Web browsing via Playwright - navigate, screenshot, click, fill forms",
  "serverType": "local",
  "localConfig": {
    "dockerImage": "archestra-browser-mcp:latest",
    "command": "npx",
    "arguments": ["@playwright/mcp@latest", "--headless"],
    "transportType": "stdio",
    "environment": []
  }
}
```

## Security Considerations

- The browser runs in a sandboxed container
- Consider implementing URL whitelisting for production use
- Rate limiting should be applied at the profile/team level
