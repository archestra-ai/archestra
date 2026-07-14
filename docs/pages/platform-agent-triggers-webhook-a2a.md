---
title: Webhook (A2A)
category: Agents
order: 9
description: Invoke agents over HTTP using the A2A protocol
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Webhook (A2A) lets external systems invoke an agent by POSTing to a per-agent URL. The endpoint follows the [A2A (Agent-to-Agent) 1.0 protocol](https://a2a-protocol.org/) for interoperability with other A2A-compatible callers.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/v2/a2a/{agentId}/.well-known/agent-card.json` | A2A 1.0 AgentCard for capability discovery |
| `POST` | `/v2/a2a/{agentId}` | JSON-RPC entry point for `SendMessage`, `SendStreamingMessage`, and `GetTask` |

The AgentCard advertises the agent's name, description, and a single skill derived from the agent. A2A clients fetch it first to discover what the agent can do, then send messages to the POST endpoint.

## SDKs

| SDK | A2A 1.0 support | Works with `/v2/a2a` |
|-----|-----------------|----------------------|
| [a2a-python](https://github.com/a2aproject/a2a-python) | Yes | Yes — use directly |
| [a2a-js](https://github.com/a2aproject/a2a-js) (TypeScript) | Not yet — tracked in [a2a-js#321](https://github.com/a2aproject/a2a-js/issues/321) | No — speak JSON-RPC directly, or translate `role` / `state` enums between 0.3 and 1.0 |

Other languages can call the JSON-RPC endpoint directly using the request shapes below.

## Authentication

Every request carries a bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

A2A validates the token the same way the [MCP gateway](/docs/mcp-authentication) does, so it accepts the methods below. Whichever you use, the caller's [role and team access](/docs/platform-access-control) gates which agents they can reach.

| Method | Best for | Acting user | Notes |
| --- | --- | --- | --- |
| Bearer token | Direct API integrations and scripts | Personal tokens only | Static platform token from **Settings > Your Account** (personal), **Settings > Teams** (team), or **Settings > Organization** (org). Team and org tokens don't identify a single user. |
| External IdP JWT (JWKS) | Callers signed in through a corporate identity provider | Yes | Bind the agent to an [identity provider](/docs/platform-identity-providers) in its settings; the caller then presents their IdP's JWT directly and Archestra resolves the user — no Archestra token to hand out. |
| OAuth client credentials | Backend services and machine-to-machine callers | No | Register an [OAuth client](/docs/mcp-authentication) and add the agent to its allowed list. |
| OAuth authorization code | An app acting for whoever is signed in | Yes | A confidential OAuth client that resolves the individual user. |

To give each of your users their own identity without handing out tokens, bind the agent to your identity provider and forward each user's JWT from your backend — the External IdP JWT method. For a browser app in front of a long-running agent, keep the token in your backend and call A2A server-to-server.

## SendMessage

JSON-RPC method `SendMessage` runs a message against the agent.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "11111111-1111-1111-1111-111111111111",
      "role": "ROLE_USER",
      "parts": [{ "text": "Summarize the last 5 PRs in repo X." }]
    }
  }
}
```

Field notes:

- `messageId` — required, must be unique per message (UUIDs recommended).
- `role` — `ROLE_USER` for caller, `ROLE_AGENT` for the agent's reply.
- `parts[].text` — message body.
- `contextId` / `taskId` — omit on the first message; copy from the response for follow-up turns.

The response is one of two shapes inside `result`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "message": {
      "messageId": "...",
      "role": "ROLE_AGENT",
      "contextId": "327a5306-c7dc-4e0c-ba2f-107da6c2548b",
      "parts": [{ "text": "Here is the summary..." }]
    }
  }
}
```

If the agent needs human approval before running a tool, `result` contains a `task` with `status.state = "TASK_STATE_INPUT_REQUIRED"` and `metadata.approvalRequests`. See [Approvals](#approvals).

## SendStreamingMessage

`SendStreamingMessage` runs a message and streams the reply as [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events), instead of one buffered response. Use it for long-running agents — the connection stays alive and delivers tokens as the agent produces them, so a slow turn never trips a client or proxy timeout.

The request is a `SendMessage` body with `method` set to `SendStreamingMessage`. The AgentCard advertises support with `capabilities.streaming: true`.

```bash
curl -N -X POST https://archestra.example.com/v2/a2a/<agentId> \
  -H "Authorization: Bearer <platform_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendStreamingMessage",
    "params": {
      "message": {
        "messageId": "11111111-1111-1111-1111-111111111111",
        "role": "ROLE_USER",
        "parts": [{ "text": "Summarize the last 5 PRs in repo X." }]
      }
    }
  }'
```

The response is a `text/event-stream`. Each `data:` frame is a JSON-RPC response carrying one `statusUpdate`. Interim frames hold a text delta with `final: false`; the last frame is `final: true` with `state: "TASK_STATE_COMPLETED"` and the complete message.

```
data: {"jsonrpc":"2.0","id":1,"result":{"statusUpdate":{"taskId":"...","status":{"state":"TASK_STATE_WORKING","message":{"role":"ROLE_AGENT","parts":[{"text":"Here "}]}},"final":false}}}

data: {"jsonrpc":"2.0","id":1,"result":{"statusUpdate":{"taskId":"...","status":{"state":"TASK_STATE_COMPLETED","message":{"role":"ROLE_AGENT","parts":[{"text":"Here is the summary..."}]}},"final":true}}}
```

Read the final `TASK_STATE_COMPLETED` frame for the authoritative answer — the interim deltas are for live display. When an agent needs approval, the stream ends with a `task` frame instead (see [Approvals](#approvals)). Comment lines (`: keep-alive`) hold the connection open during long gaps; skip any line that is not a `data:` frame.

## Multi-turn conversations

To keep messages in the same conversation, copy `contextId` from the first response into every subsequent request:

```bash
# Turn 1
curl -X POST https://archestra.example.com/v2/a2a/<agentId> \
  -H "Authorization: Bearer <platform_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "11111111-1111-1111-1111-111111111111",
        "role": "ROLE_USER",
        "parts": [{ "text": "hi, my name is victor" }]
      }
    }
  }'
# → result.message.contextId = "327a5306-..."

# Turn 2 — reuse contextId
curl -X POST https://archestra.example.com/v2/a2a/<agentId> \
  -H "Authorization: Bearer <platform_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "22222222-2222-2222-2222-222222222222",
        "role": "ROLE_USER",
        "contextId": "327a5306-c7dc-4e0c-ba2f-107da6c2548b",
        "parts": [{ "text": "do you know who i am?" }]
      }
    }
  }'
```

`contextId` is generated by Archestra on the first message. Clients cannot supply their own.

`X-Archestra-Session-Id` and `Mcp-Session-Id` do **not** group conversations — they are observability-only headers. Use `contextId` to continue a conversation.

## Approvals

When an agent's tool call hits a [tool invocation policy](/docs/platform-ai-tool-guardrails) requiring approval, the response is a `task`, not a `message`:

```json
{
  "result": {
    "task": {
      "id": "task-...",
      "contextId": "ctx-...",
      "status": { "state": "TASK_STATE_INPUT_REQUIRED" },
      "metadata": {
        "approvalRequests": [
          { "approvalId": "appr-...", "toolName": "send_email", "approved": false, "resolved": false }
        ]
      }
    }
  }
}
```

To approve (or reject), send a follow-up `SendMessage` with `taskId`, `contextId`, and decisions in `metadata.taskOps`:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "33333333-3333-3333-3333-333333333333",
      "role": "ROLE_USER",
      "taskId": "task-...",
      "contextId": "ctx-...",
      "parts": [],
      "metadata": {
        "taskOps": {
          "approvalDecisions": [{ "approvalId": "appr-...", "approved": true }]
        }
      }
    }
  }
}
```

Approvals also work through [Slack](/docs/platform-slack) and [MS Teams](/docs/platform-ms-teams). The same flow handles multi-request and multi-turn approvals.

## GetTask

Use `GetTask` to fetch the current state of a task (useful while polling an approval task):

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "GetTask",
  "params": { "id": "task-..." }
}
```

## Pass-through payload (v1 only)

The legacy `POST /v1/a2a/{agentId}` endpoint accepts any non-A2A JSON body. The body is stringified and passed to the agent as the user message — useful for tools like Zapier that just want to fire an event at an agent:

```json
{
  "event": "issue_opened",
  "title": "Login button broken on Safari",
  "url": "https://github.com/acme/app/issues/1421"
}
```

`v1` is single-turn — every call is a fresh conversation. For multi-turn use `v2` with a `SendMessage` envelope.

## Observability

Pass a session ID to group all LLM and MCP tool calls in [Observability](/docs/platform-observability):

```
X-Archestra-Session-Id: my-session-123
```

Without it, Archestra generates one per request. The header is independent of `contextId` — it tags traces only.

## Configuration

A2A uses the same LLM configuration as [Chat](/docs/platform-chat). See [Deployment - Environment Variables](/docs/platform-deployment#environment-variables) for the full list of `ARCHESTRA_CHAT_*` variables.
