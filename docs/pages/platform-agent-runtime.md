---
title: Agent Runtime (Beta)
category: Agents
order: 7
description: Run coding agents and delegated tasks in isolated containers
lastUpdated: "2026-09-21"
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Agent Runtime runs an Agent in its own Kubernetes container for coding, commands, and long-running tasks. You can follow its terminal output, send instructions, and continue work with the same files.

A dedicated runtime belongs to an existing Agent. It uses that Agent's instructions, tools, Environment, and access rules. Choose the built-in agent, Claude Code, Codex, OpenCode, Hermes, OpenClaw, or your own image.

Chat and Projects open an interactive terminal for Agents with a dedicated runtime. Delegation, A2A, email, and schedules start unattended tasks that return a result when finished. Ordinary messaging-channel conversations stay in the foreground unless the channel Agent delegates work.

## Runtime Backend

Administrators can enable [warm pools](/docs/platform-deployment#warm-pools) to start containers before tasks arrive. New runs use these spare containers to reduce startup time.

Kubernetes is currently the supported runtime backend. Archestra manages task state, credentials, cancellation, and run history. The cluster runs the containers where Agents execute commands.

## Cluster Prerequisites

Your administrator must enable Agent Runtime on a Kubernetes cluster with persistent storage. See [Agent Runtime Deployment](/docs/platform-deployment#agent-runtime) for controller installation, provider requirements, and privileged workloads.

Fargate-only clusters are not supported. See [EKS With Fargate](/docs/platform-deployment#eks-with-fargate) for a hybrid setup with EC2 runtime nodes.

## Configure Agent Runtime

Choose a maintained template from **Create Agent**. The **Runtime** picker sits below Visibility in Configuration. Switching runtimes keeps your name, description, and instructions. It replaces the image, command, inference settings, environment variables, and credential declarations.

Maintained runtimes arrive preconfigured. Model or Authentication settings open by default; other settings are collapsed for review. **Archestra** uses the platform’s native agent loop with the selected model and tools, without a dedicated runtime. **Custom image** opens the model, image, and inference settings.

Existing Agents keep their saved runtime image when the platform upgrades. To use a newer maintained image, update **Image** in the Agent's **Agent Runtime** settings and start a new run. Continuing an existing workspace keeps its original image.

An attention icon marks missing or incompatible settings that need to be fixed before creation, even when the section is collapsed. Hover over the icon to see what needs to change. Claude personal accounts connect after saving. Codex requires your ChatGPT subscription before creation. Claude provider billing requires an explicit compatible connection.

The created page and Agent header show remaining setup requirements. Connection changes refresh the banner automatically. Each person connects their own subscription before running a shared Agent.

For an existing Agent, configure **Dedicated Agent runtime** in its **Agent Runtime** tab.

Select the Agent in Chat or a Project and send your first task. Its live terminal opens so you can follow progress and provide input. See [Work With Runs In Chat](#work-with-runs-in-chat) for continuing work.

The **Agents** list marks an Agent with a dedicated runtime with a **Runtime** badge. An Agent created from a popular agent template shows the template name instead — **Claude Code**, for example. Its **Chat** action reads **Start run**.

**Settings → Agents → Runtime Backend** shows backend health and deployment defaults. Each Agent can override its image, command, environment variables, resources, and run controls. Deployment defaults remain managed by the operator.

Use an image containing the tools your task needs. A coding image might include Git and a language toolchain. Leave **Command** blank when the image supplies `archestra-runtime-agent`; otherwise set its executable and arguments.

In the runtime's Advanced settings, enter any container ports you want to forward, such as `3000` for a web app. Separate multiple ports with commas. Open **Connection details** on an active run to copy its port forwarding command. Leave the field empty when the runtime exposes no ports.

### Environments And Network Egress

Containers use the Agent's [Environment](/docs/platform-environments), including its namespace and network egress policy. Without an override, the organization default applies, followed by the built-in **Public internet** policy.

Allow the repositories, package registries, and services your task needs. Archestra keeps its control plane and DNS reachable. Continuing a run applies the current policy. Changing execution namespaces requires a new run.

See [Network Egress Policies](/docs/platform-environments#network-egress-policies) for policy modes and cluster support.

### Built-In Archestra Agent

The built-in agent loop is available through **Custom image** using the default runtime image. It includes a shell tool, the Agent's assigned MCP tools, and its system prompt. It supports OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. Follow-up instructions are consumed between model turns.

Use it when you need a general coding loop without a specific third-party client's behavior. The [runtime-agent source](https://github.com/archestra-ai/archestra/tree/main/platform/runtime-agent) provides a working integration example.

### Model Inference And MCP Tools

Provider-backed runs use the Agent's selected model through Archestra's LLM proxy. The runtime receives a temporary virtual key; provider credentials remain in the backend. These calls retain platform logs, policies, and cost controls.

Assigned MCP tools are available through the Agent's gateway with the initiating user's permissions. Adding a tool does not require rebuilding the image.

**Claude Code** supports two connection types:

- **Personal Claude subscription:** each person connects their own Pro or Max account. Claude Code sends inference through Archestra's proxy, using your subscription for Anthropic access. Proxy logs show token usage. Subscription requests do not count toward metered cost limits. Inference guardrails and MCP tool policies apply.
- **API key or cloud provider:** use Anthropic, AWS Bedrock, or Anthropic on Vertex AI through Archestra's proxy. Platform inference controls apply. See [Supported LLM Providers](/docs/platform-supported-llm-providers) for setup.

Personal Claude connections belong to your user account. Connect once to reuse your subscription across your Claude Code Agents and Environments. They work only in the Claude Code runtime. Tokens use your configured secrets backend. Reconnect when the connection expires.

Sign-in connects directly to Claude through your browser and the Archestra backend. It does not start a container or download a runtime image. Starting an Agent still requires its runtime image. Disconnecting your account prevents new subscription runs across all your Claude Code Agents.

With read-only Vault, generate a token using `claude setup-token`, store it in Vault, and connect its `path#key` reference. Disconnect prevents new runs from using a connection; running sessions retain their issued token. Revoke it in Claude to end provider access.

**Codex** requires the initiating user's connected ChatGPT subscription. Connect it under **Model Providers**; an ordinary OpenAI API key does not replace it. Each teammate uses their own connection.

The **Inference API** must match the client in your image. Maintained templates select it for you. Claude Code uses Anthropic Messages. Codex offers the two OpenAI protocols. Other runtimes can use OpenAI Responses, OpenAI Chat Completions, or Anthropic Messages.

### Skills

The Agent's [Skills policy](/docs/platform-agents#skills) applies to every maintained runtime template. Skills use the configured MCP gateway; they need no separate installation in the client. The caller's access and the Agent's environment still apply.

Runtime startup instructions include a compact preview of available skill names and descriptions. The MCP discovery tool also advertises this preview to connected clients. Clients load full instructions and bundled resources on demand. Scripts return as text; binary assets return as base64. Clients can save these files and run them using their own tools. The image must contain any dependencies the skill requires.

The [Code Sandbox](/docs/platform-code-sandbox) is separate from the Agent Runtime container. Its `/skills` paths are available through sandbox tools, not the runtime's local shell.

## Bring Your Own Image

Use a custom image to add development tools or run your own Agent client. Set its image, command, and arguments on the Agent. Archestra supplies the task, credentials, storage, and live terminal.

Custom clients must connect to the injected MCP gateway and support listing and calling tools. Use `list_skills` and `load_skill` for skill instructions and resources. No additional Archestra SDK is required. Native skill directories and slash commands are client-specific.

Send model requests to the injected LLM proxy, using the supplied virtual key as the provider key. The maintained Claude Code subscription image uses a separate passthrough key and OAuth bearer token, so the proxy can attribute its token usage to the run. See the [image contract](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/runtime-contract.md#runtime-environment) for the request headers.

The [maintained images](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/README.md) provide build examples. The [image contract](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/runtime-contract.md) contains the complete environment and transcript specifications.

### Image Requirements

| Requirement | What To Provide |
| --- | --- |
| Shell and terminal | `/bin/sh` and `tmux` on `PATH`. |
| Command | Your client executable, or `archestra-runtime-agent` when Command is blank. |
| Initialization | Optional `archestra-agent-init` for setup before the client starts. |
| Output | Progress and results on stdout or stderr. Never print credentials. |
| Completion | Exit `0` after successful work; use a non-zero exit for failure. |
| Storage | Keep working files and saved client sessions under `/home/node`. Other container paths may be ephemeral. |

Read `ARCHESTRA_AGENT_RUNTIME_MODE` to support interactive and unattended work. Interactive clients remain available for follow-ups; unattended clients finish the task and exit.

### Reporting Failures

Your image can supply an actionable error message before exiting non-zero. Runtime carries that message into task results, notifications, and run details.

Publish a JSON envelope containing `version`, `code`, and `message` to `${ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX}.failure`. Your image defines the code and wording; no platform registration is required. Remove credentials and private details before publishing. Without a valid envelope, Runtime reports the exit status.

See the [failure contract](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/runtime-contract.md#failure-reasons) for the format, limits, and a shell example.

### SDK Integration

You can package an SDK-based Agent loop in a custom image. Configure its model client with the injected proxy URL, protocol, virtual key, and model. Connect its MCP client to the injected gateway URL and token.

Read the task from `ARCHESTRA_AGENT_RUNTIME_TASK` and instructions from `ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT`. Your loop handles model turns and tool execution. Archestra handles runtime lifecycle and access to platform services.

The built-in [Archestra Agent](https://github.com/archestra-ai/archestra/tree/main/platform/runtime-agent) uses AI SDK and the MCP SDK. Use its source as an example for configuration, local tools, and follow-up handling. For clients outside the runtime, see [External Agent Clients](#external-agent-clients).

### Continuing Work

These lifecycle rules apply to maintained and custom images.

Follow-ups reuse the files and saved conversation from the original run. If the original interactive process is still alive, you can reattach to it. After suspension, the client restores its saved state in a new process.

Idle containers pause to release compute. Suspension preserves files, but stops shell processes and development servers. Restart those services when resuming work. The Agent's **Maximum duration** sets how long its container and files are kept. The deployment default applies when unset. Follow-up turns do not extend it. Run history has a separate retention period.

Stopping a run preserves its files and output. Deleting its container and storage permanently removes the files. Saved run history remains available. Finish or cancel active work before deletion. Save final deliverables to a repository or download them before expiry.

Custom clients should restore saved state when `ARCHESTRA_AGENT_RUNTIME_CONTINUE=1` and re-read credentials on each invocation. Keep that state under `/home/node`. Interrupted work is not automatically replayed, because it may already have changed external systems.

### Files

External clients can use `read_workspace_file` and `write_workspace_file` without starting another Agent turn. Each accepts a run ID and a path relative to the run’s working directory. File access can wake a paused container, but does not extend its retention deadline.

Only the original run owner can access these files. See the [MCP tool reference](/docs/platform-archestra-mcp-server) for request schemas and overwrite behavior.

### Readable Transcript

Maintained images export messages and tool activity alongside terminal recordings. Custom clients can provide the same history by writing `readable-transcript.json` in `ARCHESTRA_AGENT_RUNTIME_DIR` before exiting.

Use the versioned [transcript format](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/runtime-contract.md#readable-transcript). Include user-visible messages and tool results; exclude credentials and private reasoning. Terminal recordings remain available when an image does not export this format.

### Input Files

Files attached to a task are available before the client starts. The task includes their absolute paths. `ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_MANIFEST` points to their names, paths, media types, and sizes.

Each turn has its own input directory. Earlier attachments remain available for follow-up work. Clients read these files using their normal file or shell tools.

### Runtime Environment

Archestra injects runtime configuration automatically. The main integration points are:

| Variables | Purpose |
| --- | --- |
| `ARCHESTRA_AGENT_RUNTIME_TASK`, `ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT` | Task and Agent instructions. |
| `ARCHESTRA_AGENT_RUNTIME_MODEL` | Selected model. |
| `ARCHESTRA_AGENT_RUNTIME_DIR` | Runtime configuration and transcript directory. |
| `ARCHESTRA_LLM_PROXY_URL`, `ARCHESTRA_LLM_PROXY_PROTOCOL`, `ARCHESTRA_VIRTUAL_KEY` | Model connection and runtime authentication. |
| `ARCHESTRA_MCP_GATEWAY_URL`, `ARCHESTRA_MCP_GATEWAY_TOKEN` | Assigned tools and user-scoped access. |
| `ARCHESTRA_AGENT_RUNTIME_STEER_FIFO` | Follow-up instructions for turn-boundary steering. |

Custom images should use the proxy and gateway to retain platform controls. Send the run ID in `X-Archestra-Run-Id` and `X-Archestra-Session-Id` request headers. The [full reference](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/runtime-contract.md#runtime-environment) covers native client aliases and continuation variables.

### Configuration And Secrets

Use environment variables for ordinary configuration and **Secret** for sensitive values. Reusable connections supply credentials to multiple Agents. One-off secrets belong to one Agent.

Administrators manage shared connections; users connect their own personal accounts. See [Credentials](/docs/platform-credentials) for supported scopes and Vault setup.

#### Transfer A Credential From A Connected Client

A client that already holds a credential — a CLI token the local session was using — can hand it to an Agent during a handoff instead of switching to Settings. The Agent must allow client-supplied credential values; the setting is off until an administrator turns it on.

The value is stored personally for the caller. It applies to every run that person starts on the Agent and to nobody else's runs. A key already declared at organization scope is refused rather than widened.

Two limits are worth stating to anyone who uses this. The value passes through the calling model's context and that client's transcript, and some clients display tool arguments when asking for approval; Archestra redacts it from the tool-call log, not from anything before it. A credential that should never enter a model's context belongs in Settings. The value also reaches the workspace on the Agent's next turn — a run already in progress keeps the environment it started with.

### Run Controls

| Control | Behavior |
| --- | --- |
| Steering | **Turn boundary** queues instructions between model turns. **Terminal input** sends them to an interactive CLI. |
| Idle timeout | Stops the run after its task finishes and no follow-up arrives within the timeout. |
| Maximum duration | Sets a hard time limit, including during active work. |
| Metered LLM budget (USD) | Blocks further metered proxy calls when the run's budget is exhausted. Subscription usage does not count toward this budget. |
| CPU and memory | Override deployment defaults when the workload needs different sizing. |

## Logs And Observability

The run's terminal output shows command progress and results. LLM Proxy Logs show model requests, usage, and cost. MCP Gateway Logs show tool calls and outcomes. Run IDs link these records to the task.

Proxy and gateway requests also participate in existing tracing and metrics. Claude subscription inference appears in proxy logs with token usage; its MCP calls appear in gateway logs.

## Delegate Work

Give a coordinator Agent access to a specialist under **Tools, Skills & Knowledge → Subagents**. When the specialist has a dedicated runtime, delegation starts a durable task there. The coordinator can continue answering other messages while work runs.

Assign `start_run` when the coordinator should choose a target by Agent ID. Gateways that can start runs also expose their status, steering, and cancellation controls.

### External Agent Clients

A local coding client or another system can connect through the MCP Gateway and use:

1. `list_agents` to discover an accessible Agent.
2. `start_run` to start work.
3. `get_run` or `list_runs` to read progress and results.
4. `steer_run` or `cancel_run` to intervene.

Steering completed work starts another turn using the saved files and conversation. A2A clients can continue with the same `contextId`. See [A2A and SDKs](/docs/platform-agent-triggers-webhook-a2a#sdks) for direct integrations.

### Client Handoff

The built-in **Agent Runtime Handoff** skill guides work between connected clients and the runtime. Install shared skills from [Connect](/docs/platform-connection). The workflow supports repository work and documents in desktop clients.

Send the current goal, decisions, remaining work, and required files when handing off. Input files arrive before the first turn starts. Local file paths alone do not transfer their contents.

Keep the returned session link when switching clients. The connected client can read the original request to recover the task context. Follow-ups reach the same files and saved conversation, including while work is running. An unavailable session reports an error instead of silently starting a new session.

For repository work, include the exact base commit and any local changes. Request a return patch relative to the handed-off working tree so it does not repeat existing local edits. Review it against your current working tree before applying it. For documents, retrieve the finished file from the run.

You can hand off unfinished repository work before closing your laptop. Check that the files will be kept until your planned return. The repository workflow saves a local handoff note outside tracked source files. A fresh conversation can use it to recover the task and session link.

Ask your client to “bring it back and continue here” to resume locally. It retrieves changes, checks for conflicts, and runs the relevant checks. Stop remote editing before continuing locally. After expiry, run history remains available, but files do not.

### Messaging Channels

Assign a foreground coordinator to the channel and give it access to runtime specialists. Its instructions determine when to delegate. Users can name a specialist without knowing Agent IDs or tool syntax.

Delegated work returns its result to the originating thread when finished. Ordinary requests stay with the coordinator.

### Email

Email sent to an Agent with a dedicated runtime starts a task there. When replies are enabled, its result returns in the original email thread.

Private mode can use the verified sender's personal credentials. Internal and Public modes use shared credentials. See [Incoming Email](/docs/platform-agent-triggers-email) for access and provider setup.

## Work With Runs In Chat

Select a runtime Agent in Chat and send a task to open its live terminal. Attach files before starting so the Agent can read them in its container. Startup progress and failures appear alongside the run.

You can leave the page while work continues. Reopen it from the sidebar to see current output or retained history. Runs indicate when input is needed or progress has stalled. Send follow-up instructions to continue the work.

## Organize Runs In Projects

Start a run from a Project to keep it alongside related chats and files. Existing runs can move through **Change project** without stopping their work.

Project access determines which members can review others' runs. Only the person who started a run can control its terminal. See [Projects](/docs/platform-projects) for access rules.

## Share A Run

Share a run with your organization, teams, or individual users. Recipients can review its details and live or retained output. Sharing grants read-only access; terminal control stays with the person who started the run.

Only the run owner can view or change its sharing recipients. Agent readers can see run history, initiators, and sharing scopes without access to recipient names.

## View Runs From An Agent

The Agent's **Runs** tab opens live terminals and completed recordings. Reattach while the client remains alive, or resume its saved conversation after suspension. Detaching leaves the run active.

Run ownership follows the user who started it, not the Agent creator. Sharing grants read-only output access, never an interactive terminal. Agent administrators can read output even without an explicit share. Project access also permits reading runs when paired with permission to read all project sessions.

Recordings preserve earlier terminal output, including screens replaced by redraws. Run history remains available after the container and files are removed and follows the configured retention period. See [Deployment](/docs/platform-deployment#agent-runtime) for retention and transcript limits.

## Monitor Runtime Health

Agent Runtime exports startup timing, lifecycle counters, and per-agent health metrics. Monitor queued work, stale heartbeats, authentication waits, and undelivered completion replies. See [Agent Runtime Observability](/docs/platform-observability#agent-runtime-health) for metrics and alerting guidance.

## Example Architecture

A coordinator Agent answers questions in a messaging channel. It delegates coding tasks to a specialist with repository access and a dedicated runtime. Only the specialist needs Agent Runtime.

### Use Case: Fix A Bug And Prepare A Pull Request

Connect repository credentials through [Credentials](/docs/platform-credentials). Ask the coding Agent to fix a bug, run tests, and prepare a pull request. Review its terminal output, then send follow-up instructions if tests reveal another issue. Share the run with a teammate for review. The same specialist can receive tasks from Chat, a channel coordinator, or an external client.
