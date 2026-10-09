---
title: Connect Your Agents
description: Connect your AI client to Archestra's tools, models, and shared skills
order: 2
lastUpdated: 2026-10-08
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect your AI client once, and Archestra governs everything it does. It gets Archestra's tools, models, and shared skills. Your access rules, [Guardrails](/docs/agents/guardrails), cost limits, and logs then apply to it.

- **Tools** come through the [MCP Gateway](/docs/mcp/gateway).
- **Model requests** go through the [LLM Proxy](/docs/llm-proxy).
- **Shared [skills](/docs/agents/skills)** install in the client.

Open **Connect** in the Archestra sidebar and choose how to connect:

- **Coding agents:** for [Claude Code](/docs/integrations/claude-code), Codex, Cursor, Copilot CLI, and OpenCode, you run one command in a terminal and approve the connection in your browser.
- **[Claude Desktop](/docs/integrations/claude-desktop#setup):** a downloadable installer sets up Desktop.
- **[n8n](/docs/integrations/n8n):** you enter the gateway URL and model settings in your workflow.
- **Any Client:** any tool that supports MCP or an OpenAI-compatible API. Copy the gateway URL, the proxy base URL, a key, and a Git URL for the shared skills.

To leave out the proxy or the skills, click **Customize setup** before you approve.

![Connect with Codex selected and its setup command](/docs/automated_screenshots/platform-connection_connect-with-ai.webp)

<span id="claude-code"></span>
<span id="claude-desktop"></span>

<span id="codex"></span>
<span id="cursor"></span>
<span id="copilot-cli"></span>
<span id="opencode"></span>

## Before You Start

For Claude Code, Codex, Cursor, Copilot CLI, and OpenCode:

- Node.js 18 or newer, and a terminal on the computer where you use the client.
- The client's CLI on your `PATH`: `claude`, `codex`, `copilot`, or `opencode`. OpenCode must be 1.17 or newer.
- Python 3 for Claude Code. Git for Cursor and OpenCode skills.
- An Archestra URL on HTTPS. Plain HTTP works only on `localhost`.

## Connect a Coding Agent

The command changes nothing on your computer until you approve it in your browser.

1. On **Connect**, select your client. For another system, click **Use the Windows command** or **Use the macOS / Linux command**.
2. Click **Copy** and run the command in a terminal. It prints a code and opens an approval page in your browser.
3. Check that the code in the browser matches the code in the terminal. Tick **This code matches the code in my terminal** and click **Approve connection**.
4. Back in the terminal, the installer sets up your client and lists what it set up. When it asks **Sign in now?**, press Enter to sign in to the gateway in your browser.
5. Open a new terminal and run the command the installer prints last. It starts your client with a first question, such as `opencode --prompt 'What can you do with my Archestra tools?'`. Cursor has no command: open Cursor.

![The browser approval page with a code to match against the terminal](/docs/automated_screenshots/platform-connection_browser-approval.webp)


## Finish Setup in Your Client

Some clients need one more step. The installer prints any other steps under **Good to know**. `<gateway>` is the name your client lists for the Archestra gateway.

- **Claude Code:** if you skipped the sign-in, start Claude Code, run `/mcp`, select the gateway, and choose **Authenticate**.
- **Codex:** if you skipped the sign-in, run `codex mcp login <gateway>`.
- **Cursor:** sign in to the gateway under **Customize → MCPs** in Cursor, then reload Cursor to load the skills. Cursor keeps its own models unless you set up the proxy. To do that, find **Cursor model settings (manual step)** in the installer output. Enter the proxy URL and key it shows under **Settings → Models → API Keys**. Turn on **Use OpenAI API Key** and **Override OpenAI Base URL**. A Cursor subscription cannot be the key.
- **Copilot CLI:** on Windows, setup sets the proxy variables for your user. On macOS and Linux, add the `export` lines the installer prints to your shell profile.
- **OpenCode:** if you skipped the sign-in, run `opencode mcp auth <gateway>`.

<span id="startup-guard"></span>

<span id="troubleshooting"></span>

## After Setup

- **Launch check:** setup adds a block to your shell profile. Each time Claude Code, Codex, Copilot CLI, or OpenCode starts, it checks the connection. Press `C` there to disconnect. To turn it off, set `ARCHESTRA_CLAUDE_GUARD=0`, `ARCHESTRA_CODEX_GUARD=0`, `ARCHESTRA_COPILOT_GUARD=0`, or `ARCHESTRA_OPENCODE_GUARD=0`.
- **Backups:** setup saves each config file it changes as a `.archestra-backup` file next to the original.
- **Setup failed or expired:** run it again. Approval requests expire after ten minutes. Only approve a request you started.

**Next:** [See it work](/docs/get-started/see-it-work).
