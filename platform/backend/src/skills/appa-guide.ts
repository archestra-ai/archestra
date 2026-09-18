import type { BuiltInSkill } from "./built-in-skills";

export const APPA_GUIDE_SKILL: BuiltInSkill = {
  builtInSkillId: "appa-guide",
  name: "appa-guide",
  description:
    "Configure Guardrails v2 (OpenAPPA): explain the current policy, review available tools, and change how tool calls and results are handled using the policy read, validate, and update tools.",
  feature: "appa",
  content: `# APPA Guide

Use this skill to explain or change the organization policy. It works
through platform tools, including when those tools are connected to Claude Code.
The policy is shared with the OpenAPPA editor in Studio and stored in the database.
A local organization.appa.toml file, Claude Code settings, or a shell command does
not change it.

## Read and explain

Call \`archestra__get_guardrails_policy\` with no arguments. Read the returned
\`content\` and \`revision\`. If the user only asked to inspect or explain,
summarize what can run, what data becomes restricted, and what is blocked.
Do not save or propose unrelated changes.

## Inspect installed MCP servers

For initial setup or a review of installed MCPs, call
\`archestra__list_mcp_server_deployments\` with no arguments. For each distinct
Catalog ID returned, call \`archestra__get_mcp_server_tools\` with
\`{ "mcpServerId": "<Catalog ID>" }\`. Use the Catalog ID, not the deployment ID.
For a change scoped to one server, inspect that server's tools.

Read the exact tool names, descriptions, and input schemas. Summarize which
tools read external content, change data, or send data elsewhere, and compare
them with the current policy. These are inferences from metadata: identify
uncertain behavior instead of inventing trust labels or audiences. Explain
which tools currently fall through to the catch-all before proposing rules.

Use \`archestra__search_tools\` for targeted discovery of tools available to the
calling agent. Its results may be limited by assignments and permissions; they
are not a complete inventory of installed servers. Missing discovery results,
missing Catalog IDs, and permission errors mean incomplete coverage. Say which
servers or tools could not be inspected.

This inspection reads stored tool metadata. It does not test live
server health or prove a tool's behavior. Do not execute tools or read private
content merely to classify them. Loading this skill does not run an automatic
scan or save policy rules; follow these steps when handling the user's request.

## Change a policy

1. Read the latest policy before editing. For initial setup, build on it rather
   than replacing it. Preserve unrelated rules, comments, and external bindings.
2. Load \`references/policy-writing.md\` with \`archestra__load_skill\` before
   writing TOML. Use the actual names returned by the platform; do not translate
   them to Claude Code's host tool names or invent connector names.
3. Explain the intended behavior in plain English. Make only the change the
   user authorized. If the requested outcome is unclear, ask one focused
   question. An inspection request does not authorize a save. Existing approval
   for a specific change carries forward; do not ask for it again.
4. Call \`archestra__validate_guardrails_policy\` with
   \`{ "content": "<complete proposed TOML>" }\`. Fix reported errors and
   validate again. Validation checks the policy, not the availability or
   correctness of external annotation services.
5. If the text already provides the requested behavior, report that no change
   is needed. Otherwise call \`archestra__update_guardrails_policy\` with
   \`{ "content": "<complete validated TOML>", "expectedRevision": N }\`,
   where N is the revision returned by the read tool.
6. If the save reports a conflict, someone saved a newer copy. Read it again,
   combine your intended change with those edits, and validate before retrying.
   Never just increase N and resend the old text. If the edits conflict in
   meaning, ask the user which behavior they want.
7. Read back the saved policy. Briefly report the change and its save number.
   Saved policies apply to new conversations. This conversation keeps its
   original policy; a successful save does not prove the new behavior here.

## Boundaries

- Reading requires permission to view policies. Validating and saving require
  permission to edit them. Loading this skill grants no extra permissions or
  tool assignments. On a permission error, explain what is missing; do not use
  a shell, direct database access, or another identity to bypass it.
- The default has no rules for specific tools. Its catch-all annotator returns
  empty delta and requirements, so unlisted tools have no additional APPA
  restrictions. It neither classifies their data nor raises existing trust.
- Explicit rules still apply. Keep the catch-all unless the user wants unknown
  tools blocked. Do not quietly weaken a rule to make a blocked call succeed.
- The supported editor format is \`[policy]\` plus \`[externals]\`.
  Local commands and file includes are rejected. Batteries are installed per
  MCP server outside the policy text and compose into it automatically. Do not
  copy Claude Code's subprocess annotators, battery includes, CLI reload steps,
  or local hooks.
- Keep secrets out of policy text. Existing remote bindings may refer to a
  backend environment variable with \`token_env\`; never invent a credential.
- APPA is available only when \`ARCHESTRA_OPENAPPA_ENABLED=true\`.
  If its tools are unavailable, report that rather than pretending
  the policy changed. Do not change deployment settings through this skill.
`,
  files: [
    {
      path: "references/policy-writing.md",
      kind: "reference",
      content: `# Writing OpenAPPA policies

The document starts with:

\`\`\`toml
[policy]
version = 2
\`\`\`

This version identifies the policy format. The API's revision is a separate
save number used to prevent overwriting another edit.

## Tool rules

A static rule names a tool and states its result delta and call requirements.
These examples use fictional names: replace them with exact discovered names.
Merge rules into the existing document; do not copy a second [policy] header.

A read whose output should make the session suspicious:

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

An empty delta preserves the current labels. It does not mean that the output
is verified or that a suspicious session becomes trusted. A trust-lowering
read may require accepting APPA's proposed session change before it runs.

Trust describes whether the session can safely drive a tool. Audience describes
who may receive its information. Preserve declared audience names and resolvers;
do not assume that a team name is already a policy audience. Prefer these data
boundaries to blanket approval requirements when they express the user's goal.

## Catch-all and annotators

The default uses this fallback and an existing local binding:

\`\`\`toml
[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "*"
annotator = "noop"
\`\`\`

Preserve the existing [externals.annotators.noop] URL; its port belongs to this
deployment. The handler returns empty delta, empty requirements, and no effects.
It does not call a model. A named tool rule takes precedence regardless of where
the catch-all appears. Multiple rules for the same tool are matched in order;
put narrower argument-specific rules before a broad rule for that name.

An annotator can classify each call instead of using a static delta. It needs a
policy declaration and a working implementation. The default noop adds no
restrictions; it is not a security classifier. Do not promise automatic
classification merely because a tool uses the wildcard.

For an existing remote annotator, the shape is:

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

The URL is illustrative, not an installed service. Use only an implementation
the operator has configured. Validate the complete document before saving.
Do not combine a tool's static delta with an annotator on the same declaration.

## Approvals and unsupported behavior

An approval requires an authority with the appropriate permission and a working
review channel. Do not invent one or replace a denied operation with noop.
When APPA provides a remedy offer, use only the exact offer_id from that
response with the available remedy tool and the user's authorization.

This guide does not configure subprocesses, battery installs, or deployment
changes. If the existing bindings cannot express the requested behavior,
explain what support is missing rather than silently allowing it.
`,
    },
  ],
};
