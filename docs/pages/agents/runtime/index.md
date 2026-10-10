---
title: Agent Runtime
description: Run coding agents and long tasks in their own Kubernetes containers
order: 2
alpha: "Agent Runtime is in Alpha and requires the [Agent Sandbox controller](/docs/agents/runtime/setup#cluster-prerequisites)."
lastUpdated: 2026-10-10
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Agent Runtime gives an agent a dedicated runtime: its own container, running a coding agent such as Claude Code or Codex. You get a live terminal, and the files persist. Send follow-ups and continue later with the same files.

Agent Runtime becomes available when your Kubernetes cluster serves the Agent Sandbox API. It needs persistent storage and the [Agent Sandbox controller](/docs/agents/runtime/setup#cluster-prerequisites). See [Setup](/docs/agents/runtime/setup).

A run uses the agent's instructions, tools, skills, and permissions. Its model calls go through the [LLM Proxy](/docs/llm-proxy) and its tools through the [MCP Gateway](/docs/mcp/gateway), so logs, guardrails, and cost limits apply.

![The Create Agent page with Claude Code, Codex, OpenCode, Hermes, and OpenClaw under Coding agents](/docs/automated_screenshots/agents-runtime_create-agent.webp)

## Create an Agent With a Dedicated Runtime

1. Go to **Agents** and click **Add Agent**.
2. Under **Coding agents**, pick **Claude Code**, **Codex**, **OpenCode**, **Hermes**, or **OpenClaw**. The agent opens prefilled.
3. Review **Runtime** on the **Configuration** step. An attention icon marks a setting you must fix. Hover over it to see what to change.
4. Click **Create and run**, or **Continue setup** to add tools, skills, and knowledge first.

![The Configuration step with Claude Code selected in the Runtime picker](/docs/automated_screenshots/agents-runtime_runtime-picker.webp)

Already have an agent? Open it, turn on **Dedicated runtime** on its **Agent Runtime** tab, and click **Save changes**.

From a connected client, ask your agent to create one. [`create_agent`](/docs/reference/archestra-mcp-server#create_agent) takes the same choice as `runtime: { "template": "claude-code" }`, or a custom `image`. [`list_llm_models`](/docs/reference/archestra-mcp-server#list_llm_models) finds a model to pin.

### Choose and Order Coding Agents

With [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update), go to **Settings → Agents → Coding agents** to choose the agents offered during creation.

1. Click **+** to add a choice, or remove one with its **Remove** button.
2. Drag the agent chips into your preferred order. You can also focus an agent's reorder handle and use the arrow keys.
3. Click **Save**. The Create Agent cards and Configuration runtime choices follow the saved order.

Removing a choice preserves existing agents and their runtime configuration.

### Update the Image

A saved agent keeps its image when Archestra upgrades. To use a newer image, change **Image** on the **Agent Runtime** tab. New runs use it. A continued run keeps its original image.

## Models and Credentials

Each run gets a temporary virtual key. Provider keys stay in Archestra.

- **Claude Code:** your Claude Pro or Max subscription, or an API key for Anthropic, Amazon Bedrock, or Anthropic on Vertex AI.
- **Codex:** your ChatGPT subscription, connected under **Model Providers**. An OpenAI API key does not replace it.
- **Other agents:** any [model provider](/docs/llm-proxy/providers) configured in Archestra.

What to know:

- Each person connects their own subscription before their first run. Subscription usage shows in the logs, but it does not count toward cost limits.
- Tools run with the permissions of the person who started the run.

### Clone a Private GitHub Repository

The built-in coding agent images use `GITHUB_TOKEN` to authenticate Git commands, including `git clone`.

1. Save a GitHub token in [Credentials](/docs/admin/security/credentials), with access to the repository. Cloning needs read access to repository contents; pushing needs write access.
2. Open the agent's **Agent Runtime** tab. Under **Environment**, click **Add variable**.
3. Set **Key** to `GITHUB_TOKEN` and **Type** to **Secret**. Under **Secret source**, select your saved credential.
4. Save the agent, start a new run, and ask it to clone the repository using its HTTPS URL. A successful clone creates the repository's directory in the workspace.

What to know:

- For a token used only by this agent, choose **Resource-specific secret** instead. Secret values are provided after saving; turn on **Required variable** to have Chat prompt for a missing value before a run.
- **Accept credentials from a connected client** controls [credential transfers during handoff](/docs/agents/runtime/handoff#pass-a-credential). It is not required for secrets configured under **Environment**.
- To compile code with an additional toolchain, such as Go, [extend the agent image](/docs/agents/runtime/custom-images#add-a-toolchain).

## Run a Task

Select the agent in Chat or in a [Project](/docs/chat/projects) and send a task. This starts a **run**: a container that works on your task. Follow-ups continue the same run. The live terminal opens and shows startup progress. Attach files before you send, and the agent reads them in its container.

- **Leave and come back:** the run keeps working. Reopen it from the sidebar and send a follow-up.
- **Past runs:** the agent's **Runs** tab lists live and finished runs. **Resume** reopens a run without sending a message.
- **Copy text:** turn off **Focus terminal** to select text in the browser.
- **Follow-ups** reach the agent between its turns. To type them into its terminal instead, set **Steering** to **Terminal input** on the **Agent Runtime** tab.
- **Open a web app:** **View connection details** gives a port forwarding command for the agent's **Ports to forward**.

What to know:

- Only the person who started a run can type in it. [Share the run](/docs/admin/access-control#granular-access-control) to give others read-only access. Project members and agent administrators can read it without a share.

### How Long a Run Lasts

- An idle run pauses. Its files stay. Shell processes and development servers stop, so restart them when you resume.
- A run expires after its maximum duration. Its history stays, but its files go. Push your work to a repository or download it first.
- Stopping a run keeps its files. Deleting its container and storage removes them.

<span id="run-controls"></span>

### Limits

Set these under **Limits** on the agent's **Agent Runtime** tab. A field you leave empty uses the [deployment default](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_DEFAULT_TTL_HOURS).

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
- **Review:** a remedy that needs a person shows on the run page. The run's owner approves or denies it. Client permission settings cannot approve it. A run with no eligible reviewer stays blocked.
- **File downloads:** a protected transfer checks the pinned file content before it returns a download command. It refuses a file that needs changes or that passes the protected export limit. The session owner can still download directly.
- **Old sessions:** turning on Guardrails does not protect work that started before. Start a new session. Guardrails do not replace filesystem or network sandboxing.

## Start Runs From Elsewhere

- **Your coding agent:** [hand work off](/docs/agents/runtime/handoff) from Claude Code or another connected agent, and bring it back.
- **A coordinator agent:** add the agent as a [subagent](/docs/agents/subagents). The coordinator keeps answering while the run works. This also covers messaging channels: the result returns to the original thread.
- **Messaging channels:** a message to the agent in [Slack](/docs/agents/triggers-and-channels/slack), [Microsoft Teams](/docs/agents/triggers-and-channels/ms-teams), or [Telegram](/docs/agents/triggers-and-channels/telegram) starts a run. The bot replies with a link to the run, then posts the result in the thread. A follow-up from the same person continues their run.
- **Email:** an [email](/docs/agents/triggers-and-channels/email) to the agent starts a run. The result returns in the thread when replies are on.
- **A2A:** A2A clients start runs and continue them with the same `contextId`. See [A2A](/docs/agents/triggers-and-channels/webhook-a2a#sdks).

## Troubleshooting

- **A run does not start:** see [Setup troubleshooting](/docs/agents/runtime/setup#troubleshooting).
- **A model call fails with HTTP 500 and `x-should-retry: false`:** the organization's [Guardrails](/docs/agents/guardrails) policy is invalid. An administrator must fix it. Retrying does not help.
- **Find a run's traffic:** LLM Proxy Logs and MCP Gateway Logs show the run ID. For health metrics, see [Agent Runtime Health](/docs/admin/observability/metrics#agent-runtime-health).
