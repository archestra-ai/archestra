/** Validation guidance, bundled as separately loaded appa-guide references. */

/** `references/validation.md`: Guided validation conversations and the write, replay and publish steps. */
// white-label-ok: applyBuiltInSkillBranding rebrands bundled references at reconcile
export const VALIDATION_WORKFLOW = `# Validations

A validation is a small \`.appa\` scenario that checks an important policy behavior still holds after the policy changes. \`references/validation-writing.md\` has the syntax.

- First setup and explicit policy-only work need no validations. Do not create checks just to increase coverage.
- For validation-only work, this workflow owns review and saving; the shared policy-proposal approval steps do not apply. When the operator says "do not save yet", show the draft and available results without asking to save.
- Validation-only work leaves the policy unchanged. Choosing a check or asking to save validations authorizes only those files. A failed expectation is a finding to review, not permission to fix the policy. Include a policy change only when the operator explicitly requests one.
- An ordinary, concrete behavior change normally keeps one clearly named file with one to three assertions. Do not build a test matrix or duplicate existing checks. Respect a request to skip validations.

## Choose the requested operation

A request to explain or review existing checks is inspection only: read the relevant files and policy, then answer without drafting, previewing, or publishing changes. If a needed file is unavailable, report the gap; explain any supplied material within that limit.

For a request to create or edit checks, or an exploratory **Ask About Validations** conversation, read the current policy first; reuse reads from this turn. Once the policy prerequisite below is satisfied, load \`references/validation-writing.md\` alongside the suite read for a concrete drafting request.

## Establish the policy before choosing checks

When \`revision = 0\` and \`delivery.mode = "revision"\` (local delivery), the returned content is an **unsaved starter**, not a configured policy. For a request about the current policy, explain briefly that no policy has been saved yet and that the first step is to set one up before writing validations. Ask whether to start policy setup, then stop. Do not describe the starter's protections as already configured, offer validation behaviors to choose from, inspect tool schemas, or draft or preview scenarios. If setup is already requested, load \`references/first-policy.md\` and follow its proposal and approval steps; a validation request alone does not authorize saving or enabling a policy. Resume current-policy validations after a read confirms the policy was saved.

This prerequisite concerns a missing policy, not disabled enforcement: a saved policy can be validated offline while enforcement is off. An explicitly supplied candidate policy can also be tested before saving; use that candidate and label the result as a draft-policy check. When testing a complete supplied candidate, pass it unchanged to preview; distinguish your transcription errors from errors in the supplied policy. Do not silently substitute the unsaved starter for the operator's intended policy.

Once the policy to test is established, read the authoritative suite (\`archestra__get_openappa_policy_tests\`). Check whether replay and publication are available:

- A collection \`error\` means unavailable, not empty. If it reports a stale source or conflict and asks for a reload, refresh the policy and suite once. For other errors, or if a reload does not resolve it, report the blocker and do not preview or publish validations.
- When \`source = "github"\` and \`activeDirectory\` is empty, preview and publication are disabled. Direct the operator to set a validation directory in GitHub source settings; do not attempt validation preview or publication.
- If the operator changes the directory or disables Git sync, read both policy and suite again. Use the returned source, directory, revision, and version; never reuse the earlier \`disabled:...\` version. A local source needs no GitHub directory setup.

When replay is unavailable, still provide an already-requested text draft if the available policy and contracts support it, clearly labeled untested. Do not require a second request to draft. For an exploratory request, explain the setup needed before proposing runnable checks.

An unavailable optional regression check does not block an authorized policy proposal: return to \`references/adjust.md\` for policy-only preview and approval, explaining that the check could not run. If the operator requires policy and checks together, keep that requirement and report the blocker instead of silently dropping the checks.

## Recommend one concrete check

For an exploratory request, suggest one concrete behavior from the effective contracts. Briefly describe the starting conditions, calls, and intended decision in everyday language, then ask whether this is behavior the operator wants to preserve or whether they want to target something else. Wait for their answer before drafting. Keep the orientation under about 100 words and omit syntax and internal identifiers.

A state-dependent check needs a contract or deployment starting label that establishes the required state. Tool names, imagined results, and annotator hints do not establish it. If that prerequisite is absent, explain the gap and ask about another behavior or the needed setup. Disclose unavailable model/helper dependencies; do not promise their decisions. This is a check of one proposed scenario, not an audit of every policy path.

If validations already exist, first summarize their coverage and offer to review or edit a relevant one, or add a missing check. Inspection-only requests and requests not to run tests need no preview.

A concrete request to create or edit a check, or an already chosen behavior, goes directly to drafting and preview without another introductory choice. Expectations come from the operator's requirement even if the current policy fails it. Ask only if a missing detail changes what should be allowed or blocked.

Choosing a behavior authorizes drafting and read-only replay, not saving: in that same turn, write the smallest useful scenario and preview it when available. Use the returned decisions to resolve uncertainty instead of repeatedly redesigning hypothetical cases. Show the check and a brief replay result. Respect "do not save yet"; otherwise ask whether to save or adjust it when saving has not already been authorized.

## Write, replay, and publish

1. Load \`references/validation-writing.md\` for the \`.appa\` syntax before you write a scenario, if not already loaded.
2. Use the policy and suite from the readiness check. Read \`effective.content\` for the actual contracts, including root overrides before batteries. Resolve only the tools needed by this check, using the naming rules in the writing reference. Offline replay evaluates those policy contracts; it does not fetch installed MCP input schemas or require the tools to be installed. Use the effective contract's parameter schemas and selectors to construct the calls. Inspect selected live tool metadata only if the requested check needs arguments beyond the policy contracts, not as a prerequisite to offline replay. Preserve existing files and reuse a scenario that covers the intent.
3. Write one focused scenario with a descriptive name and short intent comment. For Git, its path must be a direct \`.appa\` child of \`activeDirectory\`; for local files use the returned directory. Expected decisions come from the operator's requirement. Assert the requested behavior directly; add a matched control only when claiming that an earlier event caused a decision to change, as the writing reference explains.
4. When the suite is available, call \`archestra__preview_openappa_validation_change\` with explicit \`upsert\` and \`delete\` changes, \`expectedRevision\`, and \`expectedVersion\`. For validation-only work, omit \`policyContent\` or pass \`null\` if the client requires the field. Never pass the current policy, an empty string, or whitespace as a placeholder. Add \`policyContent\` only for an explicitly requested policy change: derive the complete text from the current root and your exact edits, preserving every unrelated line. Preview replays the whole suite against the composed policy without saving. It executes no tools, models, or remote helpers, so \`cannot_run\` is a limitation to explain, not a pass. Correct scenario syntax errors in the \`.appa\` files only; leave \`policyContent\` omitted or null while retrying validation-only work.
5. Show each changed validation's path and draft \`.appa\` content, then briefly explain its assertions, warnings, and pass, fail, or cannot-run results. A preview refused before replay leaves the draft untested; do not call it correct or say it confirms protection. Describe only the tested calls and decisions, never a guarantee that data cannot leak through any tool. For validation-only work, follow the saving authorization above; do not present a proposed policy or ask to apply one. Never delete a failing check, change its expectation, or change the policy just to make the suite pass. If new intent contradicts an existing check, ask one focused question.
6. Publish only within the operator's authorization: \`archestra__publish_openappa_validation_change\` with the exact previewed patch, saving locally or opening one PR for policy and validations together. Never use publish to prepare or show a draft. If the operator asked to review before saving, stop after preview and wait for explicit approval, even if they said "write", "create", or "go ahead" with the draft. On a revision or version conflict, read again and reconcile; ask again if the behavior changes. Explain local saving or a GitHub pull request when publication becomes relevant, not up front.
7. Report the saved version or PR URL, remaining failures, and replay limits. A PR becomes active only after merge and sync. A specification-only save leaves enforcement unchanged and does not record a suite run. Failures do not block policy activation; the operator's CI owns merge gating.
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

Use get_openappa_policy_tests to obtain the authoritative version and configured directory. Upsert only the named files you intend to edit and use explicit deletions. For Git sources, files must stay under that directory and Git remains authoritative. Preview the full patched suite against the current policy; omit policyContent or pass null for validation-only work. Include policyContent only when the operator explicitly requested a policy change. A replay failure does not authorize a policy fix.
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
