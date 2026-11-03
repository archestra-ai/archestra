---
title: ChatGPT
description: Bring your gateway and skills into ChatGPT, and check the desktop app's tool calls with Guardrails
order: 4
lastUpdated: 2026-11-03
---

Run one setup command to connect the ChatGPT desktop app to your gateway, install the Archestra connection plugin, and route local model requests through Archestra. [Guardrails](/docs/agents/guardrails) then check tool calls in local Work and Codex conversations.

<a id="local-work-inference"></a>

## Use Guardrails in the Desktop App

The desktop app's Work and Codex tabs run on your computer and read the Codex settings there. Route them through the [LLM Proxy](/docs/llm-proxy), and Guardrails check every tool call, such as a shell command in a Work task.

Setup checks the local sandbox before changing settings. On Linux, it runs a harmless command through Codex's sandbox. When the Windows desktop app runs Codex in WSL, setup runs the desktop app's Linux Codex sandbox in WSL's default distribution. If your desktop project uses another distribution, set `$env:ARCHESTRA_CODEX_WSL_DISTRIBUTION = "YourDistribution"` in PowerShell before running setup.

Setup identifies the desktop executable from its recent launch logs or a single cached installation. If setup cannot identify it, open a local Work or Codex conversation once, then retry. For an explicit executable, set `$env:ARCHESTRA_CODEX_WSL_EXECUTABLE` to its absolute Linux path before running setup.

A failed check stops setup with repair instructions. On Ubuntu or Debian, run `sudo apt install bubblewrap` in the checked Linux environment, then rerun setup. For namespace errors, follow OpenAI's [sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites).

1. On **Connect**, select **ChatGPT**. Keep **LLM proxy** on under **Choose what to include**.
2. Click **Copy** and run the command in a terminal on the computer with the desktop app. Review and approve the ChatGPT setup in your browser.
3. The installer configures model routing, connects the gateway, and installs the Archestra plugin with its gateway, onboarding workflow, and selected shared skills through the native marketplace. Sign in to the gateway when asked; a separate plugin ZIP upload is unnecessary for local desktop conversations.
4. Restart ChatGPT and start a Work task. In the [logs](/docs/admin/logs), its requests show the ChatGPT client.

- The setup needs the `codex` CLI on your `PATH`. It changes `~/.codex/config.toml`, so Codex CLI on the same computer uses the same settings. See [Connect Your Agents](/docs/get-started/connect#before-you-start) for the other prerequisites.
- On Windows, use the Windows command also when ChatGPT runs Codex in WSL. Codex in WSL cannot read Windows Credential Manager. So while ChatGPT runs Codex in WSL, the setup signs in to the gateway with Codex's `mcp_oauth_credentials_store=file` setting. Codex then saves the sign-in in `.credentials.json` in your Codex folder, where both Codex for Windows and Codex in WSL read it.
- Chats and dots run on OpenAI's servers and do not read these settings. Guardrails do not check them. The plugin brings your tools and skills there.

For package format and upload requirements, see OpenAI's [plugin packaging guide](https://developers.openai.com/plugins/build/plugins). OAuth approval and workspace policy remain in ChatGPT.

<span id="install-the-plugin"></span>

## Install the Plugin for Web Chats and Dots

Your ChatGPT account must permit plugin archive uploads and custom MCP servers. The generated archive uses a concrete HTTPS gateway URL and automatic OAuth client registration, enabled by default in Archestra. If your deployment disables registration, use a pre-registered connection configured separately. Private deployments need a separately configured Secure MCP Tunnel connection; this URL-based archive does not bind a tunnel automatically.

1. On **Connect**, select **ChatGPT**, then **Using ChatGPT on the web? Download the plugin**. Use **Choose what to include** to change the gateway or leave skills out.
2. Download the plugin. The ZIP contains the gateway URL, OAuth settings, and copies of your accessible portable skills, including their scripts and reference files. The export adds no OAuth access tokens or client secrets.
3. In [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Upload plugin archive** and upload the ZIP. If uploads are restricted, ask your workspace administrator to upload it.
4. Review the plugin, install it, and connect your gateway account through OAuth. Start a web chat or dot with the plugin selected.

**Download again** downloads another copy with your current selections. For local Work and Codex conversations, switch to terminal setup.

The endpoint is inferred from your deployment, like other clients. Administrators must configure a public HTTPS connection base URL. For a private deployment, configure Secure MCP Tunnel in ChatGPT instead of using an unreachable localhost URL. A dot needs the plugin connected in its own configuration, subject to workspace policy.

## Skills and Updates

The archive includes a gateway setup workflow even when you leave shared skills out. It guides local desktop setup and sandbox repairs; web chats and dots do not need local Linux packages.

Shared skills are a snapshot of readable standalone skills. Templated and agent-bound skills require Archestra activation and are omitted with a notice. A skill is also omitted with a notice when its name is not a portable skill name: up to 64 lowercase letters and digits, with single hyphens between words. Rename it to include it. Re-download and upload a new archive after changing skills. Removing the uploaded plugin removes its bundled skills; remove its connection from any dot that uses it too.

## Disconnect This Computer

Use the disconnect command to restore the local settings added by terminal setup.

1. On **Connect**, select **ChatGPT** and open **How it works** in the disconnect area, inside **Manage** when clients are connected. Run the cleanup command on the computer where you ran setup.
2. Restart ChatGPT. Cleanup removes the connection plugin and marketplace, signs out of the gateway, restores model routing, and removes the startup check. Unrelated plugins and your ChatGPT account login remain.
3. In **Manage**, choose **Disconnect**, then **Revoke access** to revoke the server-side connection and skill links.

ChatGPT desktop and Codex share these local settings and the gateway sign-in. If you uploaded the web plugin separately, remove it from ChatGPT Plugins and any dots that use it too.
