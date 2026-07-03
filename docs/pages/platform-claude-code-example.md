---
title: Using Claude Code Max Subscription
category: Examples
order: 10
description: Route Claude Code through Archestra with a one-time setup script while your Claude subscription keeps paying for inference
lastUpdated: 2026-07-02
---

<!--
Check ../docs_writer_prompt.md before changing this file.

Walkthrough for the /connection_beta?clientId=claude-code flow: connecting
Claude Code to Archestra with the one-time setup script, in passthrough mode so
an existing Claude Pro/Max subscription keeps paying for inference. Cover:
- Passthrough: the script leaves Claude Code's own credential (subscription
  OAuth token or API key) untouched and only points ANTHROPIC_BASE_URL at the
  proxy; Archestra forwards the credential upstream and never stores it.
- Attribution: personal passthrough virtual key wired into
  ANTHROPIC_CUSTOM_HEADERS as X-Archestra-Virtual-Key, plus X-Archestra-Agent-Id.
- The Virtual key alternative (ANTHROPIC_AUTH_TOKEN, standard virtual key).
- Prerequisites: claude CLI on PATH, proxy/gateway access, llmVirtualKey:create
  (best-effort for attribution, required for Virtual key mode), skill:admin for
  the shared-skills bundle.
- What the script configures, in order: MCP gateway via claude mcp add,
  ~/.claude/settings.json merge (one-time .archestra-backup of an existing
  file), shared-skills plugin marketplace install. Nothing is undone
  automatically; manual revert steps.
- One-time token: expires in 15 minutes, single use, Regenerate button.
- Finish with /mcp -> select the gateway -> Authenticate -> browser OAuth.
Screenshots live in /docs/automated_screenshots/platform-claude-code-example_*.
Don't restate obvious UI; keep it short.
-->

If your team already pays for Claude Pro or Max, Claude Code can keep using that subscription while Archestra governs the traffic. The **Connect** page generates a one-time setup script that routes inference through an [LLM proxy](/docs/platform-llm-proxy) in *passthrough* mode, registers your [MCP gateway](/docs/platform-mcp-gateway) for tools, and installs your organization's [shared skills](/docs/platform-agent-skills-sharing) - one command, no manual config edits.

![The Connect page with Claude Code selected, showing the passthrough setup and the one-time command](/docs/automated_screenshots/platform-claude-code-example_connect-page.webp)

## How passthrough works

Passthrough - the option tagged **Good for reusing a subscription** - leaves your credential untouched. The script points `ANTHROPIC_BASE_URL` at `…/v1/anthropic/<proxy-id>`, Claude Code keeps sending its own credential (the subscription OAuth token, or your API key), and the proxy forwards it to Anthropic unchanged: Anthropic still bills your plan, and Archestra never stores a provider credential.

For attribution, the script also adds two headers via `ANTHROPIC_CUSTOM_HEADERS`: your personal [passthrough virtual key](/docs/platform-llm-proxy-authentication#passthrough-virtual-keys) in `X-Archestra-Virtual-Key`, which ties every request to your Archestra user for logging, [cost tracking and limits](/docs/platform-costs-and-limits), and proxy policies; and `X-Archestra-Agent-Id`, which labels the traffic as Claude Code in the LLM logs.

If you'd rather use an Archestra-managed credential than a subscription, switch the proxy row under **Review the setup** to **Virtual key** - the script then writes `ANTHROPIC_AUTH_TOKEN` instead, a standard virtual key the proxy swaps for a stored provider key.

## Prerequisites

- The `claude` CLI installed and on `PATH` - the script exits otherwise.
- Read access to the LLM proxy and, for tools, an [MCP gateway](/docs/platform-mcp-gateway).
- Permission to create virtual keys (`llmVirtualKey:create`). Without it the passthrough script still works, just without per-user attribution; the **Virtual key** option strictly requires it.
- The **Install shared skills** option on the Connect page requires the skill admin permission (`skill:admin`). The review step lists every skill the command installs; deselect the ones (or all) you don't need.

## 1. Generate and run the command

On the **Connect** page choose **Claude Code**, confirm the selections under **Review the setup**, and copy the command - `curl … | bash` on macOS/Linux, `irm … | iex` on Windows. It is single-use and expires in 15 minutes; **Regenerate** mints a fresh one.

Run it in a terminal. The script, in order:

1. Registers the gateway with `claude mcp add --transport http <name> …/v1/mcp/<gateway-slug>`.
2. Merges the proxy settings into `~/.claude/settings.json`, backing up any existing file once to `~/.claude/settings.json.archestra-backup`. Your existing Anthropic credentials keep working - only the base URL changes.
3. Adds the shared-skills bundle as a Claude Code plugin marketplace and installs it.

![The setup script output after a successful run](/docs/automated_screenshots/platform-claude-code-example_run-connection-script.webp)

The script is not undone automatically. To revert: restore the settings backup (if one was taken), run `claude mcp remove <name>`, and delete the `Connection passthrough - <email>` key on the **Virtual Keys** page (LLM Proxies → Credentials).

## 2. Authorize the gateway

The gateway is registered but not yet authenticated — it grants tool access per user, so each user signs in once. Run `claude /mcp` (or `/mcp` inside a running session).

![Running /mcp in Claude Code](/docs/automated_screenshots/platform-claude-code-example_mcp-command.webp)

Select the new gateway - until the OAuth flow completes it is listed as `disabled` and `not authenticated`, which is expected.

![The gateway listed under Manage MCP servers](/docs/automated_screenshots/platform-claude-code-example_select-gateway.webp)

Choose **Authenticate**. Claude Code opens your browser on Archestra's consent screen; sign in and click **Allow**. If the server still shows `disabled` afterwards, choose **Enable**.

![Choosing Authenticate for the gateway](/docs/automated_screenshots/platform-claude-code-example_authenticate.webp)

## Done

Inference now flows through your proxy - still billed to your subscription - with every request logged and attributed in [Observability](/docs/platform-observability). The gateway authenticates tool calls as you, so your permissions and attribution apply, while upstream credentials follow each server's configuration (see [MCP Authentication](/docs/mcp-authentication)). The installed skills load automatically the next time `claude` starts and appear in the slash-command menu.
