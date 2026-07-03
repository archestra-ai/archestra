---
title: Using Claude Desktop (Cowork)
category: Examples
order: 9
description: Route Claude Desktop's Cowork inference and tools through Archestra with one importable configuration profile
lastUpdated: 2026-07-02
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

Claude Desktop's Cowork mode lets non-technical teammates run agentic tasks. Pointing it at Archestra brings that traffic under the same governance as the rest of your platform: inference is routed through an [LLM proxy](/docs/platform-llm-proxy), and Cowork gets your organization's tools through an [MCP gateway](/docs/platform-mcp-gateway). Both are wired up by one configuration profile generated on the **Connect** page, so no JSON is edited by hand.

![The Connect page with Claude Desktop selected, showing the profile download and import steps](/docs/automated_screenshots/platform-claude-desktop-example_connect-page.webp)

## What the profile wires up

The downloaded profile carries two independent connections:

- **Inference** points Claude Desktop at `…/v1/anthropic/<proxy-id>` instead of Anthropic directly. Spend lands in [Costs & Limits](/docs/platform-costs-and-limits), requests are traced in [Observability](/docs/platform-observability), and proxy policies such as [Dual LLM](/docs/platform-dual-llm) apply.
- **Tools** register the gateway as a managed MCP server named `archestra-mcp-<gateway-slug>` at `…/v1/mcp/<gateway-slug>`. It uses OAuth (dynamic client registration), so the gateway authenticates and attributes every tool call as the signed-in user - see [MCP Authentication](/docs/mcp-authentication). This part is optional: with no gateway selected the profile is inference-only.

It also embeds two [virtual keys](/docs/platform-llm-proxy-authentication), which is why the profile is generated rather than typed in:

- The **Gateway API key** is a standard virtual key minted from your Anthropic provider key. The proxy swaps it for the real provider key server-side, so the raw Anthropic key never reaches the desktop.
- The **`X-Archestra-Virtual-Key`** custom header carries your personal passthrough virtual key. It attributes every request to your user, which is what drives per-user cost, limits, and policies. A second custom header, `X-Archestra-Agent-Id`, labels the traffic as Claude Desktop in the LLM logs.

Repeat downloads reuse the same two keys (`Connection setup - <email>` and `Connection passthrough - <email>`). Revoke them any time on the **Virtual Keys** page (LLM Proxies → Credentials).

## Prerequisites

- An [LLM proxy](/docs/platform-llm-proxy) you can access, with an Anthropic [provider key](/docs/platform-supported-llm-providers) configured.
- Permission to create virtual keys (`llmVirtualKey:create`). Without it, ask an admin either to grant it or to mint the two keys for you on the **Virtual Keys** page - a profile downloaded by the admin themselves would attribute your traffic to the admin.
- Optional: an [MCP gateway](/docs/platform-mcp-gateway) to expose tools.
- Claude Desktop with Cowork.

## 1. Download the profile

On the **Connect** page choose **Claude Desktop**, confirm the selections under **Review the setup**, then click **Download configuration**. The file holds your keys in plain text, so treat it like a secret; **Preview configuration** shows the same JSON with secrets masked.

## 2. Enable Developer Mode

In Claude Desktop, open the menu and choose **Help → Troubleshooting → Enable Developer Mode**. This adds the **Developer** menu used next.

![Enabling Developer Mode via Help → Troubleshooting](/docs/automated_screenshots/platform-claude-desktop-example_enable-developer-mode.webp)

## 3. Import the configuration

Choose **Developer → Configure Third-Party Inference…**.

![Opening Configure Third-Party Inference from the Developer menu](/docs/automated_screenshots/platform-claude-desktop-example_configure-third-party-inference.webp)

In the window that opens, click the **Default** dropdown in the top-right corner, choose **Import configuration…**, and select the downloaded `archestra_con_*` file.

![Import configuration in the configurations dropdown](/docs/automated_screenshots/platform-claude-desktop-example_import-configuration.webp)

## 4. Test the connection

The import fills the **Connection** form: provider **Gateway**, the base URL, the Gateway API key, and both custom headers. Click **Test connection** - a green result confirms model discovery and a one-token completion through the proxy.

![Connection form populated by the import with a successful test](/docs/automated_screenshots/platform-claude-desktop-example_test-connection.webp)

Under **Connectors & extensions**, the same import added the gateway as a managed MCP server.

![The managed MCP server created by the import](/docs/automated_screenshots/platform-claude-desktop-example_check-mcp-gateway.webp)

## 5. Apply and relaunch

Click **Apply Changes**, then **Relaunch now**.

![Relaunch prompt after applying changes](/docs/automated_screenshots/platform-claude-desktop-example_apply-changes.webp)

After the restart the account indicator in the bottom-left reads **Gateway** - inference is now flowing through Archestra.

![Claude Desktop running on the gateway after relaunch](/docs/automated_screenshots/platform-claude-desktop-example_settings.webp)

## 6. Connect the MCP gateway

The managed server is imported but not yet authorized. Open **Settings** from the account menu in the bottom-left, go to **Connectors**, select the new `archestra-mcp-*` connector, and click **Connect**.

![The Archestra connector before authorizing](/docs/automated_screenshots/platform-claude-desktop-example_connectors.webp)

Claude Desktop opens your browser on Archestra's consent screen. Click **Allow** to grant the `mcp` and `offline_access` scopes.

![Approving the gateway in the browser](/docs/automated_screenshots/platform-claude-desktop-example_allow-access.webp)

The connector then lists the gateway's tools with per-tool approval controls, all defaulting to **Needs approval**. These can be relaxed here - the gateway still enforces your Archestra permissions on every call.

![The connected gateway with its tools and permissions](/docs/automated_screenshots/platform-claude-desktop-example_check-connection.webp)

## Done

Start a Cowork task. Inference runs through your proxy and tool calls go through the gateway under your Archestra identity - billed, traced, and policy-checked along the way.
