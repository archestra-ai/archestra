---
title: Connect Your Agents
description: Connect your AI client to Archestra's tools, models, and shared skills
order: 2
lastUpdated: 2026-11-24
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->
<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

In organisation, every developer sets up their coding agent on their own. One pastes a personal API key into Claude Code. Another adds an MCP server they found on GitHub to Cursor.

Such a setup is quite dangerous as may cause agentic data leaks from one MCP server to another, simply compromise developer's machine due to usage of non-approved MCP server, or cause uncontrollable token spend.

Archestra's here to help!

:::connect-animation:::

### Connect Page

When we rolled out Archestra at our first customers, we quickly found that connecting it to every agent developers use is hard.

So we built one page for it: **Connect**. It's a self-serve page you send to your engineers, and each of them connects their agent to Archestra in a couple of minutes.

![Connect with Codex selected and its setup command](/docs/automated_screenshots/platform-connection_connect-with-ai.webp)

Under the hood, connecting an agent:

- Sends its model traffic through the [LLM Proxy](/docs/llm-proxy). Your admin sees every model request in the logs, and [Guardrails](/docs/agents/guardrails) and [cost controls](/docs/llm-proxy/cost-controls) apply to it.
- Gives it your MCP servers through the [MCP Gateway](/docs/mcp/gateway).
- Installs [skills](/docs/agents/skills) from your catalog.
- Sets its system prompt. This is especially useful when you want to nudge agents to use particular skills or MCP servers.

If you want to castomise the page look, admins do it under **Settings → Connect Page**.
