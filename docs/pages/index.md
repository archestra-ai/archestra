---
title: Archestra Docs
description: What Archestra is and how its parts fit together
order: 0
lastUpdated: 2026-10-08
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra connects your agents to tools from MCP servers and context from your enterprise documents, then governs every model and tool call they make.

New here? Follow the **[Get Started guide](/docs/get-started)** to run Archestra locally and connect your first agent.

:::architecture-diagram:::

## Core Capabilities

- **[Agents and Skills](/docs/agents):** Build autonomous agents with custom tools, knowledge, and [skills](/docs/agents/skills). Run them in [Chat](/docs/chat), messaging apps like [Slack and Microsoft Teams](/docs/agents/triggers-and-channels), or your own code over A2A.
- **[MCP Gateway & Servers](/docs/mcp):** Expose tools to any MCP-compatible client through a unified, secure [gateway](/docs/mcp/gateway), and run sandboxed or self-hosted [MCP servers](/docs/mcp/servers).
- **[LLM Proxy & Router](/docs/llm-proxy):** Centralize model access across OpenAI, Anthropic, Gemini, Bedrock, and Azure with [virtual keys](/docs/llm-proxy/authentication), [cost tracking](/docs/llm-proxy/costs-and-limits), and automatic [failover](/docs/llm-proxy/model-router).
- **[Knowledge (RAG)](/docs/knowledge):** Give agents cited answers from connected enterprise sources like Confluence, Google Drive, and SharePoint with automatic source permission sync.
- **[Governance & Guardrails](/docs/agents/guardrails):** Decide which tool calls an agent can make from what it has read, and keep an audit log of every tool and model call.

