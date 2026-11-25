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

- Each person uses their own access, so two people can get different tools from one agent. In **Manual** mode, a person gets an assigned tool only if they can access its MCP server. In both modes, a tool that needs an account uses the person's own connection, unless you pin one.
- Built-in platform tools are excluded by default in All mode. Review the exclusions before you give an agent tools that change Archestra itself.
- The agent loads tools as it needs them. It starts with [`search_tools`](/docs/reference/archestra-mcp-server#search_tools) and [`run_tool`](/docs/reference/archestra-mcp-server#run_tool), not the full list. In **Manual** mode, you can turn off **Progressive tool loading** to send every assigned tool.
- <span id="missing-connections"></span>**Missing connections:** in **Manual** mode, choose when the agent prompts users to connect missing tool accounts (on call, on chat open, or required before chat). To use one account for everyone, pin a connection or [resolve credentials at call time](/docs/mcp/authentication/servers#resolve-at-call-time).

## Prompt Templates

- **Helpers:** Handlebars [blocks](https://handlebarsjs.com/guide/builtin-helpers.html) such as `#if` and `#each` work, and so do `includes`, `equals`, `contains`, and `json`.
- [Skills](/docs/agents/skills) can use templates too. Add `templated: true` to the skill's frontmatter. See [Writing Skills](/docs/agents/skills/writing).
- To keep an expression as text, add a backslash: `\{{user.name}}`. An expression Handlebars cannot read stays as written.

## Code Sandbox

- **Files you attach** appear under `/home/sandbox/attachments/`.
- **Large tool results** go to `/home/sandbox/tool-results/`. When a tool returns more than 32 KB of text, the agent sees only the beginning, plus the file's path to grep the rest.
- **Files the agent saves** appear in the conversation's **Files** panel.
- **Network access** follows the [egress policy](/docs/admin/environments#network-egress-policies) of the agent's environment, unless the agent [sets its own](/docs/admin/environments#give-one-agent-its-own-policy).
- Files stay between commands. Running processes do not.
- Without the sandbox, or in an encrypted chat, a large tool result is cut to its first 32 KB.
- The sandbox is on by default. To turn it off, set [`ARCHESTRA_CODE_RUNTIME_ENABLED=false`](/docs/admin/deployment/configuration#ARCHESTRA_CODE_RUNTIME_ENABLED). For setup, see [Code Sandbox deployment](/docs/admin/deployment/networking#code-sandbox-requirements).
