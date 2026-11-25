---
title: Agents
description: Build agents with instructions, tools, skills, subagents, and triggers
order: 2
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->
<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

Archestra can run agents itself, and it can give tools to [agents that run somewhere else](/docs/get-started/connect). An agent in Archestra is a system prompt, a [model](/docs/llm-proxy/providers), and the [tools](/docs/mcp) connected to it. You can switch its [runtime](/docs/agents/runtime) too: from Archestra's native runtime to Claude Code, Codex, and others.

For example, you can build a Project Manager agent by connecting it to Slack and Jira through [MCP](/docs/mcp/servers). Or build a Feature Factory agent with [Claude Code as its runtime](/docs/agents/runtime).

![The Agents catalog](/docs/automated_screenshots/agents_catalog.webp)

<span id="creating-and-editing-an-agent"></span>
<span id="invocation-paths"></span>
<span id="messaging-channel-assignment"></span>

## Handover from Local Agents to Archestra Agents

![A coding agent hands its session over from a laptop to Archestra](/docs/agents-handoff.svg)

Once we let Codex, Claude Code, OpenCode, and other coding agents [run in the cloud](/docs/agents/runtime), we noticed how handy it is to [hand a long task](/docs/agents/runtime/handoff) from the local agent on your laptop to an agent in Archestra. It's similar to [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) from Anthropic or [Codex cloud](https://developers.openai.com/codex/cloud) from OpenAI, with one difference: these agents don't run "somewhere in the cloud", they run in [your infrastructure](/docs/admin/deployment), under your full control. You can also hand over across platforms, for example from a local [Pi](https://github.com/badlogic/pi-mono) to a remote Claude Code.

## Agents in Chat and over API, Not Only on the Web

Archestra agents are available in [Slack](/docs/agents/triggers-and-channels/slack), [Microsoft Teams](/docs/agents/triggers-and-channels/ms-teams), [Telegram](/docs/agents/triggers-and-channels/telegram), and [Email](/docs/agents/triggers-and-channels/email). You can also call them through [Agent-to-Agent (A2A) calls or incoming webhooks](/docs/agents/triggers-and-channels/webhook-a2a).

> Fun fact: Archestra the company replaced its project manager with a Slack agent called "Archestra PM". It prioritizes tasks, reviews customer calls, and makes borderline jokes.

<span id="default-agents"></span>
<span id="organizing-agents"></span>
<span id="system-prompt-templating"></span>

<span id="prompt-templates"></span>

## Prompt Templates for Archestra Agent Runtime

Archestra's native agent runtime supports [Handlebars](https://handlebarsjs.com/) expressions in the **Instructions** field, so the agent can behave differently for each person. For example:

<!-- prettier-ignore -->
```handlebars
You help {{user.name}}. Today is {{currentDate}}.
{{#includes user.teams "Engineering"}}You can use the engineering tools.{{/includes}}
```

| Expression                           | Gives                                                             |
| ------------------------------------ | ----------------------------------------------------------------- |
| `{{user.name}}`, `{{user.email}}`    | The person's name and email                                       |
| `{{user.role}}`                      | Their organization role                                           |
| `{{user.teams}}`                     | Their team names, as a list                                       |
| `{{currentDate}}`, `{{currentTime}}` | The date and time in UTC, such as `2026-03-12` and `14:30:00 UTC` |
| `{{archestraVersion}}`               | The version of the running platform, such as `1.4.0`              |

<span id="code-sandbox"></span>

## Code Sandbox in Archestra Agent Runtime

Archestra's native runtime can run shell commands and Python with [`run_command`](/docs/reference/archestra-mcp-server#run_command). Under the hood it runs on [Dagger](https://dagger.io), which makes it very fast, but it can make deploying the platform harder, because it needs [privileged pods](/docs/admin/deployment/networking#code-sandbox-requirements).
