---
title: Overview
category: Agents
order: 1
description: Agent overview, invocation paths, knowledge sources, and prompt templating
lastUpdated: 2026-04-23
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Agents are reusable AI workers with instructions, tool access, and optional knowledge retrieval. You can invoke the same agent from chat, external integrations, or automation without rebuilding the workflow each time.

An agent can include:

- a system prompt that defines behavior
- suggested prompts for common tasks in chat
- one or more assigned tools
- an optional search-and-run tool mode for hiding most tools from MCP `tools/list`
- optional delegation targets to other agents
- one or more assigned knowledge sources

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
- A2A (Agent-to-Agent) protocol
- [Scheduled Tasks](/docs/platform-agent-triggers-schedule)
- [Incoming Email](/docs/platform-agent-triggers-email)
- [Slack](/docs/platform-slack)
- [MS Teams](/docs/platform-ms-teams)

Trigger setup is managed from **Agent Triggers**. Slack, MS Teams, and Incoming Email each have their own setup flow, and Incoming Email also owns the per-agent email invocation settings.

## Knowledge Sources

Agents can be assigned one or more knowledge bases or knowledge connectors. This gives the agent retrieval access to your internal docs and connected systems without hardcoding those sources into the prompt.

When at least one knowledge source is assigned, Archestra automatically adds the built-in [`query_knowledge_sources`](/docs/platform-archestra-mcp-server#query_knowledge_sources) tool to that agent. The model can call it during a run to search across the assigned sources and pull relevant context into its answer.

See [Knowledge Bases](/docs/platform-knowledge-bases) for how retrieval works and how sources are assigned. See [Archestra MCP Server](/docs/platform-archestra-mcp-server) for the built-in tool behavior and RBAC requirements.

## A2A (Agent-to-Agent)

A2A is a JSON-RPC 2.0 gateway for invoking agents programmatically from external systems. Each agent exposes two endpoints:

- **Agent Card Discovery**: `GET /v1/a2a/:agentId/.well-known/agent.json`
- **Message Execution**: `POST /v1/a2a/:agentId`

### Authentication

All A2A requests require Bearer token authentication. You can use a personal token from **Settings > Your Account**, a team token from **Settings > Teams**, or the organization token from **Settings > Organization**, as long as that token has access to the target agent.

### Agent Card

The discovery endpoint returns an Agent Card describing the agent's name, description, URL, and basic input/output capabilities. Use it when an external client needs to discover an agent before sending `message/send` requests.

### Sending Messages

Send JSON-RPC 2.0 requests to execute the agent:

```bash
curl -X POST "https://api.example.com/v1/a2a/<agentId>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "message/send",
    "params": {
      "message": {
        "parts": [{ "kind": "text", "text": "Hello agent!" }]
      }
    }
  }'
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "messageId": "msg-...",
    "role": "agent",
    "parts": [{ "kind": "text", "text": "Agent response..." }]
  }
}
```

### Pass-Through Payloads (Webhooks)

The `POST /v1/a2a/:promptId` endpoint also accepts arbitrary JSON payloads that are not wrapped in a JSON-RPC envelope. This is useful when integrating with webhook sources whose payload shape cannot be customized.

When the body is not a valid JSON-RPC 2.0 request, the entire payload is JSON-stringified and forwarded to the agent as the user message. The response is still returned as a JSON-RPC envelope, with `id` defaulting to `1`.

```bash
curl -X POST "https://api.example.com/v1/a2a/<promptId>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "event": "issue.opened", "issue": { "id": 42, "title": "Bug" } }'
```

The agent receives the literal string `{"event":"issue.opened","issue":{"id":42,"title":"Bug"}}` as its user message and can parse/route on it as needed.

### Delegation Chain

When an agent delegates work to another agent, Archestra tracks that call chain for observability. Delegated agents also inherit the current [tool guardrails](/docs/platform-ai-tool-guardrails) trust state so downstream tool policy enforcement does not reset mid-run.

### Configuration

A2A uses the same LLM configuration as Chat. See [Deployment - Environment Variables](/docs/platform-deployment#environment-variables) for the full list of `ARCHESTRA_CHAT_*` variables.

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
