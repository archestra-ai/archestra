---
title: ChatGPT
description: Download a ChatGPT plugin with your gateway and portable skills
order: 4
lastUpdated: 2026-10-30
---

Download one plugin from Archestra to bring your gateway's MCP tools and portable skills into ChatGPT.

## Install the Plugin

Your ChatGPT account must permit plugin archive uploads and custom MCP servers. The generated archive uses a concrete HTTPS gateway URL and automatic OAuth client registration, enabled by default in Archestra. If your deployment disables registration, use a pre-registered connection configured separately. Private deployments need a separately configured Secure MCP Tunnel connection; this URL-based archive does not bind a tunnel automatically.

1. On **Connect**, select **ChatGPT**. Use **Choose what to include** to change the gateway or leave skills out.
2. Click **Download ChatGPT plugin**. The ZIP contains the gateway URL, OAuth settings, and copies of your accessible portable skills, including their scripts and reference files. The export adds no OAuth access tokens or client secrets.
3. After the download finishes, click **Open ChatGPT** to open the desktop Plugins page, or **Configure on web instead** to use the browser. Choose **Upload plugin archive** and upload the ZIP. If uploads are restricted, ask your workspace administrator to upload it through the workspace's plugin controls.
4. Review the plugin, install it, and connect your gateway account through OAuth. Start a new conversation with the plugin selected and ask which tools and skills are available.

Use **Download again** to return to the download step. Refreshing the page starts from the download step too. The desktop action uses the app-registered `codex://plugins` route; the web link is the fallback when the desktop app is unavailable or the browser blocks an app launch.

The endpoint is inferred from your deployment, like other clients. Administrators must configure a public HTTPS connection base URL. For a private deployment, configure Secure MCP Tunnel in ChatGPT instead of using an unreachable localhost URL. A dot needs the plugin connected in its own configuration, subject to workspace policy.

## Skills and Updates

The archive is a snapshot of readable standalone skills. Templated and agent-bound skills require Archestra activation and are omitted with a notice. Re-download and upload a new archive after changing skills. Removing the uploaded plugin removes its bundled skills; remove its connection from any dot that uses it too.

## Local Work Inference

A plugin archive configures tools and skills, not model inference. Local ChatGPT Work can use native model-provider configuration in the desktop app. See OpenAI's [local Work provider support](https://learn.chatgpt.com/docs/amazon-bedrock) and [managed gateway setup](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway).

That local configuration does not apply to hosted ChatGPT or dots. Model routing and uploaded-plugin use together still require a native-app test with your deployment. The Codex installer is separate: it also changes Codex's MCP, skills, and authentication settings, so do not run it solely to configure Work.

For package format and upload requirements, see OpenAI's [plugin packaging guide](https://developers.openai.com/plugins/build/plugins). OAuth approval and workspace policy remain in ChatGPT.
