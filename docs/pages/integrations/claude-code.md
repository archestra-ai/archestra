---
title: Claude Code
description: Connect Claude Code with subscription or API-key inference
order: 1
lastUpdated: 2026-10-13
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Claude Code can route model requests through Archestra while using your Claude subscription or an Archestra virtual key. Connect also installs the MCP Gateway and selected shared skills.

## Requirements

Install Claude Code and sign in to your Claude account for subscription inference. You need access to a running Archestra deployment. For virtual-key inference, an administrator must first configure the provider key in Archestra.

## Connect

1. Open **Connect** in Archestra and select **Claude Code**.
2. Copy the command and run it in a terminal. It opens an approval page in your browser.
3. On the approval page, click **Approve connection**. To change the gateway or leave out the proxy or skills first, open **Setup options**. If your admin picked provider keys for Claude Code, its models use an Archestra virtual key. Otherwise Claude Code keeps your own subscription or key.
4. When the installer asks **Sign in now?**, press Enter. Sign in to Archestra in the browser and approve the gateway connection. If you skipped it, start Claude Code, run `/mcp`, select the Archestra gateway, and choose **Authenticate**.
5. Open a new terminal and run the `claude` command the installer prints last. It starts a new session that loads the updated settings.

Setup backs up `~/.claude/settings.json` to `~/.claude/settings.json.archestra-backup` before its first change. To disconnect, press `C` in the [launch check](/docs/get-started/connect#startup-guard) and select the connection to remove. To restore settings manually, copy the backup over `settings.json` and remove the gateway with `claude mcp remove --scope user <gateway>`; `<gateway>` is its name in `/mcp`.

## Verify the Connection

Send `Reply with connection verified.` In Archestra, open **Logs → LLM Proxy** and find the Claude Code request. A response with subscription billing confirms subscription routing; a virtual-key request confirms API-key routing.

Run `/mcp` and confirm that the gateway is connected. Enable the gateway if it is disabled. Ask Claude Code to list the tools available from that gateway. The list reflects the tools assigned in Archestra and your permissions.

If inference works but tools do not, authenticate the gateway separately. If no request appears in the proxy logs, check that you started a new session and that another Claude configuration does not override the generated settings.

## Gateway Tool Permissions

Setup lets Claude Code run gateway tools through [`run_tool`](/docs/reference/archestra-mcp-server#run_tool) without asking each time. A permission prompt or Claude Code's auto mode then does not stop a task such as a [handoff](/docs/agents/runtime/handoff) halfway. Setup adds the allow rule to `permissions.allow` in `settings.json`.

What to know:

- The rule covers every tool on the gateway. A Claude Code rule cannot match a tool's arguments, so it cannot be narrower.
- Your access rules and [Guardrails](/docs/agents/guardrails) still apply to each call.
- To approve each call yourself, run `/permissions` in Claude Code and add the same rule as an ask rule. An ask rule wins over an allow rule.
