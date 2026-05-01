---
title: Webhook (A2A)
category: Agents
order: 7
description: Invoke agents over HTTP using the A2A protocol or any JSON payload
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Webhook (A2A) lets external systems invoke an agent by POSTing to a per-agent URL. The endpoint follows the [A2A (Agent-to-Agent) protocol](https://a2a-protocol.org/) for interoperability with other A2A-compatible callers, and also accepts any non-A2A JSON payload as a pass-through, so it works as a generic webhook for tools that just want to fire data at an agent.

Use it for: internal services kicking off an agent run, third-party tools (Zapier, n8n, GitHub Actions) sending events as webhooks, or another agent platform calling an Archestra agent over A2A.

Only **internal agents** (agents with `agentType: "agent"`) can be invoked this way. External-agent records cannot expose an A2A endpoint.

## Endpoints

Each internal agent gets two endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/v1/a2a/{agentId}/.well-known/agent.json` | A2A AgentCard for capability discovery |
| `POST` | `/v1/a2a/{agentId}` | Execute a message against the agent |

The AgentCard advertises the agent's name, description, and a single skill derived from the agent. A2A clients fetch it first to discover what the agent can do, then send messages to the POST endpoint.

## Authentication

Both endpoints require an Archestra token in the `Authorization` header:

```
Authorization: Bearer <platform_token>
```

A personal token from **Settings > Your Account**, a team token from **Settings > Teams**, or the organization token from **Settings > Organization** all work, as long as the token has access to the target agent. Token issuance is the same as for the [MCP Gateway](/docs/platform-mcp-gateway) — there is no separate token type for A2A.

## Request Formats

The POST endpoint accepts two shapes.

**A2A JSON-RPC envelope** — for callers that speak the A2A protocol natively:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "parts": [
        { "kind": "text", "text": "Summarize the last 5 PRs in repo X." }
      ]
    }
  }
}
```

**Pass-through payload** — any other JSON body is stringified and passed to the agent as the user message. This is what makes the endpoint work as a generic webhook:

```json
{
  "event": "issue_opened",
  "title": "Login button broken on Safari",
  "url": "https://github.com/acme/app/issues/1421"
}
```

The agent receives the serialized payload as its first message and can reason over it directly.

## Response

The endpoint always replies with a JSON-RPC response envelope, regardless of the request format:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "messageId": "...",
    "role": "agent",
    "parts": [
      { "kind": "text", "text": "Here is the summary..." }
    ]
  }
}
```

On failure, `result` is replaced with an `error` object containing a JSON-RPC error code and a message.

## Session Grouping

To group multiple A2A requests into a single conversation in [Observability](/docs/platform-observability), pass a session ID in the request:

```
X-Archestra-Session-Id: my-session-123
```

All LLM and MCP tool calls executed during the request are recorded as children of one trace and tagged with the session ID. If no header is provided, Archestra generates a unique ID per request.

## Configuration

A2A uses the same LLM configuration as [Chat](/docs/platform-chat). See [Deployment - Environment Variables](/docs/platform-deployment#environment-variables) for the full list of `ARCHESTRA_CHAT_*` variables.

## Example

```bash
curl -X POST https://archestra.example.com/v1/a2a/<agentId> \
  -H "Authorization: Bearer <platform_token>" \
  -H "Content-Type: application/json" \
  -H "X-Archestra-Session-Id: incident-4471" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "parts": [{ "kind": "text", "text": "Run the on-call check." }]
      }
    }
  }'
```
