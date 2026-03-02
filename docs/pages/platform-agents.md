---
title: Overview
category: Agents
order: 1
description: Agent overview, A2A protocol, and trigger configuration
lastUpdated: 2026-01-25
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

![Agent Platform Swarm](/docs/platform-agents-swarm.png)

Agents in Archestra provide a comprehensive no-code solution for building autonomous and semi-autonomous agents that can access your data and work together in swarms. Each agent consists of a User Prompt, System Prompt, assigned tools, and sub-agents, and can be triggered via:
- Archestra Chat UI
- A2A (Agent-to-Agent) protocol
- [Incoming Email](/docs/platform-agent-triggers-email)
- [Slack](/docs/platform-slack)
- [MS Teams](/docs/platform-ms-teams)

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

### Configuration

A2A uses the same LLM configuration as Chat. See [Deployment - Environment Variables](/docs/platform-deployment#environment-variables) for the full list of `ARCHESTRA_CHAT_*` variables.

