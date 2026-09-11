---
title: Agent Runtime (Beta)
category: Agents
order: 7
description: Run coding agents, follow their progress, and continue their work
lastUpdated: "2026-09-11"
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Agent Runtime runs tasks in a workspace with a live terminal. Use it for coding, running commands, and work that needs follow-up instructions.

![Available Agent Runtime templates](/docs/automated_screenshots/platform-agent-runtime_catalog.webp)

## Getting Started

Your administrator must [enable Agent Runtime](/docs/platform-deployment#agent-runtime) before you can use it.

Choose a template from **Create Agent**, such as Claude Code, Codex, or Archestra Agent. Configure its instructions and tools, then connect any required accounts. Existing Agents can enable **Dedicated runtime** under **Advanced**.

Start work from Chat or a [Project](/docs/platform-projects). Attach files for the agent to read in its workspace, then describe the task. You can leave the page while the run continues.

## Model Inference And MCP Tools

The Agent's assigned tools remain available during runs. [Runtime Credentials](/docs/platform-runtime-credentials) supply access to repositories and other services.

### Claude Code

Use your own Claude Pro or Max subscription, or a configured [Anthropic, Bedrock, or Vertex AI connection](/docs/platform-supported-llm-providers). Each person connects their own subscription account.

Subscription runs connect directly to Anthropic. Archestra's inference logs, cost limits, and inference guardrails do not apply. Tool policies still apply. Provider connections route through Archestra, so inference logs, limits, and guardrails apply. Your Claude subscription connection works only in the Claude Code runtime.

Reconnect when your subscription connection expires. Disconnect prevents new runs from using it; running sessions keep their access. Revoke the token in Claude to end provider access.

### Codex

Codex requires your connected ChatGPT subscription. Connect it under **Model Providers**. An OpenAI API key does not replace this connection.

## Follow And Continue Work

Open a run from Chat, its Project, or the Agent's **Runs** tab. Follow its terminal output and respond when the agent needs input. Finished runs retain their output for review.

Send follow-up instructions to continue in the same workspace. Stopping a run keeps its files and output. Idle workspaces pause; a follow-up resumes them. Development servers may need restarting after resumption.

Workspaces have a retention deadline. Save final work to a repository or download it before expiry. Stop active work before deleting a workspace. Deletion permanently removes its files; saved run history remains available.

## Run Limits

Agents can set a maximum duration, idle timeout, and metered LLM budget. A duration limit can stop active work. The metered budget applies to calls through Archestra's proxy.

## Environments And Network Egress

Runs follow the Agent's [Environment network policy](/docs/platform-environments#network-egress-policies). Ask your administrator to allow any services your task needs.

## Sharing

Share runs with people or teams for read-only review. Only the person who started a run can control its terminal. [Projects](/docs/platform-projects) keep related runs, chats, and files together.

## Delegated Work

Other Agents can delegate tasks to an Agent with a dedicated runtime. Messaging-channel coordinators return the result to the originating thread. [Email](/docs/platform-agent-triggers-email) and [external clients](/docs/platform-archestra-mcp-server) can also start work.

## Use Case: Fix A Bug And Prepare A Pull Request

Ask a coding Agent to fix a bug, run tests, and prepare a pull request. Review its progress in the terminal. If the tests reveal another issue, send a follow-up instruction in the same workspace. Share the run so a teammate can review the result.

## Custom Images

Administrators can provide images with extra tools or a different coding client. Image authors can use the [runtime image reference](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/README.md).
