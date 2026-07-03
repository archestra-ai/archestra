---
title: Using Claude Code Max Subscription
category: Examples
order: 10
description: Route Claude Code through Archestra while your Claude subscription keeps paying for inference
lastUpdated: 2026-07-03
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

## Step 1. Run the connection setup script

On the **Connect** page, choose **Claude Code**, check the selections under **Review the setup**, copy the shell command, and run it in your terminal.

![The Connect page with Claude Code selected, showing the passthrough setup and the one-time command](/docs/automated_screenshots/platform-claude-code-example_connect-page.webp)

![The setup script output after a successful run](/docs/automated_screenshots/platform-claude-code-example_run-connection-script.webp)

## Step 2. Allow Claude Code access your MCP Gateway

The gateway is added but not signed in. In your terminal run `claude /mcp`, choose the added gateway, then choose **Authenticate**.

![The gateway listed under Manage MCP servers](/docs/automated_screenshots/platform-claude-code-example_select-gateway.webp)

![Choosing Authenticate for the gateway](/docs/automated_screenshots/platform-claude-code-example_authenticate.webp)

Claude Code opens Archestra's consent screen in your browser; sign in and click **Allow**. If the server still shows `disabled`, choose **Enable**.

## All Set

You can now leverage Archestra MCP orchestrator, guardrails and observability, all while enjoying your Claude Code subscription plan.
