##### Membership request protocol

Audience providers implement either HTTP endpoints or local executables.

OpenAPPA queries membership services to expand group selectors into reader IDs or to resolve individual member IDs to canonical reader IDs. For the complete JSON wire schema, see [The consult request](#the-consult-request).

Consult requests include `declaration.templates` listing the declared templates for that provider. The service MUST validate that this declaration matches the templates it supports before evaluating credentials or upstream APIs, refusing requests on mismatch. Operational failures abort policy evaluation without recording an allowance.

To query group membership for `user-group/oncall`, OpenAPPA sends:

```json
{"selector": "user-group/oncall"}
```

The service returns reader IDs:

```json
{"members": ["a@corp.com", "slack:U2"]}
```

An empty group returns `{"members": []}`.

To look up an individual member, OpenAPPA sends:

```json
{"member": "slack:U1"}
```

The service returns the resolved reader ID:

```json
{"principal": "a@corp.com"}
```

If the member cannot be resolved, the service returns `{"principal": null}`, and the identifier remains unchanged. Non-null `principal` values must conform to reader ID format rules.

If the service fails, times out, or returns invalid data, the audience check cannot complete, and OpenAPPA denies the operation. OpenAPPA records all membership responses in the audit log alongside the associated decision.

### Annotator protocol

OpenAPPA transmits consult requests with `kind = "annotation"`. Policy rules and permits reside in `declaration`; call attributes reside in `artifact.args`:

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

`artifact.context` contains [context provider](references/contracts/annotators.md#context-providers) outputs. When `inputs` is omitted, `declaration.inputs` is empty and `artifact.args` contains the complete call:

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

Consult requests do not disclose the trajectory's current audience, trust rank, or history.

Annotators respond with an `answer` object specifying `delta`, `requires`, and `emits`:

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

Protocol constraints:
- `answer` must define `delta`, `requires`, and `emits`, and may include `forwards` and `evidence`. Unrecognized keys are rejected.
- `evidence` is an optional opaque string (up to 1,024 bytes) recording provenance (such as a policy version or file hash). It is part of the recorded annotation and is forwarded to configured [recorders](references/contracts/annotators.md#recorders).
- `forwards` uses the same structure and validation as `delta`.
- `requires` must include `history` and `attention` arrays (even when empty).
- `requires.audience` must contain exactly `contains`.
- History checks use `{"contains":"<effect>"}` or `{"excludes":"<effect>"}`.
- Audience arrays use `"public"` or a list of permitted audiences. `"public"` must not be placed inside an audience list.
- Audience lists must not contain duplicate entries or combine `self` and `internal`.

OpenAPPA rejects responses containing unknown keys, null values, empty audience objects, duplicate emitted effects, or values outside configured permits. If a response violates permits, OpenAPPA denies the call and logs the violating field and allowed set (e.g. `field=delta.audience allowed=declaration.audiences`) without echoing the unvetted value. Built-in model classifiers return the inner `answer` object directly.

Annotations are bound strictly to the specific call evaluated. Any change to call arguments requires a fresh annotation. Replaying a recorded session reuses cached annotations and membership data without re-querying annotators.

If an annotator fails, times out, or returns values outside its permits, the call is denied. OpenAPPA checks that the answer uses permitted values; the annotator is responsible for classifying the call correctly.

### Test an annotator

Use `appa runtime annotate` to test annotator classifications against sample tool calls offline. It exercises the production consult pathway (including declaration generation, request serialization, backend execution, and permits validation) without opening a trajectory or executing tools.

```sh
appa runtime [--config <path>] [--batteries-dir <dir>] annotate [--repeat <n>] [--concurrency <n>] < calls.jsonl
```

Standard input accepts newline-delimited JSON objects representing tool calls:

| Field | Description |
|---|---|
| `id` | Call identifier echoed in output. |
| `tool` | Tool name as declared in policy. |
| `arguments` | Tool arguments object. |
| `cwd` | Optional working directory forwarded to [context providers](references/contracts/annotators.md#context-providers). |

Standard output yields newline-delimited JSON responses in arrival order:

| `outcome` | Meaning | Diagnostic fields |
|---|---|---|
| `answer` | Annotator returned valid labels within permits. | `annotator`, `answer` |
| `outside_mandate` | Response violated the protocol or exceeded permits (denied in production). | `annotator`, `answer` |
| `no_answer` | Annotator failed to respond or timed out (denied in production). | `annotator`, `reason` |
| `static` | Tool has a static contract; no annotator was consulted. | |
| `unresolved` | Tool or argument pattern is not defined in policy. | `reason` |

`--repeat <n>` runs each call `n` times to assess model classification consistency (default: 1). `n` MUST be at least 1. `--concurrency <n>` limits in-flight requests (default: 4).

Example checking Google Drive tool calls against battery rules:

```toml
# appa.toml
include = ["batteries/google-workspace/appa.toml"]

[policy]
version = 2

[policy.audience]
self = ["google-workspace:viewer"]
internal = ["google-workspace:full-members"]
```

```sh
cat > calls.jsonl <<'EOF'
{"id":"org","tool":"mcp/claude_ai_Google_Drive/create_file","arguments":{"title":"t","textContent":"x","parentId":"<org-wide folder id>"}}
{"id":"read","tool":"mcp/claude_ai_Google_Drive/read_file_content","arguments":{"fileId":"<file id>"}}
EOF
APPA_PROVIDER_GOOGLE_WORKSPACE_TOKEN=... appa runtime --config appa.toml annotate < calls.jsonl
```

Output:

```json
{"id":"read","repeat":0,"latency_ms":0,"outcome":"static"}
{"id":"org","repeat":0,"latency_ms":387,"outcome":"answer","annotator":"google-workspace.drive-readers","answer":{"delta":{},"emits":["google-workspace.changed"],"requires":{"attention":[],"audience":{"contains":["internal"]},"history":[],"trust":"trusted"}}}
```

Without the token, the `org` line is a `no_answer` with the program's error:

```json
{"id":"org","repeat":0,"latency_ms":67,"outcome":"no_answer","annotator":"google-workspace.drive-readers","reason":"non_success status=1 detail=\"google-workspace.drive-readers: APPA_PROVIDER_GOOGLE_WORKSPACE_TOKEN is not set\""}
```

The command exits with status 0 after testing all input calls, regardless of individual outcomes. It exits with a non-zero status if the policy fails to load or if input JSON is malformed. It also exits with a non-zero status when it cannot write an answer to standard output, for example after the reader closes the pipe. In that case no further call is scheduled, and the calls in flight are dropped.

### Recorder protocol

OpenAPPA sends batch delivery notifications after committing decisions and call outcomes to the log. Deliveries contain engine-derived labels:

```json
{
  "version": 1,
  "kind": "recorder",
  "name": "file-tracker",
  "root": "cc:7f3a…",
  "records": [
    {
      "record": "released",
      "dispatch": "cc:7f3a…/9c1e…/0",
      "tool": "host/claude-code/Write",
      "arguments": { "file_path": "/work/notes.md", "content": "…" },
      "label": { "trust": "suspicious", "audience": [["internal"]] },
      "evidence": "absent"
    },
    { "record": "outcome", "dispatch": "cc:7f3a…/9c1e…/0", "outcome": "success" }
  ]
}
```

| Record type | Fields | Meaning |
|---|---|---|
| `released` | `dispatch`, `tool`, `arguments`, `label`, `evidence` | The tool call was released for execution. `label` is its published label. |
| `outcome` | `dispatch`, `outcome` | The tool call completed with status `success`, `failure`, or `indeterminate`. |
| `unreleased` | `trajectory`, `batch`, `tool`, `arguments`, `evidence` | The batch was evaluated and the tool call was denied or suppressed. |

`label.audience` is `"public"` or a list of conjunctive clauses. Each clause contains audience identifiers; a reader belongs to the audience only if included in every clause. `evidence` contains the annotator's `evidence` string, or `null`.

Recorders must respond with `{"version":1,"answer":{}}`. OpenAPPA delivers records in append-log order with at-least-once delivery semantics. Failed deliveries are retried on subsequent batches. Following a restart, OpenAPPA replays deliveries from the start of the trajectory family; recorders MUST ensure idempotent processing by deduplicating against `dispatch` identifiers.

### Sanitizer protocol

Consult requests supply input data in `artifact.body` alongside instructions in `declaration`. The sanitizer returns transformed output in `answer.body`:

| Section | Fields | Description |
|---|---|---|
| `declaration` | `hint`, `permits`, `on`, and `parameters` (for `tool_input` rewrites). | Policy boundaries and transformation instructions. |
| `artifact` | `body` and `tool` (when known). | Input payload and tool identifier. |
| `answer` | `body` | Transformed output payload. |

In the request, `on` contains a single string (`"tool_input"` or `"tool_output"`). OpenAPPA applies the audience or trust rank specified in `permits` to the sanitized result. See [The consult request](#the-consult-request).

### Authority protocol

OpenAPPA transmits consult requests detailing the proposed tool call and unmet preconditions. `declaration` carries `hint` and `permits`; `artifact` contains `tool`, `arguments`, and the `requirements` array:

| Precondition type | JSON structure in `requirements` |
|---|---|
| Trust | `{"kind":"trust","required":"trusted"}` |
| Public audience | `{"kind":"audience","required":"public"}` |
| Restricted audience | `{"kind":"audience","required":["internal","@finance","alice@corp.com"]}` (ordered by built-in audience, `@` references, then literal reader IDs). |
| Effect exclusion | `{"kind":"effect","excludes":"email.sent"}` |
| Attention | `{"kind":"attention","mark":"finance-signoff"}` |

Consult requests do not disclose the trajectory's current label or existing audience members.

The authority responds with a `ruling` (`"approve"` or `"deny"`) and an optional `reason`:

```json
{
  "version": 1,
  "answer": {
    "ruling": "approve",
    "reason": "The user authorized this email."
  }
}
```

See [The consult request](#the-consult-request).

### The consult request

Consult requests send a standardized JSON payload to external components across HTTP and local command transports:

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
    "requirements": [{ "kind": "audience", "required": ["auditor@external.com"] }]
  }
}
```

| Key | Description |
|---|---|
| `version` | Protocol version (must be `1`). |
| `kind` | Component type: `authority`, `sanitizer`, `annotation`, `audience`, or `context`. |
| `name` | Component identifier declared in policy. |
| `declaration` | Policy constraints, permits, and hints for the component. |
| `artifact` | Call data: proposed tool invocation, data payload, or membership selector. |

Payload structure by component kind:

| Kind | `declaration` contents | `artifact` contents | Expected `answer` contents |
|---|---|---|---|
| `authority` | `hint`, `permits` | `tool`, `arguments`, `requirements` | `ruling`, optional `reason` |
| `sanitizer` | `hint`, `on`, `permits`; `parameters` for input rewrites | `tool` (when known), `body` | `body` |
| `annotation` | `hint`, optional `deployment_hint` and `context_hints`, `inputs`, `trust_ranks`, `audiences`, `attention_marks`, `effects` | `args`, `context` | `delta`, optional `forwards`, `requires`, `emits` |
| `audience` | `templates` | `selector` or `member` | `members` or `principal` |
| `context` | Empty | `tool`, `arguments`, optional `cwd` | Arbitrary JSON or `null` |

In audience requests, `declaration.templates` lists the selector templates declared for that provider. The service MUST reject requests if its supported templates do not match this list.

OpenAPPA pins membership responses in the audit record alongside the decision. If an evaluation pauses for approval or remediation, cached membership responses are reused when execution resumes. Fresh decisions execute new membership queries. Replaying recorded decisions reuses saved responses without contacting external services.

Consult requests never expose the agent's full trajectory label, history, or conversation transcript. Components process input data in `artifact` strictly within the bounds specified by `declaration`. Context requests uniquely include `cwd`, and context answers are passed directly to annotators without engine validation.

Components must respond with `{"version":1,"answer":{...}}` containing fields corresponding to their component type. Additional top-level fields are rejected.

OpenAPPA rejects a response if the service returns an HTTP error, exits with a non-zero status code, times out, exceeds `max_body_bytes`, or returns malformed JSON.

