---
title: Policy Configuration
category: Agents
subcategory: Built-In Agents
order: 7
description: Built-in agent that auto-configures security policies for tools
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

The Policy Configuration Subagent analyzes tool metadata and automatically determines appropriate [Dynamic Tools](/docs/platform-dynamic-tools) security policies. Instead of manually configuring call policies and result policies for each tool, this subagent uses LLM structured output to generate both settings in a single call.

## How It Works

When triggered, the subagent sends each tool's name, description, MCP server name, and parameter schema to an LLM. The LLM returns a structured response with two policy decisions:

**toolInvocationAction** (Call Policy) -- when should the tool be allowed to execute:

| Value                             | Meaning                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `allow_when_context_is_sensitive` | Safe to invoke even with sensitive data in the context (read-only tools, internal dev tools) |
| `block_when_context_is_sensitive` | Only invoke when context is safe (tools that could leak data)                                |
| `block_always`                    | Never invoke automatically (tools that delete or destroy data)                |

**trustedDataAction** (Result Policy) -- how should the tool's output be treated:

| Value                    | Meaning                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `mark_as_safe`           | Results are safe (internal systems, databases, dev tools)                                                                            |
| `mark_as_sensitive`      | Results are sensitive but exact values are safe to use (filesystem, external APIs)                                                   |
| `sanitize_with_dual_llm` | Results are processed through the [Dual LLM](/docs/platform-dual-llm) pattern (web scraping, sensitive data needing summarization)   |
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

### Manual: "Configure with Subagent" Button

On the Tools page, select one or more tools using the checkboxes, then click **Configure with Subagent** in the bulk actions bar. The subagent analyzes each selected tool and applies the recommended policies. Tools that already have custom policies (with conditions) are preserved -- only default policies are overwritten.

### Automatic: On Tool Assignment

When the **Auto-configure on tool assignment** toggle is enabled on the Policy Configuration Subagent's settings, the subagent automatically runs whenever a new tool is assigned to an agent. This means newly added tools get security policies without manual intervention.

## LLM Configuration

The subagent requires an LLM API key and model to be configured in the **LLM API Keys** settings. It resolves the first available provider and selects the best model configured for that API key. If no API key is configured, the subagent is unavailable.

See [Supported LLM Providers](/docs/platform-supported-llm-providers) for a full list of supported LLM providers.
