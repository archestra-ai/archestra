---
title: Using Claude Desktop (Cowork)
category: Examples
order: 9
description: Route Claude Desktop's inference and tools through Archestra
lastUpdated: 2026-07-03
---

<!--
Check ../docs_writer_prompt.md before changing this file.

Walkthrough for the /connection_beta?clientId=claude-desktop flow: connecting
Anthropic's Claude Desktop (Cowork) to Archestra with a single downloadable
configuration profile. Cover:
- What the profile wires up: inference through an LLM proxy + tools through an
  MCP gateway, both in one import; mcp block omitted when no gateway selected.
- The two embedded credentials: standard virtual key as the inference API key,
  passthrough virtual key in the X-Archestra-Virtual-Key custom header for
  per-user attribution (X-Archestra-Agent-Id identifies the client, not secret);
  key reuse across downloads and revocation on the Virtual Keys page.
- Prerequisites (LLM proxy with an Anthropic provider key, optional MCP gateway,
  llmVirtualKey:create, Claude Desktop developer mode).
- The end-to-end steps shown on the Connect page and mirrored in Claude Desktop:
  download profile -> Enable Developer Mode -> Configure Third-Party Inference ->
  Import configuration -> Test connection -> Apply Changes + relaunch ->
  connect the archestra-mcp-* connector via OAuth.
Screenshots live in /docs/automated_screenshots/platform-claude-desktop-example_*.
Don't restate obvious UI; keep it short.
-->

## Step 1. Download the configuration profile

On the **Connect** page, choose **Claude Desktop**, check the selections under **Review the setup**, and click **Download configuration**.

![The Connect page with Claude Desktop selected, showing the profile download and import steps](/docs/automated_screenshots/platform-claude-desktop-example_connect-page.webp)

## Step 2. Enable Developer Mode

In Claude Desktop go to **Help → Troubleshooting → Enable Developer Mode**.

![Enabling Developer Mode via Help → Troubleshooting](/docs/automated_screenshots/platform-claude-desktop-example_enable-developer-mode.webp)

## Step 3. Import the configuration profile

In Claude Desktop go to **Developer → Configure Third-Party Inference…**.

![Opening Configure Third-Party Inference from the Developer menu](/docs/automated_screenshots/platform-claude-desktop-example_configure-third-party-inference.webp)

Click **Default** in the top-right, from the dropdown choose **Import configuration…**, and select the downloaded configuration profile.

![Import configuration in the configurations dropdown](/docs/automated_screenshots/platform-claude-desktop-example_import-configuration.webp)

## Step 4. (Optional) Test the connection

Click **Test connection**. A green result means the proxy discovered your models and ran a one-token completion.

![Connection form populated by the import with a successful test](/docs/automated_screenshots/platform-claude-desktop-example_test-connection.webp)

## Step 5. Restart Claude Desktop

Click **Apply Changes**, then **Relaunch now**.

![Relaunch prompt after applying changes](/docs/automated_screenshots/platform-claude-desktop-example_apply-changes.webp)

After the restart, the account indicator in the bottom-left reads **Gateway**. Inference is now flowing through Archestra LLM Proxy.

## Step 6. Allow Claude Desktop access your MCP Gateway

The gateway is added but not signed in. Open **Settings → Connectors**, select the new `archestra-mcp-*` connector, then click **Connect**.

![Claude Desktop running on the gateway after relaunch](/docs/automated_screenshots/platform-claude-desktop-example_settings.webp)

![The Archestra connector before authorizing](/docs/automated_screenshots/platform-claude-desktop-example_connectors.webp)

Claude Desktop opens Archestra's consent screen in your browser; sign in and click **Allow**.

## Done

You can now leverage Archestra MCP orchestrator, guardrails and observability, all while enjoying your Claude Desktop app.
