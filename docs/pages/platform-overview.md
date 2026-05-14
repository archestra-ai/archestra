---
title: Overview
category: Archestra Platform
order: -1
description: High-level architecture overview of Archestra Platform components
lastUpdated: 2026-04-01
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

## The Full AI Stack for Everyone

Archestra is a centralized AI Platform designed for organizations where software engineers, and non-technical teams all need to work with AI agents. While a non-technical user may enjoy simple ChatGPT-like UI and get immediate results, a technical user may build agents using LangChain, N8N, pure Python or other stack of choice leveraging MCP orchestrator, guardrails and observability. Archestra will reduce friction and increase AI adoption in all cases.

> Fun fact: The team behind Archestra.AI previously worked on Grafana OnCall.

![Platform Architecture](/docs/platform-overview-architecture.webp)

## Composable Components

Archestra is built as a set of composable components. Most organizations already have tools like n8n, LiteLLM, Grafana, or custom MCP servers in their infrastructure. You can adopt all of Archestra, a few components, or even just one — it integrates with what you already have. We're building an open composable platform and not willing to lock you.

**[Agentic Chat](/docs/platform-chat)** — ChatGPT-like interface for non-technical users. Talk to agents via web UI, [Slack](/docs/platform-slack), [MS Teams](/docs/platform-ms-teams), or [Email](/docs/platform-agent-triggers-email).

**[Agent Runtime](/docs/platform-agents)** — No-code builder for autonomous agents. Define system prompts, assign MCP tools and sub-agents, configure triggers.

**[MCP Orchestrator](/docs/platform-orchestrator)** — Run MCP servers as isolated pods in Kubernetes.

**[Knowledge Base](/docs/platform-knowledge-bases)** — Built-in RAG Knowledge Base to give your agents access to your data.

**[LLM & MCP Proxies](/docs/platform-llm-proxy)** — Drop-in proxy between your apps and LLM providers. [MCP Gateway](/docs/platform-mcp-gateway) provides a single endpoint for all MCP tools. Works with any framework: n8n, LangChain, Vercel AI, Pydantic AI, Mastra.

**[Security & Guardrails](/docs/platform-lethal-trifecta)** and **[Observability](/docs/platform-observability)** — Deterministic tool invocation policies and trusted data policies that cannot be bypassed by prompt injection. Prometheus metrics, OpenTelemetry tracing, and [per-team cost tracking](/docs/platform-costs-and-limits).

See [Pricing Model](/docs/platform-pricing-model) for licensing details.
