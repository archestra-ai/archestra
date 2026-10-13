---
title: Connect Your Agents
description: Connect your AI client to Archestra's tools, models, and shared skills
order: 2
lastUpdated: 2026-10-14
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect your AI client once, and Archestra governs everything it does. It gets Archestra's tools, models, and shared skills. Your access rules, [Guardrails](/docs/agents/guardrails), cost limits, and logs then apply to it.

- **Tools** come through the [MCP Gateway](/docs/mcp/gateway).
- **Model requests** go through the [LLM Proxy](/docs/llm-proxy).
- **Shared [skills](/docs/agents/skills)** install in the client.

Open **Connect** in the Archestra sidebar and choose how to connect:

- **Coding agents:** for [Claude Code](/docs/integrations/claude-code), Codex, Cursor, Copilot CLI, and OpenCode, you run one command in a terminal and approve the connection in your browser.
- **[Claude Desktop](/docs/integrations/claude-desktop#setup):** a downloadable installer sets up Desktop.
- **[n8n](/docs/integrations/web-ui-and-automation#n8n):** you enter the gateway URL and model settings in your workflow.
- **Any Client:** any tool that supports MCP or an OpenAI-compatible API. Copy the gateway URL, the proxy base URL, a key, and a Git URL for the shared skills.

To leave out the proxy, skills, or plugins, open **Setup options** on the approval page before you approve. Your admin decides which provider keys the proxy uses for each client.

Guardrails recognize Archestra Chat, Claude Code, Codex CLI, and OpenCode automatically. Custom clients and workflows need a [session header](/docs/agents/guardrails/clients#session-headers) so Guardrails can track their conversations.

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
- The client's CLI on your `PATH`: `claude`, `codex`, `copilot`, or `opencode`. OpenCode must be 1.17 or newer. Copilot CLI proxy setup requires 1.0.95 or newer.
- Python 3 for Claude Code and for Cursor's models. Git for Cursor and OpenCode skills.
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
- **Cursor:** quit and reopen Cursor, then sign in to the gateway under **Customize → MCPs**. Setup points Cursor's OpenAI API key settings at the [Model Router](/docs/llm-proxy/model-router) with a virtual key for your model providers. Cursor's model picker then lists only the models the Model Router offers you, such as `anthropic:claude-sonnet-4-6`. Setup switches off Cursor's built-in models. Switch one back on under **Settings → Models**.
- **Copilot CLI:** setup saves your provider settings and available key in `providers.json` and selects the model in `settings.json`. If setup reports a missing key, add it to `providers.json`. The environment variables printed at the end are optional.
- **OpenCode:** if you skipped the sign-in, run `opencode mcp auth <gateway>`. If setup adds Archestra model providers to OpenCode, it changes a `model` or `small_model` you set to the same model on Archestra. If Archestra does not offer that model, setup removes the setting. Disconnect restores your setting.

<span id="startup-guard"></span>

<span id="troubleshooting"></span>

## After Setup

- **Launch check:** setup adds a block to your shell profile. Each time Claude Code, Codex, Copilot CLI, or OpenCode starts, it checks the connection. Press `C` there to disconnect. To turn it off, set `ARCHESTRA_CLAUDE_GUARD=0`, `ARCHESTRA_CODEX_GUARD=0`, `ARCHESTRA_COPILOT_GUARD=0`, or `ARCHESTRA_OPENCODE_GUARD=0`.
- **Backups:** setup saves each config file it changes as a `.archestra-backup` file next to the original.
- **Guardrail helpers in Codex:** setup lets Codex run the guardrail helper tools, such as [`ask_user`](/docs/reference/archestra-mcp-server#ask_user) and [`yell`](/docs/reference/archestra-mcp-server#yell), without a prompt each time. A call that needs your approval still shows the approval form. To get the prompts back, delete the `tools` tables under the gateway's entry in `~/.codex/config.toml`.
- **Codex waits for the gateway:** Codex 0.99 or newer does not send the first `codex exec` request until the gateway is connected. If you skipped sign-in, or the gateway is down, that command stops. Sign in with `codex mcp login <gateway>`, then run it again. Older Codex ignores this and can still send the first request early. To let `codex exec` start without the gateway, delete `required = true` under the gateway's entry in `~/.codex/config.toml`.
- **Setup reference:** if an agent runs the installer, Guardrails do not apply to that agent's conversation for ten minutes, so it can finish the setup. The setup reference the installer prints marks that conversation. Every other session follows your Guardrails policy from its first request.
- **Setup failed or expired:** run it again. Approval requests expire after ten minutes. Only approve a request you started.

**Next:** [See it work](/docs/get-started/see-it-work).
