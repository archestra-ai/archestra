---
title: Overview
category: Agents
order: 1
description: Agent overview, invocation paths, knowledge sources, and prompt templating
lastUpdated: 2026-04-27
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Agents are reusable AI workers with instructions, tool access, and optional knowledge retrieval. You can invoke the same agent from chat, external integrations, or automation without rebuilding the workflow each time.

An agent can include:

- a system prompt that defines behavior
- suggested prompts for common tasks in chat
- one or more assigned tools
- optional automatic tool assignment from matching MCP catalog labels
- an optional search-and-run tool mode for hiding most tools from MCP `tools/list`
- optional delegation targets to other agents
- one or more assigned knowledge sources

## Tool Assignment Mode

An agent has a tool assignment mode: **Manual** (default) or **Automatic**.

In **Manual** mode, you pick each tool directly. In **Automatic** mode, the agent receives tools from MCP catalog entries that share at least one `key: value` label pair with the agent. For example, an agent labeled `department: finance` automatically receives tools from catalog items tagged `department: finance`.

Use Automatic mode when labels already describe which MCP servers belong to a team, department, app, or environment and you want new matching catalog entries to be picked up without editing every agent.

See [MCP Gateway - Tool Assignment Mode](/docs/platform-mcp-gateway#tool-assignment-mode) for the full behavior and constraints.

## Search-and-Run Tool Mode

By default, an agent exposes every assigned tool through MCP `tools/list`.

For larger toolsets, you can switch the agent to **search-and-run tool mode**. In that mode, MCP clients only see the built-in [`search_tools`](/docs/platform-archestra-mcp-server#search_tools) and [`run_tool`](/docs/platform-archestra-mcp-server#run_tool) tools. Those two tools are enabled implicitly by the mode and do not need normal tool assignment.

- `search_tools` can still discover them
- `run_tool` can still execute them

Use this when the full tool menu is too large to send to the model on every turn, but you still want the agent to keep access to the same assigned toolset.

See [MCP Gateway - Search-and-Run Tool Mode](/docs/platform-mcp-gateway#search-and-run-tool-mode) for the MCP-client-facing behavior and the same mode on gateways.

## Invocation Paths

Agents can be triggered through:

- Archestra Chat UI
- [Webhook (A2A)](/docs/platform-agent-triggers-webhook-a2a)
- [Scheduled Tasks](/docs/platform-agent-triggers-schedule)
- [Incoming Email](/docs/platform-agent-triggers-email)
- [Slack](/docs/platform-slack)
- [MS Teams](/docs/platform-ms-teams)

Trigger setup is managed from **Agent Triggers**. Slack, MS Teams, and Incoming Email each have their own setup flow, and Incoming Email also owns the per-agent email invocation settings.

## Knowledge Sources

Agents can be assigned one or more Knowledge Bases or knowledge connectors. This gives the agent retrieval access to your internal docs and connected systems without hardcoding those sources into the prompt.

When at least one knowledge source is assigned, Archestra automatically adds the built-in [`query_knowledge_sources`](/docs/platform-archestra-mcp-server#query_knowledge_sources) tool to that agent. The model can call it during a run to search across the assigned sources and pull relevant context into its answer.

See [Knowledge Bases](/docs/platform-knowledge-bases) for how retrieval works and how sources are assigned. See [Archestra MCP Server](/docs/platform-archestra-mcp-server) for the built-in tool behavior and RBAC requirements.

## Delegation

When an agent delegates work to another agent, Archestra tracks the full call chain for observability. Delegated agents also inherit the current [tool guardrails](/docs/platform-ai-tool-guardrails) trust state, so downstream tool policy enforcement does not reset mid-run.

## System Prompt Templating

Agent system prompts support [Handlebars](https://handlebarsjs.com/) templating. Templates are rendered at runtime before the prompt is sent to the LLM, with the current user's context injected as variables.

### Variables

| Variable         | Type     | Description                          |
| ---------------- | -------- | ------------------------------------ |
| `{{user.name}}`  | string   | Name of the user invoking the agent  |
| `{{user.email}}` | string   | Email of the user invoking the agent |
| `{{user.teams}}` | string[] | Team names the user belongs to       |

### Helpers

| Helper            | Output       | Description                      |
| ----------------- | ------------ | -------------------------------- |
| `{{currentDate}}` | `2026-03-12` | Current date in UTC (YYYY-MM-DD) |
| `{{currentTime}}` | `14:30:00 UTC` | Current time in UTC (HH:MM:SS UTC) |

All [built-in Handlebars helpers](https://handlebarsjs.com/guide/builtin-helpers.html) (`#each`, `#if`, `#with`, `#unless`) are also available, along with Archestra helpers like `includes`, `equals`, `contains`, and `json`.

### Example

```handlebars
You are a helpful assistant for
{{user.name}}. Today's date is
{{currentDate}}.

{{#includes user.teams "Engineering"}}
  You have access to engineering-specific tools and documentation.
{{/includes}}

{{#if user.teams}}
  The user belongs to:
  {{#each user.teams}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}.
{{/if}}
```
