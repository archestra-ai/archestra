/**
 * `references/archestra.md` of the built-in appa-guide skill: what an OpenAPPA
 * policy looks like in Archestra. OpenAPPA's own semantics live in the
 * `references/contracts/` parts; this file holds only what Archestra adds.
 */
// white-label-ok: applyBuiltInSkillBranding rebrands bundled references at reconcile
export const ARCHESTRA_REFERENCE = `# OpenAPPA in Archestra

\`references/contracts.md\` defines what every policy field means. This file covers what Archestra adds: where the policy lives, the tool names it evaluates, its default rules, and what it cannot enforce.

## The policy document

Archestra stores one root policy per organization, \`organization.appa.toml\`. With GitHub sync the repository owns the text: publishing opens a pull request, and Archestra enforces it only after merge and a successful sync. Without sync, publishing saves a local revision in the database.

The document's \`[policy] version = 2\` names the format. The API \`revision\` is a separate save number that prevents overwriting concurrent edits. Change a saved policy with \`edits\` that name only the text you replace; send the complete text only for a first policy or a full rewrite. Merge rules into the existing document and never add a second \`[policy]\` header.

The supported format is \`[policy]\`, \`[policy.deployment]\`, \`[externals]\`, and battery declarations.

## Tool names

A rule can use the name a client sends or the canonical ID \`<family>/<namespace>/<tool>\`. Names are case-sensitive; match the name Archestra evaluates, not another client's spelling.

- MCP tools: \`<catalog>__<tool>\`, canonical \`mcp/<catalog>/<tool>\`. Archestra splits a name at its last \`__\`; when the catalog or tool name contains another \`__\`, the name is evaluated as \`host/archestra/<full name>\` instead. Write rules with the exact name from the inventory rather than a derived canonical ID.
- Platform tools: \`archestra__<name>\`, canonical \`mcp/archestra/<name>\`. \`archestra__execute_remedy_plan\` is \`appa/execute_remedy_plan\`.
- A name without \`__\` is a native client tool, canonical \`host/archestra/<name>\`. Native tools never appear in an MCP inventory. Claude Code sends \`Bash\`, \`Read\`, \`Write\`, \`Edit\`, \`Grep\`, \`Task\`, and \`Agent\`; OpenCode's spawn tool is lowercase \`task\`; Codex sends \`exec_command\` and \`spawn_agent\`. OpenAPPA's own Claude Code install names them \`host/claude-code/<Name>\`; Archestra does not, so such a rule matches nothing here.
- \`archestra__run_command\` runs a command in the Archestra chat sandbox. It is not a client's shell: a rule on it does not govern Claude Code's \`Bash\`, and the reverse.
- Command tools such as \`Bash\`, \`shell\`, \`exec_command\`, and \`run_command\` may send the command as \`command\` or \`cmd\`; the proxy aliases the two, so a selector on \`command\` matches either.
- \`archestra__run_tool\` needs no rule: a call is evaluated as the target tool it runs.

## Default rules

The starting policy routes unlisted tools to a catch-all annotator that adds no restrictions:

\`\`\`toml
[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "*"
annotator = "noop"
\`\`\`

Keep the existing \`[externals.annotators.noop]\` URL. It also declares the \`archestra.run-command\` annotator (\`builtin = "archestra"\`) and routes \`archestra__run_command\` to it, so the organization's default model ranks each sandbox command \`suspicious\` or \`trusted\`. Explicit rules take precedence over the catch-all, and the first matching rule for a tool applies, so put a narrow rule with an argument selector before the broad rule for the same tool.

A rule declares either \`annotator\` or static fields such as \`requires\`, never both. To block \`archestra__run_command\` outright, replace its annotator rule with \`delta = {}\` and \`requires = { attention = ["blocked"] }\`; to block only some commands, put a selector rule with \`requires\` before the annotated rule.

Without the catch-all, declare \`archestra__search_tools\`, \`archestra__load_skill\`, \`mcp/appa/yell\`, and the policy tools with \`delta = {}\` so agents can still find tools, load skills, and change the policy.

## Batteries

A battery is declared in the root policy. \`include\` names it, either \`batteries/<name>/appa.toml\` for a bundled battery or \`batteries/<name>@sha256-<hash>/appa.toml\` for an uploaded package. \`[server_aliases]\` points each battery namespace at an installed server's tool prefixes:

\`\`\`toml
include = ["batteries/github/appa.toml"]

[server_aliases]
github = ["github_prod"]
\`\`\`

Each credential variable a battery reads is bound to a runtime credential key with \`archestra__bind_guardrails_credential\`, for example \`{ "variable": "APPA_PROVIDER_GITHUB_TOKEN", "key": "github-token" }\`. The binding lives outside the policy text and never holds the value, only the key. A \`[credentials]\` line in the text overrides the binding and locks it in the Batteries dialog; do not add one.

A battery governs calls only when \`effective.batteries\` marks it \`active\`. Removing its \`include\` entry turns it off.

## Approvals and remedies

The default \`hitl\` authority covers only \`human-approval\`. Require that mark for potentially destructive actions or publishing/sharing outside the company; do not add it to every tool call.

An approval needs an authority whose permits cover the requirement, and a review channel. Do not invent an authority. When a ruling offers a remedy, call \`archestra__execute_remedy_plan\` with the exact \`offer_id\`; it requests the review itself when the policy requires one, or returns the review to ask with \`archestra__ask_user\`.

## Subagent returns

Claude Code, Codex, and OpenCode can protect native CLI subagent returns through the Archestra proxy. A child inherits its parent's restrictions, but its tool-call rules do not by themselves protect the answer it sends back. The parent must choose a return contract before spawning the child. The proxy withholds the child's final answer, including a tool-free answer, until OpenAPPA admits it. An available output sanitizer can replace it with an approved summary. If verification fails, the return stays blocked.

\`[policy.deployment] context_control = true\` declares that the integration controls child context and returns. It alone does not create a return contract, an output sanitizer, or a secure client. Before proposing return protection, check the exact client and the actual policy. Confirm that the parent can choose a return contract before spawn and that the proxy can deliver it to the child before inference. If the proxy refuses a session because it cannot deliver that contract, report the limitation. Confirm the deployment can issue signed lineage and verify returns against the durable child crossing without reading or exposing signing secrets. If you cannot verify these conditions, report them as unavailable.

This protection is for native CLI subagents. Loading a skill runs in the current session, not a child. OpenAPPA-protected Archestra Chat does not support subagent delegation. The trusted client and executor must isolate raw child transcripts and control artifacts from model tools. Proxy checks for known transcript paths are defense in depth, not a shell or filesystem sandbox. Do not propose live reads of private transcripts to test the boundary.

## Provider-hosted tools

Known provider-hosted declarations, including Claude's advisor, run inside the model provider. OpenAPPA accepts them but cannot check each call before it executes. Unknown tool types and client-run types without a call gate are refused instead of assumed hosted. OpenAI Responses web search is different: its result can be withheld and ruled on before the client receives it. Azure Responses hosted web search is refused because its result cannot be withheld. Deferred \`tool_search\` declarations, including versioned Anthropic types and \`defer_loading\` tools, are refused because their client-callable tools are not on the wire.

No policy setting refuses all provider-hosted declarations with a signed offer to call a client-side counterpart. A hosted declaration arrives before the provider chooses a call or its arguments, so a tool rule cannot provide that substitute. If the operator requires this boundary, identify the client and provider tools and report it as unsupported. Do not add a rule that claims to protect provider-side execution.

## Reading a trajectory

A yell's archive is a gzipped JSON file attached to the chat as \`openappa-yell-<id>.json.gz\`. The copy shown inline is cut short and usually ends before the trajectory, so read the file. The archive holds no prompts, tool arguments, or tool outputs. It shows which calls happened, in what order, and how the policy ruled.

1. Find the file: run \`ls /home/sandbox/attachments/\` with \`archestra__run_command\`. If the archive is missing, copy it in with \`archestra__upload_file\`, using source \`{"type":"chat_attachment","filename":"openappa-yell-<id>.json.gz"}\`.
2. Never print the whole file. Most of it is the policy, under \`runtime\`. Query the part you need with jq, where FILE is the path from step 1:
   - Layout: \`gunzip -c FILE | jq '.trajectory | keys'\`
   - Every fact in order, with its kind and tool: \`gunzip -c FILE | jq -r '.trajectory.facts[] | .seq as $s | .fact | to_entries[0] | "\\($s) \\(.key) \\(.value.tool? // "")"'\`
   - One fact in full: \`gunzip -c FILE | jq '.trajectory.facts[] | select(.seq == 42)'\`
3. The parts of \`trajectory\`:
   - \`branches\` lists the trajectories in the report. The one with \`yelling: true\` raised the yell.
   - \`trust_chain\` lists the trust ranks, lowest first.
   - \`facts\` is the policy engine's log, ordered by \`seq\`. Each fact has one key, which is its kind. DispatchOpened starts a tool call and names the tool. DispatchSucceeded and DispatchClosed end it. Ruling and Denial are policy decisions.
   - \`runtime_events\` lists runtime events, ordered by \`seq\`, with the time in \`at\`.
4. Check what is missing before you conclude. \`truncated_before_seq\` means older facts were left out. \`omitted_reason\` means the report has no trajectory. A tool that appears in no fact and no runtime event was not attempted in the recorded range.
5. A name can appear as a token such as \`tool-3\`. A token stands for the same thing everywhere in one report and means nothing in another report.
6. Without \`archestra__run_command\`, say that you cannot open the archive. Ask the operator to download it from the Yells tab and paste the facts to check. Do not guess what the trajectory holds.
`;
