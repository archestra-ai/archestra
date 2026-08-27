---
title: Background Execution
category: Agents
order: 7
description: Run delegated Agent tasks in an isolated deployment
lastUpdated: 2026-08-27
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Background execution gives an Agent an isolated deployment for delegated, long-running work. It is an optional capability of the Agent, not a separate resource to create or grant access to.

The execution rule is simple:

- **Direct conversations stay in the foreground.** Chatting with the Agent in Archestra Chat, Slack, MS Teams, Telegram, email, or through its A2A endpoint uses the normal Archestra Agent loop. The messaging-channel 🦀 shortcut described below is an explicit delegation request, not an ordinary direct message.
- **Delegated tasks can run in the background.** When another Agent starts a durable task for this Agent, Archestra uses the Agent's deployment if Background execution is configured. Without it, the delegated task uses the foreground Agent loop.

This lets a coordinator Agent stay responsive in a messaging channel while a specialist Agent handles durable work in its own container. You can also chat directly with the specialist; that direct conversation still stays in the foreground.

## Configure Background Execution

An administrator must first enable Background execution for the deployment. See [Deployment configuration](/docs/platform-deployment#agent-background-execution).

To configure an Agent:

1. Open **Agents** and select the Agent.
2. Select **Edit**, then open **Advanced**.
3. Turn on **Background execution**.
4. Configure the container image and, when needed, its command, environment variables, credentials, idle timeout, steering, and privileged mode.
5. Save the Agent.

The Agent's [environment](/docs/platform-environments) also applies to its Background execution deployment, including network egress policy. Use a purpose-built image for the work the Agent performs. For example, a coding Agent's image can include Git, a language toolchain, and repository tooling.

### Credentials

Credential declarations describe the values the deployment expects. Each declaration can be either:

- **Per user** — each person supplies their own value before starting background work.
- **Shared** — an Agent administrator configures one value used by every caller.

After saving the Agent, its **Overview** shows whether the required credentials are ready. Secrets are stored through Archestra's configured secrets provider and are injected only into the Background execution deployment.

When external Vault storage is enabled, the credential control uses the same Vault secret picker as MCP server deployments. Users select a secret and key; they never paste the secret value into the Agent form.

## Delegate Work

Give the coordinator Agent access to the specialist under **Tools & Knowledge → Subagents**, and assign the task tools it needs. The coordinator uses `start_task` for durable work and can use `get_task`, `list_tasks`, `steer_task`, and `cancel_task` to manage it.

`start_task` returns immediately. If the target Agent has Background execution configured, the task starts in that Agent's deployment. Otherwise, it runs through the foreground Agent loop. The coordinator can continue answering other messages while the task works.

### Messaging channels

For a lightweight coding-task channel, assign a foreground coordinator Agent and give it exactly one subagent with Background execution configured. A message beginning with 🦀 (or `:crab:`) is routed straight to that Background execution Agent. The channel receives one short task-started reply, followed by the pull request link when it is available.

Users do not need to name tools, copy Agent IDs, or describe the delegation mechanism. Messages without the marker continue through the coordinator's normal foreground conversation.

## View Runs

An Agent with Background execution configured has a **Runs** tab on its page. Use it to:

- review run state and timestamps
- follow live container logs
- attach to the live shell for troubleshooting or interactive work

Logs and shell attachment are available while the deployment is running. Access follows the Agent's existing scope and permissions; there is no separate Background execution permission or sidebar resource.

## Example Architecture

A common setup uses two Agents:

- A coordinator Agent is assigned to a messaging channel. It answers ordinary questions in the foreground and delegates durable requests.
- A coding Agent has repository tools and Background execution configured. It receives delegated tasks in an isolated coding image and reports the result to the coordinator.

Only the coding Agent needs Background execution. The coordinator remains a normal foreground Agent.
