---
title: Agents
description: Build agents with instructions, tools, skills, subagents, and triggers
order: 2
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

An agent is a reusable assistant: instructions, a model, and the tools, knowledge, skills, and subagents it can use. You build it once and use it everywhere: in Chat, from your coding agent, in messaging channels, and from other systems.

![The Agents catalog](/docs/automated_screenshots/agents_catalog.webp)

<span id="creating-and-editing-an-agent"></span>

## Create an Agent

1. Go to **Agents** and click **Add Agent**.
2. Start from scratch, or pick a template under **Popular agents**.
3. On **Configuration**, enter a name and instructions, and choose the model.
4. Click **Continue setup** to choose tools, knowledge, skills, subagents, and messaging channels.
5. Click **Create**, then **Chat** to send your first task.

What to know:

- Instructions can use your details, such as your name, teams, and today's date. See [Prompt Templates](#prompt-templates).
- To run the agent in its own container, with a live terminal, give it a [dedicated runtime](/docs/agents/runtime).

<span id="tool-access-modes"></span>
<span id="custom-mode"></span>
<span id="auto-mode"></span>
<span id="knowledge-sources"></span>
<span id="skills"></span>
<span id="delegation"></span>

## Choose What the Agent Can Use

On the **Tools, Skills & Knowledge** tab, each kind of resource has two modes:

- **All:** the agent can use everything the person using it can access, in the agent's [environment](/docs/admin/environments). You can exclude items under **All … except**.
- **Manual:** the agent uses only what you assign.

This works the same for tools, knowledge sources, [skills](/docs/agents/skills), and [subagents](/docs/agents/subagents).

What to know:

- Each person uses their own access. In **All** mode, two people can get different tools from one agent. In both modes, a tool that needs an account uses the person's own connection, unless you pin one.
- Built-in platform tools are excluded by default in All mode. Review the exclusions before you give an agent tools that change Archestra itself.
- The agent loads tools as it needs them. It starts with [`search_tools`](/docs/reference/archestra-mcp-server#search_tools) and [`run_tool`](/docs/reference/archestra-mcp-server#run_tool), not the full list. In **Manual** mode, you can turn off **Progressive tool loading** to send every assigned tool.
- <span id="missing-connections"></span>**Missing connections:** in **Manual** mode, choose when the agent prompts users to connect missing tool accounts (on call, on chat open, or required before chat). To use one account for everyone, pin a connection or [resolve credentials at call time](/docs/mcp/authentication/servers#resolve-at-call-time).

<span id="invocation-paths"></span>
<span id="messaging-channel-assignment"></span>

## Use an Agent

Run an agent interactively, delegate work to it from your coding client, or trigger it from team channels and APIs:

- **Chat and Projects:** select the agent from the picker in [Chat](/docs/chat) or scope it to a [Project](/docs/chat/projects).
- **Coding agents:** once [connected](/docs/get-started/connect), hand off background tasks from your editor or CLI with [`start_run`](/docs/reference/archestra-mcp-server#start_run) and monitor their progress. See [Hand Off Work](/docs/agents/runtime/handoff).
- **Messaging channels:** connect [Slack](/docs/agents/triggers-and-channels/slack), [Microsoft Teams](/docs/agents/triggers-and-channels/ms-teams), [Telegram](/docs/agents/triggers-and-channels/telegram), or [Email](/docs/agents/triggers-and-channels/email) on the agent's **Messaging Channels** tab. See [Triggers & Channels](/docs/agents/triggers-and-channels).
- **Automations and APIs:** invoke the agent programmatically via [Agent-to-Agent (A2A) calls or incoming webhooks](/docs/agents/triggers-and-channels/webhook-a2a).

<span id="default-agents"></span>
<span id="organizing-agents"></span>

What to know:

- **Default agent:** new chats automatically use your default agent. To change it, click **Set as default** on any agent card under **Agents**.
- **Sidebar pinning:** click **Pin** on an agent to keep it in the left navigation sidebar for quick access.

<span id="system-prompt-templating"></span>

## Prompt Templates

Tailor an agent's instructions to the person using it. Write [Handlebars](https://handlebarsjs.com/) expressions in the **Instructions** field, on the agent's **General** tab. Archestra fills them in on each run:

```handlebars
You help {{user.name}}. Today is {{currentDate}}.
{{#includes user.teams "Engineering"}}You can use the engineering tools.{{/includes}}
```

| Expression | Gives |
| --- | --- |
| `{{user.name}}`, `{{user.email}}` | The person's name and email |
| `{{user.role}}` | Their organization role |
| `{{user.teams}}` | Their team names, as a list |
| `{{currentDate}}`, `{{currentTime}}` | The date and time in UTC, such as `2026-03-12` and `14:30:00 UTC` |

What to know:

- **Helpers:** Handlebars [blocks](https://handlebarsjs.com/guide/builtin-helpers.html) such as `#if` and `#each` work, and so do `includes`, `equals`, `contains`, and `json`.
- [Skills](/docs/agents/skills) can use templates too. Add `templated: true` to the skill's frontmatter. See [Writing Skills](/docs/agents/skills/writing).
- To keep an expression as text, add a backslash: `\{{user.name}}`. An expression Handlebars cannot read stays as written.

## Code Sandbox

Each conversation gets a private Linux container, so the agent can run shell commands and Python with [`run_command`](/docs/reference/archestra-mcp-server#run_command).

- **Files you attach** appear under `/home/sandbox/attachments/`.
- **Large tool results** go to `/home/sandbox/tool-results/`. When a tool returns more than 100,000 characters, the agent sees only the beginning, plus the file's path to grep the rest.
- **Files the agent saves** appear in the conversation's **Files** panel.
- **Network access** follows the [egress policy](/docs/admin/environments#network-egress-policies) of the agent's environment.

What to know:

- Files stay between commands. Running processes do not.
- Without the sandbox, or in an encrypted chat, a large tool result is cut to its first 100,000 characters.
- The sandbox is on by default. To turn it off, set [`ARCHESTRA_CODE_RUNTIME_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_ENABLED). For setup, see [Code Sandbox deployment](/docs/admin/deployment#code-sandbox).
