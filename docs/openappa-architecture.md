# Archestra × OpenAPPA

APPA evaluates tool calls and results at the existing LLM-proxy Tool Guardrails
checkpoints. Clients supply a stable session ID; caller identity is optional attribution.
The special MCP remedy tool also calls the embedded runtime.

Session state is keyed only by session ID. Participants in the same Slack thread
share trust state and pending calls. Internal agent requests use the local-request
trust boundary; external requests still require platform authentication.
The unreleased session-key migration clears old sessions, events, and receipts.
Saved policies remain intact.

## Startup configuration

`ARCHESTRA_OPENAPPA_ENABLED` defaults to `false`. Explicit `true` enables APPA
and the OpenAPPA editor. It automatically registers the proxy plugin.
`ARCHESTRA_BETA` and the plugin list alone do not activate them.
The OpenAPPA editor stores organization policy revisions in PostgreSQL. Restart
the backend when changing the flag; saving a policy requires no restart.

The HTTP API and agent read/validate/update tools share validation and revision
checks. Edits compile without executing external services. The next dispatch
loads the latest saved revision under the native runtime lock. New conversations
use it; existing conversations retain their recorded policy.

The editor accepts `[policy]` and URL/builtin bindings in `[externals]`. File
includes, local commands, and runtime-owned settings are rejected. Tokens are
referenced through `token_env`; policy documents must not contain credentials.
Existing file-based deployments must copy their policy into the editor. An
unconfigured organization starts with only a catch-all annotator. It returns
empty changes and requirements, leaving trust and audience unchanged. Explicit
tool rules take precedence over the catch-all. The local backend serves this
fixed answer without calling a model or accessing user data.

| Boundary | Flag off | Flag on |
| --- | --- | --- |
| Incoming tool results | Existing result policies | APPA admission and saved output |
| Outgoing calls | Existing invocation policies | APPA decision |
| Refusal envelope | Existing adapter | Same adapter, APPA explanation and remedies |
| Session header | No APPA wiring | Stable conversation identity |
| Special MCP remedy | Hidden and unavailable | Existing embedded remedy execution |
| Runtime | Not loaded or initialized | Lazy native initialization; errors fail closed |

Migrations remain additive and deployment-wide; runtime APPA records are accessed
only when enabled. The existing guardrails remain active with the APPA flag off.

## Tool calls and results

```mermaid
sequenceDiagram
  participant C as Chat or proxy client
  participant P as LLM proxy
  participant A as Embedded APPA
  participant L as Model provider
  participant T as Tool executor
  C->>P: Request with session identity and history
  P->>A: SessionStart + submitted ToolResults
  A-->>P: Admitted output or APPA blocking text
  P->>L: Request with result replacements applied
  L-->>P: Proposed calls (buffer until complete)
  P->>A: ToolCall with exact normalized arguments
  alt All calls allowed
    P-->>C: Executable calls
    C->>T: Normal execution
    T-->>C: Normal result
    Note over C,P: Result is admitted on the next model request
  else Any call denied
    P-->>C: Existing refusal envelope with APPA text; no executable calls
  end
```

Chat does not recheck APPA before execution or submit results directly. Its
normal result storage and rendering remain intact. The proxy consumes
client-reported completion and explicit protocol errors; it does not independently
prove execution. Repeated history reuses persisted admitted output.

## Remedies

The `archestra__execute_remedy_plan` MCP tool is available when enabled and
executes remedies directly through the Rust binding. Registered remote
authorities, sanitizers, and narrowing remedies remain available.

This PR does not connect APPA human approval to Chat. Calls requiring human
approval remain blocked, and a remedy requiring an unavailable human authority
returns APPA's explanation. There are no APPA approval cards, waiting requests, or
automatic call retries. Existing Chat and MCP prompts are unchanged.

## Persistence and current limits

The Rust binding owns the existing five PostgreSQL tables and commits APPA
events with completed processing receipts. Repeated calls retain exact-input
checks; repeated results return saved admitted output. Pending interrupted work
retains the existing blocking behavior.

This integration does not send `Prompt` or `TurnEnd`. Abandoned-call recovery,
unresolved-dispatch cleanup and unused remedy-permit lifetime are unchanged.
The enabled prototype still refuses locked chats and delegation and disables
detached tool tasks. These restrictions do not apply with the APPA flag off.

General attachment/final-answer enforcement, child return
integration, provider-hosted tools and operator recovery remain follow-up work.
Start new conversations when enabling APPA: old tool results have no receipts.

## Build and deployment

The addon is compiled alongside Archestra's existing native addons and packaged
inside the normal platform image. Cargo fetches OpenAPPA at the full commit
pinned in `openappa-rs/Cargo.toml` and `archestra-rs/Cargo.lock`; neither a sibling
checkout nor an extra Docker build context is required. Archestra's existing
release workflow stays unchanged. There is no separate addon release.
