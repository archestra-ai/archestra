---
title: Agent Runtime
description: Run coding agents and long tasks in their own Kubernetes containers
order: 2
beta: "Agent Runtime is in Beta and requires the [Agent Sandbox controller](/docs/agents/runtime/setup#cluster-prerequisites)."
lastUpdated: 2026-10-26
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Agent Runtime gives an agent a dedicated runtime: its own container, running a coding agent such as Claude Code or Codex. You get a live terminal, and the files persist. Send follow-ups and continue later with the same files.

Agent Runtime becomes available when your Kubernetes cluster serves the Agent Sandbox API. It needs persistent storage and the [Agent Sandbox controller](/docs/agents/runtime/setup#cluster-prerequisites). See [Setup](/docs/agents/runtime/setup).

A run uses the agent's instructions, tools, skills, and permissions. Its model calls go through the [LLM Proxy](/docs/llm-proxy) and its tools through the [MCP Gateway](/docs/mcp/gateway), so logs, guardrails, and cost limits apply.

![The Create Agent page with Claude Code, Codex, OpenCode, Hermes, OpenClaw, Grok Build, and Kimi Code under Agent Runtimes](/docs/automated_screenshots/agents-runtime_create-agent.webp)

## Create an Agent With a Dedicated Runtime

1. Go to **Agents** and click **Add Agent**.
2. Under **Agent Runtimes**, pick **Claude Code**, **Codex**, **OpenCode**, **Hermes**, **OpenClaw**, **Grok Build**, or **Kimi Code**. The agent opens prefilled.
3. Review **Runtime** on the **Configuration** step. An attention icon marks a setting you must fix. Hover over it to see what to change.
4. Click **Create and run**, or **Continue setup** to add tools, skills, and knowledge first.

![The Configuration step with Claude Code selected in the Runtime picker](/docs/automated_screenshots/agents-runtime_runtime-picker.webp)

Already have an agent? Open it, turn on **Dedicated runtime** on its **Agent Runtime** tab, and click **Save changes**.

From a connected client, ask your agent to create one. [`create_agent`](/docs/reference/archestra-mcp-server#create_agent) takes the same choice as `runtime: { "template": "claude-code" }`, or a custom `image`. [`list_llm_models`](/docs/reference/archestra-mcp-server#list_llm_models) finds a model to pin.

### Choose and Order Agent Runtimes

With [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update), go to **Settings → Agents → Agent Runtimes** to choose the agents offered during creation.

1. Click **+** to add a choice, or remove one with its **Remove** button.
2. Drag the agent chips into your preferred order. You can also focus an agent's reorder handle and use the arrow keys.
3. Click **Save**. The Create Agent cards and Configuration runtime choices follow the saved order.

Removing a choice preserves existing agents and their runtime configuration.

### Update the Image

Built-in coding agent images use the deployment's current catalog image unless pinned by digest. When the image reference changes, your next follow-up restarts the Agent on that image and keeps your files.

If you change a custom image or the **Privileged mode** setting, which grants access to the host system, start a new run. Existing files are kept until their retention deadline.

## Models and Credentials

Each run gets a temporary virtual key. Provider keys stay in Archestra.

- **Claude Code:** your Claude Pro or Max subscription, or an API key for Anthropic, Amazon Bedrock, or Anthropic on Vertex AI.
- **Codex:** your ChatGPT subscription, connected under **Model Providers**. An OpenAI API key does not replace it.
- **Grok Build:** your SuperGrok subscription, connected under **Model Providers**, or an xAI API key. Pick an xAI model, such as `grok-4.7`.
- **Kimi Code:** a Kimi for Coding membership key or a Kimi API Platform key, added as a Moonshot (Kimi) key under **Model Providers**. Pick a Kimi model, such as `k3.1-pro`. Models of other providers work too if they use Chat Completions.
- **Other agents:** any [model provider](/docs/llm-proxy/providers) configured in Archestra.

What to know:

- Each person connects their own subscription before their first run. Subscription usage shows in the logs, but it does not count toward cost limits.
- Claude subscription runs use Opus unless you select another **Model**. **Claude account default** follows Claude Code's choice for your account.
- Tools run with the permissions of the person who started the run.

### Clone a Private GitHub Repository

Give a built-in coding agent a `GITHUB_TOKEN`, and it can clone, commit, push, and open pull requests as that token's GitHub account.

1. Save a GitHub token in [Credentials](/docs/admin/credentials), with access to the repository. Cloning needs read access to repository contents; pushing needs write access.
2. Open the agent's **Agent Runtime** tab. Under **Environment**, click **Add variable**.
3. Set **Key** to `GITHUB_TOKEN` and **Type** to **Secret**. Under **Secret source**, select your saved credential.
4. Save the agent, start a new run, and ask it to clone the repository, make a change, and open a pull request. The pull request's commits show the token's GitHub account as their author. If GitHub rejects the token, the run stops before the agent starts.

What to know:

- For a token used only by this agent, choose **Resource-specific secret** instead. Secret values are provided after saving; turn on **Required variable** to have Chat prompt for a missing value before a run.
- **Accept credentials from a connected client** controls [credential transfers during handoff](/docs/agents/runtime/handoff#pass-a-credential). It is not required for secrets configured under **Environment**.
- The built-in images include Node.js, Python, Rust, and PostgreSQL with pgvector. To compile code with another toolchain, such as Go, [extend the agent image](/docs/agents/runtime/custom-images#add-a-toolchain).

## Run a Task

Select the agent in Chat or in a [Project](/docs/chat/projects) and send a task. This starts a **run**: a container that works on your task. Follow-ups continue the same run. The live terminal opens and shows startup progress. Attach files before you send, and the agent reads them in its container.

- **Leave and come back:** the run keeps working. Reopen it from the sidebar and send a follow-up.
- **Past runs:** the agent's **Runs** tab lists live and finished runs. Select the **Open full view** expand icon for the larger terminal and run controls. For a retained run you started, select **Resume** to reopen it without sending a message.
- **Stop a run:** the person who started it can select **Stop** in Chat or on the agent's **Runs** tab. Confirm with **Stop run**. Saved files and history remain available.
- **Copy text:** select **Select text** to copy text with the browser. Select **Type** to use the running app's controls again.
- **Follow-ups** reach the agent between its turns. To type them into its terminal instead, set **Steering** to **Terminal input** on the **Agent Runtime** tab.
- **Open a web app:** for a run you started, select **Open full view**, then **More run actions → View connection details** for the agent's port forwarding command.

What to know:

- Only the person who started a run can type in it. [Share the run](/docs/admin/access-control#granular-access-control) to give others read-only access. Project members and agent administrators can read it without a share.

### How Long a Run Lasts

- An idle run pauses. Its files stay. Shell processes and development servers stop, so restart them when you resume.
- A run expires after its maximum duration. Its history stays, but its files go. Push your work to a repository or download it first.
- Stopping a run keeps its files. Deleting its container and storage removes them.

<span id="run-controls"></span>

### Limits

Set these under **Limits** on the agent's **Agent Runtime** tab. A field you leave empty uses the [deployment default](/docs/admin/deployment/configuration#ARCHESTRA_AGENT_RUNTIME_DEFAULT_TTL_HOURS).

| Setting | What It Does |
| --- | --- |
| **Idle timeout** | Stops the run when it finishes a task and no follow-up arrives in this time. |
| **Maximum duration** | Ends the run after this time, even mid-task, and deletes its files. Follow-ups do not extend it. |
| **Metered LLM budget** | Blocks metered model calls once the run spends this amount. Subscription usage does not count. |
| **CPU and memory** | Sets the container's size. |

<span id="environments-and-network-egress"></span>

## Network Access

Unless an administrator sets a policy, a run can reach the public internet. To limit it, set a [network egress policy](/docs/admin/environments#network-egress-policies) on the agent's [environment](/docs/admin/environments).

What to know:

- A strict policy can break a task. Allow the repositories, package registries, and services the task uses.
- A continued run picks up the current policy.

## Guardrails in a Run

[Guardrails](/docs/agents/guardrails) check each tool call and tool result inside the run.

- **Delegated runs** get their parent's restrictions before work starts. Follow-up instructions keep them. An answer crosses the guardrail check before another agent gets it.
- **Review:** a remedy that needs a person shows in the run's live terminal, as the agent's own question card or form. The run's owner approves or denies it there. Client permission settings cannot approve it. An agent with no question card or form keeps the call blocked.
- **File downloads:** a protected transfer checks the pinned file content before it returns a download command. It refuses a file that needs changes or that passes the protected export limit. The session owner can still download directly.
- **Old sessions:** turning on Guardrails does not protect work that started before. Start a new session. Guardrails do not replace filesystem or network sandboxing.

## Start Runs From Elsewhere

- **Remote Agents:** [hand work off](/docs/agents/runtime/handoff) from Claude Code or another connected agent, and bring it back.
- **A coordinator agent:** add the agent as a [subagent](/docs/agents/subagents). The coordinator keeps answering while the run works. This also covers messaging channels: the result returns to the original thread.
- **Messaging channels:** a message to the agent in [Slack](/docs/agents/triggers-and-channels/slack), [Microsoft Teams](/docs/agents/triggers-and-channels/ms-teams), or [Telegram](/docs/agents/triggers-and-channels/telegram) starts a run. The bot replies with a link to the run, then posts the result in the thread. A follow-up from the same person continues their run.
- **Email:** an [email](/docs/agents/triggers-and-channels/email) to the agent starts a run. The result returns in the thread when replies are on.
- **A2A:** A2A clients start runs and continue them with the same `contextId`. See [A2A](/docs/agents/triggers-and-channels/webhook-a2a#sdks).
- **Scripts and CI:** a script starts a run with [`start_agent_run`](/docs/reference/archestra-mcp-server#start_agent_run) through an MCP Gateway and polls [`get_agent_run`](/docs/reference/archestra-mcp-server#get_agent_run). The run ends when the agent finishes. A failed run says whether to start again: see [Read Why a Run Failed](#read-why-a-run-failed). Continue the saved workspace with [`steer_agent_run`](/docs/reference/archestra-mcp-server#steer_agent_run).

### Read Why a Run Failed

A failed run carries a stable `failure.code`, so a script can retry or stop without parsing the message.

| Code | Retry | What happened |
| --- | --- | --- |
| `launch.kubernetes_unavailable` | Yes | The Kubernetes API was overloaded or unavailable. |
| `launch.kubernetes_rejected` | No | Kubernetes refused the run's objects. |
| `launch.controller_missing` | No | The cluster has no Agent Sandbox controller. |
| `launch.misconfigured` | No | The agent's settings or the caller's credentials do not allow a start. |
| `launch.capacity_timeout` | Yes | The pod did not start or resume in time. |
| `launch.credentials_timeout` | Yes | The run's credentials did not reach the pod in time. |
| `pod.evicted` | Yes | Kubernetes evicted or preempted the pod. |
| `pod.oom_killed` | No | The agent ran out of memory. |
| `pod.image_pull` | No | The image could not be pulled. |
| `pod.failed` | No | The pod failed for another reason. |
| `turn.interrupted` | Yes | The pod was replaced while the agent worked. The turn is not repeated. |
| `turn.recording_failed` | Yes | The terminal recording stopped, so the turn stopped. |
| `turn.process_exited` | No | The agent exited before it reported a result. |
| `turn.exit_status` | No | The agent exited with an error and gave no reason. |
| `budget.exceeded` | No | The run spent its **Metered LLM budget**. |
| `run.settings_changed` | No | The agent's image or host access changed. Start a new run. |
| `run.resume_refused` | No | The saved workspace cannot take this turn. |
| `run.workspace_busy` | Yes | Another turn took the saved workspace first. |
| `run.workspace_missing` | No | The workspace was deleted while the agent worked. |
| `run.deadline_exceeded` | No | The workspace reached its retention deadline. |
| `run.unknown` | No | No other code applies. |
| `image.<code>` | Depends | The agent's image reported this code. Maintained images mark rate limits, provider outages, and proxy or tool startup failures as retriable. |

What to know:

- `failure.retriable` is `true` when a new run of the same agent is likely to succeed without a change.
- `failure` is `null` on a run that did not fail, and on a failed run with no code.
- Under [Guardrails](/docs/agents/guardrails), [`get_agent_run`](/docs/reference/archestra-mcp-server#get_agent_run) withholds the status reason but still returns the code. [`GET /api/agent-runs/:taskId`](/docs/reference/api#/Agents/getMyAgentRun) also returns `failure.message`, the same text as `statusReason`.

## Troubleshooting

- **A run does not start:** see [Setup troubleshooting](/docs/agents/runtime/setup#troubleshooting).
- **A run ends with a pod failure:** open **Failed details** for the Kubernetes pod name, failure reason, and container exit code when available. Share these details with your cluster operator; for example, `OOMKilled` identifies a memory termination and `Evicted` includes Kubernetes' eviction message.
- **A model call fails with a Guardrails error:** the message says what to do, and the status says who.
  - `400`: the conversation holds content [Guardrails](/docs/agents/guardrails) cannot store, such as binary tool output. Rewind past it or start a new conversation.
  - `409`: the conversation cannot continue. Start a new one.
  - `500` with `x-should-retry: false`: an administrator must fix the policy or the deployment setting the message names, or report the reference it carries.
  - `503`: a short outage. The client retries on its own.
- **A model call fails with HTTP 400 and names `X-Archestra-Runtime-Binding`:** the agent's image does not send the [run headers](/docs/agents/runtime/custom-images#send-the-run-headers). Rebuild it on a current maintained image, then start a new run.
- **Find a run's traffic:** LLM Proxy Logs and MCP Gateway Logs show the run ID. For health metrics, see [Agent Runtime Health](/docs/admin/observability/metrics#agent-runtime-health).
