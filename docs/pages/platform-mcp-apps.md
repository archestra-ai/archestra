---
title: MCP Apps
category: MCP
order: 4
description: Interactive UI rendering for MCP tool outputs
lastUpdated: 2026-03-22
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

MCP Apps allow MCP servers to return interactive UI alongside their tool outputs. When a tool result contains a UIResource, the Chat UI renders it in a sandboxed iframe instead of showing raw JSON.

## How It Works

1. An MCP server returns a tool result containing a `UIResource` object.
2. The Chat UI detects the UIResource in the tool output.
3. Instead of rendering JSON, an iframe displays the interactive content.

## UIResource Format

Tool results can include a UIResource in two ways:

**Top-level:**
```json
{
  "uri": "ui://weather-widget",
  "mimeType": "text/html",
  "text": "<html>...</html>"
}
```

**Nested in `_meta`:**
```json
{
  "data": { "temperature": 22 },
  "_meta": {
    "ui": {
      "uri": "ui://weather-widget",
      "mimeType": "text/html",
      "text": "<html>...</html>"
    }
  }
}
```

## Supported MIME Types

| MIME Type | Behavior |
|-----------|----------|
| `text/html` | Renders HTML content via iframe `srcdoc` |
| `text/uri-list` | Loads remote URL in iframe `src` |
| `application/remote-dom+json` | Reserved for future remote DOM support |

## Security

All MCP App content renders in a sandboxed iframe with restricted permissions:

- `allow-scripts` - JavaScript execution
- `allow-forms` - Form submission
- `allow-popups` - Opening new windows

The iframe cannot access the parent page's DOM, cookies, or storage.

## Communication Protocol

MCP Apps can communicate with the parent page via `postMessage`:

**Iframe to parent:**
- `ui-lifecycle-iframe-ready` - Iframe has loaded and is ready
- `ui-size-change` - Request height change: `{ type: "ui-size-change", height: 400 }`

**Parent to iframe:**
- `ui-lifecycle-auth` - Authentication nonce for handshake

## MCP Gateway Compatibility

UIResource metadata passes through the MCP Gateway transparently. External clients consuming tool results via the gateway will receive UIResource objects as-is and can implement their own rendering.

## LLM Gateway Compatibility

The LLM proxy preserves UIResource metadata in tool results during format conversion between providers (OpenAI, Anthropic, Gemini).
