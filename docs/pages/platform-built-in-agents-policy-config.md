---
title: Tool Policy Configuration Agent
category: Agents
subcategory: Built-In Agents
order: 7
description: Built-in agent that auto-configures tool call policies and tool result policies
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

The Tool Policy Configuration Agent analyzes tool metadata and automatically determines appropriate [AI tool guardrails](/docs/platform-ai-tool-guardrails). Instead of manually configuring tool call policies and tool result policies for each tool, this built-in agent uses LLM structured output to generate both settings in a single call.

## How It Works

When triggered, the subagent sends each tool's name, description, MCP server name, and parameter schema to an LLM. The LLM returns a structured response with two policy decisions:

**toolInvocationAction** (Tool Call Policy) -- when should the tool be allowed to execute:

| Value                             | Meaning                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `allow_when_context_is_sensitive` | Safe to invoke even with sensitive data in the context (read-only tools, internal dev tools) |
| `block_when_context_is_sensitive` | Only invoke when context is safe (tools that could leak data)                                |
| `block_always`                    | Never invoke automatically (tools that delete or destroy data)                |

**trustedDataAction** (Tool Result Policy) -- how should the tool's output be treated:

| Value                    | Meaning                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `mark_as_safe`           | Results are safe (internal systems, databases, dev tools)                                                                            |
| `mark_as_sensitive`      | Results are sensitive but exact values are safe to use (filesystem, external APIs)                                                   |
| `sanitize_with_dual_llm` | Results are processed through the [Dual LLM Agent](/docs/platform-dual-llm) pattern (web scraping, sensitive data needing summarization)   |
| `block_always`           | Results are blocked entirely                                                                                                       |

The LLM also returns a reasoning field explaining why it chose those settings (this reasoning is stored on the tool record for auditability).

## Analysis Prompt

The subagent evaluates tool metadata against examples like:

- Internal read-only tools (list-endpoints, get-config): allow invocation, mark results safe
- Database queries (read-only): allow invocation, mark results sensitive
- File reads (code/config): allow invocation, mark results sensitive
- Web search/scraping: block when context is sensitive, mark results safe
- Delete/remove/destroy operations: block invocation always, mark results safe

The subagent blocks any tool that is obviously destructive — i.e. tools that delete or destroy data.

## Triggering Policy Configuration

The Tool Policy Configuration Agent can run in two ways:

- **Automatically on tool discovery**. When enabled, newly discovered tools get default tool call policies and tool result policies without manual review first.
- **Manually on demand**. You can trigger it for specific tools when you want Archestra to propose defaults for an existing tool set.

In both cases, tools that already have custom policies with conditions are preserved. Only default policies are overwritten.
