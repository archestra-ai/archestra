/** Validation guidance, bundled as separately loaded appa-guide references. */

/** `references/validation.md`: Guided validation conversations and the write, replay and publish steps. */
// white-label-ok: applyBuiltInSkillBranding rebrands bundled references at reconcile
export const VALIDATION_WORKFLOW = `# Validations (\`validate\`)

A validation is a unit test for one case the operator cares about: a short \`.appa\` scenario of one or more calls and the decision the operator expects, such as "Slack data must never be posted to a public GitHub repository". Replay runs it offline against the policy; it executes no tools, models, or remote helpers. Saving a validation on its own never changes the policy or the enforcement switch. Approval follows **Save** below, not the policy's approval steps.

## When to offer one

Offer a validation only at these points, in one sentence, and never more than once per conversation:

- **After a targeted behavior change is approved**: ask with one \`archestra__ask_user\` question, "Add a validation for this change?", with options "Write validation" and "Not now". With local delivery, ask after the save. When approval opens a pull request, ask before publishing, so the check joins the same pull request: preview it with the complete proposed policy as \`policyContent\`, and publish both with \`archestra__publish_openappa_validation_change\` instead of \`archestra__update_guardrails_policy\`.
- **When the operator asks to validate the policy or write a validation**: go to **Get the case**.

Do not offer one after a first policy or \`init\`, for explain, review, or yell requests, after the operator declines, or just to add coverage.

## Get the case

1. A concrete case names an action and the expected decision, plus starting conditions when they matter (for example, after reading private Slack data). If the request or the change you just made gives one, go to **Write**.
2. Otherwise read only the policy and find the operator's own rules: root \`[[policy.tool]]\` rules that name a tool other than \`archestra__*\` or the catch-all \`*\`. The starter's controls for platform tools (\`run_command\`, \`ask_user\`, \`superyell\`), the catch-all, and battery rules are defaults: never offer them as cases.
   - **With own rules**: ask one \`archestra__ask_user\` question, "Which case should the validation cover?", with one or two options, each a case one of those rules decides (for example, "Block public posting after reading an HR record"); the operator types their own case in its "Type something" field.
   - **Without own rules**: say in one sentence that the policy has only default rules, so there is no case of theirs to validate yet, and offer to make a change first (\`references/adjust.md\`); after that change, offer its validation as **When to offer one** says.
   - Either way, that is your whole reply: do not inspect servers or read the suite first, do not summarize the policy or the existing validations, and do not offer to review them.
3. If the operator asks what to check, name one or two cases their own rules decide and ask them to pick one or describe their own.

## Before you write

1. Read the policy with \`archestra__get_guardrails_policy\`. When \`revision = 0\` and \`delivery.mode = "revision"\`, no policy has been saved: say so, offer to set up a starting policy (\`references/first-policy.md\`), and do not write a validation. A saved policy can be validated while enforcement is off.
2. Read the suite with \`archestra__get_openappa_policy_tests\`.
   - A collection \`error\` means unavailable, not empty. For a stale source or conflict, read the policy and suite again once; otherwise report the blocker and stop.
   - When \`source = "github"\` and \`activeDirectory\` is empty, preview and save are disabled: direct the operator to set a validation directory in GitHub source settings.
   - After the operator changes the directory or Git sync, read both again and use the returned source, directory, revision, and version.
3. Load \`references/validation-writing.md\` for the \`.appa\` syntax.

## Write

1. Build the calls from \`effective.content\` as the writing reference says. Inspect a tool's metadata only when the case needs arguments the policy's contracts do not show.
2. Write exactly one file for the case, unless the operator asks for more: a descriptive name, a one-line intent comment, and one to three assertions. Cover a variant of the same case (another read, another argument) as another assertion in that file, not a second file. For Git, its path is a direct \`.appa\` child of \`activeDirectory\`; locally, use the returned directory. Reuse an existing file that already covers the case instead of adding a duplicate.
3. Expectations come from the operator's case, even when the policy fails it today. Ask only if a missing detail changes what should be allowed or blocked. If the case needs a starting state, a contract or the deployment's starting label must establish it; tool names and imagined results do not. If nothing does, explain the gap and ask for the setup.
4. Preview with \`archestra__preview_openappa_validation_change\`: explicit \`upsert\` and \`delete\`, \`expectedRevision\`, and \`expectedVersion\`. Omit \`policyContent\` unless a policy change is part of the request; never pass the current policy or blank text as a placeholder. Fix \`.appa\` syntax errors in the file only and preview again.
5. Explain in at most three sentences, without tool calls or \`.appa\` text: the situation, the expected decision, and what the preview found. Keep passed, failed, and cannot-run distinct. \`cannot_run\` means replay could not decide offline, for example because the step needs a remote annotator; it is not a pass.
6. If the check fails, say the policy does not handle this case yet and offer to change the policy (\`references/adjust.md\`). Never weaken or delete a check to make it pass.
7. End the turn with one \`archestra__ask_user\` question, "Save this validation?", with options "Save" and "Not now". A typed answer is a change: apply it, preview again, and ask again. Respect "don't save yet".

## Save

1. Call \`archestra__publish_openappa_validation_change\` with the exact patch you previewed and the same \`expectedRevision\` and \`expectedVersion\`. On a conflict, read the policy and suite again, re-apply the file, preview, and ask again if the result changed.
2. Locally, the validation is saved. With Git sync, give the pull request URL: it is active only after merge and sync.
3. Report the file path and its last preview result in one or two sentences. Saving does not record a run: offer to run the saved suite.

## Run or explain saved validations

- To run: call \`archestra__run_openappa_policy_tests\` (after merge and sync for Git), then report the run's passed, failed, and cannot-run counts and whether it is outdated.
- To explain: read the policy and the suite, then say in plain language which case each validation checks and its latest result. Change nothing.
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
