---
title: Connect Your Agents
description: Connect your AI client to Archestra's tools, models, and shared skills
order: 2
lastUpdated: 2026-10-15
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect your AI client once, and Archestra governs everything it does. It gets Archestra's tools, models, and shared skills. Your access rules, [Guardrails](/docs/agents/guardrails), cost limits, and logs then apply to it.

- **Tools** come through the [MCP Gateway](/docs/mcp/gateway).
- **Model requests** go through the [LLM Proxy](/docs/llm-proxy).
- **Shared [skills](/docs/agents/skills)** install in the client.

Open **Connect** in the Archestra sidebar and choose how to connect:

- **Coding agents:** for [Claude Code](/docs/integrations/claude-code), Codex, Cursor, Copilot CLI, OpenCode, and Kilo Code, you run one command in a terminal and approve the connection in your browser.
- **[Claude Desktop](/docs/integrations/claude-desktop#setup):** a downloadable installer sets up Desktop.
- **[n8n](/docs/integrations/web-ui-and-automation#n8n):** you enter the gateway URL and model settings in your workflow.
- **Any Client:** any tool that supports MCP or an OpenAI-compatible API. Copy the gateway URL, the proxy base URL, a key, and a Git URL for the shared skills.

To leave out the proxy, skills, or plugins, open **Setup options** on the approval page before you approve. Your admin decides which provider keys the proxy uses for each client.

Guardrails recognize Archestra Chat, Claude Code, Codex CLI, OpenCode, and Kilo Code automatically. Custom clients and workflows need a [session header](/docs/agents/guardrails/clients#session-headers) so Guardrails can track their conversations.

![Connect with Codex selected and its setup command](/docs/automated_screenshots/platform-connection_connect-with-ai.webp)

<span id="claude-code"></span>
<span id="claude-desktop"></span>

<span id="codex"></span>
<span id="cursor"></span>
<span id="copilot-cli"></span>
<span id="opencode"></span>
<span id="kilo"></span>

## Before You Start

For Claude Code, Codex, Cursor, Copilot CLI, OpenCode, and Kilo Code:

- Node.js 18 or newer, and a terminal on the computer where you use the client.
- The client's CLI on your `PATH`: `claude`, `codex`, `copilot`, `opencode`, or `kilo`. OpenCode must be 1.17 or newer. Copilot CLI proxy setup requires 1.0.95 or newer.
- Python 3 for Claude Code and for Cursor's models. Git for Cursor, OpenCode, and Kilo Code skills.
- An Archestra URL on HTTPS. Plain HTTP works only on `localhost`.

## Connect a Coding Agent

The command changes nothing on your computer until you approve it in your browser.

1. On **Connect**, select your client. For another system, click **Use the Windows command** or **Use the macOS / Linux command**.
2. Click **Copy** and run the command in a terminal. It prints a code and opens an approval page in your browser.
3. Check that the code in the browser matches the code in the terminal. Tick **This code matches the code in my terminal** and click **Approve connection**.
4. Back in the terminal, the installer sets up your client and lists what it set up. When it asks **Sign in now?**, press Enter to sign in to the gateway in your browser.
5. Open a new terminal and run the command the installer prints last. It starts your client with a first question about the gateway's tools, leaving your other MCP servers alone. Cursor has no command: open Cursor.

![The browser approval page with a code to match against the terminal](/docs/automated_screenshots/platform-connection_browser-approval.webp)


## Finish Setup in Your Client

Some clients need one more step. The installer prints any other steps under **Good to know**. `<gateway>` is the name your client lists for the Archestra gateway.

- **Claude Code:** if you skipped the sign-in, start Claude Code, run `/mcp`, select the gateway, and choose **Authenticate**.
- **Codex:** if you skipped the sign-in, run `codex mcp login <gateway>`.
- **Cursor:** quit and reopen Cursor, then sign in to the gateway under **Customize → MCPs**. Setup points Cursor's OpenAI API key settings at the [Model Router](/docs/llm-proxy/model-router) with a virtual key for your model providers. Cursor's model picker then lists only the models the Model Router offers you, such as `anthropic:claude-sonnet-4-6`. Setup switches off Cursor's built-in models. Switch one back on under **Settings → Models**.
- **Copilot CLI:** setup saves your provider settings and available key in `providers.json` and selects the model in `settings.json`. If setup reports a missing key, add it to `providers.json`. The environment variables printed at the end are optional.
- **OpenCode:** if you skipped the sign-in, run `opencode mcp auth <gateway>`. If setup adds Archestra model providers to OpenCode, it changes a `model`, `small_model` or agent `model` you set to the same model on Archestra. If Archestra does not offer that model, setup removes the setting, and an agent then uses the session's model. Disconnect restores your settings. Providers you sign in to from OpenCode itself, such as a ChatGPT or Claude subscription or your own key, also go through Archestra and are listed next to the Archestra providers. Archestra cannot route some providers with your own sign-in, such as a Kimi Code plan. Those use an Archestra provider's models and key, and their name says which one: "Kimi For Coding (kimi.ai) via Moonshot (Kimi)". Restart OpenCode after signing in to one.
- **Kilo Code:** if you skipped the sign-in, run `kilo mcp auth <gateway>`. Setup writes its settings to `~/.config/kilo/kilo.json`. If your `kilo.jsonc` already registers the same gateway under another name, setup disables that duplicate and preserves its comments and connection settings. Model settings work as for OpenCode, and the proxy settings turn off providers that do not go through Archestra, such as the Kilo Gateway.

<span id="startup-guard"></span>

<span id="troubleshooting"></span>

## After Setup

- **Launch check:** setup adds a block to your shell profile. Each time Claude Code, Codex, Copilot CLI, OpenCode, or Kilo Code starts, it checks the connection. Press `C` there to disconnect. To turn it off, set `ARCHESTRA_CLAUDE_GUARD=0`, `ARCHESTRA_CODEX_GUARD=0`, `ARCHESTRA_COPILOT_GUARD=0`, `ARCHESTRA_OPENCODE_GUARD=0`, or `ARCHESTRA_KILO_GUARD=0`.
- **Startup check updates:** each launch also checks whether your installed startup check is older than the deployment. If an update is available, it shows why and how to rerun setup, then continues after six seconds. Press any key to continue sooner.
- **Backups:** setup saves each config file it changes as a `.archestra-backup` file next to the original.
- **Automatic client helpers:** approved OpenCode and Kilo Code setup installs an update loader for the managed launcher helper and routing plugin, using Node.js 18 or newer. Before launch or plugin activation, it refreshes verified code from your connected Archestra deployment over HTTPS and loads that code in the same process. Concurrent starts share a download check for 30 seconds. Failed or offline downloads keep the verified cached code. These updates do not upgrade the client CLI, rerun installation, issue new provider keys, or replace your original backups.
- **Duplicate gateways:** the launcher and plugin repair equivalent, enabled registrations before tools bind. They match the exact gateway URL, preserve JSONC comments and authentication settings, and leave deliberately disabled or disconnected bindings disabled. Conflicting connection settings stop repair rather than choose credentials for you.
- **Existing installations:** a launcher installed without the update loader cannot download and execute new code retroactively. Apply an approved setup once to enroll it; subsequent managed helper updates need no setup rerun. The shell-profile wrapper and health-check screen remain installed locally, separate from the automatically updated helper. Plain-HTTP local development uses cached helper code only.
- **Guardrail helpers in Codex:** setup lets Codex run the guardrail helper tools, such as [`ask_user`](/docs/reference/archestra-mcp-server#ask_user) and [`yell`](/docs/reference/archestra-mcp-server#yell), without a prompt each time. A call that needs your approval still shows the approval form. To get the prompts back, delete the `tools` tables under the gateway's entry in `~/.codex/config.toml`.
- **Codex waits for the gateway:** Codex 0.99 or newer does not send the first `codex exec` request until the gateway is connected. If you skipped sign-in, or the gateway is down, that command stops. Sign in with `codex mcp login <gateway>`, then run it again. Older Codex ignores this and can still send the first request early. To let `codex exec` start without the gateway, delete `required = true` under the gateway's entry in `~/.codex/config.toml`.
- **Setup reference:** the first conversation that presents the installer's reference with a valid session ID is exempt from Guardrails for the rest of the ten-minute setup window. Later requests must carry both the reference and that session ID. Different session IDs and requests without the reference remain governed.
- **Exemption limits:** the first conversation wins, even if it did not run the installer. Session IDs come from the client, so this does not protect against a client that copies both the reference and the session ID. If the server loses the short-lived ownership record, another conversation can claim the rest of the window.
- **Setup failed or expired:** run it again. Approval requests expire after ten minutes. Only approve a request you started.

**Next:** [See it work](/docs/get-started/see-it-work).
