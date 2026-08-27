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
4. Review the container image and configure any command override, environment variables, run controls, or elevated permissions it needs.
5. Save the Agent.

The image field starts with the installation's default Background execution image. The Agent's [environment](/docs/platform-environments) also applies to its deployment, including network egress policy and registry access. Use a purpose-built image for the work the Agent performs. For example, a coding Agent's image can include Git, a language toolchain, and repository tooling.

Leave **Command** blank to use the built-in Agent loop supplied by the default image. A custom image can override the command and arguments. Background execution images must include a POSIX shell and `tmux`, which keep the live process attachable from the Executions tab.

The deployment uses the same Agent system prompt and tool access as foreground execution. Keep the Agent's instructions focused on the specialist role you want it to perform in either mode.

### Configuration and secrets

Background execution uses the same environment-variable editor as containerized MCP servers. Use a plain-text, boolean, or number variable for non-sensitive configuration, and use **Secret** for credentials. A secret can be either:

- **Per user** — each person supplies their own value before starting background work.
- **Shared** — an Agent administrator configures one value used by every caller.

After saving the Agent, its **Overview** shows whether required secrets are ready. Secret values are stored through Archestra's configured secrets provider and injected only into the Background execution deployment; they are not stored in the Agent definition.

When external Vault storage is enabled, the credential control uses the same Vault secret picker as MCP server deployments. Users select a secret and key; they never paste the secret value into the Agent form.

### Run controls

- **Steering** controls how follow-up instructions reach a live run. **Turn boundary** safely queues them between Agent turns. **Terminal input** types into an interactive CLI and is intended for custom images such as coding-agent CLIs.
- **Idle timeout** stops a deployment after it finishes its current work and receives no follow-up instructions for the configured period.
- **Maximum duration** is a hard wall-clock lifetime for each run. Kubernetes enforces the limit even when the process is still active.
- **Metered LLM budget** creates a spend ceiling for the run's short-lived virtual API key. After the ceiling is reached, further metered model calls are blocked by the LLM proxy. Subscription-backed calls have no billed spend and do not count against this ceiling.
- **CPU and memory** override the installation defaults for this Agent. Leave them blank unless the workload needs different sizing.

Each delegated task starts in a fresh pod. Task state, events, logs, and the final response remain attached to the execution. The container filesystem is removed when the execution ends. Keep durable outputs in a repository or an external artifact store.

## Delegate Work

Give the coordinator Agent access to the specialist under **Tools & Knowledge → Subagents**, and assign the task tools it needs. The coordinator uses `start_task` for durable work and can use `get_task`, `list_tasks`, `steer_task`, and `cancel_task` to manage it.

`start_task` returns immediately. If the target Agent has Background execution configured, the task starts in that Agent's deployment. Otherwise, it runs through the foreground Agent loop. The coordinator can continue answering other messages while the task works.

### Messaging channels

For a lightweight coding-task channel, assign a foreground coordinator Agent and give it exactly one subagent with Background execution configured. A message beginning with 🦀 (or `:crab:`) is routed straight to that Background execution Agent. The channel receives one short task-started reply, followed by the pull request link when it is available.

Users do not need to name tools, copy Agent IDs, or describe the delegation mechanism. Messages without the marker continue through the coordinator's normal foreground conversation.

## View Executions

An Agent with Background execution configured has an **Executions** tab. Use it to:

- review execution outcomes and timestamps
- read live or retained container logs
- attach to the live shell for troubleshooting or interactive work

Archestra retains up to 1 MB of container output after the pod is removed. Only the user whose credentials started an execution can attach to its live shell. Agent administrators cannot enter another user's shell. There is no separate Background execution permission or sidebar resource.

## Example Architecture

A common setup uses two Agents:

- A coordinator Agent is assigned to a messaging channel. It answers ordinary questions in the foreground and delegates durable requests.
- A coding Agent has repository tools and Background execution configured. It receives delegated tasks in an isolated coding image and reports the result to the coordinator.

Only the coding Agent needs Background execution. The coordinator remains a normal foreground Agent.
