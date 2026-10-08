##### Membership request protocol

Audience providers support HTTP endpoints and local commands.

OpenAPPA can ask the membership service for a group's members or for the reader ID behind one member. The examples below show the request data and response data. For the complete JSON request and response format, see [The consult request](#the-consult-request).

Every request carries `declaration.templates`: the templates the policy declares for the provider. The service MUST compare that list with the templates it serves and MUST refuse the request when the lists differ, before it reads its credential or calls the provider. OpenAPPA treats the refusal as an operational failure of the service that names the provider; it records no decision.

To read the members of the Slack `oncall` group, OpenAPPA sends:

```json
{"selector": "user-group/oncall"}
```

The service returns the members as reader IDs:

```json
{"members": ["a@corp.com", "slack:U2"]}
```

The service returns `{"members": []}` when a group has no members. This is a successful response.

To look up one member, OpenAPPA sends:

```json
{"member": "slack:U1"}
```

The service returns that member's reader ID under `principal`:

```json
{"principal": "a@corp.com"}
```

If the service cannot find the member, it returns `{"principal": null}`. The member then keeps its ID as written. A non-null `principal` must satisfy the [reader ID rule](references/contracts/audiences.md#reader-ids).

If the service fails, takes too long to respond, or returns an invalid answer, OpenAPPA cannot complete the audience check and stops the operation. OpenAPPA records membership responses with the decision that requested them.

### Annotator protocol

OpenAPPA sends the selected call data and the annotator's instructions in a consult request with `kind = "annotation"`. `declaration` contains the instructions and permitted values; `artifact.args` contains the call data to classify.

For the customer example, the request is:

```json
{
  "version": 1,
  "kind": "annotation",
  "name": "classify-customer",
  "declaration": {
    "hint": "Classify customer records as internal and suspicious.",
    "inputs": ["subject"],
    "trust_ranks": ["suspicious"],
    "audiences": ["internal"],
    "attention_marks": [],
    "effects": []
  },
  "artifact": { "args": { "subject": "cust-7" }, "context": {} }
}
```

`artifact.context` carries the [context providers'](references/contracts/annotators.md#context-providers) answers. Without an `inputs` mapping, `declaration.inputs` is empty and `artifact.args` contains the complete call. For example, the `artifact` field contains:

```json
{
  "args": {
    "name": "Bash",
    "description": "Runs one shell command and returns its output.",
    "arguments": { "command": "cargo test" }
  },
  "context": {}
}
```

The request does not include the trajectory's current audience, trust rank, or previous actions.

For the customer request, the service returns this response to classify the result as internal and suspicious, with no call requirements or effects:

```json
{
  "version": 1,
  "answer": {
    "delta": { "trust": "suspicious", "audience": ["internal"] },
    "requires": { "history": [], "attention": [] },
    "emits": []
  }
}
```

The response uses `emits` for effects and `requires.history` for history checks. These names differ from the policy TOML fields.

- `answer` must contain exactly `delta`, `requires`, and `emits`.
- `requires` must contain `history` and `attention` arrays, even when empty.
- Audience and trust fields inside `delta` and `requires` are optional. An omitted field adds no restriction or requirement.
- `requires.audience` can contain `contains`, `within`, or both.
- Each history entry is `{"contains":"<effect>"}` or `{"excludes":"<effect>"}`.
- JSON audience values use `"public"` or a list of permitted audiences. Do not put `public` inside a JSON audience list.
- A restricted list cannot repeat entries or contain both `self` and `internal`.

OpenAPPA rejects unknown keys, `null` values, empty audience objects, duplicate emitted effects, and values outside the permits. For a value outside the permits, the refusal names the field and the declaration list that does not contain it, such as `field=delta.audience allowed=declaration.audiences`. It never repeats the answered value. A built-in model returns only the contents of `answer`, without the surrounding `version` and `answer` fields.

OpenAPPA uses the annotation only for the call it classified. Changing the call requires a new annotation. Rechecking or replaying the same recorded call reuses its annotation and membership responses.

If the annotator fails or returns an invalid answer, the call does not run. The agent can propose it again. OpenAPPA checks that the answer uses permitted values; the annotator is responsible for classifying the call correctly.

### Sanitizer protocol

A consult request tells the sanitizer what to change and supplies the data in `artifact.body`. The sanitizer returns the transformed data in `answer.body`:

| Part | Fields |
|---|---|
| `declaration` | Instructions in `hint`, the permitted change in `permits`, and the data type in `on`. For `tool_input`, also the argument schema in `parameters`. |
| `artifact` | The data in `body`, and the tool name in `tool` when known. |
| `answer` | The transformed data in `body`. |

In a request, `on` is one string: `tool_input` or `tool_output`. OpenAPPA assigns the returned data's audience or trust rank from `permits`. See [The consult request](#the-consult-request) for the complete JSON format and response requirements.

### Authority protocol

OpenAPPA sends the authority the proposed tool call and the requirements that need approval. The consult request puts `hint` and `permits` in `declaration`. The `artifact` field contains the tool name in `tool`, its `arguments`, and the unmet `requirements`.

Each entry in `requirements` uses one of these forms:

| Requirement | JSON form |
|---|---|
| Trust | `{"kind":"trust","required":"trusted"}` |
| Public audience | `{"kind":"audience","required":"public"}` |
| Restricted audience | `{"kind":"audience","required":2}`; the number is the required reader count. |
| Effect exclusion | `{"kind":"effect","excludes":"email.sent"}` |
| Attention | `{"kind":"attention","mark":"finance-signoff"}` |

The request describes the requirements to approve. It does not include the trajectory's current audience or trust rank, or the identities of its current readers.

The authority returns `ruling` as `approve` or `deny`, with an optional `reason`. For example:

```json
{
  "version": 1,
  "answer": {
    "ruling": "approve",
    "reason": "The user authorized this email."
  }
}
```

See [The consult request](#the-consult-request) for the full request format.

### The consult request

A consult request is a JSON request that OpenAPPA sends to an external component. HTTP services and local programs receive the same format. This example asks `support-reviewer` to approve an email whose recipient is outside the current audience:

```json
{
  "version": 1,
  "kind": "authority",
  "name": "support-reviewer",
  "declaration": {
    "hint": "Review whether this release of customer information is authorized.",
    "permits": { "audience_missing": ["public"] }
  },
  "artifact": {
    "tool": "send_email",
    "arguments": { "recipient": "auditor@external.com", "body": "Ticket summary" },
    "requirements": [{ "kind": "audience", "required": 1 }]
  }
}
```

| Key | Meaning |
|---|---|
| `version` | Protocol version. Must be `1`. |
| `kind` | `authority`, `sanitizer`, `annotation`, `audience`, or `context`. |
| `name` | The component name declared in the policy. |
| `declaration` | Policy instructions and limits for the component. The agent does not supply them. |
| `artifact` | Request data: the tool call to review, data to clean, or the selector or member to look up. |

Each component uses these fields differently:

| Kind | `declaration` | `artifact` | `answer` |
|---|---|---|---|
| `authority` | `hint`, `permits` | `tool`, `arguments`, `requirements` | `ruling`, optional `reason` |
| `sanitizer` | `hint`, `on`, `permits`; `parameters` for input rewrites | `tool` when known, `body` | `body` |
| `annotation` | `hint`, `inputs`, `trust_ranks`, `audiences`, `attention_marks`, `effects` | `args`, `context` | `delta`, `requires`, `emits` |
| `audience` | `templates` | `selector` or `member` | `members` or `principal` |
| `context` | empty | `tool`, `arguments`, optional `cwd` | any JSON value, or `null` |

For an audience request, `declaration.templates` lists the selector templates the policy declares for the provider under `selectors`, such as `viewer` and `user-group/<handle>`. The service MUST refuse a request whose templates differ from the ones it serves. It reads the requested selector or member ID from `artifact` and returns its result under `answer`.

OpenAPPA records membership responses with the decision that requested them. If that decision requires an approval or remedy, OpenAPPA reuses those responses when it continues the decision. A new decision can request updated membership. Replaying a recorded decision uses its saved responses without calling the membership service. Responses from unrelated decisions cannot be substituted.

A consult request does not include the agent's current audience, trust rank, previous actions, or user message. The component processes the request data in `artifact` using the instructions and limits in `declaration`. A `context` request alone carries `cwd`, and a `context` answer is the one answer OpenAPPA does not validate: it is data for the annotator, not a decision.

The service or program returns `{"version":1,"answer":{...}}`. The fields inside `answer` must match the component's response format. Extra fields in the surrounding response object are not allowed.

OpenAPPA rejects a response if the HTTP service reports an error, the program exits with a non-zero status, the request times out, or the response exceeds the size limit or has an invalid format. It cannot use that response to approve a call, deliver cleaned data, or annotate a tool.

