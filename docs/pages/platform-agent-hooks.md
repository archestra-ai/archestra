---
title: Hooks (Beta)
category: Agents
order: 11
description: Scripts that run in the sandbox when an agent lifecycle event fires
lastUpdated: 2026-07-19
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Hooks are small Python or shell scripts that run when a lifecycle event fires in a chat. They run in the conversation's [code sandbox](./platform-code-sandbox). Use them to inject context at the start of a session, or to inspect every tool call before and after it runs.

> **Beta feature** — hooks need the code sandbox. The Hooks section appears in the agent dialog only when the sandbox runtime is configured.

## Adding a Hook

Open an agent's create or edit dialog and go to the Hooks section. Pick the event, pick the language — Python or shell — and write the script in the editor. The "Available context" panel shows the exact payload the selected event delivers.

A hook can be disabled without deleting it, with the toggle on its row.

## Events

| Event | Fires | What the script can do |
| --- | --- | --- |
| Session start | When a conversation starts | Inject context: stdout is appended to the agent's system prompt |
| Pre tool use | Before every tool call | Block the call: exit with code 2, and stderr becomes the reason shown to the model |
| Post tool use | After every tool call | Give feedback: exit with code 2, and stderr is appended to the tool result as `[hook feedback]` |

## The Script Contract

Each script receives one JSON payload on stdin. Field names match Claude Code's hook payloads, so existing Claude Code hook scripts port unchanged.

Every event includes:

| Field | Value |
| --- | --- |
| `hook_event_name` | `SessionStart`, `PreToolUse`, or `PostToolUse` |
| `session_id` | The conversation ID |
| `cwd` | The sandbox working directory, `/home/sandbox` |
| `permission_mode` | Always `default` |

Event-specific fields:

| Event | Fields |
| --- | --- |
| Session start | `source` (always `startup`), `model` |
| Pre tool use | `tool_name`, `tool_input` |
| Post tool use | `tool_name`, `tool_input`, `tool_response` (truncated to 50,000 characters) |

Exit code 0 proceeds. Exit code 2 blocks (Pre tool use) or attaches feedback (Post tool use). Any other exit code, or a crash, is ignored — hooks fail open and never break the conversation. Scripts time out after 30 seconds.

A Pre tool use hook that blocks one tool:

```python
import json
import sys

payload = json.load(sys.stdin)

if payload["tool_name"] == "slack__send_message":
    print("Slack messages need human review first", file=sys.stderr)
    sys.exit(2)
```

Python hooks can declare dependencies in the Requirements field — they install before the script runs.

## Editing Hooks from an Agent

The built-in `list_hooks`, `create_hook`, `update_hook`, and `delete_hook` tools manage hooks over MCP. Assign them to an agent and it can write its own hooks in chat — "add a hook that blocks tool calls touching the production database", for example. External clients connected to the agent's [MCP gateway](./platform-mcp-gateway), such as Claude Code, get the same tools.

## Use Case: Guarding a Support Agent

Fjord Outfitters runs a support agent with access to their order system. A Pre tool use hook blocks any `orders__refund` call above a threshold, so large refunds always reach a human. A Session start hook prints the current returns policy, so every conversation starts with it in context — no system prompt edits when the policy changes.
