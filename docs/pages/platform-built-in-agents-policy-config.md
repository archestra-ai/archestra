---
title: Tool Policy Configuration Agent
category: LLM Proxy
subcategory: Security Concepts
order: 4
description: Built-in agent that auto-configures tool call policies and tool result policies
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

The Tool Policy Configuration Agent analyzes tool metadata and automatically determines appropriate [AI tool guardrails](/docs/platform-ai-tool-guardrails). Instead of manually configuring tool call policies and tool result policies for each tool, this built-in agent uses LLM structured output to generate both settings in a single call.

## How It Works

When triggered, the subagent sends each tool's name, description, MCP server name, parameter schema, and [tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations) to an LLM. The LLM returns structured recommendations for both tool call policies and tool result policies, along with reasoning that is stored for auditability.

The specific policy options and enforcement behavior are documented on [AI Tool Guardrails](/docs/platform-ai-tool-guardrails). This built-in agent is the mechanism that proposes those defaults automatically.

## When It Runs

The Tool Policy Configuration Agent can run in two ways:

- **Automatically on tool discovery**. When enabled, newly discovered tools get default tool call policies and tool result policies without manual review first.
- **Manually on demand**. You can trigger it for specific tools when you want Archestra to propose defaults for an existing tool set.

In both cases, tools that already have custom policies with conditions are preserved. Only default policies are overwritten.
