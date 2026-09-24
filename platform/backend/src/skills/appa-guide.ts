import type { BuiltInSkill } from "./built-in-skills";

export const APPA_GUIDE_SKILL: BuiltInSkill = {
  builtInSkillId: "appa-guide",
  name: "appa-guide",
  description:
    "Configure Guardrails v2 (OpenAPPA): explain the effective policy, review tools, preview a policy diff, and publish a local revision or GitHub pull request.",
  feature: "appa",
  // white-label-ok: applyBuiltInSkillBranding rebrands the built-in skill body at reconcile
  content: `---
name: appa-guide
description: Configure Guardrails v2 (OpenAPPA): explain the effective policy, review tools, preview a policy diff, and publish a local revision or GitHub pull request.
argument-hint: "init|adjust"
---

Guardrails v2 (OpenAPPA) configuration helper for Archestra and connected client hosts. Request: $ARGUMENTS

If the request says \`diagnose\` and \`inspect only\`, do not propose or make changes. Inspect the host and report **Health** for runtime, policy, agents, and tool servers. Report an optional **Unavailable** section, one **OpenAPPA pieces** line, and then **No changes applied.** Do not mention battery matches or suggested includes in the report.

You run inside Archestra or in a client connected to Archestra (such as Claude Code, Codex, or OpenCode). Every host follows the same flow: inspect tools, preview the proposed policy, explain it in plain English, wait for approval, publish it, and check the result. The OpenAPPA Policy page shows the policy read-only. Archestra stores the effective policy in the database. When GitHub sync is configured, the repository owns the source text. A local client file, setting, or shell command does not change this policy.

## Platform tools in Archestra

Access and manage the policy and platform state through Archestra MCP tools:

- Read policy: \`archestra__get_guardrails_policy\` with no arguments.
- Preview and validate a proposed change: \`archestra__preview_guardrails_policy_change\` with \`{ "content": "<complete proposed TOML>", "expectedRevision": N }\`. This returns before and after text for a diff, delivery mode, errors, and warnings without saving.
- Publish an approved change: \`archestra__update_guardrails_policy\` with \`{ "content": "<complete previewed TOML>", "expectedRevision": N }\`. An optional \`title\` and \`summary\` describe the GitHub PR if sync is configured.
- Check a policy PR: \`archestra__get_guardrails_policy_change_status\` with \`{ "number": N }\`, using the number returned by publish.
- Inspect deployed MCP servers: \`archestra__list_mcp_server_deployments\` with no arguments.
- Inspect server tools: \`archestra__get_mcp_server_tools\` with \`{ "mcpServerId": "<Catalog ID>" }\`.
- Discover agent tools: \`archestra__search_tools\` for tools available to the calling agent.
- Reference materials: \`archestra__load_skill\` with \`{ "name": "appa-guide", "path": "references/contracts.md" }\` or \`references/policy-writing.md\`.
- Remedy execution: \`archestra__execute_remedy_plan\` when a runtime ruling gives an \`offer_id\`.

If you run from a connected client where tool names lack the \`archestra__\` prefix, call the matching unprefixed tool.

## Mode

Use one mode:

- **\`init\`** - inspect installed tools and build a starting policy.
- **\`adjust\`** - help the operator change an existing policy.

If the request makes the mode clear, start in that mode. Otherwise, show these two choices in one short message and wait. Do not run both modes at the same time. Treat a maintenance or lifecycle request (such as a health audit, agent protection, or runtime upgrade) as \`adjust\` with a clear goal.

If the operator asks to view or explain the policy (for example \`show policy\`, \`explain policy\`, or \`what is the current policy?\`):
1. Call \`archestra__get_guardrails_policy\`.
2. Summarize active rules, protected tools, and included batteries in plain language. If asked about subagents, distinguish tool-call rules from the separate child-return boundary.
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

- The root config is the operator's source of truth. Root tool rules run before battery rules, and the first matching rule applies. Preserve the whole root policy, including \`[policy.deployment]\`, unless the operator approves a change. A saved revision replaces the complete document; it does not inherit fields from the starting policy.
- Use Information Flow Control (IFC) labels first. Express boundaries with trust and audience labels. Do not use effects or human approvals when labels express the requirement. Trusted data flowing within its audience stays autonomous.
- A battery gives maintained defaults. Never edit a battery. Override a tool contract with a root rule.
- A battery is declared in this same policy document. \`include\` names it - either \`batteries/<name>/appa.toml\` for a bundled battery or \`batteries/<name>@sha256-<hash>/appa.toml\` for an uploaded package - \`[server_aliases]\` points the namespace at server tool prefixes, and \`[credentials]\` binds runtime credential keys.
- A battery is available when it exists in the bundled or organization battery layer. It is declared by \`include\` and governs calls only when \`effective.batteries\` marks it \`active\`. Say "include" rather than "install" when you propose that change.
- Read and preview before you propose. Show the diff, warnings, and complete proposed behavior in plain English. Wait for approval before you publish. Ask for approval again if a correction changes that behavior.
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
- For CLI subagents, inspect the spawn tool, the child's tool rules, and the return boundary separately. A rule on the spawn tool or the child's reads does not make its final answer safe for the parent. See \`references/contracts.md\` before proposing return protection.
- Provider-hosted tools execute inside the model provider without a client-side call to gate. Ask whether connected clients declare them and whether the operator accepts that limitation before an initial or tool-related policy proposal. A \`[[policy.tool]]\` rule cannot refuse their declaration. OpenAI Responses web search is the exception whose result is checked before it reaches the client. If the operator requires refusing every hosted tool with a signed offer to use a local counterpart, state that this is not supported; do not invent an offer or claim a policy rule enforces it.
- Do not configure the configuring actor: skip the agent that runs this skill and the runtime control tools \`execute_remedy_plan\` and \`get_remedy_plans\`.
- Call \`execute_remedy_plan\` only when the previous tool result quoted \`offer_id: "<hex>"\`. Copy that hex string exactly. Never invent an offer id. Never ask the operator for an offer id.
- When the operator sends approval (such as "Approve", "Approved", or "yes"), apply the waiting proposal immediately. If the operator approves when no proposal is waiting, state that nothing needs applying.
- Inspection and proposal drafting never require approval.
- Keep user-facing replies compact. Group tools by server and behavior. Use one short sentence or bullet per outcome.

After a local revision, summarize the active behavior in one to three short sentences. Explain what data is private or suspicious, and where private data can go. Add:
> Saved policies apply to new conversations. This conversation keeps the policy it started with.

If publishing opens a GitHub PR, give its link and state that the proposed policy is not enforced until merge and a successful repository sync. Do not claim it is active or tell the operator to start a new conversation yet.

## Initial tool sync (\`init\`)

### Inspect

1. Call \`archestra__get_guardrails_policy\` with no arguments. Read \`content\` (root policy text), \`revision\` (version token), \`delivery\` (local revision or GitHub PR), and \`effective\` (enforced policy). Note \`[policy.deployment]\`, declared \`include\`, \`[server_aliases]\`, and \`[credentials]\` entries. \`effective.content\` holds the composed policy, and \`effective.batteries\` lists battery statuses:
   - \`active\`: battery's rules or routed annotator can govern calls.
   - \`unavailable\`: no battery package answers the entry.
   - \`missing_credentials\`: \`[credentials]\` does not bind required helper variables.
   - \`server_missing\`: alias target resolves to no server.
   - \`naming_conflict\`: alias target is ambiguous.
   - \`unrouted\`: no tool rule uses this organization-wide battery's annotator.
   - \`refused\`: runtime rejected composition.
   Report every non-\`active\` battery or \`effective.error\` as a problem to fix. If composition is refused while Guardrails v2 is on, proxied requests fail closed. Do not claim the new text or a previous policy is enforced.
2. Read the root policy text and effective policy. Note which rules come from batteries.
3. Call \`archestra__list_mcp_server_deployments\` to find all deployed MCP servers.
4. For each distinct Catalog ID, call \`archestra__get_mcp_server_tools\` with \`{ "mcpServerId": "<Catalog ID>" }\`. Use the Catalog ID, not the deployment ID.
5. Call \`archestra__search_tools\` to find tools visible to the calling agent. Missing search results do not prove a server has no tools.
6. Cross-check all sources. In Archestra, MCP tools use \`<catalog>__<tool>\` (canonical \`mcp/<catalog>/<tool>\`), and platform tools use \`archestra__<name>\`. MCP inventory never lists native client tools: Claude Code uses \`Task\` or \`Agent\`, OpenCode uses lowercase \`host/archestra/task\`, and Codex uses \`spawn_agent\`. Native tools may be evaluated as \`host/claude-code/<name>\` or \`host/archestra/<name>\`. Names are case-sensitive; match the evaluated name instead of copying another client's rule.
   This inspection reads stored tool metadata only. Do not execute tools or read private content to classify them.
7. Compare installed and native tools with existing root rules. If native subagents are in scope and \`[policy.deployment] context_control = true\` is absent, propose it and check that the client can receive the return contract before inference. An existing custom policy does not inherit the starting policy's deployment block.
8. Ask which clients use provider-hosted tools, such as Claude's advisor. If used, ask whether provider-side execution without a proxy-gated call is acceptable. An MCP inventory cannot discover these declarations. If it is not acceptable, list the unsupported refusal and signed-local-counterpart requirement under **Needed for this to work** rather than presenting the policy as complete.

### Batteries

Batteries supply pre-packaged security rules for popular MCP servers. In Archestra, batteries are declared in the root policy text:

- Check which batteries are declared in \`include\` and active in \`effective.batteries\`.
- An organization-wide annotator-only battery governs no server. It is \`unrouted\` until a tool rule names its annotator. Check that rule before calling it active. If it needs a credential, calls routed to it are refused until the credential is bound.
- When you propose a battery, write one short sentence stating what it covers, what it protects, and any key assumption. Keep it under 20 words. Examples:
  > Slack battery - Keeps Slack data private and asks before publishing it.
  > GitHub battery - Assumes every repository is public and prevents private data from leaking to GitHub.
- If the current root config changes a battery's default behavior, explain the result in plain English.

### Cover the remaining tools

Create root rules only for installed tools that neither the root config nor an installed battery covers.

- **IFC monoids first**: Always express security boundaries with the \`trust\` lattice and the \`self\` ⊆ \`internal\` ⊆ \`public\` audience chain. Keep autonomous work unblocked for trusted data inside its legitimate audience. Use the reserved \`blocked\` mark only when no safe sanitizer exists.
- For a native spawn, match the client's exact tool spelling and check the return contract separately. A capitalized \`Task\` rule does not match OpenCode's lowercase \`task\`. Do not classify a provider-hosted declaration as a native client tool or promise that a root rule gates its execution.
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

Before showing the proposal, call \`archestra__preview_guardrails_policy_change\` with the complete draft and the revision you read. It validates and composes the draft without saving. Fix errors and preview again. Show warnings. A valid status alone does not prove that a battery governs tools or an external service works. If the preview shows no change, report that no update is needed without asking for approval.

Group the proposal by server. Show:

- the proposed starting policy
- batteries to add via \`include\`, each with its one-sentence explanation
- existing behavior that stays unchanged
- how remaining installed tools will behave
- tools left undeclared (covered by \`name = "*"\` if present, refused otherwise)
- every configured MCP server whose tools could not be detected
- any requested subagent return boundary that the connected host cannot support or verify
- the previewed diff and whether approval will save a local revision or open a GitHub PR

Add one short \`OpenAPPA pieces: <primitives>\` line.

If an MCP server could not be inspected, state: "<server> is configured, but I could not inspect its tools in this session."

At the end of the proposal, add **Needed for this to work** if any required support is missing. Group missing requirements there and propose concrete fixes.

End with: **Approve, or tell me what to change.** Wait for the reply.

After approval:

1. Re-read the policy and its \`revision\` and \`delivery\`. If either changed since the proposal, revise the proposal and ask for approval again.
2. Preview the exact approved draft again with \`archestra__preview_guardrails_policy_change\`. If the diff, warnings, or delivery mode changed, show the new proposal and ask for approval again. Do not publish an invalid preview.
3. If the draft is unchanged, report that no update is needed. Otherwise call \`archestra__update_guardrails_policy\` with \`{ "content": "<complete previewed TOML>", "expectedRevision": N }\`, where N is the revision from the re-read. Use a clear \`title\` and \`summary\` when publishing a GitHub PR.
4. On a conflict, re-read, combine your change with the new text, preview, and ask for approval again if the proposed behavior changes. Never just increase N and retry the old draft.
5. If publish returns \`pull_request\`, give its URL. Use \`archestra__get_guardrails_policy_change_status\` with its number when asked about progress. State that the proposal is not enforced until the PR merges and repository sync succeeds. Do not say the policy changed yet.
6. If publish returns \`revision\`, read back the effective policy. Report any \`effective.error\` or non-\`active\` battery as a problem. If composition is refused while Guardrails v2 is on, proxied requests fail closed. Do not claim that a previous policy still protects them. Otherwise summarize what the new revision protects. Say that saved policies apply to new conversations. This conversation keeps the policy it started with.

## Adjust the current config (\`adjust\`)

Start from the user's requested outcome, not a full tool rescan.

If the requested outcome is ambiguous, ask one focused question and wait.

1. Call \`archestra__get_guardrails_policy\`. Record current \`content\`, \`revision\`, \`delivery\`, and \`effective\` status.
2. For syntax or rules not shown in the current config, read \`references/contracts.md\` or \`references/policy-writing.md\` with \`archestra__load_skill\`. Preserve \`[policy.deployment]\` while editing. For tool or client changes, ask whether provider-hosted tools are in use and whether their unmediated execution is acceptable; a tool rule cannot refuse them before the provider runs them. If the requested boundary needs signed local substitution, report it as unavailable rather than proposing an ineffective rule.
3. If a battery helps, add it to the draft \`include\` list. Explain it with the one-sentence rule used in \`init\` mode. Existing root rules keep priority.
4. Preview the complete proposed policy with \`archestra__preview_guardrails_policy_change\` and the current \`revision\`. Fix errors and preview again. If it produces no change, report that without approval language.
5. Explain what happens now, the previewed diff and warnings, and the practical effect. State whether approval will save locally or open a GitHub PR. Add one short \`OpenAPPA pieces: <primitives>\` line.
6. End with: **Approve, or tell me what to change.** Wait for the reply.
7. Re-read the policy and its \`revision\` and \`delivery\`. If either changed, revise the proposal and ask for approval again. Otherwise preview the exact approved draft again. If the diff or warnings changed, ask for approval again. Do not publish an invalid or unchanged preview.
8. Call \`archestra__update_guardrails_policy\` with \`{ "content": "<complete previewed TOML>", "expectedRevision": N }\`, where N is the latest revision. Give a GitHub PR a clear \`title\` and \`summary\`.
9. On a conflict, re-read, merge, preview, and request approval again if the proposed behavior changes.
10. If publish returns \`pull_request\`, give its URL and say the proposal takes effect only after merge and repository sync. Check its status with \`archestra__get_guardrails_policy_change_status\` when asked. If publish returns \`revision\`, read back \`effective.error\` and \`effective.batteries\` and report any problem. Otherwise, summarize the change and say that saved policies apply to new conversations. This conversation keeps the policy it started with.

## Boundaries

- Reading and previewing require \`toolPolicy:read\`. Publishing requires \`toolPolicy:update\`. GitHub PR publishing and status checks also require \`credential:read\`. Adding a battery that binds runtime credentials requires \`credential:update\`. On a permission error, explain what is missing. If GitHub sync lacks a ready App credential or has changed upstream, do not claim a policy update. Fix or sync the source before retrying.
- The default catch-all annotator returns empty delta and requirements, so unlisted tools have no extra APPA restrictions.
- Explicit rules apply. Keep the catch-all unless the user wants unknown tools blocked. Do not quietly weaken a rule to let a blocked call succeed.
- Without the catch-all, declare \`archestra__search_tools\` with \`delta = {}\` so agents can find tools. \`archestra__run_tool\` requires no rule. The policy evaluates each call using the target tool that runs.
- The supported editor format is \`[policy]\`, \`[policy.deployment]\`, \`[externals]\`, and battery declarations: \`include\`, \`[server_aliases]\`, and \`[credentials]\`. An \`include\` entry must be \`batteries/<name>/appa.toml\` or \`batteries/<name>@sha256-<hash>/appa.toml\`. Removing an entry turns that battery off.
- Keep secrets out of policy text. Remote bindings can use backend environment variables with \`token_env\`. Never put raw credentials in policy text.
- APPA is available only when \`ARCHESTRA_OPENAPPA_ENABLED=true\`. If its tools are unavailable, report that fact. Do not change process environment settings through this skill; policy \`[policy.deployment]\` may be edited through preview and approval.
- A refused policy blocks enabling Guardrails v2. If it is already on, every proxied request fails closed without retry until the policy is fixed. Report the error. Do not claim Guardrails v2 switched off or that the draft is active.
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

[policy.deployment]
context_control = true
\`\`\`

This version identifies the policy format. The API revision is a separate save number that prevents overwriting concurrent edits. Preview the complete draft with that revision before showing the diff and publishing it. With GitHub sync, publishing creates a PR. The policy takes effect after merge and successful sync. Without GitHub sync, publishing saves a local revision.

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

A battery is declared in this same document. \`include\` names it - either \`batteries/<name>/appa.toml\` for a bundled battery or \`batteries/<name>@sha256-<hash>/appa.toml\` for an uploaded package - \`[server_aliases]\` points the namespace at server tool prefixes, and \`[credentials]\` binds runtime credential keys:

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
      // white-label-ok: applyBuiltInSkillBranding rebrands bundled references at reconcile
      content: `# OpenAPPA policy configuration and contracts reference

An OpenAPPA policy defines restrictions on tool results and requirements for tool calls.
It also defines approvals and data transforms when a call is blocked.

## Policy format and storage

Archestra shows the policy read-only on the OpenAPPA Policy page. The document follows the \`organization.appa.toml\` format. With GitHub sync, the repository owns the source text. A proposed edit opens a PR, and Archestra enforces it only after merge and successful sync. Without sync, Archestra saves a local revision in the database.

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
- Native client built-ins: \`host/claude-code/<name>\` or \`host/archestra/<name>\`. Claude Code's \`Task\` and \`Agent\`, OpenCode's lowercase \`host/archestra/task\`, and Codex's \`spawn_agent\` have different spellings. Match the runtime's exact case.
- Search without catch-all: declare \`archestra__search_tools\` with \`delta = {}\`.
- Command tools such as \`bash\`, \`shell\`, \`exec_command\`, and \`run_command\` can use \`command\` or \`cmd\` arguments. The proxy normalizes these variants. Check the evaluated tool name when writing an argument-specific rule.

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

### Subagent returns

Claude Code, Codex, and OpenCode can protect native CLI subagent returns through the Archestra proxy. A child inherits its parent's restrictions, but its tool-call rules do not by themselves protect the answer it sends back. The parent must choose a return contract before spawning the child. The proxy withholds the child's final answer, including a tool-free answer, until OpenAPPA admits it. An available output sanitizer can replace it with an approved summary. The parent receives only a verified return. If verification fails, the return stays blocked.

The root policy can declare that the integration controls child context and returns:

\`\`\`toml
[policy]
version = 2

[policy.deployment]
context_control = true
\`\`\`

This setting alone does not create a return contract, an output sanitizer, or a secure client. Before proposing return protection, check the exact client and the actual policy. Confirm that the parent can choose a return contract before spawn and that the proxy can deliver it to the child before inference. If the proxy refuses a session because it cannot deliver that contract, report the limitation. Never claim the child is protected. Confirm the deployment can issue signed lineage and return receipts without reading or exposing signing secrets. If you cannot verify these conditions, report them as unavailable.

This protection is for native CLI subagents. Loading a skill runs in the current session, not a child. OpenAPPA-protected Archestra Chat does not support subagent delegation. The trusted client and executor must isolate raw child transcripts and control artifacts from model tools. Proxy checks for known transcript paths are defense in depth, not a shell or filesystem sandbox. Do not propose live reads of private transcripts to test the boundary.

### Provider-hosted tools

Known provider-hosted declarations, including Claude's advisor, run inside the model provider. OpenAPPA accepts them, but cannot check each call before it executes. Unknown tool types and client-run types without a call gate are refused instead of assumed hosted. OpenAI Responses web search is different: its result can be withheld and ruled on before the client receives it. Azure Responses hosted web search is refused because its result cannot be withheld. Other hosted calls and results are not governed through a native client tool rule. Deferred \`tool_search\` declarations, including versioned Anthropic types and \`defer_loading\` tools, are still refused because their client-callable tools are not on the wire.

There is no supported policy switch that refuses all provider-hosted declarations with a signed offer to call a client-side counterpart. A hosted declaration arrives before the provider chooses a call or its arguments, so a policy tool rule cannot provide that substitute. If the operator requires this boundary, identify the client and provider tools and report it as unsupported. Do not add a rule that falsely claims to protect provider-side execution.

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
