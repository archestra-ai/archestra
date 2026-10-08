## Externals

The `[externals]` sections tell OpenAPPA how to call the components declared in the policy. Each component uses `[externals.<kind>.<name>]`, where `kind` identifies its role and `name` matches its policy declaration. This connection is called a binding.

In the example below, OpenAPPA sends approval requests for `support-reviewer` to an HTTP service. The shared settings limit requests to two seconds and responses to 65,536 bytes:

```toml
[externals]
timeout_ms = 2000
max_body_bytes = 65536

[externals.authorities.support-reviewer]
url = "https://approver.corp/rule"
token_env = "APPA_APPROVER_TOKEN"
```

`timeout_ms` limits the time an endpoint or command has to answer one request. `max_body_bytes` limits the accepted response size. These settings apply to the whole deployment. Each [model implementation](#model-implementations) and [Jev](#jev) has its own `timeout_ms` and `max_concurrent` in its own section. `max_concurrent` limits the requests of one implementation across the whole runtime, all sessions included. A reload that OpenAPPA accepts applies a changed value to later requests of every session. Requests that already run or wait finish under the previous limit.

The available settings depend on the component's role:

| Component kind | Implementation setting | Requirement |
|---|---|---|
| `authorities` | Exactly one of `url`, `command`, or `builtin`. | Optional. Without a binding, the authority returns no answer. |
| `sanitizers` | Exactly one of `url`, `command`, or `builtin`. | Required, except for `attest-schema`. |
| `annotators` | Exactly one of `url` or `command`. | Required unless the declaration specifies a builtin. |
| `context` | Exactly one of `url` or `command`. | Optional. Each configured provider is asked about every call that needs a new annotation. |
| `audience` | Exactly one of `url`, `command`, or `readers`; `selectors` on a `url` or `command` entry; optional `lookup`. | Required for each referenced provider and each `lookup` target. `readers` is allowed only on a `lookup` target. |

OpenAPPA rejects an external component name that the policy does not declare, or a component that is missing its required implementation. For annotators, `builtin` belongs on `[[policy.annotator]]`, not under `[externals]`.

Included files can add bindings and annotator builtins. An included file may add `[externals.jev]`, and the section combines field by field: each field is declared by one file only. They cannot replace root settings: `timeout_ms`, `max_body_bytes`, `review_timeout_ms`, `[externals.claude_code]`, or `[externals.llm]`.

### HTTP services

Set `url` to the service endpoint. Use HTTPS for remote services. Plain HTTP is allowed only for a service on the same machine, at a loopback address such as `127.0.0.1`. Do not put a username or password in the URL.

If the service requires authentication, set `token_env` to an environment variable such as `APPA_SANITIZER_TOKEN`. OpenAPPA reads its value and sends it as a bearer token. The variable name must start with `APPA_`, but cannot start with `APPA_PROVIDER_`.

### Local programs

Set `command` to a list containing the executable and its arguments, such as `command = ["python3", "./sanitize.py"]`. OpenAPPA runs the program on the same machine, without a shell, and ends every process it started when the request completes. The shipped batteries run `python3`, which Windows does not always provide. It starts the program in the directory containing the configuration file.

The program reads one JSON consult request from standard input and writes one JSON response to standard output. It must respond within `timeout_ms`, and its response must fit within `max_body_bytes`. Each OpenAPPA instance runs at most eight such programs at once.

If the program needs a credential, set `token_env` to an environment variable whose name starts with `APPA_PROVIDER_`. OpenAPPA passes that variable to the program. It does not pass other `APPA_*` variables, including its own credentials.

OpenAPPA does not require this variable when loading the policy. The program must handle a missing credential when it runs.

### Model implementations

The `claude-code` and `llm` implementations send the component's instructions and request data to a model. OpenAPPA puts fixed instructions and `declaration` in the system prompt. For an annotator, the fixed instructions include the label guide: the rule and the criteria for each trust and audience leaf, and worked example calls, each with the annotation it gets under the annotator's permits. An example whose labels the permits exclude is left out. OpenAPPA sends `artifact` as the user message, to be processed as data.

Before an annotator request leaves for a model provider, OpenAPPA redacts what it recognizes as a secret in `artifact.args`. This applies to `claude-code`, `llm`, and `jev`. Each string goes through the detector of `builtin = "redact-secrets"`. The whole value of a field whose name contains `password`, `passwd`, `passphrase`, `secret`, `token`, `api_key`, `private_key`, `access_key`, `authorization`, `cookie`, or `credential`, or is `auth`, is replaced. Each secret becomes `[redacted-secret]`. The tool name is not redacted. Redaction is best effort, not a proof that no secret remains. Authority and sanitizer requests are not redacted, because a sanitizer must see the value it cleans. The consult record keeps the request before redaction.

OpenAPPA builds the expected response format from the declaration. The model returns only the contents of `answer`, without the surrounding `version` and `answer` fields.

OpenAPPA checks authority and annotator answers against their permits and assigns sanitized data the declared audience or trust rank. The model is responsible for making the correct judgment or removing the required content.

`[externals.claude_code]` configures the local Claude Code implementation:

| Field | Purpose |
|---|---|
| `command` | Selects the executable. Default: `claude`. |
| `model` | Selects the model. Default: `sonnet`. |
| `timeout_ms` | Sets the timeout for one request, including its wait for a free slot. Default: 60,000. |
| `max_concurrent` | Sets how many requests the runtime runs at once. Default: 4. |

Each request starts a new `claude -p` process. It cannot use tools, load project settings, or reuse a previous conversation. It runs in a new temporary directory with optional background traffic disabled and receives no `APPA_*` environment variables.

`[externals.llm]` selects the model used by all `builtin = "llm"` components. This example uses an Anthropic model, a token from `APPA_LLM_TOKEN`, a 30-second timeout, and up to four concurrent requests:

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

Supported providers are `anthropic`, `openai`, `gemini`, and `ollama`. `token_env` follows the rules of [HTTP services](#http-services). An optional `url` selects a custom endpoint and follows the same URL rules. `timeout_ms` defaults to 60,000 and includes the wait for a free slot. `max_concurrent` defaults to 4.

A deployment in which any component uses `builtin = "llm"` opens only when the section's key is available: `token_env` names a variable that is set, or the provider is `ollama` and the section names no `token_env`. A section that no component uses loads without its key.

An `llm` request that fails with a connection error, status 429, or a 5xx status is retried 500 ms later, at most three attempts in total. A retry starts only when `timeout_ms` leaves time for it. Other failures are not retried. Each attempt takes a free slot, and the wait before a retry holds none.

`openai` uses the Chat Completions API, including when `url` points to a compatible service. `ollama` uses `http://localhost:11434` unless `url` specifies another endpoint, and requires no token.

### Jev

`[externals.jev]` names the key used by all `builtin = "jev"` annotators:

```toml
[externals.jev]
token_env = "APPA_PROVIDER_JEV_API_KEY"
# Optional limits:
# timeout_ms = 2000
# max_concurrent = 16
```

| Field | Purpose |
|---|---|
| `token_env` | Names the variable that holds the TypeSafe API key. Required. Must start with `APPA_`. |
| `timeout_ms` | Sets the timeout for one request, including its wait for a free slot. Default: the shared `timeout_ms`. Minimum: 550; OpenAPPA rejects a smaller value, inherited or declared. |
| `max_concurrent` | Sets how many requests the runtime runs at once. Default: 16. |

A battery that ships this section declares `token_env` only. The root config can then declare `[externals.jev]` with `timeout_ms` or `max_concurrent`, and the section takes the key from the battery and the limits from the root. OpenAPPA rejects a second `token_env`, from the root or from another battery, and a section in which no file declares `token_env`. OpenAPPA sends the key only to TypeSafe's API at `https://api.typesafe.ai/v1/systemone`. A configuration cannot name another endpoint. The operator can set `APPA_PROVIDER_JEV_API_URL` in the OpenAPPA process environment, following the URL rules of [HTTP services](#http-services).

A deployment that declares a `jev` annotator opens only when the key's variable is set. A reload that OpenAPPA refuses leaves the running deployment serving. A section that no annotator uses loads without its key.

Each consult sends the tool's name, description, and arguments to that endpoint, with secrets redacted as for every model provider; see [Model implementations](#model-implementations). A consult larger than 64 KiB is not sent and gets no answer. A slow request is repeated on a new connection, and a server error or a connection failure is retried, within `timeout_ms`. The consult record carries the attempts and the label probabilities under `jev_diagnostics`.
