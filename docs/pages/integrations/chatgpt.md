---
title: ChatGPT
description: Use Archestra gateway tools in ChatGPT desktop, Chat, Work, and dots
order: 15
lastUpdated: 2026-10-30
---

Connect Archestra's gateway as a custom MCP plugin to use your organization's tools in ChatGPT. The **ChatGPT** client on **Connect** is separate from **Codex**: the Codex installer does not configure ChatGPT's plugins.

## Requirements

- Access to an Archestra MCP gateway and a ChatGPT account whose workspace permits custom MCP servers.
- A gateway reachable by ChatGPT through public HTTPS, or a separately configured [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). A desktop browser's access to localhost or a private network does not give ChatGPT the same access.
- OAuth client registration. Archestra enables automatic registration by default. If your deployment disables it, obtain a registered MCP OAuth client from your administrator.

## Connect ChatGPT

1. On **Connect**, select **ChatGPT**. Use **Choose what to include** to select a different gateway when available.
2. Click **Open ChatGPT Plugins**. In ChatGPT, select the plus button, then **Add custom MCP server**.
3. Enter a name and description. Under **Connection**, enter the gateway URL shown on Connect, including its full path. For Secure MCP Tunnel, select **Tunnel** and your configured tunnel instead.
4. Choose OAuth, review the requested access, and select **I understand and want to continue**, then **Create as a plugin**. Sign in to Archestra and approve access.
5. Review the discovered tools and install the resulting plugin. Start a new Chat or Work conversation in ChatGPT desktop, type `@`, and select the plugin. Ask which tools are available to check the connection.

For a dot, connect the plugin in that dot's configuration. Its plugin access remains subject to ChatGPT workspace policy. See OpenAI's [dot connection guide](https://learn.chatgpt.com/docs/dots/getting-started).

## Connection Limits

This flow connects MCP tools. It does not install Archestra's shared skills or approved client plugins, and it does not route ChatGPT's model requests through the LLM proxy. Claude Desktop's `.mcpb` installer is specific to Claude Desktop.

If custom MCP setup is unavailable, ask your ChatGPT workspace administrator about plugin permissions. For transport, OAuth, and tool-discovery failures, follow OpenAI's [connection and troubleshooting guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). After changing gateway tool metadata, refresh the connection in ChatGPT and test in a new conversation. To disconnect, remove the plugin connection in ChatGPT.
