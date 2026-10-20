---
title: Hand Off Work
description: Hand a task from your coding agent to Agent Runtime, then bring the result back
order: 2
beta: "Agent Runtime is in Beta and requires the [Agent Sandbox controller](/docs/agents/runtime/setup#cluster-prerequisites)."
lastUpdated: 2026-10-20
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

## Post a Worker's File to Slack

The agent answering in Slack can post a worker's file with its own bot identity. Use [`transfer_workspace_file`](/docs/reference/archestra-mcp-server#transfer_workspace_file) to authorize the download, execute the returned command with [`run_command`](/docs/reference/archestra-mcp-server#run_command), then call [`post_thread_file`](/docs/reference/archestra-mcp-server#post_thread_file) with the downloaded sandbox path. The destination is the current Slack thread.

If the file is missing after an approval pause or a new turn, repeat the transfer into the current sandbox. Transfer and publication remain subject to guardrails.

## Hand Off With Guardrails On

With [Guardrails](/docs/agents/guardrails) on, a run keeps the restrictions of the session that started it, when Guardrails check that session. They check it when your coding agent is connected as a [Guardrails client](/docs/agents/guardrails/clients): its model requests go through the LLM Proxy.

- **A client Guardrails check:** the run starts under your session's restrictions. Its answer passes the guardrail check before your agent reads it. Another session cannot steer the run or read its files.
- **Any other client:** the [Unrecognized clients](/docs/agents/guardrails/clients#unrecognized-clients) setting decides. When it is **Allowed**, the run starts without your session's restrictions, and Guardrails still check each tool call inside it. When it is **Blocked**, the run does not start.

A file you read or download while the run is in the middle of a tool call comes back as `pending`. Guardrails pin that version and release it once the tool call finishes, so call the same tool again a little later.

If a request is refused:

- **"Guardrails do not recognize this client":** unrecognized clients are blocked. [Connect the client](/docs/agents/guardrails/clients#connect-a-client) so that Guardrails check it. Or allow unrecognized clients, which needs [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).
- **"This runtime is bound to a different session":** another session started the run. Continue it from that session.
- **"This runtime is bound to a Guardrails session, and this call carried no proof of its source":** the call reached Archestra without the proof the LLM Proxy attaches to a connected client's runtime calls, usually because the client's model requests did not go through the LLM Proxy, or because the model made a steer or write while Guardrails were off. Retry it from the conversation that started the run. If the client is not connected, [connect it](/docs/agents/guardrails/clients#connect-a-client).
- **"The protected file could not be admitted":** Guardrails held the file's bytes from your session. The ruling after the message says why and names any plan that lets them through.

## Pass a Credential

Your agent can give the run a credential, such as a GitHub token, with [`transfer_credential`](/docs/reference/archestra-mcp-server#transfer_credential). It reaches the container on the next turn and serves only your runs.

What to know:

- The value passes through your agent's model and transcript. A secret that must never reach a model belongs in the agent's **Environment variables** instead.
- To refuse transfers, turn off **Accept credentials from a connected client** on the agent.
- Claude Code's auto mode can block the transfer before it reaches Archestra. [Connect](/docs/integrations/claude-code#gateway-tool-permissions) adds the allow rule that prevents this. If you added the gateway another way, add the rule in `/permissions`.
