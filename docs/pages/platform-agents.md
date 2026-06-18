---
title: Overview
category: Agents
order: 1
description: Agent overview, invocation paths, knowledge sources, and prompt templating
lastUpdated: 2026-06-18
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Agents are reusable AI workers with instructions, tool access, and optional knowledge retrieval. You can invoke the same agent from chat, external integrations, or automation without rebuilding the workflow each time.

An agent can include:

- a system prompt that defines behavior
- suggested prompts for common tasks in chat
- one or more assigned tools
- optional **Load tools when needed** mode for keeping MCP `tools/list` small
- optional delegation targets to other agents
- one or more assigned knowledge sources

## Load Tools When Needed

By default, an agent exposes every assigned tool through MCP `tools/list`.

For larger toolsets, enable **Load tools when needed**. This keeps the initial tool list small. MCP clients see the built-in [`search_tools`](/docs/platform-archestra-mcp-server#search_tools) and [`run_tool`](/docs/platform-archestra-mcp-server#run_tool) tools first. Those two tools are enabled implicitly and do not need normal tool assignment.

- `search_tools` can still discover them
- `run_tool` can still execute them

Use this when the full tool menu is too large to send to the model on every turn, but you still want the agent to keep access to the same assigned toolset.

With the per-agent **Access all tools** setting on, discovery is not limited to assigned tools. For a signed-in user, `search_tools` also returns third-party tools from MCP catalogs the user can access, plus `query_knowledge_sources` when the user can access at least one knowledge connector. `run_tool` executes such a tool directly with credentials resolved at call time, following the MCP server's **Agent connections** setting: on behalf of the user by default (each person's own connection), or one shared account when the server is configured that way. A caller without a connection gets an actionable prompt to connect — nothing is borrowed from team or organization credentials. Nothing is assigned to the agent, so no permission to modify the agent is involved. This lets [Agent Skills](/docs/platform-agent-skills-sharing) reference tools without pre-assigning every tool to every agent. Admins can turn the behavior off org-wide with the **Dynamic Tool Access** security setting on the agent settings page, restricting discovery and dispatch to assigned tools only regardless of the per-agent setting.

Tool call policies still apply to the target tool. If the model calls `run_tool` to execute `send_email`, Archestra evaluates policies for `send_email` with the same arguments and context it would use for a direct tool call. See [AI Tool Guardrails - Load Tools When Needed](/docs/platform-ai-tool-guardrails#load-tools-when-needed).

See [MCP Gateway - Load Tools When Needed](/docs/platform-mcp-gateway#load-tools-when-needed) for the MCP-client-facing behavior and the same mode on gateways.

## Invocation Paths

Agents can be triggered through:

- Archestra Chat UI
- [Webhook (A2A)](/docs/platform-agent-triggers-webhook-a2a)
- [Scheduled Tasks](/docs/platform-agent-triggers-schedule)
- [Incoming Email](/docs/platform-agent-triggers-email)
- [Slack](/docs/platform-slack)
- [MS Teams](/docs/platform-ms-teams)

Trigger setup is managed from **Agent Triggers**. Slack, MS Teams, and Incoming Email each have their own setup flow, and Incoming Email also owns the per-agent email invocation settings.

## Knowledge Sources

Agents can be assigned one or more Knowledge Bases or knowledge connectors. This gives the agent retrieval access to your internal docs and connected systems without hardcoding those sources into the prompt.

When at least one knowledge source is assigned, Archestra automatically adds the built-in [`query_knowledge_sources`](/docs/platform-archestra-mcp-server#query_knowledge_sources) tool to that agent. The model can call it during a run to search across the assigned sources and pull relevant context into its answer.

See [Knowledge Bases](/docs/platform-knowledge-bases) for how retrieval works and how sources are assigned. See [Archestra MCP Server](/docs/platform-archestra-mcp-server) for the built-in tool behavior and RBAC requirements.

## Environments

An agent can be assigned to an [environment](/docs/platform-private-registry#environments). The agent's code sandbox then runs under that environment's egress network policy — the same machinery that governs self-hosted MCP server pods — so its outbound network access is restricted to what the policy allows. With no environment assigned, the agent uses the default runtime.

See [Network Egress Policies](/docs/platform-private-registry#network-egress-policies) for how policies are configured and which destinations are reachable.

## Delegation

When an agent delegates work to another agent, Archestra tracks the full call chain for observability. Delegated agents also inherit the current [tool guardrails](/docs/platform-ai-tool-guardrails) trust state, so downstream tool policy enforcement does not reset mid-run.

## Convert to Skill

An agent can be converted into an [Agent Skill](/docs/platform-agent-skills-sharing) — a reusable `SKILL.md` instruction set that any agent can activate from chat. Use this when the agent's value is mostly in its instructions and you want them available as a `/slash-command` rather than as a separate agent to switch to.

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
