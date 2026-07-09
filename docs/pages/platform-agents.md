---
title: Overview
category: Agents
order: 1
description: Agent overview, invocation paths, knowledge sources, and prompt templating
lastUpdated: 2026-07-09
---

Agents are reusable AI workers with instructions, tool access, and optional knowledge retrieval. You can invoke the same agent from chat, external integrations, or automation without rebuilding the workflow each time.

An agent can include:

- a system prompt that defines behavior
- suggested prompts for common tasks in chat
- a **Tools & Knowledge Sources** setting: **Auto** (every tool and knowledge source the chatting user can access, minus an exclusion list) or **Custom** (only assigned tools and sources)
- optional **Load tools when needed** mode for keeping MCP `tools/list` small
- optional delegation targets to other agents
- one or more assigned knowledge sources

## Load Tools When Needed

By default, an agent exposes every assigned tool through MCP `tools/list`.

For larger toolsets, enable **Load tools when needed**. This keeps the initial tool list small. MCP clients see the built-in [`search_tools`](/docs/platform-archestra-mcp-server#search_tools) and [`run_tool`](/docs/platform-archestra-mcp-server#run_tool) tools first. Those two tools are enabled implicitly and do not need normal tool assignment.

- `search_tools` can still discover them
- `run_tool` can still execute them

Use this when the full tool menu is too large to send to the model on every turn, but you still want the agent to keep access to the same assigned toolset.

An agent's **Tools & Knowledge Sources** setting is **Auto** or **Custom** — tabs in the agent dialog. The tabs govern both tools and [knowledge sources](#knowledge-sources); this section covers the tools half. In **Custom** mode the agent uses only its explicitly assigned tools; new agents get a default set assigned by the backend, and the create form pre-selects that same set. Custom assignments resolve credentials at call time by default; you can pin a specific connection per server instead. In **Auto** mode, discovery is not limited to assigned tools: `search_tools` can find and `run_tool` can run every tool the signed-in user can access — Archestra built-in tools and tools from MCP servers — except tools on the agent's [exclusion list](#excluding-servers-and-tools). User permissions still apply. `run_tool` executes such a tool directly with credentials resolved at call time, following the MCP server's **Default credential** setting: on behalf of the user by default (each person's own connection), or one shared account when the server is configured that way. A caller without a connection gets an actionable prompt to connect — nothing is borrowed from team or organization credentials. Nothing is assigned to the agent, so no permission to modify the agent is involved. This lets [Agent Skills](/docs/platform-agent-skills) reference tools without pre-assigning every tool to every agent.

Tool call policies still apply to the target tool. If the model calls `run_tool` to execute `send_email`, Archestra evaluates policies for `send_email` with the same arguments and context it would use for a direct tool call. See [AI Tool Guardrails - Load Tools When Needed](/docs/platform-ai-tool-guardrails#load-tools-when-needed).

See [MCP Gateway - Load Tools When Needed](/docs/platform-mcp-gateway#load-tools-when-needed) for the MCP-client-facing behavior and the same mode on gateways.

### Excluding Servers and Tools

**Auto** can be too broad: it gives the agent everything the calling user can reach. To carve out exceptions, each agent has an exclusion list — edit it under **Disabled tools** on the **Auto** tab of the agent dialog (or via `GET`/`PUT /api/agents/:id/tool-exclusions`), excluding whole MCP servers or individual tools. Use this for an agent that should see everything except, say, a payments server or a single destructive tool.

While the tools setting is **Auto**, exclusions cover the agent's entire surface:

- excluded tools do not appear in `search_tools` results and cannot be executed by `run_tool` or called directly by an MCP client
- the agent's MCP resources and prompts from an excluded server are also unreachable
- tools explicitly assigned to the agent are excluded too — the assignments stay in place and take effect again in **Custom** mode

Built-in tools are excluded by default. When an agent is created in **Auto** mode or switched to it, the exclusion list is pre-filled with every built-in tool that is not assigned to the agent — except a small set that always stays available: `search_tools`, `run_tool`, the sandbox and file tools (`run_command`, `upload_file`, `download_file`, `search_files`, `read_file`, `save_file`, `edit_file`, `delete_file`), and `query_knowledge_sources`. So by default an **Auto**-mode agent cannot use the built-ins that manage the platform itself (creating agents, managing teams, policies, and so on) until an admin removes them from the list. The pre-fill runs on every switch to **Auto** — to keep a built-in usable across switches, assign it to the agent. When a platform update ships a new built-in tool, agents already in **Auto** mode get it excluded by default; admins opt in by un-excluding it. Agents that were in **Auto** mode before exclusions existed keep exactly their capabilities: the unassigned built-ins they could not use are now on their exclusion list, visible and editable.

Only `search_tools` and `run_tool` can never be excluded; everything else can. Agent delegation tools sit outside the exclusion list — manage them through delegation itself — and the built-in server cannot be excluded as a whole, only tool by tool.

Exclusions are stored per agent and have no effect in **Custom** mode. Cloning an agent copies them. Agent export does not carry them — server and tool IDs are not portable across organizations — so an imported agent starts with no exclusions and they must be re-created. Exclusions track the specific tool record: if an MCP server renames a tool, the renamed tool counts as new and is no longer excluded.

## Invocation Paths

Agents can be triggered through:

- Archestra Chat UI
- [Webhook (A2A)](/docs/platform-agent-triggers-webhook-a2a)
- [Incoming Email](/docs/platform-agent-triggers-email)
- [Slack](/docs/platform-slack)
- [MS Teams](/docs/platform-ms-teams)

Trigger setup is managed from **Agent Triggers**. Slack, MS Teams, and Incoming Email each have their own setup flow, and Incoming Email also owns the per-agent email invocation settings.

## Knowledge Sources

Knowledge follows the same **Auto** / **Custom** setting as tools (**Tools & Knowledge Sources** in the agent dialog). In **Auto** mode the agent can search every Knowledge Base and connector the chatting user can access, in its environment. In **Custom** mode it searches only the sources you assign to it. Either mode is still filtered by each user's own visibility.

Whenever an agent has at least one reachable knowledge source, Archestra adds the built-in [`query_knowledge_sources`](/docs/platform-archestra-mcp-server#query_knowledge_sources) tool so the model can search across them during a run.

The output of `query_knowledge_sources` is treated as sensitive by default, which can impact the ability to use subsequent tools. See [Archestra MCP Server](/docs/platform-archestra-mcp-server#auth), and [AI Tool Guardrails](/docs/platform-ai-tool-guardrails), for more details.

See [Knowledge Bases](/docs/platform-knowledge) for how retrieval works and how sources are assigned. See [Archestra MCP Server](/docs/platform-archestra-mcp-server) for the built-in tool behavior and RBAC requirements.

## Environments

An agent can be assigned to an [environment](/docs/platform-environments). This does two things: its [code sandbox](/docs/platform-code-sandbox) runs under that environment's egress network policy (the same machinery that governs self-hosted MCP server pods), and the tools and knowledge it can use are scoped to that environment — the agent only sees tools and knowledge connectors in the same environment (built-in servers excepted). With no environment assigned, the agent uses the Default environment.

See [Environments](/docs/platform-environments) for the isolation model and [network egress policies](/docs/platform-environments#network-egress-policies) for how policies are configured.

## Delegation

When an agent delegates work to another agent, Archestra tracks the full call chain for observability. Delegated agents also inherit the current [tool guardrails](/docs/platform-ai-tool-guardrails) trust state, so downstream tool policy enforcement does not reset mid-run.

## Convert to Skill

An agent can be converted into an [Agent Skill](/docs/platform-agent-skills) — a reusable `SKILL.md` instruction set that any agent can activate from chat. Use this when the agent's value is mostly in its instructions and you want them available as a `/slash-command` rather than as a separate agent to switch to.

The **Convert to skill** action on the agents page opens a confirmation dialog where you set the skill's description and choose whether to remove the source agent once the skill is created. The skill inherits the agent's scope. Conversion is lossy by nature: a skill carries instructions only, with no tools, model, or knowledge of its own. Each field is either carried over or annotated:

- the system prompt becomes the skill body, and the scope carries over directly; the name is normalized into a slug (for example `Support Helper` → `support-helper`) so it works as a `/slash-command`
- the description is required — the agent's own is prefilled, and you must supply one when the agent has none (an activating agent uses it to decide when to run the skill); **Generate** drafts one from the agent's prompt, tools, and example prompts via a single LLM call when you need a starting point
- if the system prompt uses [Handlebars templating](#system-prompt-templating), the skill is flagged `templated` so its body is re-rendered with the activating user's context at runtime — otherwise the slug would bake one author's `{{user.name}}` into instructions every agent shares
- assigned tools are carried into the skill's [`allowed-tools`](https://agentskills.io/specification#allowed-tools-field) frontmatter (the skill-runtime tools are dropped as noise), so the activating agent knows which tools to enable; the default model and knowledge sources have no skill equivalent and are reported as not carried, without cluttering the skill body
- suggested prompts, icon, and labels are folded into the body or metadata, and the origin agent is recorded in metadata so the skill stays linked back to it
- removing the source agent is optional and off by default; it is a soft delete, so the agent can be restored later from the deleted-agents filter

## System Prompt Templating

Agent system prompts support [Handlebars](https://handlebarsjs.com/) templating. Templates are rendered at runtime before the prompt is sent to the LLM, with the current user's context injected as variables. Agent Skills can opt into the same rendering with a `templated: true` frontmatter field (set automatically when converting a templated agent); their `SKILL.md` body is then rendered with the same variables and helpers each time the skill is loaded.

### Variables

| Variable         | Type     | Description                          |
| ---------------- | -------- | ------------------------------------ |
| `{{user.name}}`  | string   | Name of the user invoking the agent  |
| `{{user.email}}` | string   | Email of the user invoking the agent |
| `{{user.teams}}` | string[] | Team names the user belongs to       |

### Helpers

| Helper            | Output       | Description                      |
| ----------------- | ------------ | -------------------------------- |
| `{{currentDate}}` | `2026-03-12` | Current date in UTC (YYYY-MM-DD) |
| `{{currentTime}}` | `14:30:00 UTC` | Current time in UTC (HH:MM:SS UTC) |

All [built-in Handlebars helpers](https://handlebarsjs.com/guide/builtin-helpers.html) (`#each`, `#if`, `#with`, `#unless`) are also available, along with Archestra helpers like `includes`, `equals`, `contains`, and `json`.

### Example

```handlebars
You are a helpful assistant for
{{user.name}}. Today's date is
{{currentDate}}.

{{#includes user.teams "Engineering"}}
  You have access to engineering-specific tools and documentation.
{{/includes}}

{{#if user.teams}}
  The user belongs to:
  {{#each user.teams}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}.
{{/if}}
```
