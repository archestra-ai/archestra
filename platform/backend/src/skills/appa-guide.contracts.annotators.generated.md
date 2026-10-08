## Annotators

An annotator classifies a tool call. It can determine the call's output restrictions (`delta`), requirements (`requires`), and effects. The `jev` builtin determines audience and trust only: no effects, history, or attention marks. OpenAPPA checks the resulting contract before allowing the call.

Use an annotator when a script or service must determine the rules for a call. For example, a script can classify files by directory: files in `/srv/public-docs` can be shared publicly, while files in `/srv/customer-records` are restricted to internal users.

A tool selects one annotator with `annotator = "<name>"`. The annotator supplies `delta`, `requires` (including attention marks), and emitted effects. A `jev` annotator supplies audience and trust only, so its effects, `requires.history`, and `requires.attention` are always empty. Do not also declare these fields on that tool.

### Example: annotate a tool call with Claude Code

The example below uses the built-in Claude Code classifier to annotate calls to `Bash`. It receives the complete tool call and uses the `hint` to determine its restrictions and requirements. The `ranks`, `audiences`, `marks`, and `effects` fields limit what it can return.

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

This configuration sends the tool name, description, and arguments to Claude Code. It does not require a `parameters` schema. If the tool has no description, the request omits it.

### Inputs

By default, the annotator receives the complete tool call. Use `inputs` when it needs only specific parts of the call. In the example below, the annotator receives the `customer_id` argument under the name `subject`, instead of receiving the tool name, description, and all arguments:

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

Selecting fewer inputs does not change the response requirements: the annotator still supplies the complete annotation. Each input can select one of the following:

| Input value | Selected data |
|---|---|
| `$tool_call` | Complete call: name, optional description, and arguments. |
| `$tool_call.name` | Tool name. |
| `$tool_call.description` | The tool's description. The tool contract must declare `description`. |
| `$tool_call.arguments` | Complete argument object. |
| `$tool_call.arguments.<name>` | One top-level argument. The tool's `parameters` schema must declare it as required. |

A selected argument can contain any JSON value permitted by its schema.

### Context providers

A context provider is a program the deployment runs to find facts about a call that the call does not state. Configure each one under `[externals.context.<name>]`. For example, which readers a `git push` reaches is the visibility of the repository, and who wrote a pull request's comments is in the repository's history. The provider finds these facts, and the annotator classifies from them instead of guessing.

```toml
[[policy.annotator]]
name = "classify-push"
builtin = "claude-code"
hint = "`context.github` is the deployment's own finding. A push into a public repository requires audience public; into a private one, internal."

[[policy.tool]]
name = "Bash(command:*git push*)"
annotator = "classify-push"

[externals.context.github]
command = ["python3", "context.py"]
```

Before OpenAPPA asks an annotator for a new annotation, it sends every configured context provider one consult request with `kind = "context"`. The requests run concurrently. `declaration` is empty. `artifact` carries the call: `tool`, `arguments`, and `cwd`, the directory the harness would run the call in, when the harness reports one. The provider returns `{"version": 1, "answer": <any JSON value>}`. A provider that has nothing to say about the call answers `null`.

OpenAPPA gives every annotator the answers in `artifact.context`, one entry per provider name:

```json
{
  "github": { "answer": { "repository": { "name": "acme/widget", "visibility": "public" } } },
  "tickets": { "error": "timeout" }
}
```

A provider that answers `null` has no entry. A provider that fails, does not answer in time, or answers an invalid response gets an `error` entry with the reason. A context provider never stops a call: the annotator is asked in every case, and it classifies a missing fact as unknown. The annotator never sees `cwd`.

The answer is free-form JSON, and OpenAPPA does not validate it. An answer SHOULD state facts, not labels: a repository's visibility, not an audience. Text an answer quotes, such as a table description, SHOULD carry its author, because the annotator judges trust by who wrote the text.

OpenAPPA records the context with the annotation it produced. A later decision that reuses the annotation reuses its context and does not ask the providers again. A battery can configure a context provider, as the `github` battery does.

### Permits and hint

An annotator's permits limit the values it can use in its answers. The following fields define these limits:

| Field | Allowed values in an answer | If omitted |
|---|---|---|
| `ranks` | Ranks used in `delta.trust` or `requires.trust`. | Every rank in the trust chain. |
| `audiences` | Built-in audiences, `@` references, selector placeholders, or literal reader IDs that the answer may use. | `self`, `internal`, named groups, and reader IDs declared in the policy. |
| `marks` | Required attention marks. | Every mark the policy declares: in a tool's `requires.attention`, an authority's `permits.attention`, or another annotator's `marks`. |
| `effects` | Effects that the call may record or require. | Every effect name declared by the policy. |

`public` is always allowed in an answer, so it is not listed in `audiences`. Setting `audiences = []` allows only public answers.

An annotator can use a selector placeholder only when its own `audiences` lists it. A selector placeholder in `audiences`, such as `@github:repo/$owner/$repo/collaborators`, is instantiated for each call. Every `$<argument_name>` in it becomes a required top-level string (or array of strings) argument of every tool that uses the annotator, so the wildcard `*` tool, whose arguments the policy does not describe, cannot use such an annotator. The consult request and the answer schema list the concrete spellings for that call, such as `@github:repo/acme/api/collaborators`, one per element of an array argument, and the answer MAY use only those spellings. The annotator can answer about the resource the call names and about no other. See [Read a source collection from a tool argument](references/contracts/audiences.md#read-a-source-collection-from-a-tool-argument) for the placeholder rules.

An empty list and an omitted field have different meanings. For example, `marks = []` prevents the annotator from requiring attention. Omitting `marks` allows it to use any mark the policy declares, `blocked` included; a catch-all `["*"]` permit declares no mark of its own.

The optional `hint` tells the annotator what the deployment knows about its calls: which hosts are its own, which paths hold whose data, what a context provider's answer means. It can give examples. Every annotator builtin (`claude-code`, `llm`, `jev`) already applies OpenAPPA's label guide: the rule and the criteria for each trust and audience leaf, with worked examples. A hint does not restate the guide. For `claude-code` and `llm`, the hint overrides the guide where the two disagree. `jev` adds the hint to each of its four questions, after the guide's rule for that question. It cannot allow values excluded by the permits and cannot exceed 512 characters. An annotator name must be non-empty and can contain dots.

### Implementing an annotator

An annotator can be an HTTP service or a local program. Configure its `url` or `command` under `[externals.annotators.<name>]`, where `<name>` matches the annotator's declaration.

Alternatively, use a built-in annotator. The available options are:

- `builtin = "claude-code"`: uses Claude Code to classify tool calls.
- `builtin = "llm"`: uses the model configured under `[externals.llm]` to classify tool calls.
- `builtin = "jev"`: asks TypeSafe's Jev classifier, with the key named under [`[externals.jev]`](references/contracts/externals.md#jev), to label each call's audience and trust.

Set `builtin` on `[[policy.annotator]]`, as in the Claude Code example above. An annotator with `builtin` cannot also have an `[externals.annotators.<name>]` section. Unlike sanitizers and authorities, annotators do not accept `builtin` under `[externals]`.

`claude-code` runs the local `claude` command and requires Claude Code on the machine running OpenAPPA. On Windows, `claude` must resolve to `claude.exe`: OpenAPPA cannot start the `claude.cmd` shim that npm installs. `llm` requires model settings under `[externals.llm]` and the key they name. `jev` requires `[externals.jev]` and its key, judges the complete call, so its annotator cannot declare `inputs`, and needs a mandate that admits at least two trust ranks. OpenAPPA rejects a configuration with a missing implementation, an unknown implementation name, or a model implementation whose key is not set.

