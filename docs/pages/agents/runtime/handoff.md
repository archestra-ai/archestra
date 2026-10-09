---
title: Hand Off Work
description: Hand a task from your coding agent to Agent Runtime, then bring the result back
order: 2
lastUpdated: 2026-10-09
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Start a task on your laptop, and let Archestra finish it. Your coding agent hands the task to an agent in Archestra, with your repository changes and context. The task keeps running after you close the laptop. When it is done, your coding agent brings the result back as a patch.

With a [dedicated runtime](/docs/agents/runtime), the task runs in its own container, with a live terminal you can watch.

## Hand Off a Task

1. Install the **Agent Runtime Handoff** skill from [Connect](/docs/get-started/connect).
2. Ask your coding agent to "hand this over to Archestra".
3. To continue locally, ask it to "bring it back and continue here".
4. Review the repository patch it returns before you apply it.

## What Your Agent Uses

The skill drives these tools on the [MCP Gateway](/docs/mcp/gateway). You can also call them yourself.

- **Find an agent:** [`list_agents`](/docs/reference/archestra-mcp-server#list_agents).
- **Start a run:** [`start_run`](/docs/reference/archestra-mcp-server#start_run).
- **Check progress:** [`get_run`](/docs/reference/archestra-mcp-server#get_run) or [`list_runs`](/docs/reference/archestra-mcp-server#list_runs).
- **Change course:** [`steer_run`](/docs/reference/archestra-mcp-server#steer_run) or [`cancel_run`](/docs/reference/archestra-mcp-server#cancel_run). Steering a finished run starts a new turn with the same files.
- **Read or write files** without starting a turn: [`read_workspace_file`](/docs/reference/archestra-mcp-server#read_workspace_file) and [`write_workspace_file`](/docs/reference/archestra-mcp-server#write_workspace_file).

Only the person who started a run can steer it or use its files.

## Pass a Credential

Your agent can give the run a credential, such as a GitHub token, with [`transfer_credential`](/docs/reference/archestra-mcp-server#transfer_credential). It reaches the container on the next turn and serves only your runs.

What to know:

- The value passes through your agent's model and transcript. A secret that must never reach a model belongs in the agent's **Environment variables** instead.
- To refuse transfers, turn off **Accept credentials from a connected client** on the agent.
