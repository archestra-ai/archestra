---
title: Archestra Docs
description: What Archestra is and how its parts fit together
order: 0
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra is an open-source AI platform. It gives agents tools from MCP servers and context from your documents and connected data. It governs every model and tool call they make.

New here? [Get started](/docs/get-started): run Archestra and connect your first agent.

## For Users

- **[Chat](/docs/chat) and [everywhere else](/docs/agents/triggers-and-channels):** You work with agents in Chat and Projects. They also answer in Slack and Microsoft Teams, reply to email, and run from your own code over A2A.
- **[Agents and skills](/docs/agents):** You build an agent once, with its own tools, knowledge, and [skills](/docs/agents/skills), and use it everywhere. A coding agent can get its own container with [Agent Runtime](/docs/agents/runtime).
- **[Connected clients](/docs/get-started/connect):** Your coding agents and your own apps use Archestra's tools, models, and shared skills.

## For Administrators

- **[Guardrails](/docs/agents/guardrails):** Archestra checks each tool call against your policy before it runs. It blocks the calls your policy does not allow, such as sending private data out after reading an untrusted web page.
- **[Logs and auditing](/docs/admin/logs):** Archestra logs every model request, tool call, and admin change across Chat and connected clients.
- **[Cost control](/docs/llm-proxy/costs-and-limits):** You see what every model call costs and set spending limits.
- **Model providers:** The [LLM Proxy](/docs/llm-proxy) and [Model Router](/docs/llm-proxy/model-router) sit between clients and providers. You can switch or mix providers without changing clients.
- **[Access control](/docs/admin/access-control):** Your access rules apply the same way in Chat, messaging apps, and connected clients.
- **[Self-hosting](/docs/admin/deployment):** Archestra runs in Docker or on Kubernetes in your environment.
- **[Licensing](/docs/get-started#licensing):** Open core. Enterprise features are free for companies with fewer than 30 users.

:::architecture-diagram:::
