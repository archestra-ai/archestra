## Annotators

An annotator dynamically computes contract rules for tool calls. It can return output restrictions (`delta`), restrictions on content the call sends beyond its arguments (`forwards`), execution preconditions (`requires`), and side effects (`effects`). (The built-in `jev` annotator determines audience and trust labels only.)

Use annotators when call rules depend on runtime arguments or external context (such as classifying file access by filesystem directory or database queries by target table).

Tools bind an annotator using `annotator = "<name>"`. The annotator computes `delta`, `forwards`, `requires`, and emitted effects for each invocation.

A tool can also declare a label floor beside its annotator. The floor narrows every answer, so no answer can loosen it:

- `requires.trust`: the call requires the higher of this floor and the annotator's floor.
- `requires.audience.contains`: the call requires these readers and the annotator's. The readers MUST be literal; a placeholder is refused.
- `delta.trust`: the result carries the lower of this trust and the annotator's.

A tool with an annotator MUST NOT declare `forwards`, `effects`, `delta.audience`, `requires.effects`, or `requires.attention`. The loader refuses each of them.

```toml
[[policy.annotator]]
name = "file-tracker"

[[policy.tool]]
name = "Bash(network_hosts:*)"
annotator = "file-tracker"
requires = { audience = { contains = ["public"] } }
delta = { trust = "suspicious" }
```

### Example: annotate a tool call with Claude Code

The example below uses Claude Code as a classifier for `Bash` invocations. It inspects the full tool call and uses the configured `hint` to evaluate restrictions and preconditions. The `ranks`, `audiences`, `marks`, and `effects` fields bound the permitted outputs:

```toml
[[policy.annotator]]
name = "classify-command"
builtin = "claude-code"
ranks = ["suspicious", "trusted"]
audiences = ["internal"]
marks = []
effects = []
hint = "Hosts under corp.example are the organization's own: what they return is internal. Files under /srv/customer-records are internal."

[[policy.tool]]
name = "Bash"
description = "Runs one shell command and returns its output."
annotator = "classify-command"
```

This configuration forwards the tool name, description, and arguments to Claude Code without requiring a `parameters` schema. If a tool omits `description`, it is omitted from the consult payload.

### Inputs

By default, an annotator receives the complete tool call. Use `inputs` to restrict the payload to specific call attributes. In the example below, the annotator receives only the `customer_id` argument (renamed to `subject`):

```toml
[[policy.annotator]]
name = "classify-customer"
inputs = { subject = "$tool_call.arguments.customer_id" }
ranks = ["suspicious"]
audiences = ["internal"]
marks = []
effects = []
hint = "Classify customer records as internal and suspicious."

[[policy.tool]]
name = "get_customer"
parameters = { type = "object", properties = { customer_id = { type = "string" } }, required = ["customer_id"] }
annotator = "classify-customer"

[externals.annotators.classify-customer]
url = "https://classifier.corp/label"
```

Restricting inputs does not reduce the annotator's response obligations; it must still return a complete annotation. Supported input selectors include:

| Selector | Extracted data |
|---|---|
| `$tool_call` | Full call: name, description (if declared), and argument map. |
| `$tool_call.name` | Tool name string. |
| `$tool_call.description` | Tool description string (requires `description` in the contract). |
| `$tool_call.arguments` | Entire arguments map. |
| `$tool_call.arguments.<name>` | Single top-level argument (must be marked `required` in `parameters`). |

Selected argument values retain their native JSON types as validated by the tool's schema.

### Context providers

Context providers gather external facts about a tool call that cannot be derived from call arguments alone (such as checking repository visibility via GitHub API during a `git push`, or querying ticket metadata during an issue lookup). Configure context providers under `[externals.context.<name>]`.

```toml
[[policy.annotator]]
name = "classify-push"
builtin = "claude-code"

[[policy.tool]]
name = "Bash(command:*git push*)"
annotator = "classify-push"

[externals.context.github]
command = ["python3", "context.py"]
hint = "A push into a public repository requires audience public; into a private one, internal."
```

Before consulting an annotator, OpenAPPA sends concurrent consult requests (`kind = "context"`) to all configured context providers. The `artifact` payload includes `tool`, `arguments`, and `cwd` (if provided by the harness). Providers return `{"version": 1, "answer": <JSON>}` or `null` if the call is not relevant.

OpenAPPA passes provider outputs to the annotator under `artifact.context`, keyed by provider name:

```json
{
  "github": { "answer": { "repository": { "name": "acme/widget", "visibility": "public" } } },
  "tickets": { "error": "timeout" }
}
```

If a provider returns `null`, its key is omitted. If a provider times out, returns an error, or produces invalid JSON, OpenAPPA records an `error` object with the failure reason. Context provider failures never block execution directly; annotators treat missing or failed context as unknown data. Annotators do not receive `cwd`.

An optional `hint` (maximum 2,048 characters) under `[externals.context.<name>]` guides the annotator on interpreting the provider's data. OpenAPPA forwards hints in `declaration.context_hints` whenever the provider returns an answer or error. Context provider answers represent factual data, while hints represent deployment instructions.

Provider answers are arbitrary JSON. Providers SHOULD return factual state rather than security labels (e.g. reporting `visibility: "public"` rather than an audience label). Quoted external text SHOULD include author metadata so annotators can evaluate trust.

OpenAPPA logs context outputs alongside the resulting annotation. Subsequent evaluations that reuse the cached annotation reuse its recorded context without re-querying providers.

### Permits and hint

Annotator permits enforce strict bounds on what an annotator may return:

| Field | Allowed values in response | Default (if omitted) |
|---|---|---|
| `ranks` | Trust ranks permitted in `delta.trust` or `requires.trust`. | All ranks in `trust_chain`. |
| `audiences` | Audiences, group references, selector placeholders, or reader IDs allowed in answers (`public` is always permitted). | All declared policy audiences (`self`, `internal`, named groups, reader IDs). |
| `marks` | Attention marks permitted in `requires.attention`. | All marks declared across tools, authorities, and annotators. |
| `effects` | Effect names permitted in `emits` or `requires.history`. | All effect names declared in the policy. |

`public` is always permitted and must not be listed in `audiences`. Setting `audiences = []` allows only `public` classifications.

An empty list explicitly denies all values for that field (for example, `marks = []` forbids the annotator from attaching attention marks, and `audiences = []` permits only `public`). An omitted field permits any value valid within the policy: omitting `marks` lets the annotator require any mark the policy declares, including `blocked` if the policy uses it.

An annotator may return selector placeholders only if explicitly declared in its `audiences` permit (such as `@github:repo/$owner/$repo/collaborators`). Declaring a placeholder requires all tools bound to the annotator to provide those arguments; consequently, the wildcard tool `*` cannot use an annotator with selector placeholders. In consult requests, OpenAPPA instantiates placeholders into concrete values (e.g. `@github:repo/acme/api/collaborators`), and the annotator must reference only those instantiated values. See [Read a source collection from a tool argument](references/contracts/audiences.md#read-a-source-collection-from-a-tool-argument).

An optional `hint` (maximum 512 characters) provides task-specific classification rules (e.g. mapping specific directory paths or commands to labels). Built-in annotators (`claude-code`, `llm`, `jev`) automatically include OpenAPPA's label guide, so a hint does not restate it. Hints cannot expand configured permits.

An optional deployment-wide hint (`[policy.deployment] hint`, maximum 2,048 characters, root configuration only) defines global environment boundaries, such as internal hostnames or forge domains. OpenAPPA forwards this to all annotators as `declaration.deployment_hint`.

```toml
[policy.deployment]
hint = "Hosts under corp.example and the forge git.corp.example are the organization's own."
```

### Implementing an annotator

Annotators can execute as HTTP services, local executables, or built-in model classifiers. Configure endpoints or executable commands under `[externals.annotators.<name>]`, matching the annotator's policy name.

Built-in annotator engines are configured directly via `builtin` on `[[policy.annotator]]`:
- `builtin = "claude-code"`: Runs local Claude Code (`claude -p`).
- `builtin = "llm"`: Dispatches to the model backend configured under `[externals.llm]`.
- `builtin = "jev"`: Queries TypeSafe's Jev classifier using credentials configured under [`[externals.jev]`](references/contracts/externals.md#jev).

An annotator declaring `builtin` must not define an `[externals.annotators.<name>]` section. Unlike sanitizers and authorities, annotator builtins belong in `[[policy.annotator]]`.

`claude-code` requires the `claude` CLI on `PATH`. On Windows, `claude` must resolve to `claude.exe` (OpenAPPA cannot execute the `claude.cmd` npm shim). `llm` requires `[externals.llm]` configuration. `jev` requires `[externals.jev]` credentials, classifies the entire call object (cannot use `inputs`), and requires a mandate whose `ranks` admit at least two trust ranks. Configurations with missing, unrecognized, or unconfigured builtins are rejected at policy load.

## Recorders

Recorders receive event notifications when tool calls are released, allowing external systems to track state across calls. For example, a file tracker records security labels when files are written via `Write`, enabling its paired annotator to retrieve those labels when `Read` subsequently accesses the files.

Tools bind a recorder using `recorder = "<name>"` (supported on explicit contracts and the `"*"` wildcard). Bind each recorder under `[externals.recorders.<name>]` using `url` or `command`. There is no `[[policy.recorder]]` section; every recorder referenced by a tool contract must have a matching binding under `[externals.recorders]`.

```toml
[[policy.annotator]]
name = "file-tracker"

[[policy.tool]]
name = "host/claude-code/Write"
annotator = "file-tracker"
recorder = "file-tracker"

[externals.annotators.file-tracker]
command = ["appa", "file-tracker", "annotate"]

[externals.recorders.file-tracker]
command = ["appa", "file-tracker", "record"]
```

Recorders operate asynchronously. They cannot block, approve, or delay execution. However, because subsequent annotators may rely on recorded state, recorder components must maintain high integrity.

### Published label

The published label for a released call is the trajectory label at release time combined with the tool's `forwards` and `delta`. For write operations, this captures the label of data available in call arguments. For copy operations, it reflects the source object's label via `delta` even if payload bytes bypassed the agent context. If an input sanitizer rewrites arguments, the published label reflects the post-rewrite trajectory state.

