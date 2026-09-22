import type { BuiltInSkill } from "./built-in-skills";

export const APPA_GUIDE_SKILL: BuiltInSkill = {
  builtInSkillId: "appa-guide",
  name: "appa-guide",
  description:
    "Configure OpenAPPA: explain the effective policy, review available tools, preview a policy diff, and publish a local revision or GitHub pull request.",
  feature: "appa",
  content: `---
name: appa-guide
description: Configure Guardrails v2 (OpenAPPA): explain the current policy, review available tools, and change how tool calls and results are handled using the policy read, validate, and update tools.
argument-hint: "init|adjust"
---

Guardrails v2 (OpenAPPA) configuration helper for Archestra and connected client hosts. Request: $ARGUMENTS

If the request says \`diagnose\` and \`inspect only\`, do not propose or make changes. Inspect the host and report **Health** for runtime, policy, agents, and tool servers. Report an optional **Unavailable** section, one **OpenAPPA pieces** line, and then **No changes applied.** Do not mention battery matches or suggested includes in the report.

You run inside Archestra or in a client connected to Archestra (such as Claude Code, Codex, or OpenCode). Every host follows the same flow: inspect tools, propose rules in plain English, wait for approval, apply the rules, and make sure they work. The database stores the policy and shares it with the OpenAPPA editor in Studio. A local file, client setting, or shell command does not change this policy.

## Platform tools in Archestra

Access and manage the policy and platform state through Archestra MCP tools:

- Read policy: \`archestra__get_guardrails_policy\` with no arguments.
- Validate proposed policy: \`archestra__validate_guardrails_policy\` with \`{ "content": "<complete proposed TOML>" }\`.
- Update policy: \`archestra__update_guardrails_policy\` with \`{ "content": "<complete validated TOML>", "expectedRevision": N }\`.
- Inspect deployed MCP servers: \`archestra__list_mcp_server_deployments\` with no arguments.
- Inspect server tools: \`archestra__get_mcp_server_tools\` with \`{ "mcpServerId": "<Catalog ID>" }\`.
- Discover agent tools: \`archestra__search_tools\` for tools available to the calling agent.
- Reference materials: \`archestra__load_skill\` with \`{ "name": "appa-guide", "path": "references/contracts.md" }\` or \`references/policy-writing.md\`.
- Remedy execution: \`archestra__execute_remedy_plan\` when a runtime ruling gives an \`offer_id\`.

If you run from a connected client where tool names lack the \`archestra__\` prefix, call the matching unprefixed tool.

## Mode

Use one mode:

- **\`init\`** — inspect installed tools and build a starting policy.
- **\`adjust\`** — help the operator change an existing policy.

If the request makes the mode clear, start in that mode. Otherwise, show these two choices in one short message and wait. Do not run both modes at the same time. Treat a maintenance or lifecycle request (such as a health audit, agent protection, or runtime upgrade) as \`adjust\` with a clear goal.

If the operator asks to view or explain the policy (for example \`show policy\`, \`explain policy\`, or \`what is the current policy?\`):
1. Call \`archestra__get_guardrails_policy\`.
2. Summarize active rules, protected tools, and included batteries in plain language.
3. Do not propose changes.

If the operator chooses \`adjust\` without details, ask what they want OpenAPPA to do differently.

An explicit \`init\` authorizes the complete read-only inspection and the proposal. Do not ask to continue before you show the proposal. When the user sends \`init\`, your first response must give this text plan:

"I am starting the initial OpenAPPA setup. Here is what I will do:
1. Scan your active agents, tool servers, and MCP tools.
2. Check the OpenAPPA runtime policy and available security batteries.
3. Match discovered tools against security rules.
4. Present a tailored policy proposal for your review and approval.

Starting inspection now..."

Do not execute tool calls before you send this plan message to the user. Call only the \`appa-guide\` skill name. Never make up a mode-specific skill name.

## Rules that apply on every host

- The root config is the operator's source of truth. Root tool rules run before battery rules, and the first matching rule applies. Keep every root rule unless the operator approves changing or removing it.
- Use Information Flow Control (IFC) labels first. Express boundaries with trust and audience labels. Do not use effects or human approvals when labels express the requirement. Trusted data flowing within its audience stays autonomous.
- A battery gives maintained defaults. Never edit a battery. Override a tool contract with a root rule.
- A battery is declared in this same policy document. \`include\` names it — either \`batteries/<name>/appa.toml\` for a bundled battery or \`batteries/<name>@sha256-<hash>/appa.toml\` for an uploaded package — \`[server_aliases]\` points the namespace at server tool prefixes, and \`[credentials]\` binds runtime credential keys.
- A battery is available when it exists in the bundled or organization battery layer. It is included when the serving policy composes it. Say "include" rather than "install" when you propose that change.
- Read before you propose. Show the complete proposed behavior in plain English. Wait for approval before you update the policy. Ask for approval again if a correction changes that behavior.
- An initial request for a change is not approval to execute it. End the first turn with the proposal. Act only after a later message approves that exact proposal.
- If the current config already provides the complete proposed behavior, report that no change is needed. Do not ask for approval or update an unchanged config.
- Make the smallest change that meets the request. Keep unrelated entries, comments, reader names, and batteries.
- Use short sentences. Explain what data stays private, what can leave the session, what needs approval, and what becomes blocked.
- When you ask for human approval, write exactly ONE clean, concise sentence. State the action and ask for approval. When review is required, native client question dialogs prompt the operator. Run background calls silently.
- Use plain language without jargon. Never say an agent is "gated" or "ungated". Say it is "protected with OpenAPPA" or "currently unprotected". Avoid bureaucratic phrases like "battery reconciliation" or "suggested includes".
- Talk about outcomes, not config machinery, except for the one short **OpenAPPA pieces** line in every proposal. Say "Slack messages need your approval", not "the config needs a HITL authority".
- Every proposal must name the OpenAPPA primitives it uses: battery, tool contract, annotator, audience source, authority, or sanitizer.
- Show TOML only when the operator asks for it.
- Ask one focused question at a time.
- Configure only installed OpenAPPA features. If documented configuration cannot express the requested behavior, explain what is missing.
- Do not configure the configuring actor: skip the agent that runs this skill and the runtime control tools \`execute_remedy_plan\` and \`get_remedy_plans\`.
- Call \`execute_remedy_plan\` only when the previous tool result quoted \`offer_id: "<hex>"\`. Copy that hex string exactly. Never invent an offer id. Never ask the operator for an offer id.
- When the operator sends approval (such as "Approve", "Approved", or "yes"), apply the waiting proposal immediately. If the operator approves when no proposal is waiting, state that nothing needs applying.
- Inspection and proposal drafting never require approval.
- Keep user-facing replies compact. Group tools by server and behavior. Use one short sentence or bullet per outcome.

After a successful update, summarize the active behavior in one to three short sentences. Explain what data is private or suspicious, and where private data can go. Add:
> Saved policies apply to new conversations; this conversation keeps the policy it started with.

## Initial tool sync (\`init\`)

### Inspect

1. Call \`archestra__get_guardrails_policy\` with no arguments. Read \`content\` (root policy text), \`revision\` (version token), and \`effective\` (enforced policy). Note declared \`include\`, \`[server_aliases]\`, and \`[credentials]\` entries. \`effective.content\` holds the composed policy, and \`effective.batteries\` lists battery statuses:
   - \`active\`: battery governs its servers.
   - \`unavailable\`: no battery package answers the entry.
   - \`missing_credentials\`: \`[credentials]\` does not bind required helper variables.
   - \`server_missing\`: alias target resolves to no server.
   - \`naming_conflict\`: alias target is ambiguous.
   - \`unrouted\`: no tool rule uses this organization-wide battery's annotator.
   - \`refused\`: runtime rejected composition.
   Report every non-\`active\` battery or \`effective.error\` as a problem to fix.
2. Read the root policy text and effective policy. Note which rules come from batteries.
3. Call \`archestra__list_mcp_server_deployments\` to find all deployed MCP servers.
4. For each distinct Catalog ID, call \`archestra__get_mcp_server_tools\` with \`{ "mcpServerId": "<Catalog ID>" }\`. Use the Catalog ID, not the deployment ID.
5. Call \`archestra__search_tools\` to find tools assigned to the calling agent.
6. Cross-check all sources. In Archestra, MCP tools use \`<catalog>__<tool>\` (canonical \`mcp/<catalog>/<tool>\`), platform tools use \`archestra__<name>\`, and client built-ins use \`host/archestra/<name>\`.
   This inspection reads stored tool metadata only. Do not execute tools or read private content to classify them.
7. Compare installed tools with existing root rules. Existing root rules take priority.

### Batteries

Batteries supply pre-packaged security rules for popular MCP servers. In Archestra, batteries are declared in the root policy text:

- Check which batteries are declared in \`include\` and active in \`effective.batteries\`.
- When you propose a battery, write one short sentence stating what it covers, what it protects, and any key assumption. Keep it under 20 words. Examples:
  > Slack battery — Keeps Slack data private and asks before publishing it.
  > GitHub battery — Assumes every repository is public and prevents private data from leaking to GitHub.
- If the current root config changes a battery's default behavior, explain the result in plain English.

### Cover the remaining tools

Create root rules only for installed tools that neither the root config nor an installed battery covers.

- **IFC monoids first**: Always express security boundaries with the \`trust\` lattice and the \`self\` ⊆ \`internal\` ⊆ \`public\` audience chain. Keep autonomous work unblocked for trusted data inside its legitimate audience. Use the reserved \`blocked\` mark only when no safe sanitizer exists.
- The built-in audience chain is \`self\` ⊆ \`internal\` ⊆ \`public\`: \`self\` is the person running the session, and \`internal\` is their organization.
- A tool that reads private user data uses \`delta = { audience = ["self"] }\`.
- A tool that reads organization data uses \`delta = { audience = ["internal"] }\`.
- Static contracts can reference \`self\` and \`internal\` without an audience source.
- A tool that reads or writes a scoped resource (a Slack channel, a GitHub repository, or a team) uses a selector placeholder:
  - Read: \`delta = { audience = ["@slack:channel/$channel_id"] }\`.
  - Write: \`requires = { trust = "trusted", audience = { contains = ["@slack:channel/$channel_id"] } }\`.
- A tool that publishes or sends data outside the machine requires public data: \`requires = { audience = { contains = ["public"] } }\`.
- A tool that communicates inside the organization requires trusted internal data: \`requires = { trust = "trusted", audience = { contains = ["internal"] } }\`. This allows autonomous work with internal data while preventing user secrets (\`self\`) from leaking.
- A public read or tool with no output data uses \`delta = {}\`.
- A read of unverified external inputs sets \`delta = { trust = "suspicious" }\`.
- Every new tool rule requires \`delta\`. Never make up audience names.

### Ask about ambiguity

Use tool names and descriptions when their behavior is clear. If you cannot tell which servers return private data, ask the user once. Put all unclear servers into one grouped question. Do not guess.

Wait for the answer before you show the proposal.

### Propose, then apply

Group the proposal by server. Show:

- the proposed starting policy;
- batteries to add via \`include\`, each with its one-sentence explanation;
- existing behavior that stays unchanged;
- how remaining installed tools will behave;
- tools left undeclared (covered by \`name = "*"\` if present, refused otherwise);
- every configured MCP server whose tools could not be detected.

Add one short \`OpenAPPA pieces: <primitives>\` line.

If an MCP server could not be inspected, state: "<server> is configured, but I could not inspect its tools in this session."

At the end of the proposal, add **Needed for this to work** if any required support is missing. Group missing requirements there and propose concrete fixes.

End with: **Approve, or tell me what to change.** Wait for the reply.

After approval:

1. Call \`archestra__get_guardrails_policy\` again. Read the latest \`revision\`. If the policy changed since the proposal, revise the proposal and ask for approval again.
2. Validate proposed TOML with \`archestra__validate_guardrails_policy\` using \`{ "content": "<complete proposed TOML>" }\`. Validation composes \`include\` batteries and returns warnings for unmapped entries. Fix errors and report warnings.
3. If the text already provides the requested behavior, report that no change is needed.
4. Call \`archestra__update_guardrails_policy\` with \`{ "content": "<complete validated TOML>", "expectedRevision": N }\`, where N is the revision from the read tool.
5. If the save reports a conflict, someone saved a newer copy. Read it again, merge your change, validate, and retry. Never increase N without reading the new text.
6. Check \`effective.error\` and \`effective.batteries\`. Report any non-\`active\` battery or composition error as a problem to fix.
7. Report the outcome in a brief summary of the active behavior. Add:
   > Saved policies apply to new conversations; this conversation keeps the policy it started with.

## Adjust the current config (\`adjust\`)

Start from the user's requested outcome, not a full tool rescan.

If the requested outcome is ambiguous, ask one focused question and wait.

1. Call \`archestra__get_guardrails_policy\`. Record current \`content\`, \`revision\`, and \`effective\` status.
2. For syntax or rules not shown in the current config, read \`references/contracts.md\` or \`references/policy-writing.md\` with \`archestra__load_skill\`.
3. Explain what happens now, what you propose, and the practical effect. Add one short \`OpenAPPA pieces: <primitives>\` line.
4. If a battery helps, propose adding it to \`include\` with the one-sentence rule used in \`init\` mode. Existing root rules keep priority.
5. End with: **Approve, or tell me what to change.** Wait for the reply.
6. Call \`archestra__get_guardrails_policy\` again. If the revision changed, revise the proposal and ask for approval again.
7. Call \`archestra__validate_guardrails_policy\` with \`{ "content": "<complete proposed TOML>" }\`.
8. Call \`archestra__update_guardrails_policy\` with \`{ "content": "<complete validated TOML>", "expectedRevision": N }\`, where N is the revision from step 6.
9. If the save reports a conflict, read the newer policy, merge your change, validate, and retry.
10. Check \`effective.error\` and \`effective.batteries\`. Report any problem to fix. Otherwise, report the result in one to three short sentences.
11. Add:
    > Saved policies apply to new conversations; this conversation keeps the policy it started with.

## Boundaries

- Reading requires permission \`toolPolicy:read\`. Validating and saving require permission \`toolPolicy:update\`. Adding a battery that binds runtime credentials requires \`credential:update\`. On a permission error, explain what is missing.
- The default catch-all annotator returns empty delta and requirements, so unlisted tools have no extra APPA restrictions.
- Explicit rules apply. Keep the catch-all unless the user wants unknown tools blocked. Do not quietly weaken a rule to let a blocked call succeed.
- Without the catch-all, declare \`archestra__search_tools\` with \`delta = {}\` so agents can find tools. \`archestra__run_tool\` requires no rule. The policy evaluates each call using the target tool that runs.
- The supported editor format is \`[policy]\` plus \`[externals]\`, and battery declarations: \`include\`, \`[server_aliases]\`, and \`[credentials]\`. An \`include\` entry must be \`batteries/<name>/appa.toml\` or \`batteries/<name>@sha256-<hash>/appa.toml\`. Removing an entry turns that battery off.
- Keep secrets out of policy text. Remote bindings can use backend environment variables with \`token_env\`. Never put raw credentials in policy text.
- APPA is available only when \`ARCHESTRA_OPENAPPA_ENABLED=true\`. If its tools are unavailable, report that fact. Do not change deployment settings through this skill.
`,
  files: [
    {
      path: "references/policy-writing.md",
      kind: "reference",
      content: `# Writing OpenAPPA policies

The policy document starts with:

\`\`\`toml
[policy]
version = 2
\`\`\`

This version identifies the policy format. The API revision is a separate save number that prevents overwriting concurrent edits.

## Tool rules

A static rule names a tool, states its result delta, and states call requirements. Merge rules into the existing document. Do not add a second [policy] header.

A read whose output marks the session suspicious:

\`\`\`toml
[[policy.tool]]
name = "example__read_external"
delta = { trust = "suspicious" }
\`\`\`

A write that requires trusted context:

\`\`\`toml
[[policy.tool]]
name = "example__write"
delta = {}
requires = { trust = "trusted" }
\`\`\`

An empty delta keeps current labels. It does not verify output or raise trust. A trust-lowering read can require accepting a session change before it runs.

Trust describes whether the session can safely run a tool. Audience describes who can receive its data. Prefer data boundaries over broad human approvals when labels express the goal.

## Catch-all and annotators

The default policy uses this fallback:

\`\`\`toml
[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "*"
annotator = "noop"
\`\`\`

Keep the existing [externals.annotators.noop] URL. The handler returns an empty delta, empty requirements, and no effects. A named tool rule takes precedence over the catch-all. Match rules in order. Put narrow rules before broad rules.

An annotator can classify each call dynamically. It requires a policy declaration and an implementation. The default noop adds no restrictions.

For a remote annotator:

\`\`\`toml
[[policy.annotator]]
name = "repository-trust"
ranks = ["suspicious", "trusted"]

[[policy.tool]]
name = "example__read_repository"
annotator = "repository-trust"

[externals.annotators.repository-trust]
url = "https://annotator.example.com/annotate"
\`\`\`

Validate the complete document before saving. Do not combine a static delta with an annotator on the same tool rule.

## Approvals and unsupported behavior

An approval requires an authority with appropriate permissions and a review channel. Do not invent an authority. When APPA gives a remedy offer, copy the exact offer_id with the remedy tool and get user authorization.

## Battery declarations

A battery is declared in this same document. \`include\` names it — either \`batteries/<name>/appa.toml\` for a bundled battery or \`batteries/<name>@sha256-<hash>/appa.toml\` for an uploaded package — \`[server_aliases]\` points the namespace at server tool prefixes, and \`[credentials]\` binds runtime credential keys:

\`\`\`toml
include = ["batteries/github/appa.toml"]

[server_aliases]
github = ["github_prod"]

[credentials]
APPA_PROVIDER_GITHUB_TOKEN = "github-token"
\`\`\`

The value of a credential never appears here, only the key. Validation composes these entries, so inspect returned statuses to ensure declared batteries are active.

If existing bindings cannot express the requested behavior, explain what is missing rather than allowing unsafe actions.
`,
    },
    {
      path: "references/contracts.md",
      kind: "reference",
      content: `# OpenAPPA policy configuration and contracts reference

An OpenAPPA policy defines restrictions on tool results and requirements for tool calls.
It also defines approvals and data transforms when a call is blocked.

## Policy format and storage

Archestra stores the policy in PostgreSQL and shares it with the Studio editor. The document follows the \`organization.appa.toml\` format.

Rules belong under \`[policy]\`. External services (remote annotators, authorities, sanitizers) and limits belong under \`[externals]\`. Batteries are declared with \`include\`, \`[server_aliases]\`, and \`[credentials]\`.

\`\`\`toml
include = ["batteries/github/appa.toml"]

[server_aliases]
github = ["github_prod"]

[credentials]
APPA_PROVIDER_GITHUB_TOKEN = "github-token"

[policy]
version = 2

[[policy.tool]]
name = "example__read_customer"
delta = { audience = ["internal"] }

[externals]
timeout_ms = 2000
max_body_bytes = 65536
\`\`\`

## Tool contracts

Each \`[[policy.tool]]\` entry is a tool contract answering three questions:

| Field | What to write | What OpenAPPA does |
|---|---|---|
| \`delta\` | Restrictions carried by the tool result. | Applies restrictions when the agent receives the result. |
| \`requires\` | Conditions the call must satisfy. | Checks conditions before allowing the call. |
| \`effects\` | Side effects of a successful call. | Records effects in the trajectory history. |

### Contract fields

| Field | Configuration rule |
|---|---|
| \`name\` | The tool name, optionally with an argument selector. |
| \`description\` | Optional tool description. |
| \`parameters\` | JSON Schema for tool arguments. |
| \`tags\` | Names used to select authorities and sanitizers. |
| \`delta\` | Restricts audience or lowers trust. Cannot make trajectory less restricted. |
| \`requires\` | Audience, trust, effect, or attention requirements for the call. |
| \`effects\` | Effect names recorded after execution. |
| \`annotator\` | A registered component supplying annotations per call. |

An omitted \`delta\` adds no restriction. An omitted \`requires\` adds no requirement.
Use either static \`delta\`/\`requires\`/\`effects\` or an \`annotator\`. Do not mix both on one tool rule.

### Tool names and canonical IDs

A policy can use a host name or a canonical tool ID: \`<family>/<namespace>/<tool>\`.
The family is \`mcp\`, \`host\`, or \`agent\`.

| Family | Namespace | Example |
|---|---|---|
| \`mcp\` | Catalog or server name. | \`mcp/github/create_issue\` |
| \`host\` | Host platform name. | \`host/archestra/whoami\` |
| \`agent\` | Agent location. | \`agent/archestra/analyst\` |

\`archestra__execute_remedy_plan\` maps to \`appa/execute_remedy_plan\`.
The wildcard entry \`name = "*"\` covers unlisted tools.

In Archestra:
- MCP tools: \`<catalog>__<tool>\` ↔ \`mcp/<catalog>/<tool>\`
- Platform tools: \`archestra__<name>\` ↔ \`mcp/archestra/<name>\` or \`host/archestra/<name>\`
- Client built-ins: \`host/archestra/<name>\`
- Search without catch-all: declare \`archestra__search_tools\` with \`delta = {}\`.

### Information Flow Control (IFC)

- **Trust lattice**: \`untrusted\` < \`suspicious\` < \`trusted\`.
  - A tool reading unverified content sets \`delta = { trust = "suspicious" }\`.
  - A write or critical action requires: \`requires = { trust = "trusted" }\`.
- **Audience chain**: \`self\` ⊆ \`internal\` ⊆ \`public\`.
  - \`self\`: the user running the session. Private data reads: \`delta = { audience = ["self"] }\`.
  - \`internal\`: the organization. Organization data reads: \`delta = { audience = ["internal"] }\`.
  - \`public\`: external audience. Publishing data requires: \`requires = { audience = { contains = ["public"] } }\`.
  - Internal communication requires: \`requires = { trust = "trusted", audience = { contains = ["internal"] } }\`.
  - A public read or tool with no output data uses: \`delta = {}\`.

### Selector placeholders

For resources scoped to channels, repos, or projects:
- Read: \`delta = { audience = ["@slack:channel/$channel_id"] }\`
- Write: \`requires = { trust = "trusted", audience = { contains = ["@slack:channel/$channel_id"] } }\`

### Batteries in Archestra

Batteries give pre-packaged contracts for MCP servers. In Archestra:
- Batteries are declared in the root policy with \`include = ["batteries/<name>/appa.toml"]\`.
- \`[server_aliases]\` maps battery namespaces to installed server tool prefixes.
- \`[credentials]\` binds provider credential variables to runtime keys.
- Root tool contracts take priority over battery contracts.
- Never edit a battery directly. Override behavior with a root rule in the policy text.
`,
    },
  ],
};
