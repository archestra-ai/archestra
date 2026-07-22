---
title: Overview
category: Archestra Platform
order: -1
description: High-level architecture overview of Archestra Platform components
lastUpdated: 2026-07-03
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra is a centralized AI platform for organizations where engineers and non-technical teams both work with AI agents. A non-technical user works through a chat UI and gets results right away. An engineer builds agents in LangChain, n8n, Python, or another stack, using the MCP orchestrator, guardrails, and observability. Both use the same platform.

> Fun fact: the team behind Archestra.AI previously worked on Grafana OnCall.

:::architecture-diagram:::

## Composable Components

Archestra is a set of composable components. Most organizations already run tools like n8n, LiteLLM, Grafana, or custom MCP servers. Adopt all of Archestra, a few components, or just one — each works with what you already have.

**[Agentic Chat](/docs/platform-chat)** — ChatGPT-like interface for non-technical users. Talk to agents via web UI, [Slack](/docs/platform-slack), [MS Teams](/docs/platform-ms-teams), or [Email](/docs/platform-agent-triggers-email).

**[Agent Runtime](/docs/platform-agents)** — No-code builder for autonomous agents. Define system prompts, assign MCP tools and sub-agents, configure triggers.

**[MCP Orchestrator](/docs/platform-orchestrator)** — Run MCP servers as isolated pods in Kubernetes.

**[Knowledge Base](/docs/platform-knowledge)** — Built-in RAG Knowledge Base to give your agents access to your data.

**[LLM & MCP Proxies](/docs/platform-llm-proxy)** — Drop-in proxy between your apps and LLM providers. [MCP Gateway](/docs/platform-mcp-gateway) provides a single endpoint for all MCP tools. Works with any framework: n8n, LangChain, Vercel AI, Pydantic AI, Mastra.

**[Security & Guardrails](/docs/platform-ai-tool-guardrails#the-lethal-trifecta)** and **[Observability](/docs/platform-observability)** — Deterministic tool invocation policies and trusted data policies that cannot be bypassed by prompt injection. Prometheus metrics, OpenTelemetry tracing, and [per-team cost tracking](/docs/platform-costs-and-limits).

See [Pricing Model](/docs/platform-pricing-model) for licensing details.
