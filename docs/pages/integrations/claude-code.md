---
title: Claude Code
description: Connect Claude Code with subscription or API-key inference
order: 1
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Claude Code can route model requests through Archestra while using your Claude subscription or an Archestra virtual key. Connect also installs the MCP Gateway and selected shared skills.

## Requirements

Install Claude Code and sign in to your Claude account for subscription inference. You need access to a running Archestra deployment. For virtual-key inference, an administrator must first configure the provider key in Archestra.

## Connect

1. Open **Connect** in Archestra and select **Claude Code**.
2. Use **Customize setup** to choose inference, gateway, and skills. Subscription setup keeps your subscription as the inference credential. API-key setup uses an Archestra virtual key.
3. Copy the connection prompt into Claude Code. Review the setup request in your browser and approve it. Review the terminal command before Claude Code runs it.
4. Start a new Claude Code session after setup so it loads the updated settings.
5. Run `/mcp`, select the Archestra gateway, and choose **Authenticate**. Sign in to Archestra in the browser and approve the gateway connection. Enable the gateway if it is disabled.

Setup backs up `~/.claude/settings.json` to `~/.claude/settings.json.archestra-backup` before its first change. To disconnect, press `C` in the startup guard and select the connection to remove. To restore settings manually, copy the backup over `settings.json` and remove the gateway with `claude mcp remove --scope user <gateway>`; `<gateway>` is its name in `/mcp`.

## Verify the Connection

Send `Reply with connection verified.` In Archestra, open **Logs → LLM Proxy** and find the Claude Code request. A response with subscription billing confirms subscription routing; a virtual-key request confirms API-key routing.

Run `/mcp` again and confirm that the gateway is connected. Ask Claude Code to list the tools available from that gateway. The list reflects the tools assigned in Archestra and your permissions.

If inference works but tools do not, authenticate the gateway separately. If no request appears in the proxy logs, check that you started a new session and that another Claude configuration does not override the generated settings.
