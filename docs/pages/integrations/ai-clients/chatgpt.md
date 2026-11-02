---
title: ChatGPT
description: Bring your gateway and skills into ChatGPT, and check the desktop app's tool calls with Guardrails
order: 4
lastUpdated: 2026-11-01
---

Download one plugin from Archestra to bring your gateway's MCP tools and portable skills into ChatGPT. On your computer, the desktop app's Work and Codex tabs can also send their model requests through Archestra, so [Guardrails](/docs/agents/guardrails) check each tool call they make.

## Install the Plugin

Your ChatGPT account must permit plugin archive uploads and custom MCP servers. The generated archive uses a concrete HTTPS gateway URL and automatic OAuth client registration, enabled by default in Archestra. If your deployment disables registration, use a pre-registered connection configured separately. Private deployments need a separately configured Secure MCP Tunnel connection; this URL-based archive does not bind a tunnel automatically.

1. On **Connect**, select **ChatGPT**. Use **Choose what to include** to change the gateway or leave skills out.
2. Click **Download ChatGPT plugin**. The ZIP contains the gateway URL, OAuth settings, and copies of your accessible portable skills, including their scripts and reference files. The export adds no OAuth access tokens or client secrets.
3. After the download finishes, click **Open ChatGPT** to open the desktop Plugins page, or **Configure on web instead** to use the browser. Choose **Upload plugin archive** and upload the ZIP. If uploads are restricted, ask your workspace administrator to upload it through the workspace's plugin controls.
4. Review the plugin, install it, and connect your gateway account through OAuth. Start a new conversation with the plugin selected and ask which tools and skills are available.

Use **Download again** to return to the download step. Refreshing the page starts from the download step too. The desktop action uses the app-registered `codex://plugins` route; the web link is the fallback when the desktop app is unavailable or the browser blocks an app launch.

The endpoint is inferred from your deployment, like other clients. Administrators must configure a public HTTPS connection base URL. For a private deployment, configure Secure MCP Tunnel in ChatGPT instead of using an unreachable localhost URL. A dot needs the plugin connected in its own configuration, subject to workspace policy.

## Skills and Updates

The archive is a snapshot of readable standalone skills. Templated and agent-bound skills require Archestra activation and are omitted with a notice. A skill is also omitted with a notice when its name is not a portable skill name: up to 64 lowercase letters and digits, with single hyphens between words. Rename it to include it. Re-download and upload a new archive after changing skills. Removing the uploaded plugin removes its bundled skills; remove its connection from any dot that uses it too.

<a id="local-work-inference"></a>

## Use Guardrails in the Desktop App

The desktop app's Work and Codex tabs run on your computer and read the Codex settings there. Route them through the [LLM Proxy](/docs/llm-proxy), and Guardrails check every tool call, such as a shell command in a Work task.

1. On **Connect**, select **ChatGPT**. Keep **LLM proxy** on under **Choose what to include**.
2. Under **Set up the desktop app**, click **Copy** and run the command in a terminal on the computer with the desktop app. The command runs the Codex setup, so the approval page names Codex.
3. Approve the connection, then sign in to the gateway when the installer asks.
4. Restart ChatGPT and start a Work task. In the [logs](/docs/admin/logs), its requests show the ChatGPT client.

- The setup needs the `codex` CLI on your `PATH`. It changes `~/.codex/config.toml`, so Codex CLI on the same computer uses the same settings. See [Connect Your Agents](/docs/get-started/connect#before-you-start) for the other prerequisites.
- On Windows, ChatGPT can run Codex in WSL. While it does, the Windows command stops before it changes anything, because Codex in WSL cannot open the Windows paths it would write. Run the macOS / Linux command in WSL instead. Before you run it, set `CODEX_HOME` to your Windows Codex folder, for example `export CODEX_HOME=/mnt/c/Users/you/.codex`. If you later stop running Codex in WSL, the Linux paths stay in the settings. Change them to Windows paths before you run the Windows command.
- Chats and dots run on OpenAI's servers and do not read these settings. Guardrails do not check them. The plugin brings your tools and skills there.

For package format and upload requirements, see OpenAI's [plugin packaging guide](https://developers.openai.com/plugins/build/plugins). OAuth approval and workspace policy remain in ChatGPT.
