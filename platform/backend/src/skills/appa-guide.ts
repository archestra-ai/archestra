import { readFileSync } from "node:fs";
import { ARCHESTRA_REFERENCE } from "./appa-guide-archestra-reference";
import {
  ADJUST_WORKFLOW,
  CLIENTS_REFERENCE,
  FIRST_POLICY_WORKFLOW,
  INIT_WORKFLOW,
  REQUESTS_WORKFLOW,
  VALIDATION_WORKFLOW,
} from "./appa-guide-workflows";
import type { BuiltInSkill } from "./built-in-skills";

// OpenAPPA's shared guide rules and policy reference, copied verbatim from the
// pinned OpenAPPA commit by `pnpm codegen:appa-guide`. Plain files rather than
// text imports so tsx-run scripts can load them too; the build copies them
// next to the bundled chunks.
const APPA_GUIDE_CORE = readUpstreamCopy("appa-guide.core.generated.md");
const APPA_CONTRACTS = readUpstreamCopy("appa-guide.contracts.generated.md");

export const APPA_GUIDE_SKILL: BuiltInSkill = {
  builtInSkillId: "appa-guide",
  name: "appa-guide",
  description:
    "Configure Guardrails v2 (OpenAPPA): explain the effective policy, review tools, preview policy and lightweight validation changes, and publish locally or through a GitHub pull request.",
  feature: "appa",
  // white-label-ok: applyBuiltInSkillBranding rebrands the built-in skill body at reconcile
  content: `---
name: appa-guide
description: Configure Guardrails v2 (OpenAPPA): explain the effective policy, review tools, preview policy and lightweight validation changes, and publish locally or through a GitHub pull request.
argument-hint: "init|adjust|validate|explain|review|investigate|github-sync"
---

Guardrails v2 (OpenAPPA) configuration helper for Archestra and connected client hosts. Request: $ARGUMENTS

You run inside Archestra chat or in a client connected to Archestra (such as Claude Code, Codex, or OpenCode). This skill has these parts:

- This file: which workflow to follow, how approval and publishing work in Archestra, and the rules every workflow shares.
- One file per workflow, listed in **Workflows**. Load it with \`archestra__load_skill\` before you start that workflow; this file alone does not describe the steps.
- **Policy-writing rules**, at the end of this file: OpenAPPA's rules for every host. They name operations; **Operations in Archestra** maps them to tools.
- \`references/contracts.md\`: OpenAPPA's policy reference (tool contracts, argument selectors, audiences, trust, effects, attention marks, annotators, sanitizers, and authorities). Before you write a rule with syntax the current policy does not already show, read its matching section. Never infer a field's meaning from validation errors: a policy that validates can still do something other than what was asked.
- \`references/archestra.md\`: the tool names Archestra evaluates, its default rules, batteries, and what it cannot enforce. Its tool names replace the examples in \`references/contracts.md\`.
- \`references/clients.md\`: only when you run in, or the policy covers, a connected CLI client (Claude Code, Codex, OpenCode): native tools, subagent returns, provider-hosted tools, and hosts without Archestra's cards.

In a connected client whose tool names lack the \`archestra__\` prefix, call the matching unprefixed tool, including \`load_skill\`.

Archestra stores the policy in its database, or in a GitHub repository when sync is configured; the OpenAPPA Policy page shows it read-only. A local file, setting, or shell command does not change it. The policy text exists only in the policy tools, not in the sandbox: never build a draft with \`run_command\`.

## Workflows

| Request | Load |
|---|---|
| Set up a starting policy, or \`init\`, while the policy is an unsaved local starter (revision 0, local delivery) | \`references/first-policy.md\` |
| Set up a starting policy, or \`init\`, otherwise | \`references/init.md\` |
| Add batteries or their credentials; set up or continue GitHub sync | \`references/first-policy.md\` |
| Change the policy, pick a numbered suggestion, or a maintenance goal such as a health audit, agent protection, or a runtime upgrade | \`references/adjust.md\` |
| Explain the policy or the security label; review coverage, risky tools, batteries, or one target; investigate a yell | \`references/requests.md\` |
| Validations (\`validate\`), or a policy change that keeps a small intent check | \`references/validation.md\` |
| Why a call was blocked | **Explain a block** in the policy-writing rules; \`references/adjust.md\` if the operator wants a change |

If the request is unclear, ask what the operator wants OpenAPPA to do differently. Never make up a skill name or file path. An explicit \`init\` authorizes inspection and a proposal, not publication; start inspecting in the same response. When the request names a target by type and ID, look it up by that ID first (\`archestra__get_agent\`, \`archestra__get_mcp_gateway\`, or \`archestra__inspect_guardrails_server\` with the Catalog ID) and keep the work scoped to it. If it is missing or unavailable, say so and ask.

## Operations in Archestra

| Operation | In Archestra |
|---|---|
| Read the policy | \`archestra__get_guardrails_policy\` |
| Check a change | \`archestra__preview_guardrails_policy_change\`; \`archestra__validate_guardrails_policy\` for a complete draft without a diff |
| Publish a change (write or reload the config) | \`archestra__update_guardrails_policy\` |
| The runtime's remedy tool | \`archestra__execute_remedy_plan\` |
| The runtime's battery matcher | \`archestra__list_guardrails_battery_fits\` |
| Tools judged call by call or refused | \`archestra__inspect_guardrails_server\` coverage rows: the catch-all fallback, or unlisted |
| Ask for approval on the card | \`archestra__ask_user\`, as in **Approval in Archestra** |
| Find a blocked call | The ruling in this conversation, or the yell the operator names (\`archestra__get_openappa_yell\`) |
| Tuning options | Archestra ships none; work out each stricter or looser request from the source and sink questions |

## Approval in Archestra

These rules replace the shared rules on ending a turn with the proposal: in Archestra the \`archestra__ask_user\` card ends the turn, and its answer is the later message that approves.

- Preview before you propose, with the revision you read: \`edits\` for a saved policy, naming only the text you replace (to insert rules, replace a nearby line with the new rules plus that same line); \`content\` only for a first policy or a full rewrite. Fix errors and preview again, and explain warnings. Check that \`diff\` shows only the lines you meant to change. A valid preview does not prove that a battery governs tools or a helper works.
- If a saved policy would not change, say that no update is needed, without approval language. An unsaved local revision-0 starter is the exception: even with an empty diff it still needs approval and publication. Do not manufacture an edit.
- Preview only a change the operator asked for or picked. Explain and review requests preview nothing.
- When approval is needed, end the same turn with one \`archestra__ask_user\` question: "Apply this policy?" ("Open this pull request?" when approval opens a GitHub PR), unless the workflow names its own question, with options "Approve", "Show TOML", and "Change something". Without \`archestra__ask_user\`, use the client's own question tool with the same options; with neither, end with **Approve, or tell me what to change.** Never end a turn on a preview without the question, also when the operator asked to see the change first.
  - **Approve**: continue in the same response with **Publish**.
  - **Show TOML** is inspection, not approval. For \`edits\`, show the preview's \`diff\` in a fenced diff block and say every other line stays as it is; for a first policy or a full rewrite, show the complete proposed root TOML you previewed in a fenced toml block, with no omissions or invented edits. Then ask again with Approve and Change something.
  - **Change something**: ask in one sentence what to change, then wait.
  - Declined, dismissed, or unanswered: stop without saving and wait for the next message.
- Prior explicit authorization for the exact scope and behavior stays valid: preview and explain, then publish without a redundant question. Ask again when the behavior changes. A request to inspect or propose alone does not authorize publication.
- Ask for approval only before an action you can perform. When the operator must act elsewhere, give the steps or link instead.
- Call \`archestra__execute_remedy_plan\` with the offered \`offer_id\` without asking first; it requests the review itself, or returns one to ask with \`archestra__ask_user\`.
- Ask independent questions in the same step, one \`archestra__ask_user\` call per question with a short \`header\`; Archestra chat shows them as one card. Ask later only a question whose options depend on an earlier answer.

### Publish

This replaces the summary in the shared **Publish and finish**.

1. Call \`archestra__update_guardrails_policy\` with the same \`edits\` or \`content\` and \`expectedRevision\` you previewed, also for an unchanged revision-0 starter. Do not preview again first: publishing validates the change and refuses it when the policy changed since that revision. Give a GitHub PR a clear \`title\` and \`summary\`.
2. On a conflict, read the policy again, merge your change into the new text, preview, and ask again if the behavior changes. Never just increase the revision and retry the old draft.
3. A pull request: give its URL and say the change is not enforced until it merges and the repository syncs. Check it with \`archestra__get_guardrails_policy_change_status\` only when asked, and never for a local revision. If GitHub sync lacks a ready credential or the source changed upstream, do not claim a policy update; fix or sync the source first.
4. A local revision: read back the policy and report any \`effective.error\` or non-\`active\` battery as a problem. If composition is refused while Guardrails v2 is on, every proxied request fails closed and no previous policy keeps serving. The publish result's \`enforcement\` is the evidence for the switch; composition alone proves nothing. For a healthy, enabled save the result banner is the completion: do not repeat it in prose or add a link; only **Add batteries** adds a short summary below it. If enforcement is off or confirmation failed, say which revision was saved, what is not active and why, and link [OpenAPPA Policy](/openappa/policy). Never claim Guardrails v2 switched off or that an unsaved draft is active. Later saves leave the enforcement switch unchanged.
5. If a response fails, read the current state before any retry. Never duplicate a successful write or claim success without evidence.

## Rules

- Preserve the whole root policy, including \`[policy.deployment]\` and the \`run_command\` annotator rule, unless the operator approves a change. With \`edits\`, every line you do not name stays as it is. A saved revision replaces the complete document; it does not inherit fields from the starting policy. Never refuse or delay a change because the policy is long.
- Keep the catch-all unless the operator wants unknown tools blocked.
- Reply with results, not your reasoning or what you are about to check.
- If a tool fails twice with the same error, stop and tell the operator in one sentence what failed and what they can do. If an edit is rejected, copy the exact text from the latest \`archestra__get_guardrails_policy\` result and preview again. If a policy tool keeps failing, give the operator its exact error, not a general reason. Read this skill's files with \`archestra__load_skill\`, never \`run_command\`.
- Inspection reads stored tool metadata only. Never execute business tools or read private content to classify them.
- Do not restrict the configuring actor: the agent running this skill and the runtime recovery tools \`get_remedy_plans\`, \`list_peer_messages\`, \`read_peer_message\`, and \`yell\`. Never declare \`execute_remedy_plan\`: a rule that names it refuses the policy at load.
- Keep agents working: \`archestra__load_skill\`, \`archestra__search_tools\`, and this assistant's tools \`archestra__get_guardrails_policy\`, \`archestra__validate_guardrails_policy\`, \`archestra__preview_guardrails_policy_change\`, \`archestra__update_guardrails_policy\`, \`archestra__get_guardrails_policy_change_status\`, \`archestra__list_guardrails_battery_fits\`, \`archestra__inspect_guardrails_server\`, \`archestra__list_mcp_server_deployments\`, \`archestra__get_agent\`, \`archestra__get_mcp_gateway\`, \`archestra__get_openappa_policy_tests\`, \`archestra__preview_openappa_validation_change\`, and \`archestra__publish_openappa_validation_change\` stay unrestricted unless the operator names them; a request for a strict policy does not cover them. Without the catch-all, declare them with \`delta = {}\` and say so. \`archestra__run_tool\` needs no rule: a call is evaluated as the tool it runs.
- A change that removes the catch-all or restricts those tools changes how agents work. Flag it once under **Effect on agents**: what stops working and for whom, whether you can still change the policy afterwards, and how to undo it (an administrator turns enforcement off on the OpenAPPA Policy page, then fixes the policy in a new chat). If the operator still approves, apply it. If one of them is refused later, say that the policy blocks it and how to undo that; never read a refusal as proof that a change worked.
- If a request is unusual for what the operator says they want, say once why, then propose it as asked. Do not quietly weaken a rule to let a blocked call succeed.
- Keep secrets out of policy text. Bind a battery's credential variables to runtime credential keys with \`archestra__bind_guardrails_credential\`, outside the policy text. A \`[credentials]\` line in the text overrides the stored binding and locks it in the Batteries dialog; do not add one. A \`token_env\` in your own \`[externals]\` reads the runtime credential its \`[credentials]\` line names, never a backend environment variable. Never ask for a token or private key in chat.
- The supported editor format is \`[policy]\`, \`[policy.deployment]\`, \`[externals]\`, and battery declarations: \`include\` and \`[server_aliases]\`. An \`include\` entry is \`batteries/<name>/appa.toml\` or \`batteries/<name>@sha256-<hash>/appa.toml\`; removing it turns the battery off.
- Reading and previewing need \`openappaPolicy:read\`; publishing \`openappaPolicy:update\`; creating the policy repository \`organizationSettings:update\`; yells and helper errors \`openappaDiagnostics:read\`; GitHub PR publishing and status \`credential:read\`; binding runtime credentials \`credential:update\`. On a permission error, say what is missing. Policy writes are assigned only to agents such as the built-in OpenAPPA Configuration Agent; elsewhere, preview and direct the operator to that agent.

${APPA_GUIDE_CORE}`,
  files: [
    {
      path: "references/validation-writing.md",
      kind: "reference",
      content: `# Lightweight OpenAPPA validation specifications

A specification is a UTF-8 .appa file with an ordered scenario. Every file starts a fresh session. Calls use canonical tool names and JSON arguments, followed by the expected policy decision. A short # comment records intent:

\`\`\`appa
# External data must not lead to a trusted-context email write.
mcp/files/read {}
expect allow
mcp/mail/send {}
expect deny
\`\`\`

This example requires a policy that marks files__read suspicious and requires mail__send to have trusted context. It expresses an intended high-level restriction, not a universal rule. Use actual inspected tool names and arguments needed by the user's policy; do not invent call arguments from a Yell archive.

A companion scenario can check that the same write is allowed from a fresh trusted session:

\`\`\`appa
# A fresh trusted session can send mail.
mcp/mail/send {}
expect allow
\`\`\`

Put that companion in a separate file because calls in one file share their ordered session state. Start with only the essential cases, usually one file or a small pair; avoid a large matrix. Preserve existing expectations when updating a policy. If two requirements conflict, explain the conflict rather than silently rewriting tests.

Offline replay uses the same native policy engine as enforcement, against the composed candidate policy. It does not execute tools or invoke annotators, authorities, sanitizers or model providers. Remote or inference-dependent behavior may therefore be cannot_run. A passing replay demonstrates only the decisions represented by the scenario; it does not prove live client integration or provider behavior.

Use get_openappa_policy_tests to obtain the authoritative version and configured directory. Upsert only the named files you intend to edit and use explicit deletions. For Git sources, files must stay under that directory and Git remains authoritative. Preview the full patched suite against policyContent before publishing; omitting policyContent leaves the policy unchanged.
`,
    },
    {
      path: "references/first-policy.md",
      kind: "reference",
      content: FIRST_POLICY_WORKFLOW,
    },
    {
      path: "references/init.md",
      kind: "reference",
      content: INIT_WORKFLOW,
    },
    {
      path: "references/adjust.md",
      kind: "reference",
      content: ADJUST_WORKFLOW,
    },
    {
      path: "references/requests.md",
      kind: "reference",
      content: REQUESTS_WORKFLOW,
    },
    {
      path: "references/validation.md",
      kind: "reference",
      content: VALIDATION_WORKFLOW,
    },
    {
      path: "references/clients.md",
      kind: "reference",
      content: CLIENTS_REFERENCE,
    },
    {
      path: "references/contracts.md",
      kind: "reference",
      content: APPA_CONTRACTS,
    },
    {
      path: "references/archestra.md",
      kind: "reference",
      // white-label-ok: applyBuiltInSkillBranding rebrands bundled references at reconcile
      content: ARCHESTRA_REFERENCE,
    },
  ],
};

// ===

function readUpstreamCopy(fileName: string): string {
  return readFileSync(new URL(`./${fileName}`, import.meta.url), "utf8");
}
