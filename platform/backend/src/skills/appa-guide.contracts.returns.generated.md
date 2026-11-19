## Remedy plans and child returns

When a tool call is blocked or a result introduces new restrictions, OpenAPPA generates structured remedy plans outlining how the agent can proceed safely:
- For blocked calls, plans can request authority review or propose argument sanitization.
- For restricted results, plans can offer output sanitization or allow the agent to accept label narrowing.
- For side-effecting tools listed in `confined_results`, plans can offer to withhold the result payload from the agent context while recording the tool's declared effects.

A withhold plan executes the tool and suppresses its result payload from the agent (including failure messages). Successful calls still record their declared effects in trajectory history, and the withheld result does not alter the trajectory label.

### Subagent Returns

This section applies to child agents spawned within a parent trajectory family (`subagent forks`). It does not apply to `root forks`, which run independent trajectory families from snapshot state and do not cross return boundaries. See Subagent forks and root forks.

Child agents can inspect sensitive data without leaking it to the parent trajectory. When `context_control = true` is configured, the integration isolates the child's context and buffers its return payload until OpenAPPA evaluates it. The parent selects a return contract before the child begins execution.

OpenAPPA offers return plans in order:
1. A direct validation plan checking the raw answer against target return limits.
2. Sanitization plans using untagged `tool_output` sanitizers.
3. A void return plan that discards the child's return payload entirely.

The parent provides `label` to define audience and trust bounds for the child's return. Passing `label = {}` binds the return to the parent's current label, preventing the child from introducing narrower restrictions. If a sanitizer is selected, the sanitized output must satisfy those bounds.

#### Declaring the return

Return declarations are executed autonomously by the agent without requiring human approval.

When a child spawn is initially blocked, OpenAPPA offers return declaration plans first. The parent executes a return plan and retries the spawn call. OpenAPPA then evaluates any remaining preconditions (such as tool permissions or attention requirements). Once all preconditions are resolved, the child trajectory begins execution. A declaration binds to exactly one spawn; releasing the spawn consumes the declaration.

Parents can also declare return bounds prospectively before issuing the spawn by invoking `execute_remedy_plan` without an `offer_id`:

```json
{ "label": {} }
```

Prospective declarations apply strictly to the parent's next immediate child spawn within the same turn. The declaration remains valid only while the parent's label remains unchanged. If intervening tool calls alter the parent's label, the declaration lapses. Prospective declarations must immediately precede the subagent call with no intervening tool invocations. Fan-out spawns ignore prospective declarations and must configure return contracts at the spawn block.

A host can also declare the return on the spawn's own `tool_call` event, in the `declares` field. The field takes the same `label` and optional `return_schema`:

```json
{ "declares": { "label": {} } }
```

`declares` selects one of two returns. Without `return_schema`, the return crosses as spoken. With `return_schema`, `attest-schema` attests the return. A void return or a named output sanitizer needs a plan from the spawn's block.

If the spawn is blocked, OpenAPPA applies the declaration through the block's declaration plan and checks the call again in the same hook. The call is then released, or blocked only by its other preconditions. If no declaration plan of the block fits `declares`, the block states that the declaration was not applied.

A declaration that already stands for the call, with the same tool and arguments, is kept: `declares` does not replace it. A prospective declaration also takes precedence over `declares`.

OpenAPPA refuses a `tool_call` that carries `declares` but does not start exactly one subagent. Under a deployment without `context_control` a spawn is released without a prepared child, so OpenAPPA applies no declaration there.

In the example below, a child agent can inspect internal customer data and pass its return payload through `remove_customer_details` before the parent receives it:

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

The parent selects this sanitizer plan using its `offer_id`, constraining the sanitized return to the parent's current label:

```json
{ "offer_id": "<the sanitizer offer ID>", "label": {} }
```

The declared return limits constrain what the child may read: the child cannot accept restrictions that prevent it from satisfying its return contract. OpenAPPA communicates return requirements to the child at spawn time. If the child's final response violates these constraints, OpenAPPA returns an explanation allowing the child to revise its output.

#### Void returns

A `void return` suppresses all return communication from the child to the parent trajectory:

```json
{ "offer_id": "<the void offer ID>" }
```

Because no output crosses the boundary into the parent context, the child's `taint` cannot reach the parent's label. The child may accept any label narrowing required for its task. The child must terminate with an empty final message; OpenAPPA blocks non-empty final text or `StructuredOutput` calls and instructs the child to terminate with an empty response.

Use void returns for child agents that perform autonomous mutations through their own tools without returning data. Void contracts govern return communication only; all tool calls issued by the child remain subject to their own policy contracts.

### Fan-out spawns

A `fan-out spawn` launches multiple concurrent or sequential subagents under a single parent return contract (for example, Claude Code's `Workflow` tool):
- Each child agent initializes its own fork when launched, inheriting the parent's active label at that moment.
- Each child agent's return is validated independently against the declared return contract. If a subagent uses `StructuredOutput`, OpenAPPA checks the output payload against the return bounds.
- Available remedy plans include direct validation, untagged `tool_output` sanitizers, and void returns (`attest-schema` is excluded because later agents may start after trust has degraded).
- In Claude Code, child agents are associated with the prompt context of the enclosing `Workflow`. Concurrent `Workflow` calls within the same prompt are rejected until the active workflow completes.

The workflow's own result needs no separate check: the script performs no I/O, so the only data it passes to the parent is the validated child answers.

Child agent transcripts are protected session files; direct tool reads targeting them are denied. The return check covers the child's answer. Files the child writes carry no label unless a [recorder](references/contracts/annotators.md#recorders) tracks them.

### Structured child returns

Use the built-in sanitizer `attest-schema` when a child agent must extract structured data (such as integers or enum values) from untrusted inputs without inheriting `suspicious` trust. `attest-schema` validates the payload against a declared JSON Schema without mutating it. It can elevate trust from `suspicious` to `trusted` only when all of the following conditions are met:
1. Every schema leaf bounds what the child can return: a boolean, an integer or decimal with declared bounds, a fixed list of choices (`enum` or `const`), or a `format` from OpenAPPA's closed list. Free strings, including strings constrained only by `pattern`, are rejected.
2. The parent declares the schema before the child reads untrusted data.
3. The parent holds `trusted` status when spawning the child.

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

The parent provides `return_schema` when selecting the plan:

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

OpenAPPA evaluates `attest-schema` internally; defining an `[externals.sanitizers.attest-schema]` section is prohibited. Schema validation verifies structural types; it does not validate semantic accuracy.

### Example: Customer Ticket Policy

This policy configuration accompanies the customer ticket sharing walkthrough.

The integration must support result withholding (`confined_results`) and subagent context isolation (`context_control = true`). The example uses an external sanitization service authenticated via `APPA_PII_TOKEN`:

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

After ingesting raw ticket data, the agent can email verified internal organization members. Sending email to external recipients or filing public GitHub issues triggers an authority approval request. If approved, the exception applies to that single invocation while preserving the trajectory's `internal` label.

If the agent receives sanitized ticket data (or a sanitized child return), the public output does not restrict the trajectory to `internal`.

Because the `user` authority declares no tags, it can review requests from any tool. See Validation.

