---
title: Hooks
beta: "Hooks are on whenever the [code sandbox](/docs/agents#code-sandbox) is on, which is the default."
description: Scripts that run in the sandbox when an agent lifecycle event fires
order: 6
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Run your own script at key moments in a chat. A hook is a short Python or shell script. It can add context when a chat starts, or check each tool call before and after it runs. Hooks use the same payload shape as Claude Code hooks, so many port with small changes.

Hooks run in the chat's [code sandbox](/docs/agents#code-sandbox).

![The Hooks editor on an agent](/docs/automated_screenshots/agents-hooks_hooks-editor.webp)

<span id="adding-a-hook"></span>

## Add a Hook

1. Open the agent and go to **Tools, Skills & Knowledge → Hooks**.
2. Pick the event and the language: Python or shell.
3. Write the script. **Available context** shows the payload that event sends.
4. Click **Save changes**.

To turn a hook off, use its row toggle. A Python hook can list packages under **Requirements**. They install before the script runs.

## Events

| Event | Fires | What the Script Can Do |
| --- | --- | --- |
| **Session start** | When a chat starts | Add context. Its output goes into the agent's system prompt. |
| **Pre tool use** | Before each tool call | Block the call. Exit with code 2, and the error output becomes the reason the model sees. |
| **Post tool use** | After each tool call | Give feedback. Exit with code 2, and the error output goes into the tool result as `[hook feedback]`. |

<span id="the-script-contract"></span>

## Write the Script

The script reads one JSON payload from standard input. This hook blocks one tool:

```python
import json
import sys

payload = json.load(sys.stdin)

if payload["tool_name"] == "slack__send_message":
    print("Slack messages need human review first", file=sys.stderr)
    sys.exit(2)
```

What to know:

- **Exit codes:** 0 continues. 2 blocks the call, or adds feedback. Any other code is ignored.
- Hooks fail open. A crash, or a run past 30 seconds, never stops the chat. To enforce a rule, use [Guardrails](/docs/agents/guardrails).
- **Payload fields:** every event sends `hook_event_name`, `session_id`, `cwd`, and `permission_mode`. Tool events add `tool_name` and `tool_input`. **Post tool use** adds `tool_response`, cut at 50,000 characters.

<span id="editing-hooks-from-an-agent"></span>

## Let an Agent Write Hooks

Assign the built-in [`list_hooks`](/docs/reference/archestra-mcp-server#list_hooks), [`create_hook`](/docs/reference/archestra-mcp-server#create_hook), [`update_hook`](/docs/reference/archestra-mcp-server#update_hook), and [`delete_hook`](/docs/reference/archestra-mcp-server#delete_hook) tools to an agent. Then ask it, for example: "add a hook that blocks tool calls to the production database." Clients connected through the [MCP Gateway](/docs/mcp/gateway), such as Claude Code, can use the same tools.
