---
title: Overview
category: Agents
order: 1
description: Agent overview, A2A protocol, and trigger configuration
lastUpdated: 2026-03-27
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

![Agent Platform Swarm](/docs/platform-agents-swarm.webp)

Agents in Archestra provide a comprehensive no-code solution for building autonomous and semi-autonomous agents that can access your data and work together in swarms. Each agent consists of a User Prompt, System Prompt, assigned tools, and sub-agents, and can be triggered via:

- Archestra Chat UI
- A2A (Agent-to-Agent) protocol
- [Incoming Email](/docs/platform-agent-triggers-email)
- [Slack](/docs/platform-slack)
- [MS Teams](/docs/platform-ms-teams)

Trigger setup is managed from **Agent Triggers**. Slack, MS Teams, and Incoming Email each have their own setup flow, and Incoming Email also owns the per-agent email invocation settings.

## A2A (Agent-to-Agent)

A2A is a JSON-RPC 2.0 gateway that allows external systems to invoke agents programmatically. Each Prompt exposes two endpoints:

- **Agent Card Discovery**: `GET /v1/a2a/:promptId/.well-known/agent.json`
- **Message Execution**: `POST /v1/a2a/:promptId`

### Authentication

All A2A requests require Bearer token authentication. Generate tokens via the Profile's API key settings or use team tokens for organization-wide access.

### Agent Card

The discovery endpoint returns an AgentCard describing the agent's capabilities:

```json
{
  "name": "My Agent",
  "description": "Agent description from prompt",
  "version": "1.0.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "skills": [{ "id": "default", "name": "Default Skill" }]
}
```

### Sending Messages

Send JSON-RPC 2.0 requests to execute the agent:

```bash
curl -X POST "https://api.example.com/v1/a2a/<promptId>" \
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

### Delegation Chain

A2A supports nested agent-to-agent calls. When one agent invokes another, the delegation chain tracks the call path for observability. This enables multi-step agent workflows where agents can use other agents as tools.

Delegated sub-agents also inherit the current [tool guardrails](/docs/platform-ai-tool-guardrails) trust state. If the parent agent has already crossed a sensitive-context boundary, the child starts in that same unsafe state, so downstream tool call policies continue to enforce the stricter rules instead of resetting during delegation.

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
