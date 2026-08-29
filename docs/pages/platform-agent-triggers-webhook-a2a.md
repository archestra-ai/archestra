---
title: Webhook (A2A)
category: Agents
order: 10
description: Invoke agents over HTTP using the A2A protocol
lastUpdated: 2026-08-29
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Webhook (A2A) lets external systems invoke an agent by POSTing to a per-agent URL. The endpoint follows the [A2A (Agent-to-Agent) 1.0 protocol](https://a2a-protocol.org/) for interoperability with other A2A-compatible callers.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/v2/a2a/agents` | Every AgentCard your token can reach |
| `GET`  | `/v2/a2a/{agentId}/.well-known/agent-card.json` | A2A 1.0 AgentCard for capability discovery |
| `POST` | `/v2/a2a/{agentId}` | JSON-RPC entry point for `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`, and `ListTasks` |

The AgentCard advertises the agent's name, description, and a single skill derived from the agent. A2A clients fetch it first to discover what the agent can do, then send messages to the POST endpoint.

## Discovery

The A2A spec describes three ways for a client to find an agent. Two of them apply here.

### The Agent Card Path

Each agent has its own card, so the path is scoped to an agent:

```
GET /v2/a2a/{agentId}/.well-known/agent-card.json
```

This differs from the convention in [RFC 8615](https://datatracker.ietf.org/doc/html/rfc8615), where a `.well-known` path sits at the root of a domain. One deployment hosts many agents, and a card describes exactly one — a card at the domain root could not say which agent it meant. A client that builds the URL by appending `/.well-known/agent-card.json` to a hostname gets a `401`, not a card — and not a `404`, so the failure reads like a credentials problem when it is really a path problem. Give the client the agent-scoped URL instead. You can copy it from the agent's Connect section.

### The Registry

A token belongs to a user, a team, or an organization rather than to one agent, so it usually reaches several:

```
GET /v2/a2a/agents
```

The response is a list of full AgentCards — the same card each agent serves individually. Only agents your token can reach are listed, so two callers can get different results from the same URL. Built-in agents that the platform runs for itself are left out.

Use this when you do not already know an agent's ID. The alternative is to configure the ID directly, which the spec also allows and which suits a fixed integration.

### Card Access

Cards require a token. That is a departure from the spec's public-card model, and it is deliberate: a card carries the agent's name, description, and system prompt, which the spec itself names as sensitive.

A request with no token gets a `401` with a `WWW-Authenticate` header, so a client that arrives with nothing still learns which scheme to use. Cards are cached with an `ETag`; send `If-None-Match` and you get a `304` when nothing changed.

Only platform tokens work with the registry. An identity provider JWT or an OAuth token is validated against a specific agent, so it has no meaning until you name one — use those with a single agent's card.

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
| Bearer token | Direct API integrations and scripts | Personal tokens only | Static platform token from **Personal Settings** (personal — click your name in the sidebar), **Settings > Teams** (team), or **Settings > Organization** (org). Team and org tokens don't identify a single user. |
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
- `contextId` — omit on the first message; copy from the response for follow-up turns.
- `taskId` — only to resume a task waiting for input (see [Approvals](#approvals)). Tasks in any other state reject messages.

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

A plain blocking send answers with a `message` when the Agent uses the foreground loop. For an Agent with [Background execution](/docs/platform-agent-background-execution) configured, `SendMessage` runs in that deployment and returns a completed `task`. The response is also a task when the run needs approval, when you set `returnImmediately`, or when you stream — see [Tasks](#tasks).

## Tasks

A task is a durable unit of work with an id, a state, a message history, and [artifacts](#artifacts). Archestra creates one when a run outlives the simple request/response shape:

- `SendStreamingMessage` — every streamed run is a task.
- `returnImmediately` — background execution (below).
- Background-enabled Agent — `SendMessage` uses the Agent's configured execution backend.
- Tool approval — the run pauses for a human decision.

A task moves through the A2A 1.0 states:

| State | Meaning |
|-------|---------|
| `TASK_STATE_SUBMITTED` | Created, run not started yet |
| `TASK_STATE_WORKING` | Run in progress |
| `TASK_STATE_INPUT_REQUIRED` | Paused for input — a tool approval |
| `TASK_STATE_COMPLETED` | Finished; the answer is in `artifacts` and `history` |
| `TASK_STATE_FAILED` | The run errored; `status.message` carries the reason |
| `TASK_STATE_CANCELED` | Stopped by `CancelTask` |

`COMPLETED`, `FAILED`, and `CANCELED` are terminal. A terminal task rejects further messages — start the next turn with `contextId` only. `status.timestamp` (RFC 3339) records when the state last changed.

## Background Execution

Set `configuration.returnImmediately: true` to get the task handle back at once. The run continues on the server; you poll `GetTask` or open `SubscribeToTask` for the result. A blocking `SendMessage` to a Background-enabled Agent still uses its execution backend, but waits for the task to settle before returning it.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "22222222-2222-2222-2222-222222222222",
      "role": "ROLE_USER",
      "parts": [{ "text": "Audit every open PR for license headers." }]
    },
    "configuration": { "returnImmediately": true }
  }
}
```

The response is the task in `TASK_STATE_SUBMITTED`. A client disconnect never cancels a running task — use `CancelTask` to stop one.

## GetTask

`GetTask` fetches the current state of a task:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "GetTask",
  "params": { "id": "task-...", "historyLength": 0 }
}
```

`historyLength` is optional: omit it for the full history, `0` omits the `history` field, `N` returns the N most recent messages. A completed task carries its answer in `artifacts`.

## CancelTask

`CancelTask` stops a task and returns it in `TASK_STATE_CANCELED`:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "CancelTask",
  "params": { "id": "task-..." }
}
```

Cancellation is durable first, cooperative second: the task settles as canceled immediately, and the running model call is aborted best-effort. Canceling a terminal task returns error `-32002`.

## Push Notifications

Push notifications POST a task's status changes to a URL you own, so a client that cannot hold a connection open — a serverless function, a mobile app — still learns when the work finishes. Register a webhook against a task:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "CreateTaskPushNotificationConfig",
  "params": {
    "taskId": "task-...",
    "pushNotificationConfig": {
      "url": "https://hooks.example.com/a2a",
      "token": "correlation-123",
      "authentication": { "scheme": "Bearer", "credentials": "your-endpoint-secret" }
    }
  }
}
```

Each delivery is a `POST` with `Content-Type: application/a2a+json`. The body is the same event a stream carries — a `statusUpdate` for the new state. Your `credentials` come back as the `Authorization` header and your `token` as `X-A2A-Notification-Token`, so the receiver can authenticate the call and match it to its own request.

Field notes:

- `url` — must be absolute and `https`. URLs pointing at private, loopback, or link-local addresses are rejected.
- `token` — optional correlation value, echoed on every delivery.
- `authentication.credentials` — stored encrypted and never returned by a read; `Get` and `List` show only the scheme.
- `id` — omit to create a config. Pass the id of an existing one to update it in place, so repeated setup calls don't stack up duplicate webhooks.

Deliveries carry state changes, not tokens: use `SendStreamingMessage` for incremental text. Delivery is at-least-once and retried on network and 5xx errors, so make your receiver idempotent. A webhook that stays down never affects the task itself — `GetTask` remains the authoritative record.

Manage configs with `GetTaskPushNotificationConfig` and `DeleteTaskPushNotificationConfig` (both take `taskId` and `id`), and `ListTaskPushNotificationConfigs` (takes `taskId`).

The AgentCard advertises support with `capabilities.pushNotifications: true`.

## SubscribeToTask

`SubscribeToTask` re-joins a running task's event stream — after a dropped `SendStreamingMessage` connection, for example:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "SubscribeToTask",
  "params": { "id": "task-..." }
}
```

The response is a `text/event-stream`. The first frame is the full `task` snapshot (state, history, artifacts so far); then live `statusUpdate` and `artifactUpdate` frames follow until the task settles. Multiple clients can subscribe to one task; all see the same events in the same order. Subscribing to a terminal task returns error `-32004` — use `GetTask` for finished work.

## ListTasks

`ListTasks` pages through your tasks for the agent, newest status change first:

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "ListTasks",
  "params": { "pageSize": 20, "status": "TASK_STATE_WORKING" }
}
```

Optional filters: `contextId`, `status`, `statusTimestampAfter` (RFC 3339). `historyLength` and `includeArtifacts` control payload size — both default to omitting. The response is `{ tasks, nextPageToken, pageSize, totalSize }`; pass `nextPageToken` back to fetch the next page.

## Artifacts

Artifacts are a task's outputs, separate from its conversational history. Archestra materializes the agent's final answer as one text artifact named `agent-response`:

```json
{
  "artifactId": "...",
  "name": "agent-response",
  "parts": [{ "text": "Here is the full audit..." }]
}
```

`GetTask` returns artifacts on the task. Streams deliver them incrementally as `artifactUpdate` frames: chunks with `append: true` extend the artifact, and `lastChunk: true` carries the final content.

## SendStreamingMessage

`SendStreamingMessage` runs a message and streams the reply as [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events), instead of one buffered response. The connection delivers tokens as the agent produces them, so a slow turn never trips a client or proxy timeout. Every streamed run is a [task](#tasks) — if the connection drops, the run keeps going and `SubscribeToTask` re-joins it.

The request is a `SendMessage` body with `method` set to `SendStreamingMessage`. The AgentCard advertises support with `capabilities.streaming: true`.

The stream shape depends on the `A2A-Version` header:

```bash
curl -N -X POST https://archestra.example.com/v2/a2a/<agentId> \
  -H "Authorization: Bearer <platform_token>" \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
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

With `A2A-Version: 1.0`, the stream is the spec's lifecycle shape. It opens with the `task` object, then `statusUpdate` and `artifactUpdate` frames, and closes when the task reaches a terminal state:

```
data: {"jsonrpc":"2.0","id":1,"result":{"task":{"id":"...","contextId":"...","status":{"state":"TASK_STATE_SUBMITTED"}}}}

data: {"jsonrpc":"2.0","id":1,"result":{"statusUpdate":{"taskId":"...","contextId":"...","status":{"state":"TASK_STATE_WORKING"}}}}

data: {"jsonrpc":"2.0","id":1,"result":{"artifactUpdate":{"taskId":"...","contextId":"...","artifact":{"artifactId":"...","name":"agent-response","parts":[{"text":"Here "}]}}}}

data: {"jsonrpc":"2.0","id":1,"result":{"statusUpdate":{"taskId":"...","contextId":"...","status":{"state":"TASK_STATE_COMPLETED"}}}}
```

Without the header, the stream keeps the pre-1.0 shape existing clients were built on: `statusUpdate` frames carrying text deltas with `final: false`, then a terminal `final: true` frame with the complete message. Read that final frame for the authoritative answer. Text arrives in small batches rather than per-token; concatenating the deltas always yields the full text.

Comment lines (`: keep-alive`) hold the connection open during long gaps; skip any line that is not a `data:` frame. When an agent needs approval, the stream ends with the input-required task (see [Approvals](#approvals)).

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

`contextId` is generated by Archestra on the first message. Clients cannot supply their own. Do not copy `taskId` into follow-up turns — a task is one unit of work, and finished tasks reject messages.

`X-Archestra-Session-Id` and `Mcp-Session-Id` do **not** group conversations — they are observability-only headers. Use `contextId` to continue a conversation.

## Approvals

When an agent's tool call hits a [tool invocation policy](/docs/platform-ai-tool-guardrails) requiring approval, the response is a `task` in `TASK_STATE_INPUT_REQUIRED`:

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

Once every request is decided, the run resumes and the response is the settled task. `CancelTask` on an input-required task cancels it and clears the pending requests.

Approvals also work through [Slack](/docs/platform-slack) and [MS Teams](/docs/platform-ms-teams). The same flow handles multi-request and multi-turn approvals.

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
