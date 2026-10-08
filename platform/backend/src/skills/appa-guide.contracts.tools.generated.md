## Policy file

OpenAPPA reads its configuration from an `appa.toml` file.

The file defines rules for the agent's tools. For example, a rule can restrict customer records to company members. These rules belong under `[policy]`.

Some rules need an external component to resolve group membership or remove private data. The `[externals]` section configures how OpenAPPA calls these components and other deployment settings, such as response size limits and timeouts.

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

Each `[[policy.tool]]` entry is a tool contract. It answers three questions:

| Field | What to write | What OpenAPPA does |
|---|---|---|
| `delta` | Restrictions carried by the tool's result. | Applies those restrictions when the agent receives the result. |
| `requires` | Conditions the call must satisfy. | Checks them before allowing the call. |
| `effects` | Side effects of a successful call. | Records them in the trajectory's history. |

In the example below, the `get_ticket_from_crm` tool contract restricts the trajectory to `internal` and lowers its trust to `suspicious`. The `send_email` tool contract requires the email recipient to belong to the current audience.

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

| Field | Configuration rule |
|---|---|
| `name` | The tool name, optionally with an argument selector. |
| `description` | Optional description of the tool. Annotators can receive this description. |
| `parameters` | JSON Schema for the tool arguments. Some input mappings require it. |
| `tags` | Names used to select applicable authorities and sanitizers. See [Tags](#tags). |
| `delta` | Can restrict the audience or lower trust. It cannot make the trajectory less restricted. |
| `requires` | Audience, trust, effects, or attention requirements for the call. |
| `effects` | Effect names recorded after successful execution. Declare all relevant side effects. |
| `annotator` | A registered component that supplies the complete annotation for each call. |

An omitted `delta` adds no restriction. An omitted `requires` adds no requirement.

Only one source of contract rules is allowed: static `delta`, `requires`, and `effects` fields, or an `annotator`. Combining them causes a load error.

OpenAPPA checks both `delta` and `requires` before allowing the tool call.

### Tool names

A policy can use a host-native name or a canonical tool id. Canonical ids have three segments: `<family>/<namespace>/<tool>`. The family is `mcp`, `host`, or `agent`. Each segment matches `[A-Za-z0-9_.-]+`. A namespace segment never contains `__`.

| Family | Names | Example |
|---|---|---|
| `mcp` | One tool of one MCP server. The namespace is the server. | `mcp/github/create_issue` |
| `host` | A tool the host itself provides. The namespace is the host. | `host/claude-code/Bash` |
| `agent` | An agent called as a tool. The namespace is where the agent lives. | `agent/kagent/log-analyst` |

`appa/execute_remedy_plan` is the runtime's own control tool, the one member of the `appa` family. A policy cannot declare it: the runtime recognizes it before any contract, and a `[[policy.tool]]` entry that names it refuses the policy at load. The wildcard entry `name = "*"` is not a canonical id; it covers every call without a matching explicit tool contract (see [the wildcard](#handling-undeclared-tools)).

The agent keeps using its host's tool names. A plugin implements the host lifecycle; the runtime's adapter translates tool identities and events. The runtime records canonical ids, even when the policy uses native names. Where it tells the model to run a tool, it uses the host's dispatch spelling. Claude Code and kagent have these mappings:

| Adapter | Raw tool spelling | Canonical tool id |
|---|---|---|
| Claude Code | `mcp__<server>__<tool>` — split at the first `__` after `mcp__` | `mcp/<server>/<tool>` |
| Claude Code | A built-in tool: `Bash`, `Read`, `Edit`, `Agent`, … | `host/claude-code/<name>` |
| Claude Code | `mcp__appa__execute_remedy_plan`, the remedy tool of the runtime's own `appa` MCP server | `appa/execute_remedy_plan` |
| kagent | A tool discovered from a configured MCP endpoint | `mcp/<source-id>/<tool>` |
| kagent | An agent called as a tool | `agent/<namespace>/<agent>` |
| kagent | A kagent built-in, such as `ask_user`, `load_memory`, `save_memory`, `prefetch_memory`, or a skill tool | `host/kagent/<name>` |
| kagent | The entrypoint gates | `host/kagent-gate/code_execution`, `host/kagent-gate/memory_persist` |
| kagent | The remedy tool | `appa/execute_remedy_plan` |

Claude Code names such as `Bash` and `mcp__github__create_issue` identify precise tools. An unqualified kagent rule such as `read_secret` applies to that native name across MCP servers and kagent's own tools. It does not cover remote-agent delegation. A newly discovered tool can use an existing rule without restarting the trajectory or changing its opening policy.

A host that embeds the runtime brings its own tool identification. The adapter identifies every call's canonical id. The runtime spells a tool back through the same adapter. See Add to your agent.

Use `server` when a rule should apply to one MCP connection:

```toml
[[policy.tool]]
name = "read_secret"
server = "demo-tools"
delta = { trust = "suspicious" }
```

This rule identifies `mcp/demo-tools/read_secret`. Deployment-level `[server_aliases]` maps a policy's server name to a list of configured connection identities, such as `databricks = ["genie", "sql"]`; every rule under that name then covers each listed connection. APPA does not infer a provider from a hostname or server metadata. A server qualifier cannot repair duplicate host dispatch names; the host must distinguish those tools.

kagent derives a default source ID from the exact configured endpoint URL. Native rules do not require that ID. Discovery supplies evidence, not permission: known tools need policy coverage, unavailable sources remain unknown, and later calls still pass runtime enforcement. A trajectory retains its opening policy and accepted identities.

Native names also work in `confined_results`, `assumed_tools`, and `provider_run_tools`. Coverage reports distinguish a rule spanning servers from an observed concrete tool. Overlapping declarations with incompatible provider-run execution settings are rejected.

The adapter identifies which calls start a child trajectory (Claude Code's `Agent`, a kagent agent called as a tool). A policy does not declare it.

### Tags

Tags connect tools to the authorities that can review their calls and the sanitizers that can transform their data. For example, this contract gives a ticket tool the `support` tag:

```toml
[[policy.tool]]
name = "get_ticket_from_crm"
tags = ["support"]
delta = { audience = ["internal"] }
```

An authority or sanitizer with `tags = ["support"]` applies to tools with that tag. If it lists several tags, one matching tag is enough. Without tags, an authority or sanitizer is not restricted to a particular set of tools. Its permissions still limit what it can approve or transform.

Attention approvals use a different rule: OpenAPPA selects authorities by `permits.attention`, regardless of their tags. See [Attention](references/contracts/labels.md#attention).

### Pattern matching

A policy can declare several contracts for one tool. OpenAPPA checks them in declaration order and selects the first matching contract. This includes overlapping native and canonical names; canonical spelling does not give a rule priority.

In the example below, the first contract matches a `path` string that starts with `/docs/` and declares its result as `public`. The second contract covers all other calls to `read_file` and declares their results as `internal`.

```toml
[[policy.tool]]
name = "read_file(path:/docs/*)"
delta = { audience = ["public"] }

[[policy.tool]]
name = "read_file"
delta = { audience = ["internal"] }
```

A selector checks top-level string arguments and arrays of strings. Put it in parentheses after the tool name, with conditions written as `argument:pattern` and separated by commas. List each argument only once, in any order.

Every condition must match the full value of its argument. An array argument matches when it is not empty and every element is a string that matches the pattern, so `edit_agent(teams:*)` selects a call that sends a list of teams. If an argument is missing, is an empty array, or is any other value, the selector does not match.

```toml
[[policy.tool]]
name = "mcp__github__fork_repository(owner:archestra-ai,repo:website)"
requires = { trust = "trusted" }
delta = {}
```

Use `*` to match any sequence of characters, including an empty sequence:

| Pattern | Matches | Does not match |
|---|---|---|
| `report.txt` | `report.txt` | `old-report.txt` |
| `/docs/*` | `/docs/guide.md`, `/docs/setup/install.md` | `/private/guide.md` |
| `*.md` | `guide.md`, `/docs/guide.md` | `guide.txt` |

#### Match special characters literally

Some characters have a special meaning in a selector. For example, `*` matches any text, and a comma separates argument conditions.

To match the character itself, put a backslash before it:

| Character to match | Write in the pattern |
|---|---|
| Asterisk (`*`) | `\*` |
| Closing parenthesis (`)`) | `\)` |
| Comma (`,`) | `\,` |
| Backslash (`\`) | `\\` |

For example, this contract matches a `search` call whose `query` argument is exactly `a,b`:

```toml
[[policy.tool]]
name = 'search(query:a\,b)'
delta = {}
```

The backslash tells OpenAPPA that the comma belongs to the query value. It does not separate two argument conditions.

Use single quotes around the name to preserve backslashes as written. If you use double quotes, TOML requires each backslash to be doubled. These two lines mean the same thing:

```toml
[[policy.tool]]
# Single quotes:
name = 'search(query:a\,b)'
```

```toml
[[policy.tool]]
# Equivalent form with double quotes:
name = "search(query:a\\,b)"
```

Only the four escapes listed above are supported. Other escapes cause a policy load error.

OpenAPPA selects a contract before it validates the contract's `parameters` schema. A schema error does not select a later contract. Rewritten arguments select their own matching contract. See [Sanitizers](references/contracts/sanitizers-authorities.md#sanitizers) for rewrite rules.

### Handling undeclared tools

The tool name `"*"` covers calls without a matching explicit tool contract, including calls to declared tools whose argument selectors do not match. The current format requires an annotator for this entry:

```toml
[[policy.annotator]]
name = "classify_unknown_tool"
ranks = ["suspicious"]

[[policy.tool]]
name = "*"
annotator = "classify_unknown_tool"
```

Declare and bind `classify_unknown_tool` as shown in [Annotators](references/contracts/annotators.md#annotators). The wildcard cannot contain static `delta`, `requires`, or `effects` fields. It also cannot contain metadata or argument selectors.

A policy can contain one wildcard entry. Explicit tool contracts take precedence over it, regardless of where the wildcard appears in the policy. If none of a tool's argument selectors match, the call falls through to the wildcard annotator. A matched contract's schema error still refuses the call; it does not fall through. Without a wildcard, a call with no matching contract is refused before execution.

## Include policy files

Use `include` to reuse configuration from other files. It belongs at the start of the file, outside `[policy]` and `[externals]`. This example loads declarations from `battery.toml` alongside the root file's settings:

```toml
include = ["battery.toml"]

[policy]
version = 2

[externals]
timeout_ms = 2000
max_body_bytes = 65536
```

OpenAPPA checks declarations in the root file first, then declarations from included files in the order listed by `include`. The following rules apply:

- An included file cannot include another file.
- An included file cannot replace settings that apply to the whole deployment. The one exception is `confined_results` under `[policy.deployment]`: an included file can list tools it declares itself, and the names join the root's list.
- A root `[[policy.annotator]]` replaces an included annotator with the same name. Fields omitted from the replacement are not inherited.
- Two included files cannot declare the same annotator.
- Two files cannot configure the same external component name within the same kind, such as two `[externals.sanitizers.clean]` sections.

See Batteries for reusable policy files.

## Deployment coverage

These settings describe what the agent integration can control: which tool results it can withhold and whether it can keep a child agent's data separate from the parent's:

```toml
[policy.deployment]
confined_results = ["get_ticket_from_crm"]
context_control = true

[[policy.tool]]
name = "get_ticket_from_crm"
delta = { audience = ["internal"] }
```

`confined_results` lists tools whose results the integration can withhold from the agent. A restricted result from a listed tool that declares effects offers a withhold plan. The agent selects this plan before the tool runs.

`context_control = true` declares that the integration can keep a child agent's data hidden from the parent and withhold the child's answer until OpenAPPA allows it. This lets OpenAPPA check or clean the answer before the parent reads it. The integration must implement this behavior; the setting alone does not provide it.

- A `tool_output` sanitizer requires either a tool listed in `confined_results` or a child agent's answer controlled through `context_control`.
- Every tool in `confined_results` must have a policy contract. A wildcard contract also satisfies this requirement.
- Some tools run inside the model provider's service. The integration cannot intercept their results before the model reads them. These tools can declare only static `delta` fields. They cannot declare requirements, annotators, or argument selectors, and cannot appear in `confined_results`.

OpenAPPA rejects configurations that require controls the integration does not support. See integration configuration for the integration's responsibilities.

