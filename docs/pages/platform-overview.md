---
title: Overview
category: Archestra Platform
order: -1
description: Run agents, connect tools, and govern AI across your organization.
lastUpdated: 2026-10-03
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra is an AI platform for teams. You can work with agents in Chat or connect existing applications through its LLM and MCP proxies.

## Start Here

- **Try Archestra locally:** Follow the [Quickstart](/docs/platform-quickstart) to run the platform and chat with your first agent.
- **Use your workspace:** Read about [Chat](/docs/platform-chat), [Projects](/docs/platform-projects), and [Knowledge](/docs/platform-knowledge).
- **Connect an application:** Use the [LLM Proxy](/docs/platform-llm-proxy) for model requests or an [MCP Gateway](/docs/platform-mcp-gateway) for tools.
- **Deploy for a team:** Follow [Deployment](/docs/platform-deployment), then configure [Access Control](/docs/platform-access-control).

<span id="composable-components"></span>

## How the Platform Fits Together

Agents combine instructions, models, and tools. The runtime executes them, while Chat and messaging integrations provide places to interact with them.

:::architecture-diagram:::

| Component | Purpose |
| --- | --- |
| [Agents](/docs/platform-agents) | Define instructions, tools, sub-agents, and triggers. |
| [MCP Orchestrator](/docs/platform-orchestrator) | Run MCP servers as isolated Kubernetes pods. |
| [MCP Gateway](/docs/platform-mcp-gateway) | Expose selected tools through one MCP endpoint. |
| [LLM Proxy](/docs/platform-llm-proxy) | Route application requests to model providers. |
| [Knowledge](/docs/platform-knowledge) | Give agents access to your documents and connected data. |
| [Guardrails](/docs/platform-ai-tool-guardrails) | Apply policies to tool calls and data access. |
| [Observability](/docs/platform-observability) | Inspect requests with metrics and traces. |

You can adopt the whole platform or connect individual components to your existing stack. See [Costs and Limits](/docs/platform-costs-and-limits) for usage controls and [Pricing Model](/docs/platform-pricing-model) for licensing.
