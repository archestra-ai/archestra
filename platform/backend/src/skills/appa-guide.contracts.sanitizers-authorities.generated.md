## Sanitizers

A sanitizer cleans or validates data before an agent or tool receives it. Its `permits` section specifies which audience or trust rank OpenAPPA can assign to the result.

In the example below, the integration keeps the original ticket hidden from the agent while `remove_customer_details` removes private information. The policy allows the cleaned result to be shared publicly. The service must remove all information that cannot be shared publicly.

```toml
[[policy.tool]]
name = "get_ticket_from_crm"
tags = ["support"]
delta = { audience = ["internal"] }

[[policy.sanitizer]]
name = "remove_customer_details"
on = ["tool_output"]
tags = ["support"]
hint = "Remove customer identities and all other private details from the ticket."

[policy.sanitizer.permits]
audience = { from = ["internal"], to = ["public"] }

[policy.deployment]
confined_results = ["get_ticket_from_crm"]

[externals.sanitizers.remove_customer_details]
url = "https://sanitizer.corp/sanitize"
```

### Permitted transitions

A sanitizer can change either the audience or the trust rank of its result. Its `permits` section declares the allowed change with `from` and `to`. It can contain `audience` or `trust`, but not both.

| Transition | Meaning of `from` | Meaning of `to` |
|---|---|---|
| `audience` | Readers who must be included in the original data's audience. | Audience assigned to the cleaned result. |
| `trust` | Minimum trust rank of the original data. | Trust rank assigned to the result. |

For example, the following declaration permits a sanitizer to validate or clean suspicious data and return a trusted result:

```toml
[policy.deployment]
context_control = true

[[policy.sanitizer]]
name = "vouch-fetched-text"
on = ["tool_output"]

[policy.sanitizer.permits]
trust = { from = "suspicious", to = "trusted" }
```

The sanitizer implementation must perform the validation or cleaning. The integration must keep the original data hidden until the sanitizer finishes. Merely declaring the result `trusted` does not make its content trustworthy.

The optional `hint` tells the sanitizer what to remove or validate. It does not grant permission beyond `permits`.

### Tool outputs and inputs

The `on` field selects which data the sanitizer can transform:

| `on` value | Data to transform | What the integration must do |
|---|---|---|
| `tool_output` | A tool result or a child agent's answer. | Keep the original hidden from the receiving agent and deliver the transformed result. |
| `tool_input` | All arguments of one tool call. | Run the tool with exactly the arguments returned by the sanitizer. |

When a tool result would restrict the agent, OpenAPPA can offer a sanitizer whose permitted change reduces that restriction. If the agent selects it, the integration runs the sanitizer before delivering the result.

If the cleaned result still adds restrictions, the agent can accept them or select another compatible sanitizer. Cleaning a new result does not remove restrictions from data the agent has already read.

Changing tool arguments can satisfy an audience `contains` requirement. For example, a sanitizer could replace an external recipient with an allowed internal recipient. It cannot satisfy `within` or trust requirements, because changing arguments does not change the data the agent has already read.

OpenAPPA selects the contract that matches the new arguments and checks the call again, including its requirements, effects, and argument schema. If that contract uses an annotator, OpenAPPA requests a new annotation. Membership checks use the responses already recorded for this decision.

A sanitizer's [tags](references/contracts/tools.md#tags) select the tools whose data it can transform. When arguments change, the new matching contract must also have a matching tag. Only a sanitizer without tags can transform a child agent's answer, because that answer is not a tool result.

### Implementing a sanitizer

A sanitizer implementation receives data and returns a transformed version. For example, a program can remove customer names and account numbers from a ticket before the agent reads it. The implementation must perform the transformation described by `hint` and make the result suitable for the audience or trust rank allowed by `permits`.

Configure the implementation under `[externals.sanitizers.<name>]`, using the name from `[[policy.sanitizer]]`. Use `url` for an HTTP service or `command` for a local program.

For example, this configuration runs a local program for the `remove_customer_details` sanitizer:

```toml
[externals.sanitizers.remove_customer_details]
command = ["python3", "./remove_customer_details.py"]
```

You can also select a built-in implementation with `builtin` under `[externals.sanitizers.<name>]`. The available options are:

| Configuration | Behavior |
|---|---|
| `builtin = "redact-email"` | Replaces email addresses with a fixed placeholder. It does not remove other private information. |
| `builtin = "redact-secrets"` | Replaces credentials with a fixed placeholder: private-key blocks, tokens of well-known shapes (AWS, GitHub, Anthropic, OpenAI, Slack, Google, GitLab, npm, JWT), the AWS secret access key, which has no prefix and is recognized by its 40 base64 characters, the password in a URL's `user:password@host`, the value of an assignment whose key names a password, passphrase, secret, token, credential, authorization, key or auth (quoted JSON keys, `Bearer` values and netrc `password` lines included), and any run of 20 or more characters with high entropy. It is a detector, not a proof that no secret remains. |
| `builtin = "claude-code"` | Uses Claude Code to transform data according to the sanitizer's `hint`, `on`, and `permits`. |
| `builtin = "llm"` | Uses the model configured under `[externals.llm]` to transform data according to the sanitizer's `hint`, `on`, and `permits`. |

See [Externals](references/contracts/externals.md#externals) for implementation settings. The reserved `attest-schema` sanitizer has separate configuration for [structured child returns](references/contracts/returns.md#structured-child-returns).

## Authorities

An authority reviews a tool call that would otherwise be blocked. It can approve an exception only for requirements listed in its `permits` section.

In the example below, a person reviews requests to share data from tools tagged `support`. The reviewer can approve sharing to any audience, including public sharing:

```toml
[[policy.authority]]
name = "support-reviewer"
tags = ["support"]
hint = "Review whether this release of customer information is authorized."

[policy.authority.permits]
audience_missing = ["public"]

[externals.authorities.support-reviewer]
builtin = "hitl"
```

Approval applies to one call. It does not change the trajectory's label or approve later calls.

### Permissions, tags, and hints

Each field in `permits` allows the authority to approve a different type of requirement:

| `permits` field | What an approval can satisfy |
|---|---|
| `trust_below` | Allows a call whose required trust rank is not met, up to the rank specified here. |
| `audience_missing` | Allows sharing with readers outside the current audience, limited to the audience specified here. |
| `effects_containing` | Allows a call blocked by `excludes` because a listed effect has already occurred. |
| `attention` | The listed attention marks for this call, or every declared mark except `blocked` when the list is `["*"]`. |

For example, these permissions let an authority approve a call that needs `trusted` data, a public audience, an exception for an earlier `email.sent` effect, or `finance-signoff`:

```toml
[[policy.authority]]
name = "finance-officer"

[policy.authority.permits]
trust_below = "trusted"
audience_missing = ["public"]
effects_containing = ["email.sent"]
attention = ["finance-signoff"]
```

An authority's [tags](references/contracts/tools.md#tags) select the tools it can review for unmet audience, trust, or effects requirements. Attention approvals are selected by `permits.attention` instead.

The optional `hint` explains what the authority reviews. It does not expand `permits`.

### Implementing an authority

An authority can use a built-in reviewer, an HTTP service, or a local program. Configure the implementation under `[externals.authorities.<name>]`, using the name from `[[policy.authority]]`:

| Implementation | Behavior |
|---|---|
| `builtin = "hitl"` | Asks a person to review the exact call and the requirements to be approved. |
| `builtin = "approve"` | Automatically approves every matching request within `permits`. |
| `builtin = "claude-code"` or `builtin = "llm"` | A model approves or denies using the declaration, call, and unmet requirements. |
| `builtin = "<module name>"` | Runs a module loaded from `--modules-dir` with the same system permissions as OpenAPPA. |
| `url` or `command` | Asks an external service or local program to approve or deny the call. |

Every implementation is limited by the authority's `permits`, including automatic approvers.

