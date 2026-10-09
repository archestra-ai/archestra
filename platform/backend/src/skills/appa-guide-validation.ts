/** Validation guidance, bundled as separately loaded appa-guide references. */

/** `references/validation.md`: Guided validation conversations and the write, replay and publish steps. */
// white-label-ok: applyBuiltInSkillBranding rebrands bundled references at reconcile
export const VALIDATION_WORKFLOW = `# Validations

A validation is a small \`.appa\` scenario that checks expected policy decisions across one or more ordered calls. Automatic discovery currently offers single-call examples. \`references/validation-writing.md\` has the syntax.

- First setup and explicit policy-only work need no validations. Do not create checks just to increase coverage.
- For validation-only work, this workflow owns review and saving; the shared policy-proposal approval steps do not apply.
- Validation-only work leaves the policy unchanged. Include a policy change only when explicitly requested. Never delete a failing check or change its expectation to force a pass; if new intent contradicts an existing check, ask one focused question.
- An ordinary, concrete behavior change normally keeps one clearly named file with one to three assertions. Do not build a test matrix or duplicate existing checks. Respect a request to skip validations.

## Choose the requested operation

For an explicit request to run already-saved checks or record fresh results, call \`archestra__run_openappa_policy_tests\` directly and report its recorded results. This needs no discovery, drafting, or saving step.

A request to explain or review existing checks is inspection only: read the relevant files and policy, then answer without drafting, previewing, or publishing changes. If a needed file is unavailable, report the gap; explain any supplied material within that limit.

A concrete requirement identifies an action and desired decision, plus starting conditions when relevant. A broad goal alone needs narrowing into a behavior the operator wants to check.

For an exploratory request without a concrete requirement, use **Discover before recommending an unspecified check** below directly. Discovery supplies policy and suite readiness; separate raw policy, suite, or tool reads are unnecessary before presenting its choices.

A concrete requirement, supplied candidate policy, or desired outcome different from discovery goes directly to drafting and preview. Read the current policy first, reusing reads from this turn. Once the policy prerequisite below is satisfied, load \`references/validation-writing.md\` alongside the suite read. Expectations come from the operator's requirement even if the policy fails it; ask only if a missing detail changes what should be allowed or blocked. Respect requests not to run tests.

## Establish the policy before choosing checks

When \`revision = 0\` and \`delivery.mode = "revision"\` (local delivery), the returned content is an **unsaved starter**, not a configured policy. For a request about the current policy, report that no OpenAPPA policy has been saved, so there is no saved current policy to validate. Offer to prepare the starter for review, or clarify the action and desired outcome the operator wants to govern. A broad safety goal remains unresolved; assess the starter's coverage from its declared rules during setup. Ask which next step they want, then wait. Do not offer runnable validations, inspect tool schemas, or draft or preview scenarios at this transition. If setup is already requested, load \`references/first-policy.md\` and follow its proposal and approval steps; a validation request alone does not authorize saving or enabling a policy. Resume current-policy validations after a read confirms the policy was saved.

This prerequisite concerns a missing policy, not disabled enforcement: a saved policy can be validated offline while enforcement is off. An explicitly supplied candidate policy can also be tested before saving; use that candidate and label the result as a draft-policy check. When testing a complete supplied candidate, pass it unchanged to preview; distinguish your transcription errors from errors in the supplied policy. Do not silently substitute the unsaved starter for the operator's intended policy.

Once the policy to test is established, read the authoritative suite (\`archestra__get_openappa_policy_tests\`). Check whether replay and publication are available:

- A collection \`error\` means unavailable, not empty. If it reports a stale source or conflict and asks for a reload, refresh the policy and suite once. For other errors, or if a reload does not resolve it, report the blocker and do not preview or publish validations.
- When \`source = "github"\` and \`activeDirectory\` is empty, preview and publication are disabled. Direct the operator to set a validation directory in GitHub source settings; do not attempt validation preview or publication.
- If the operator changes the directory or disables Git sync, read both policy and suite again. Use the returned source, directory, revision, and version; never reuse the earlier \`disabled:...\` version. A local source needs no GitHub directory setup.

When replay is unavailable, still provide an already-requested text draft if the available policy and contracts support it, clearly labeled untested. Do not require a second request to draft. For an exploratory request, explain the setup needed before proposing runnable checks.

An unavailable optional regression check does not block an authorized policy proposal: return to \`references/adjust.md\` for policy-only preview and approval, explaining that the check could not run. If the operator requires policy and checks together, keep that requirement and report the blocker instead of silently dropping the checks.

## Discover before recommending an unspecified check

For exploratory requests without a concrete requirement, call \`archestra__discover_openappa_validation_scenarios\` once. It checks policy readiness and constructs a bounded set of exact calls, then verifies them with native replay. Use its returned choices instead of designing hypothetical scenarios. Each choice describes an observed decision in a fresh session, not a recommended security requirement or coverage of a whole rule. Explain choices using **Help the operator understand a check** below, then ask which behavior they want to preserve and wait. Keep the association between each human-readable choice and its candidateId; identifiers are for tool calls, not choice labels. Existing files listed for a tool are related checks, not proof that they cover this behavior.

If discovery returns setup_required or unavailable, explain the prerequisite and stop. A needs_input entry means automatic discovery cannot prepare this check. Follow its reason: a custom scenario or concrete arguments may allow normal preview. A cannot_run entry has no verified decision; drop that branch. Mention unavailable branches only when they affect the requested goal or explain why no useful choice is available, using the reported limitation in plain language. Replay makes no live helper or model requests, so its diagnostics cannot establish a live outage or health problem. An empty or limited result does not mean the policy has no other testable behaviors. Do not repeat unchanged discovery, invent prerequisites, or promise unavailable helper/model outcomes.

After the operator chooses a returned scenario and confirms the observed outcome is the desired requirement, call \`archestra__draft_openappa_validation_scenario\` with its discoveryId and candidateId. This returns the exact file and a full-suite preview. Explain the returned check and result in plain language before its technical details; keep the returned file unchanged. Selection authorizes drafting and replay, not saving. If a choice expired or its policy/suite changed, refresh choices and ask again rather than substituting a scenario. For publication, use the returned exact file, revision and version in the saving steps below.

For state-dependent requirements, a contract or deployment starting label must establish the required state. Tool names, imagined results and annotator hints do not establish it. During automatic exploration, if that prerequisite is absent, explain the gap and stop that branch; ask for the needed setup or another behavior. For an explicit concrete requirement, keep the requested assertion and replay it when possible: a missing policy restriction can be the defect the failing check exposes. Use replay to resolve a concrete uncertainty rather than repeatedly redesigning hypothetical cases.

## Help the operator understand a check

The operator should be able to choose without reading tool calls or an \`.appa\` file. Offer up to three individually verified choices. Give each a short behavior label containing its relevant starting scope, followed by at most two sentences: a concrete situation consistent with the tested inputs, the observed decision, and which unwanted change this exact check would detect. Describe a fresh session as a new conversation, including any relevant configured starting restriction. Keep scope attached to the claim itself, including in the selection question: explain the returned scenario, not the policy's broader capabilities.

Use known tool purpose to explain the action; inspect only needed metadata if unclear. Metadata explains purpose; replay establishes the decision for the tested inputs and state. A motivating situation can illustrate why the tested step matters, but additional inputs, earlier actions and successful execution remain untested. Ask the operator to choose one returned candidate. A different-goal option starts clarification of the action and desired outcome; its feasibility remains to be checked.

Explain only limits relevant to this choice. When only basic availability examples are found, say that and offer to clarify a more relevant goal. Discovery is incomplete. Lead draft review and results with the same situation: what should happen, what the test found, and what a failure would mean. Give the file path for reference and provide its exact source on request. Keep passing, failing, unavailable and untested results distinct.

## Write, replay, and publish

1. Load \`references/validation-writing.md\` for the \`.appa\` syntax before you write a scenario, if not already loaded.
2. Construct calls from \`effective.content\` using the writing reference's naming and contract rules; offline replay does not require installed tools. Inspect live metadata only when the check needs arguments beyond those contracts. Preserve existing files and reuse a scenario that covers the intent.
3. Write one focused scenario with a descriptive name and short intent comment. For Git, its path must be a direct \`.appa\` child of \`activeDirectory\`; for local files use the returned directory.
4. When the suite is available, call \`archestra__preview_openappa_validation_change\` with explicit \`upsert\` and \`delete\` changes, \`expectedRevision\`, and \`expectedVersion\`. For validation-only work, omit \`policyContent\` or pass \`null\` if the client requires the field. Never pass the current policy, an empty string, or whitespace as a placeholder. Add \`policyContent\` only for an explicitly requested policy change: derive the complete text from the current root and your exact edits, preserving every unrelated line. Preview replays the whole suite against the composed policy without saving. It executes no tools, models, or remote helpers, so \`cannot_run\` is a limitation to explain, not a pass. Correct scenario syntax errors in the \`.appa\` files only; leave \`policyContent\` omitted or null while retrying validation-only work.
5. Review changed validations as **Help the operator understand a check** describes. A preview refused before replay leaves the draft untested. For validation-only work, review the files, not a proposed policy.
6. Choosing or drafting a check does not authorize saving. Respect "do not save yet" without asking to save; otherwise ask to save or adjust when publication is not already authorized. Publish with \`archestra__publish_openappa_validation_change\` using the exact previewed patch, saving locally or opening one PR for policy and validations together. If review was requested first, wait for approval even if the operator said "create" or "go ahead" with the draft. On a revision or version conflict, read again and reconcile; ask again if the behavior changes. Explain local saving or a GitHub pull request when publication becomes relevant.
7. Report the saved version or PR URL, remaining failures, and replay limits. A PR becomes active only after merge and sync. A specification-only save leaves enforcement unchanged and does not record a suite run. When the operator asks to run saved checks or record fresh results on the validations page, call \`archestra__run_openappa_policy_tests\` after saving locally (or after merge and sync for Git). Report its run ID, outcomes and stale status; a draft or publication replay is not a recorded run. Failures do not block policy activation; the operator's CI owns merge gating.
`;

/** `references/validation-writing.md`: Scenario syntax and test intent. */
// white-label-ok: applyBuiltInSkillBranding rebrands bundled references at reconcile
export const VALIDATION_WRITING = `# Lightweight OpenAPPA validation specifications

A specification is a UTF-8 .appa file with an ordered scenario. Every file starts a fresh session, independent of this chat: public audience and the highest trust rank, unless the policy's deployment starting label overrides them. Calls in one file share state. Replay supplies empty tool results and does not execute the tools.

## Resolve names and contracts once

Scenario tool names must be canonical \`<family>/<namespace>/<tool>\` IDs, even when a policy rule uses a raw client name. For an ordinary Archestra MCP name, \`crm__search_records\` becomes \`mcp/crm/search_records\`. Never put the raw double-underscore name in a scenario.

Use the installed catalog namespace, not a battery's alias: if \`[server_aliases]\` maps \`mail = ["mail_prod"]\`, an installed \`mail_prod__send\` call is \`mcp/mail_prod/send\`, even though its battery rule is \`mcp/mail/send\`. Match it against the effective policy in declaration order: root rules first, then batteries. For native names or names containing additional \`__\` separators, load **Tool names** in \`references/archestra.md\` instead of guessing.

Use concrete arguments appropriate to the behavior being tested. The effective policy's parameter schemas and selectors govern offline replay; installed tool schemas are not loaded. For an audience or trust check, satisfy unrelated policy parameter and selector requirements so they do not cause the refusal instead. Schema rejection, selector exclusion, and catch-all behavior can themselves be valid test targets. A missing helper leaves the decision untested. \`{}\` is appropriate only when the check needs no arguments.

## Assert the requested behavior

Use the smallest scenario that expresses the requirement: an intended allow, an unconditional denial, an argument boundary, or a decision after earlier calls. A read/write pair is not required for every check. Expected decisions come from the operator's intent, not from the current result.

For example, when the policy is intended to forbid deleting a protected record:

\`\`\`appa
# The protected record must not be deleted.
mcp/records/delete {
  id: "protected-example"
}
expect deny
\`\`\`

Once the relevant contracts and arguments are known, replay the draft to check its decisions instead of simulating the engine in prose. Do not invent a state-changing prerequisite: a tool's name or imagined result does not establish a label.

Add a matched control when claiming that a particular event caused a decision to change. For a read that restricts later sharing or lowers trust, load \`references/validation-read-restriction.md\` for a worked example. Otherwise this reference is sufficient.

Argument blocks are not JSON objects: put each unquoted name on its own line, followed by a colon and one JSON value, without commas between argument lines. Inside a value, use ordinary JSON: quote object keys and keep arrays or objects on one line. Start with one file or a small pair. Preserve existing expectations; explain conflicts rather than rewriting them to force a pass. Do not invent call arguments from a Yell archive.

Offline replay uses the same native policy engine as enforcement, against the composed candidate policy. It executes no tools, models or remote helpers. The host's catch-all annotator (\`noop\`) answers offline; a step that needs any other annotator, such as \`archestra.run-command\`, or an audience lookup such as team membership reports cannot_run. Steps before a missing annotator still pass or fail; after an unanswered audience lookup, replay stops at the first call in the file that was not allowed, which can be an earlier denial. A policy with a model annotator other than \`archestra\`, a model profile, or an external authority or sanitizer cannot run at all. A passing replay demonstrates only the decisions represented by the scenario; it does not prove live client integration or provider behavior.
`;

/** `references/validation-read-restriction.md`: Optional causal-check recipe. */
export const VALIDATION_READ_RESTRICTION = `# Check a restriction caused by a read

Use this recipe only when the requirement is that reading particular data changes a later decision. For direct allow, deny, or argument checks, use \`references/validation-writing.md\` alone.

A read's \`delta.audience\` restricts later sharing; \`requires.audience.contains\` checks that the destination is permitted by the current audience. Reading public data later cannot undo an earlier restriction. Trust is independent and can also cause a denial. Consult \`references/contracts/audiences.md\` or \`references/contracts/labels.md\` only when those semantics are unclear.

For "this read prevents this public write", check the exact same write before and after the read. If the write has \`delta = {}\` and no other state-changing behavior, all three calls fit in one file. Otherwise put the fresh-session control in a separate file. If the control is denied too, report the confounding requirement; the denial after the read alone does not establish its cause. An unrelated allowed lookup is not that control.

This illustrative policy has a private read and a public send; adapt the names and contracts to the user's effective policy, never add these rules merely to make a validation pass:

\`\`\`toml
[server_aliases]
mail = ["mail_prod"]

[policy]
version = 2

[[policy.tool]]
name = "crm__search_records"
delta = { audience = ["internal"] }

[[policy.tool]]
name = "mcp/mail/send"
requires = { audience = { contains = ["public"] } }
delta = {}
\`\`\`

The scenario checks that public sending works until private data is read:

\`\`\`appa
# The private read must block the same public send that was allowed before it.
mcp/mail_prod/send {
  recipient: "public"
  body: "Synthetic status update"
}
expect allow
mcp/crm/search_records {}
expect allow
mcp/mail_prod/send {
  recipient: "public"
  body: "Synthetic status update"
}
expect deny
\`\`\`

`;
