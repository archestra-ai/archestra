# afc-agent

A live AFC demo: a real MCP tool server, a real OpenRouter LLM, and the AFC engine governing every
tool call the model makes. Where `afc-demo` runs a scripted 8-beat scenario, here the *model* decides
what to call and AFC decides whether it may.

## Pieces

- **`afc-mcp-tools`** — a standalone `rmcp` MCP server (stdio) exposing five dummy tools
  (`drive_read_doc`, `drive_write_doc`, `web_fetch`, `email_send`, `crm_export`) whose schemas mirror
  `afc-demo/policy.yaml`. Any MCP client can spawn it.
- **`afc-agent`** — spawns that server, connects as an MCP client, and drives an OpenRouter model
  through a nitpicker agent loop. Each tool is wrapped by an AFC gate: effectful calls
  (write/egress/consequential) are run through `RuleEngine::check_call` *before* dispatch; reads are
  labeled and folded into a session context that taints later egress. `Allow` dispatches over MCP;
  `Deny` returns the reason to the model; `Escalate` runs the approval chain.

The engine (sync, non-`Send`) lives on one dedicated actor thread; the agent talks to it over a
channel, so governance is serialized by construction.

## Run

```sh
export OPENROUTER_API_KEY=...            # required
cargo run -p afc-agent --bin afc-agent   # defaults to deepseek/deepseek-v4-flash
```

Flags: `--model <slug>`, `--config <policy file>`, `--mcp-server <path>`.

The run walks two tasks: one that trips the no-leak rule (reading a confidential doc then emailing it
widely), and one that escalates (fetching an untrusted page, then a consequential email). The demo
"human" approver approves iff the driving prompt length is odd.

## Test

```sh
cargo test -p afc-agent
```

The tests exercise the real MCP server (spawned as a child) and the real engine — no LLM, no network,
no mocks. The live model step is covered only by running the binary.
