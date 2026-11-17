## Policy file

OpenAPPA reads its configuration from `appa.toml`.

The configuration consists of two primary sections:
- `[policy]`: Declares the policy version, tool contracts, audience hierarchies, and trust chains.
- `[externals]`: Configures transport bindings (HTTP endpoints or local executables) for external membership services, annotators, sanitizers, authorities, recorders, and context providers, as well as global timeouts and payload limits.

```toml
[policy]
version = 2

[[policy.tool]]
name = "get_ticket_from_crm"
delta = { audience = ["internal"] }

[externals]
timeout_ms = 2000
max_body_bytes = 65536
```

## Tool contracts

Each `[[policy.tool]]` entry defines a contract governing a tool's execution lifecycle:

| Lifecycle stage | Contract field | Description |
|---|---|---|
| Pre-dispatch evaluation | `requires` | Preconditions evaluated against the outbound label (`current_label ⊓ forwards`). Call is blocked if unsatisfied. |
| Pre-dispatch evaluation | `forwards` | Label of content the tool sends beyond its arguments. Combined into the outbound label during pre-dispatch checks. |
| Post-dispatch update | `delta` | Label transition applied to the trajectory after result delivery. Can narrow audience or lower trust; cannot expand permissions. |
| Post-dispatch update | `effects` | Side-effect identifiers appended to trajectory history upon successful execution. |

In the example below, `get_ticket_from_crm` restricts the trajectory audience to `internal` and downgrades trust to `suspicious`. The `send_email` contract requires that all email recipients belong to the trajectory's current audience:

```toml
[[policy.tool]]
name = "get_ticket_from_crm"
description = "Reads a customer support ticket."
delta = { trust = "suspicious", audience = ["internal"] }

[[policy.tool]]
name = "send_email"
parameters = { type = "object", properties = { recipient = { type = "string" }, body = { type = "string" } }, required = ["recipient", "body"] }
requires = { audience = { contains = ["$recipient"] } }
delta = {}
effects = ["egress"]
```

| Field | Description |
|---|---|
| `name` | Tool name, optionally with an argument selector. |
| `description` | Optional description of the tool. Forwarded to annotators. |
| `parameters` | JSON Schema for tool arguments. Required when extracting specific arguments for annotators. |
| `tags` | Category tags used to route blocked calls to matching authorities and sanitizers. See [Tags](#tags). |
| `delta` | Label transition for tool results. Can narrow audience or lower trust; cannot expand permissions. |
| `forwards` | Label of content the tool sends beyond its arguments. Accepts only literal entries (no `$<argument>` placeholders). |
| `requires` | Preconditions for executing the call: audience, trust, effects, or attention requirements. |
| `effects` | Side-effect identifiers recorded in trajectory history after successful execution. |
| `annotator` | Name of a registered [annotator](references/contracts/annotators.md#annotators) that dynamically computes the contract for each call. |
| `recorder` | Name of a registered [recorder](references/contracts/annotators.md#recorders) that receives audit records for released calls. |

If omitted, `delta` and `forwards` add no restrictions, and `requires` imposes no preconditions.

A tool contract uses either static fields (`delta`, `forwards`, `requires`, `effects`) or an `annotator`. Beside an annotator, a tool can declare only a [label floor](references/contracts/annotators.md#annotators); any other static field causes a configuration load error.

OpenAPPA evaluates `requires` before dispatching a tool call. The engine checks the outbound flow label: the trajectory's current label combined with the tool's `forwards`. The tool's `delta` applies only to the returned result, so it does not affect pre-call evaluation.

Use `forwards` when a tool itself sends content that its arguments do not carry. In the example below, `mail_report` reads a server-side report and emails it. Because the report is marked `internal`, mailing it to an external recipient fails the `contains` check regardless of what data the trajectory previously read:

```toml
[[policy.tool]]
name = "mail_report"
parameters = { type = "object", properties = { to = { type = "string" } }, required = ["to"] }
forwards = { audience = ["internal"] }
requires = { audience = { contains = ["$to"] } }
```

### Tool names

Policies identify tools using either host-native names or canonical tool IDs. Canonical IDs use a three-segment format: `<family>/<namespace>/<tool>`. The family must be `mcp`, `host`, or `agent`. Each segment matches `[A-Za-z0-9_.-]+`. Namespace segments must not contain `__`.

| Family | Namespace | Description | Example |
|---|---|---|---|
| `mcp` | Server name | A tool provided by an MCP server. | `mcp/github/create_issue` |
| `host` | Host name | A tool provided natively by the host harness. | `host/claude-code/Bash` |
| `agent` | Deployment namespace | A subagent invoked as a tool. | `agent/kagent/log-analyst` |

`appa/execute_remedy_plan` is the runtime's built-in control tool and the sole member of the `appa` family. Policies cannot declare it; the runtime handles it directly, and any `[[policy.tool]]` entry referencing it causes a configuration load error. The wildcard entry `name = "*"` is not a canonical ID; it acts as a fallback for calls without a matching explicit contract (see [Handling undeclared tools](#handling-undeclared-tools)).

Agents continue using host-native tool names. The runtime adapter maps native tool invocations to canonical IDs for policy evaluation and audit logging, and formats tool names using host syntax when returning suggestions to the agent. Claude Code and kagent use the following mappings:

| Adapter | Raw tool spelling | Canonical tool id |
|---|---|---|
| Claude Code | `mcp__<server>__<tool>` — split at the first `__` after `mcp__` | `mcp/<server>/<tool>` |
| Claude Code | Built-in tools: `Bash`, `Read`, `Edit`, `Agent`, … | `host/claude-code/<name>` |
| Claude Code | `mcp__appa__execute_remedy_plan` (remedy tool for the runtime's internal `appa` server) | `appa/execute_remedy_plan` |
| kagent | Tools discovered from configured MCP endpoints | `mcp/<source-id>/<tool>` |
| kagent | Delegated subagents invoked as tools | `agent/<namespace>/<agent>` |
| kagent | Built-in tools: `ask_user`, `load_memory`, `save_memory`, `prefetch_memory`, or skill tools | `host/kagent/<name>` |
| kagent | Entrypoint gates | `host/kagent-gate/code_execution`, `host/kagent-gate/memory_persist` |
| kagent | Remedy tool | `appa/execute_remedy_plan` |

In Claude Code, names like `Bash` or `mcp__github__create_issue` identify specific tools. In kagent, an unqualified rule such as `name = "read_secret"` matches that native tool name across all connected MCP servers and built-in tools (excluding remote-agent delegation).

Custom hosts embedding the runtime implement an adapter to map incoming calls to canonical IDs and format tool names for the model. See Add to your agent.

Use `server` when a rule must apply strictly to a single MCP connection:

```toml
[[policy.tool]]
name = "read_secret"
server = "demo-tools"
delta = { trust = "suspicious" }
```

This rule matches `mcp/demo-tools/read_secret`. Deployment-level `[aliases]` maps policy namespaces to deployment-specific identifiers:
- `aliases.mcp` maps a server name to configured connection identities (e.g. `databricks = ["genie", "sql"]`), expanding rules under that name to cover each connection.
- `aliases.host` maps a battery's host namespace to the host serving those tools (e.g. `claude-code = ["archestra"]`), translating `host/claude-code/...` rules to `host/archestra/...`.

Aliases resolve after policy composition, preserving root rule precedence over battery rules. OpenAPPA does not infer providers from hostnames or connection metadata. If a host exposes duplicate dispatch names, the host itself must disambiguate them.

#### Canonical tools

Different agent harnesses use different names and argument schemas for the same underlying capability. For example, Claude Code executes shell commands using `Bash` with a `command` argument, while other tools may use `exec_command` with a `cmd` argument. A policy can define rules once for a canonical tool `tool/<namespace>/<tool>`, and `aliases.tool` binds that canonical tool to client-specific tools:

```toml
[aliases.tool.coding]
shell = [
  { name = "host/claude-code/Bash", args = { command = "command" }, confined = true },
  { name = "host/codex/exec_command", args = { command = "cmd" } },
]

[[policy.tool]]
name = "tool/coding/shell(command:*.env*)"
delta = { audience = ["self"] }
```

During composition, OpenAPPA replaces each `tool/...` rule with one concrete rule per mapped client tool at the same position. Each copy references the client tool name (e.g. `host/claude-code/Bash(command:*.env*)` and `host/codex/exec_command(cmd:*.env*)`). The `args` table maps canonical argument names to client-specific argument names, rewriting argument selectors, `$argument` recipients, `@provider:.../$argument` placeholders, and `parameters` schemas.

The runtime never rewrites tool calls. It evaluates tools and arguments exactly as sent by the client, ensuring call digests and audit records remain cryptographically bound to the raw invocation.

`aliases.mcp` and `aliases.host` then resolve the generated rules. Under `aliases.host = { claude-code = ["archestra"] }`, the first rule resolves to `host/archestra/Bash(command:*.env*)`.

The root policy and any battery MAY declare `aliases.tool`, including for a namespace another battery writes rules for. Only root policies may declare `aliases.mcp` and `aliases.host`. The loader rejects the configuration if:
- A rule references an argument that a target does not map.
- A target maps multiple canonical arguments to the same client argument.
- Two mappings in one canonical namespace bind the same client tool after alias resolution.
- A canonical tool mapping defines no client targets.

Two canonical namespaces MAY map the same client tool. Their rules then apply in include order, and the first matching rule wins. A `tool/...` rule with no alias binding remains inactive, and a mapping for a namespace no rule names binds nothing; OpenAPPA logs both at load. `confined_results` accepts only client-specific tool names; setting `confined = true` on a target alias automatically adds that client tool to `confined_results`.

Annotators and context providers always receive the native call. Argument placeholders in `audiences` and `inputs` refer to native argument names and are not translated by alias mappings. Code-based annotators that expect canonical argument names will receive missing arguments when invoked by clients with different native schemas. Model-backed annotators inspect the entire call object and adapt to native schemas.

kagent derives a default source ID from the configured endpoint URL. Native rules do not require that ID. Tool discovery observes available tools but does not grant authority: discovered tools still require policy coverage, and all calls undergo runtime policy evaluation. Trajectories retain accepted tool identities and evaluate them against the active deployment policy.

Native names also work in `confined_results`, `assumed_tools`, and `provider_run_tools`. Coverage reports distinguish a rule spanning servers from an observed concrete tool. Overlapping declarations with incompatible provider-run execution settings are rejected.

Adapters automatically detect tool calls that spawn child trajectories (such as Claude Code's `Agent` or kagent delegated agents); policies do not need to declare spawn behavior.

### Tags

Tags route blocked tool calls to matching authorities and sanitizers. For example, this contract assigns the `support` tag to a CRM tool:

```toml
[[policy.tool]]
name = "get_ticket_from_crm"
tags = ["support"]
delta = { audience = ["internal"] }
```

An authority or sanitizer specifying `tags = ["support"]` applies to any tool carrying that tag. If multiple tags are listed, matching any single tag suffices. If an authority or sanitizer omits `tags`, it applies across all tools (subject to its configured permissions).

Attention approvals follow a different mechanism: OpenAPPA matches authorities for attention marks by `permits.attention`, ignoring tool tags. See [Attention](references/contracts/labels.md#attention).

### Pattern matching

A policy can declare multiple contracts for the same tool. OpenAPPA evaluates contracts sequentially in declaration order and selects the first match. This applies across overlapping native and canonical names; canonical names receive no special precedence.

In the example below, the first contract matches `path` values starting with `/docs/` and labels results as `public`. The second contract matches all other calls to `read_file` and labels results as `internal`:

```toml
[[policy.tool]]
name = "read_file(path:/docs/*)"
delta = { audience = ["public"] }

[[policy.tool]]
name = "read_file"
delta = { audience = ["internal"] }
```

Argument selectors filter on top-level string arguments and arrays of strings. Specify selectors in parentheses after the tool name using comma-separated `argument:pattern` pairs. Each argument may appear only once, in any order.

Each pattern must match the entire argument value. For array arguments, the selector matches only if the array is non-empty and every element matches the pattern (for example, `edit_agent(teams:*)` matches any non-empty array of strings). If an argument is missing, null, an empty array, or a non-string type, the selector does not match.

```toml
[[policy.tool]]
name = "mcp__github__fork_repository(owner:archestra-ai,repo:website)"
requires = { trust = "trusted" }
delta = {}
```

Use `*` to match any sequence of characters (including an empty sequence):

| Pattern | Matches | Does not match |
|---|---|---|
| `report.txt` | `report.txt` | `old-report.txt` |
| `/docs/*` | `/docs/guide.md`, `/docs/setup/install.md` | `/private/guide.md` |
| `*.md` | `guide.md`, `/docs/guide.md` | `guide.txt` |

Because `*` matches `/`, `?`, and `#`, avoid using wildcards within URL hostnames: `https://*.example.com/*` matches `https://attacker.test/?x=.example.com/`. Instead, terminate each hostname with `/` and specify subdomains explicitly (e.g. `https://docs.example.com/*`). OpenAPPA logs a warning at policy load if a wildcard appears within a URL host pattern.

#### Match one of several values

Use `|` to separate alternatives in a pattern. A string argument matches if it satisfies any alternative. An array argument matches if every element satisfies at least one alternative (different elements can match different alternatives). Each alternative must match the full value and may contain `*`.

For example, this contract matches Python package installations where all entries in `hosts` come from designated PyPI domains:

```toml
[[policy.tool]]
name = "install(hosts:pypi.org|files.pythonhosted.org)"
delta = {}
```

A call whose `hosts` array includes `evil.example` does not match, because that element satisfies no alternative. Specify hostnames explicitly whenever a wildcard could match untrusted domains.

#### Match special characters literally

To match special characters (`*`, `)`, `,`, `\`, `|`) literally, escape them with a backslash:

| Character to match | Escape sequence |
|---|---|
| Asterisk (`*`) | `\*` |
| Closing parenthesis (`)`) | `\)` |
| Comma (`,`) | `\,` |
| Backslash (`\`) | `\\` |
| Pipe (`\|`) | `\|` |

For example, this contract matches a `search` call where `query` is exactly `a,b`:

```toml
[[policy.tool]]
name = 'search(query:a\,b)'
delta = {}
```

Use single-quoted string literals in TOML to preserve backslashes verbatim. In double-quoted strings, backslashes must be doubled (`"search(query:a\\,b)"`).

Only the five escape sequences listed above are supported. Other escape sequences cause a configuration load error.

OpenAPPA selects a contract before validating its `parameters` schema. If schema validation fails, the call is rejected; the engine does not fall through to subsequent contracts. If a sanitizer rewrites call arguments, the new arguments undergo fresh contract selection. See [Sanitizers](references/contracts/sanitizers-authorities.md#sanitizers).

### Handling undeclared tools

The wildcard tool contract `name = "*"` routes any call that lacks an explicit matching contract through a dynamic annotator. This includes calls to declared tools whose argument selectors did not match:

```toml
[[policy.annotator]]
name = "classify_unknown_tool"
ranks = ["suspicious"]

[[policy.tool]]
name = "*"
annotator = "classify_unknown_tool"
```

A policy may declare at most one wildcard entry. The wildcard contract requires an `annotator`. Beside it, the wildcard can declare only a [label floor](references/contracts/annotators.md#annotators); it cannot define other static fields, metadata, or argument selectors.

Explicit tool contracts always take precedence over the wildcard, regardless of declaration order. If an explicit contract matches but fails argument schema validation, the engine rejects the call rather than falling back to the wildcard. If no wildcard is configured, any call lacking a matching contract is denied immediately.

## Include policy files

Use `include` to compose modular policy fragments into a root configuration. Declare `include` at the top of `appa.toml`, outside `[policy]` and `[externals]`:

```toml
include = ["battery.toml"]

[policy]
version = 2

[externals]
timeout_ms = 2000
max_body_bytes = 65536
```

Entries can also use wildcards to include all policy files in a directory (e.g. `mcp/*.toml`), allowing teams to add modular policies without modifying the root configuration:

```toml
include = [
  "batteries/github/appa.toml",
  "mcp/*.toml",
]
```

Wildcard paths must place `*` strictly in the filename portion and must end with `.toml`. Matching files are loaded at that position in alphabetical order:
- Only regular files match. Hidden files, directories, and symlinks are ignored.
- Target directories must reside within the root configuration directory. Directory traversal (`..`) is prohibited.
- Missing directories match zero files.
- The root policy file never matches its own wildcard pattern.
- Explicitly named files load only at their specific entry and are not duplicated by wildcards.
- Hosted policies cannot use directory wildcards.

OpenAPPA evaluates root declarations before included files, processing included files in the order listed under `include`:
- Included files cannot include other files.
- Included files cannot override deployment-wide settings. The sole exception is `confined_results` under `[policy.deployment]`: included files may append tools they declare. Included files must not set `[policy.deployment] hint`.
- Root declarations for `[[policy.annotator]]` or `[[policy.sanitizer]]` replace included components sharing the same name. Omitted fields in the replacement are not inherited.
- Multiple included files cannot declare the same annotator name.
- Multiple files cannot configure the same external component name within the same category (e.g. two `[externals.sanitizers.clean]` blocks).

See Batteries for pre-packaged policy bundles.

## Deployment coverage

Deployment settings declare the interception and confinement capabilities supported by the agent integration:

```toml
[policy.deployment]
confined_results = ["get_ticket_from_crm"]
context_control = true

[[policy.tool]]
name = "get_ticket_from_crm"
delta = { audience = ["internal"] }
```

`confined_results` lists tools whose result payloads the harness can intercept and withhold from the agent context. If a tool in `confined_results` declares effects and produces a restricted result, OpenAPPA can offer a withhold plan before invocation.

`context_control = true` asserts that the integration can isolate child agent execution and withhold return payloads until approved by policy. This enables pre-return validation and sanitization. The underlying harness must implement context isolation; setting this flag asserts capability but does not synthesize it.

Constraints:
- A `tool_output` sanitizer requires either a tool listed in `confined_results` or a child return governed by `context_control = true`.
- Every tool listed in `confined_results` must have a corresponding policy contract (explicit or wildcard).
- Provider-executed tools (tools executed within remote model infrastructure where outputs cannot be intercepted prior to inference) support static `delta` declarations only. They cannot declare preconditions, annotators, or argument selectors, and must not appear in `confined_results`.

OpenAPPA rejects configurations requiring integration capabilities that the deployment does not provide. See integration configuration.

