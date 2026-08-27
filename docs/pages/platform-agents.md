---
title: Overview
category: Agents
order: 1
description: Agent overview, invocation paths, knowledge sources, and prompt templating
lastUpdated: 2026-08-27
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Agents are reusable AI workers with instructions, tool access, and optional knowledge retrieval. You can invoke the same agent from chat, external integrations, or automation without rebuilding the workflow each time.

An agent can include:

- a system prompt that defines behavior
- suggested prompts for common tasks in chat
- a **Tools & Knowledge Sources** setting: **Auto** (every tool and knowledge source the chatting user can access, minus an exclusion list) or **Custom** (only assigned tools and sources)
- optional **Load tools when needed** mode for keeping MCP `tools/list` small
- a **Tool connections** setting — missing MCP server connections are requested when needed, requested at chat start, or required before use
- a **Subagents** setting: **Auto** (delegate to any agent the chatting user can access, minus a disabled list) or **Custom** (only assigned delegation targets)
- one or more assigned knowledge sources

## Creating and Editing an Agent

**Create Agent** opens a setup wizard with three steps. **Configuration** asks for the name, visibility, instructions, and model. **Tools & Knowledge** picks the tools, knowledge sources, subagents, skills, and hooks. **Advanced** holds labels, security, and the identity provider. Nothing is saved until you press **Create** on the last step — the agent then opens on its page's **Connect** section, which shows how to reach it.

Every agent has its own page. The **Overview** section repeats the wizard's configuration as read-only cards, followed by a **Connect** section with the endpoint, authentication options, primary examples, and secondary channels. **Edit** in the page header reopens the wizard for full settings control. **Save** on any step saves and returns to the agent page; **Save & Continue** saves and moves to the next step.

## Tool Access Modes

An agent's **Tools & Knowledge Sources** setting is **Auto** or **Custom** — tabs on the agent's **Tools & Knowledge** step. The tabs govern both tools and [knowledge sources](#knowledge-sources); this section covers the tools half.

### Custom Mode

In **Custom** mode the agent uses only its explicitly assigned tools. New agents get a default set assigned by the backend, and the **Tools & Knowledge** step pre-selects that same set. Assignments resolve credentials at call time by default; you can pin a specific connection per server instead.

Sharing the agent shares its assigned tools. A teammate with agent access can call an assigned tool even when its MCP server is not shared with them — the server's own team assignment governs the [registry](/docs/platform-private-registry), not tool calls through the agent. [Credential resolution](/docs/mcp-authentication#credential-resolution) decides whose connection serves each call: a pinned connection serves every caller, and resolve-at-call-time looks for a connection the caller can reach.

### Auto Mode

In **Auto** mode, discovery is not limited to assigned tools: `search_tools` can find and `run_tool` can run every tool the signed-in user can access — Archestra built-in tools and tools from MCP servers — except tools on the agent's [exclusion list](#excluding-servers-and-tools). User permissions still apply, so each caller of a shared agent may reach a different toolset. Tools explicitly assigned to the agent stay available to every caller.

`run_tool` executes a discovered tool directly with [credentials resolved at call time](/docs/mcp-authentication#resolve-at-call-time), following the MCP server's **Default credential** setting: on behalf of the user by default, or one shared account when the server is configured that way. A caller with no reachable connection gets an actionable prompt to connect — another person's personal connection is never used.

Nothing is assigned to the agent, so no permission to modify the agent is involved. This lets [Agent Skills](/docs/platform-agent-skills) reference tools without pre-assigning every tool to every agent.

Tool call policies still apply to the target tool. If the model calls `run_tool` to execute `send_email`, Archestra evaluates policies for `send_email` with the same arguments and context it would use for a direct tool call. See [AI Tool Guardrails - Load Tools When Needed](/docs/platform-ai-tool-guardrails#load-tools-when-needed).

### Excluding Servers and Tools

**Auto** can be too broad: it gives the agent everything the calling user can reach. To carve out exceptions, each agent has an exclusion list — edit it under **All tools except** on the **Auto** tab of the agent's **Tools & Knowledge** step (or via `GET`/`PUT /api/agents/:id/tool-exclusions`), excluding whole MCP servers or individual tools. Use this for an agent that should see everything except, say, a payments server or a single destructive tool. [Knowledge sources](#knowledge-sources) have a list of their own.

While the tools setting is **Auto**, exclusions cover the agent's entire surface:

- excluded tools do not appear in `search_tools` results and cannot be executed by `run_tool` or called directly by an MCP client
- the agent's MCP resources and prompts from an excluded server are also unreachable
- tools explicitly assigned to the agent are excluded too — the assignments stay in place and take effect again in **Custom** mode

Built-in tools are excluded by default. When an agent is created in **Auto** mode or switched to it, the exclusion list is pre-filled with every built-in tool that is not assigned to the agent — except a small set that always stays available: `search_tools`, `run_tool`, the sandbox and file tools (`run_command`, `upload_file`, `download_file`, `search_files`, `read_file`, `save_file`, `edit_file`, `delete_file`), and `query_knowledge_sources`. So by default an **Auto**-mode agent cannot use the built-ins that manage the platform itself (creating agents, managing teams, policies, and so on) until an admin removes them from the list. The pre-fill runs on every switch to **Auto** — to keep a built-in usable across switches, assign it to the agent. When a platform update ships a new built-in tool, agents already in **Auto** mode get it excluded by default; admins opt in by un-excluding it. Agents that were in **Auto** mode before exclusions existed keep exactly their capabilities: the unassigned built-ins they could not use are now on their exclusion list, visible and editable.

Only `search_tools` and `run_tool` can never be excluded; everything else can. Agent delegation tools sit outside the exclusion list — manage them through delegation itself — and the built-in server cannot be excluded as a whole, only tool by tool.

Exclusions are stored per agent and have no effect in **Custom** mode. Cloning an agent copies them. Agent export does not carry them — server and tool IDs are not portable across organizations — so an imported agent starts with no exclusions and they must be re-created. Exclusions track the specific tool record: if an MCP server renames a tool, the renamed tool counts as new and is no longer excluded.

## Load Tools When Needed

By default, an agent exposes every assigned tool through MCP `tools/list`.

For larger toolsets, turn on **Progressive tool loading**. This keeps the initial tool list small. MCP clients see the built-in [`search_tools`](/docs/platform-archestra-mcp-server#search_tools) and [`run_tool`](/docs/platform-archestra-mcp-server#run_tool) tools first. Those two tools are enabled implicitly and do not need normal tool assignment.

- `search_tools` can still discover them
- `run_tool` can still execute them

Use this when the full tool menu is too large to send to the model on every turn, but you still want the agent to keep access to the same assigned toolset.

**Auto** mode always loads tools progressively. Discovery only works through `search_tools` and `run_tool`, so the switch shows as on and cannot be turned off there.

See [MCP Gateway - Load Tools When Needed](/docs/platform-mcp-gateway#load-tools-when-needed) for the MCP-client-facing behavior and the same mode on gateways.

## Tool Connections

An agent's tools can come from MCP servers that each person connects with their own account. Share that agent, and someone who has not connected one of those servers finds out only when a tool from it runs.

**Tool connections** sits in **Custom** mode, under Tools & Knowledge Sources. It sets how the agent treats an MCP server the person using it has not connected yet:

- **Requested when needed** — the default. Nothing is shown up front; a connection is requested the moment a tool call needs one.
- **Requested at chat start** — the chat opens by naming the servers not yet connected, with an offer to connect. Tools from those servers wait until then.
- **Required before use** — the agent is marked unavailable in the chat picker, and a run is refused wherever it is triggered from, until every server is connected.

A server counts as connected when the person's own connection covers it, when a team or organization connection does, or when the agent pins one shared account. Servers that need no credentials never count as missing.

The setting does nothing in [**Auto** mode](#auto-mode), where each caller's tools come from what they can already reach.

## Invocation Paths

Agents can be triggered through:

- [Archestra Chat UI](/docs/platform-chat)
- [Webhook (A2A)](/docs/platform-agent-triggers-webhook-a2a)
- [Incoming Email](/docs/platform-agent-triggers-email)
- [Slack](/docs/platform-slack)
- [MS Teams](/docs/platform-ms-teams)
- [Telegram](/docs/platform-telegram)

Trigger setup is managed from **Agent Triggers**. Slack, MS Teams, Telegram, and Incoming Email each have their own setup flow, and Incoming Email also owns the per-agent email invocation settings.

Go to **Settings → Agents → Available messaging channels** to remove any channel your organization does not allow. A channel you remove disappears from the pickers and stops listening — a connected Slack bot stops answering, and email stops reaching agents.

## Knowledge Sources

Knowledge follows the same **Auto** / **Custom** setting as tools (**Tools & Knowledge Sources** on the agent's **Tools & Knowledge** step). In **Auto** mode the agent can search every Knowledge Base and connector the chatting user can access, in its environment. In **Custom** mode it searches only the sources you assign to it. Either mode is still filtered by each user's own visibility.

**Auto** can be too broad here too. Each agent has its own list of disabled knowledge sources — edit it under **All knowledge sources except** on the **Auto** tab of the agent's **Tools & Knowledge** step, or via `GET`/`PUT /api/agents/:id/knowledge-source-exclusions`. A disabled source drops out of every search the agent runs, so you can keep an archived wiki out of its answers without hiding it from anyone else. The list applies only while the setting is **Auto**; **Custom** mode already searches just what you assign.

Whenever an agent has at least one reachable knowledge source, Archestra adds the built-in [`query_knowledge_sources`](/docs/platform-archestra-mcp-server#query_knowledge_sources) tool so the model can search across them during a run. The tool disappears when every source the caller can reach is disabled for that agent.

The output of `query_knowledge_sources` is treated as sensitive by default, which can impact the ability to use subsequent tools. See [Archestra MCP Server](/docs/platform-archestra-mcp-server#auth), and [AI Tool Guardrails](/docs/platform-ai-tool-guardrails), for more details.

See [Knowledge Bases](/docs/platform-knowledge) for how retrieval works and how sources are assigned. See [Archestra MCP Server](/docs/platform-archestra-mcp-server) for the built-in tool behavior and RBAC requirements.

## Environments

An agent can be assigned to an [environment](/docs/platform-environments). This does two things: its [code sandbox](/docs/platform-code-sandbox) runs under that environment's egress network policy (the same machinery that governs self-hosted MCP server pods), and the tools, knowledge, skills, and subagents it can use are scoped to that environment — the agent only sees tools, knowledge connectors, skills, and delegation targets in the same environment (built-in servers and built-in skills excepted). With no environment assigned, the agent uses the Default environment.

See [Environments](/docs/platform-environments) for the isolation model and [network egress policies](/docs/platform-environments#network-egress-policies) for how policies are configured.

## Skills

An agent consumes [Agent Skills](/docs/platform-agent-skills) through two built-in tools: `list_skills` returns the catalog, `load_skill` pulls one skill's instructions into context. Users can also invoke a skill directly with a `/skill-name` slash command in chat. Either way, the agent only sees skills in its [environment](#environments) that the calling user can access.

A skill that names an `agent` in its frontmatter runs in that subagent instead — the agent calls the skill's `skill__<name>` tool and receives the result. See [Running a Skill in a Subagent](/docs/platform-agent-skills#running-a-skill-in-a-subagent).

## Delegation

An agent can delegate work to other agents — its **subagents**. Like **Tools & Knowledge Sources**, delegation has an **Auto** or **Custom** setting, under **Subagents** on the agent's **Tools & Knowledge** step.

In **Custom** mode the agent delegates only to the subagents you assign. In **Auto** mode it can delegate to any agent the calling user can access — new agents included automatically — minus a disabled list. Disable specific agents under **All subagents except** on the **Auto** tab (or via `GET`/`PUT /api/agents/:id/subagent-exclusions`). Each user's own access still applies, so **Auto** never means any agent can call any agent — a caller only reaches agents it could already see. Both modes stay within the agent's [environment](/docs/platform-environments): only same-environment agents are eligible.

Auto delegation resolves per calling user. It applies in chat and other flows that carry a signed-in user; automated runs without one — a scheduled trigger, for example — fall back to the explicitly assigned targets.

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

## Default Agents

Which agent a new chat starts on — one opened from the composer, an app opened in chat, or any other chat reached without naming an agent — is decided in this order:

1. the [project](/docs/platform-projects)'s pinned agent, inside that project
2. the member's own **default agent**, if they pinned one
3. the organization-wide **Default Agent**, set by an admin in **Settings → Agents**
4. the member's own personal chat agent — **My Assistant**, created for them on first use

A member can pin **any chat agent they can see** as their default — their own, a team's, or an organization-wide one. On the **Agents** page each one offers **Pin default** and **Unpin default**. There is at most one pin per member.

Exactly one row in that list is badged, because exactly one agent starts a member's new chats: **default (me)** when it is their own pin, **default (org)** when the agent is the organization's default. The organization's default reads as the organization's even for a member who also pinned it — it starts their chats either way — and that row offers no pin or unpin, since neither would change anything they can see. Unpinning elsewhere moves the badge back to the organization default.

A pin on the organization default is still kept: it is what keeps that agent theirs if an admin later points the organization default at a different one, and the row starts reading **default (me)** at that moment.

A pin is only ever made deliberately. Nothing adopts an agent into that slot on a member's behalf — so the organization default reaches everyone who has not pinned one, which is most people.

Every member still gets a personal **My Assistant** on first use, and it is what they chat with when no default is configured anywhere. Having one does not, by itself, override the organization default.

Deleting an agent that someone had pinned clears the pin for them, and they fall back to the organization default. The delete is never refused for that reason. A pin also stops applying if the member loses access to the agent — they fall back the same way, without anything to clean up.

## Deleting an Agent

Deleting an agent hides it everywhere and stops its scheduled runs. The agent is not destroyed — it moves to a trash. Switch the status filter to **Deleted** to see what is there, and **Restore** to bring one back.

Global admins can also delete an agent from the trash for good, with **Delete permanently**. This destroys its configuration, version history, hooks, and scheduled tasks. Nothing brings it back.

What the agent produced stays. Its chats and its LLM usage records survive the deletion and simply stop pointing at it, so your history and cost reporting stay intact.

Deleting an agent for good also clears it from anywhere it was set as a default — the organization default, the **/connection** defaults, and each member's personal default. Those fall back to unset, so pick a replacement afterwards.

Purging a heavily used agent has millions of usage records to detach and can take a few minutes. Past five it stops and leaves the agent in the trash, unharmed. Try again during a quieter period.

## Version History

Archestra snapshots an agent's configuration every time it changes — prompt, tools, hooks, knowledge, or settings. A save that changes nothing does not create a version. MCP gateways keep the same history.

Open **Version history** from the agent's row menu to browse the snapshots. Pick one to read its configuration. **All settings** shows the whole configuration; **Changes** shows only what moved since the version before.

The history is available through the API. `GET /api/agents/:id/versions` lists versions as metadata, newest first. `GET /api/agents/:id/versions/:version` returns one full configuration snapshot. Key material is never captured, so you can review what changed without exposing secrets.

Each agent keeps its last 100 versions. The oldest listed version can therefore be greater than 1.

### Restoring a Version

**Restore this version** returns an agent to an earlier configuration. The restore forks forward: the old configuration becomes a new version. Nothing in the history is overwritten.

If someone else edits the agent while you preview it, the restore is refused.

A restore is all-or-nothing. If the version points at something that no longer exists — a deleted tool, for example — the restore fails and the agent is left exactly as it was. Recreate the missing piece, or restore a later version instead.

Over the API, `POST /api/agents/:id/versions/:version/restore` does the same. Send the agent's current `latestVersion` as `baseVersion` to anchor the restore. A 409 then tells you someone else changed the agent first. Built-in agents cannot be restored.

## System Prompt Templating

Agent system prompts support [Handlebars](https://handlebarsjs.com/) templating. Templates are rendered at runtime before the prompt is sent to the LLM, with the current user's context injected as variables. Agent Skills can opt into the same rendering with a `templated: true` frontmatter field (set automatically when converting a templated agent); their `SKILL.md` body is then rendered with the same variables and helpers each time the skill is loaded.

### Variables

| Variable         | Type     | Description                                      |
| ---------------- | -------- | ------------------------------------------------ |
| `{{user.name}}`  | string   | Name of the user invoking the agent              |
| `{{user.email}}` | string   | Email of the user invoking the agent             |
| `{{user.role}}`  | string   | Organization role of the user invoking the agent |
| `{{user.teams}}` | string[] | Team names the user belongs to                   |

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

### Literal Braces

Prefix an expression with a backslash to keep it as text: `\{{user.name}}` renders as `{{user.name}}`. This is useful when a prompt documents its own variables.

An expression Handlebars cannot read is left as written, and the rest of the prompt still renders. The agent editor flags those expressions as you type, so you can see which ones reach the model as literal text.
