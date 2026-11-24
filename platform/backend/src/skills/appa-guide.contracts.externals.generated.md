## Externals

The `[externals]` section configures transport bindings for policy components. Each component is defined under `[externals.<kind>.<name>]`, where `<kind>` specifies the component type (`authorities`, `sanitizers`, `annotators`, `recorders`, `audience`, or `context`) and `<name>` matches the policy declaration.

In the example below, approval requests for `support-reviewer` route to an HTTP endpoint with a 2-second timeout and a 64 KiB response cap:

```toml
[externals]
timeout_ms = 2000
max_body_bytes = 65536

[externals.authorities.support-reviewer]
url = "https://approver.corp/rule"
token_env = "APPA_APPROVER_TOKEN"
```

Deployment settings:
- `timeout_ms`: Maximum execution time per consult request (default: 5,000 ms).
- `max_body_bytes`: Maximum accepted response payload size (default: 65,536 bytes).
- `review_timeout_ms`: Maximum duration human review requests remain pending (default: 600,000 ms).

These settings apply to the whole deployment; a binding cannot override them. [Model implementations](#model-implementations) and [Jev](#jev) configure their own `timeout_ms` and `max_concurrent` limits in their own sections. `max_concurrent` bounds concurrent requests to a backend across all active sessions.

Implementation requirements by component type:

| Component kind | Transport options | Binding requirement |
|---|---|---|
| `authorities` | Exactly one of `url`, `command`, or `builtin`. | Optional. Unbound authorities return no answer. |
| `sanitizers` | Exactly one of `url`, `command`, or `builtin`. | Required (except for internal `attest-schema`). |
| `annotators` | Exactly one of `url` or `command`. | Required unless declaring a `builtin` on the annotator. |
| `context` | Exactly one of `url` or `command`. | Optional. Queried for every call requiring dynamic annotation. |
| `recorders` | Exactly one of `url` or `command`. | Required for every recorder referenced by a tool contract. |
| `audience` | Exactly one of `url`, `command`, or `readers`; requires `selectors` on `url` or `command`; optional `lookup`. | Required for each referenced provider and lookup target. Non-empty `readers` tables are valid only on lookup targets. |

OpenAPPA rejects declared components missing required bindings, and an authority binding that no declaration names. A sanitizer, annotator, recorder, or audience binding that no declaration names stays idle, so a root can bind the components of a battery it may include. For annotators, `builtin` is declared on `[[policy.annotator]]` rather than under `[externals]`.

Included files may add external bindings and annotator builtins, as well as `[externals.jev]` configuration. Included files cannot override root settings for `timeout_ms`, `max_body_bytes`, `review_timeout_ms`, `[externals.claude_code]`, or `[externals.llm]`.

### HTTP services

Set `url` to the service endpoint. Remote services must use HTTPS; unencrypted HTTP is permitted only for loopback addresses (such as `127.0.0.1`). Credentials must not be embedded in the URL.

If the endpoint requires authentication, set `token_env` to the name of an environment variable (e.g. `APPA_SANITIZER_TOKEN`). OpenAPPA forwards the variable's value as an HTTP `Bearer` token. Variable names must start with `APPA_` and must not begin with `APPA_PROVIDER_`.

### Local programs

Set `command` to an array specifying the executable and arguments (e.g. `command = ["python3", "./sanitize.py"]`). OpenAPPA executes the process directly without an intermediate shell, launching it with the configuration directory as its working directory and terminating child processes upon completion. Commands referencing `appa` invoke the runtime's own binary to execute built-in plugins (such as `appa file-tracker`).

Commands read a single JSON consult request from standard input and write a JSON response to standard output within `timeout_ms` and `max_body_bytes`. When OpenAPPA reaches the end of standard output, it closes standard input, so a command that needs the whole request must read it before it closes standard output. `APPA_CONSULT_TIMEOUT_MS` informs the process of remaining execution time (accounting for queue wait). The runtime limits concurrent local program executions to eight.

If a command requires credentials, specify `token_env` with an environment variable name prefixed with `APPA_PROVIDER_`. OpenAPPA passes that variable into the process environment while filtering out other internal `APPA_*` variables. On Windows, where variable names ignore case, the filter also ignores case.

OpenAPPA does not require credential variables to be present at policy load time; the process must handle missing credentials at runtime.

### Model implementations

The `claude-code` and `llm` backends dispatch consult requests to language models. OpenAPPA injects fixed instructions and `declaration` constraints into the system prompt, including the label guide for annotators. Call data in `artifact` is sent as user content.

Before dispatching annotator requests to external model providers (`claude-code`, `llm`, or `jev`), OpenAPPA automatically redacts detected credentials in `artifact.args` using the built-in secret detector. Fields matching credential keywords (`password`, `token`, `secret`, `api_key`, `credential`, etc.) or high-entropy tokens are replaced with `[redacted-secret]`. In nested object keys, OpenAPPA also replaces private keys, URL passwords, known API tokens, and AWS secret keys. Keys that become equal get a `-2`, `-3`, … suffix, so no entry is lost. The tool name of the complete call stays as written when the declaration that judges the call names that tool exactly. When the call matches a pattern or the `*` wildcard, the tool name is redacted like any other string. Redaction is best effort. Authority and sanitizer payloads are not redacted, as sanitizers require raw text for processing.

OpenAPPA checks authority and annotator answers against their permits and assigns sanitized data the declared audience or trust rank. The model is responsible for making the correct judgment or removing the required content.

OpenAPPA derives expected response schemas from the component's declaration. Model backends return the inner `answer` object directly.

`[externals.claude_code]` configures the local Claude Code process:

| Field | Description | Default |
|---|---|---|
| `command` | Executable path. | `claude` |
| `model` | Target model name. | `sonnet` |
| `timeout_ms` | Per-request timeout including queue wait. | `60000` |
| `max_concurrent` | Maximum concurrent processes. | `4` |

Each consult spawns a fresh `claude -p` process in a temporary working directory with project settings and tools disabled.

`[externals.llm]` configures direct API integrations for `builtin = "llm"` components:

```toml
[externals.llm]
provider = "anthropic"
model = "claude-sonnet-4-5"
token_env = "APPA_LLM_TOKEN"
timeout_ms = 30000
max_concurrent = 4
# Optional endpoint override:
# url = "https://gateway.corp/v1"
```

Supported providers are `anthropic`, `openai`, `gemini`, and `ollama`. `token_env` specifies the environment variable holding the API key. `url` optionally overrides the provider endpoint. `timeout_ms` defaults to 60,000 ms, and `max_concurrent` defaults to 4.

Deployments referencing `builtin = "llm"` initialize only if the required API token is set in the environment (or if using `ollama` without authentication). An unused `[externals.llm]` section does not require an API key to load.

Transient failures (connection errors, HTTP 429, or HTTP 5xx) are retried with a 500 ms backoff, up to three attempts in total, if `timeout_ms` permits.

Requests use provider default temperature and sampling parameters. `openai` uses the Chat Completions API. `ollama` defaults to `http://localhost:11434` without authentication.

### Jev

The `[externals.jev]` section configures TypeSafe's Jev classifier for `builtin = "jev"` annotators:

```toml
[externals.jev]
token_env = "APPA_PROVIDER_JEV_API_KEY"
# Optional limits:
# timeout_ms = 2000
# max_concurrent = 16
```

| Field | Description |
|---|---|
| `token_env` | Environment variable holding the TypeSafe API key. Required; must start with `APPA_`. |
| `timeout_ms` | Request timeout including queue wait. Defaults to global `timeout_ms` (minimum: 550 ms). |
| `max_concurrent` | Maximum concurrent requests across the runtime (default: 16). |

Battery policies shipping Jev annotators declare `token_env` only; root policies can supply `timeout_ms` and `max_concurrent`. OpenAPPA sends requests strictly to `https://api.typesafe.ai/v1/systemone` (or the URL specified by `APPA_PROVIDER_JEV_API_URL` in the process environment).

Deployments declaring a `jev` annotator initialize only if the configured API key variable is set. An unused `[externals.jev]` section loads without an API key.

Each consult transmits the tool name, description, and arguments with credentials redacted as described in [Model implementations](#model-implementations). Payloads exceeding 64 KiB are rejected. Consult records retain diagnostic probabilities under `jev_diagnostics`.
