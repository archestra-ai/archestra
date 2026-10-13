## Remedy plans and child returns

The authorities, sanitizers, and integration settings in the policy determine which remedy plans OpenAPPA can offer. These plans give the agent ways to continue when a call is blocked or a result would add restrictions.

For a blocked call, a plan can request approval or change the proposed arguments. For a restricted result, a plan can clean it or let the agent accept its restrictions. If the tool declares effects, a plan can instead withhold its result.

A withhold plan runs the tool and delivers no result Value to the agent. This includes output that reports a failure. A successful call still records its declared effects. The result does not change the trajectory Label.

### Subagent Returns

This section governs a `subagent fork`: a child started by an approved spawn in the parent's `trajectory family`. It does not govern a `root fork`, which opens an independent family from copied context without a spawn dispatch or child-return contract. A root fork retains the source family's opening policy and frozen policy state; it does not select a return-remedy plan. See Subagent forks and root forks.

A child agent can read data without exposing it to the parent agent. `context_control = true` declares that the integration keeps the child's data separate and can withhold its answer until OpenAPPA allows it. The parent chooses how the answer will be checked or cleaned before the child starts.

OpenAPPA first offers a plan that checks the child's answer without changing it. It then offers plans that use the registered `tool_output` sanitizers without tags.

The parent supplies `label` to specify the audience and trust limits for the child's answer. `label = {}` uses the parent's current audience and trust rank, so the answer cannot add restrictions to the parent. If a plan uses a sanitizer, the cleaned answer must meet those limits.

In the example below, a child can read internal customer data and pass its answer through `remove_customer_details`. The sanitizer must remove private details before the parent receives the answer:

```toml
[[policy.sanitizer]]
name = "remove_customer_details"
on = ["tool_output"]
hint = "Remove customer identities and all other private details from the return."

[policy.sanitizer.permits]
audience = { from = ["internal"], to = ["public"] }

[policy.deployment]
context_control = true

[externals.sanitizers.remove_customer_details]
url = "https://sanitizer.corp/sanitize"
```

The parent selects this sanitizer's plan by its `offer_id`. This request keeps the parent's current audience and trust rank as the limits for the cleaned answer:

```json
{ "offer_id": "<the sanitizer offer ID>", "label": {} }
```

The chosen limits also restrict what the child can read: it must still be able to return an answer that meets them, with the selected sanitizer if needed. The child receives its answer requirements when it starts and submits its answer when it finishes its turn. If the answer does not meet those requirements, OpenAPPA explains the problem so the child can revise it.

### Fan-out spawns

A `fan-out spawn` starts any number of subagents under one return declaration. Claude Code's `Workflow` tool is one: its script starts agents that the parent never addresses one at a time. The parent declares the return once, at the spawn, and the declaration applies to every agent the spawn starts.

- Each agent binds its own fork when it starts. It starts at the parent's label at that moment, so an agent started after another agent's answer crossed starts at the label that answer left on the parent.
- Each agent's answer is checked separately under the declaration. An agent called with a schema answers through its `StructuredOutput` call; OpenAPPA checks that input as the answer and denies the call when it cannot cross. Its later stop is checked as another answer.
- The offered plans are the plain check and the untagged `tool_output` sanitizers. `attest-schema` is not offered: it requires the parent to be trusted when the child starts, and later agents do not have to meet that.
- Claude Code identifies the agents by the prompt the `Workflow` call ran in. A second `Workflow` in the same prompt is refused until the first one reports that it finished. After that report, no new agent binds to the spawn.

The workflow's own result needs no check of its own. The script performs no I/O, so its result is built from the script, its arguments, and the agents' answers that crossed. An agent whose answer never crosses ends without a result. The same rule covers the result of a background `Agent`.

An agent's transcript is a child file, and a call that names it is refused. A workflow run's `journal.jsonl` is not: OpenAPPA labels no files, so reading it, or resuming a run with `resumeFromRunId`, which replays the answers the journal recorded, stays outside the checked return path.

### Structured child returns

Use the reserved sanitizer `attest-schema` when the child must return structured data, such as a number of days, rather than free text. It checks the answer against the parent's JSON Schema without changing it. It can raise trust from `suspicious` to `trusted` only when all these conditions hold:

1. Every field limits what the child can return: a number, a boolean, a fixed list of choices, or a restricted format. Free text is not permitted.
2. The parent declares the schema before the child reads untrusted data.
3. The parent is trusted when it starts the child.

The following declaration allows `attest-schema` to return a trusted answer after these checks:

```toml
[[policy.sanitizer]]
name = "attest-schema"
on = ["tool_output"]
hint = "Validate the child's structured return against the declared schema."

[policy.sanitizer.permits]
trust = { from = "suspicious", to = "trusted" }

[policy.deployment]
context_control = true
```

The parent supplies `return_schema` when it selects the plan. This example requires one non-negative integer, `days_allowed`, and rejects extra fields:

```json
{
  "offer_id": "<the attest-schema offer ID>",
  "label": {},
  "return_schema": {
    "type": "object",
    "properties": { "days_allowed": { "type": "integer", "minimum": 0 } },
    "required": ["days_allowed"],
    "additionalProperties": false
  }
}
```

OpenAPPA runs `attest-schema` itself. An `[externals.sanitizers.attest-schema]` section is not allowed. The schema checks the answer's format; it cannot check whether the number of days is factually correct.

### Example: Customer Ticket Policy

This complete configuration accompanies the customer-ticket example.

The integration must be able to keep original ticket results hidden and keep a child's data separate from its parent's. The example uses external services and an `APPA_PII_TOKEN` environment variable to authenticate requests to the sanitizer.

```toml
[policy]
version = 2

[policy.deployment]
context_control = true
confined_results = ["get_ticket_from_crm"]

[policy.audience]
internal = ["google-workspace:full-members"]

[[policy.tool]]
name = "get_ticket_from_crm"
delta = { audience = ["internal"] }

[[policy.tool]]
name = "send_email"
parameters = { type = "object", properties = { recipient = { type = "string" }, body = { type = "string" } }, required = ["recipient", "body"] }
requires = { audience = { contains = ["$recipient"] } }
delta = {}
effects = ["egress"]

[[policy.tool]]
name = "file_github_issue"
requires = { audience = { contains = ["public"] } }
delta = {}
effects = ["egress", "mutation"]

[[policy.sanitizer]]
name = "remove_customer_details"
on = ["tool_output"]
hint = "Remove customer identities and all other private details from the ticket."

[policy.sanitizer.permits]
audience = { from = ["internal"], to = ["public"] }

[[policy.authority]]
name = "user"

[policy.authority.permits]
audience_missing = ["public"]

[externals]
timeout_ms = 2000
max_body_bytes = 65536

[externals.sanitizers.remove_customer_details]
url = "https://sanitizer.corp/sanitize"
token_env = "APPA_PII_TOKEN"

[externals.authorities.user]
builtin = "hitl"

[externals.audience.google-workspace]
url = "https://audience.corp/google-workspace"
selectors = [
  { template = "viewer", feeds = "self" },
  { template = "full-members", feeds = "internal" },
  { template = "group/<group-address>" },
]
```

After the agent reads the original ticket, it can email readers identified as company members by the membership service. External email and public issue creation require approval. Approval permits one call and leaves the trajectory internal.

If the agent receives only the cleaned, public version of the ticket, that result does not restrict it to internal readers. The same applies to a cleaned answer from a child agent.

The example authority has no tags, so it can approve sharing to any audience for any tool. See Validation for ways to check policy behavior.

