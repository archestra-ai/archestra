# Archestra × OpenAPPA

The APPA plugin extends the generic proxy lifecycle merged in #7833. Claude Code, Codex, OpenCode, and Chat share the lifecycle while adapters handle their client-specific syntax. The stateful integration adds durable call correlation, held responses, checkpoints, and child bindings. Policy evaluation stays inside the embedded OpenAPPA runtime; no runtime HTTP transport is used.

## Startup configuration

`ARCHESTRA_LLM_PROXY_PLUGINS` defaults to an empty list. Including `appa` enables APPA across the proxy, Chat, and MCP remedy tool. There is no separate enable flag. A configured policy path and `ARCHESTRA_BETA` do not activate it.

`ARCHESTRA_OPENAPPA_POLICY_PATH` and a session HMAC secret of at least 32 characters are required when the list includes `appa`. Configure the secret with `ARCHESTRA_OPENAPPA_SESSION_HMAC_SECRET`. Human approvals also require `ARCHESTRA_OPENAPPA_APPROVAL_SIGNING_SECRET`. Restart the backend after configuration changes.

| Boundary | APPA omitted | APPA included |
| --- | --- | --- |
| Incoming tool results | Existing result policies | Durable call correlation, APPA admission, and existing result policies |
| Outgoing calls | Existing invocation policies | APPA decision plus existing invocation policies |
| Refusal envelope | Existing adapter | Same adapter, APPA explanation and remedies |
| Session header | No APPA wiring | User and conversation identity |
| Special MCP remedy | Hidden and unavailable | Existing embedded remedy execution |
| Runtime | Not loaded or initialized | Lazy native initialization; errors fail closed |

Migrations remain additive and deployment-wide; runtime APPA records are accessed
only when enabled. The existing guardrails remain active with an empty plugin list.

## Tool calls and results

```mermaid
sequenceDiagram
  participant C as Chat or proxy client
  participant P as LLM proxy
  participant A as Embedded APPA
  participant L as Model provider
  participant T as Tool executor
  C->>P: Request with session identity and history
  P->>A: session_start or child_start, then prompt
  P->>A: Correlated submitted results with durable event identities
  A-->>P: Admission receipts and approved result presentations
  P->>L: Request with result replacements applied
  L-->>P: Proposed calls (buffer until complete)
  P->>A: Batch with exact normalized calls and arguments
  alt All calls allowed
    P-->>C: Executable calls
    C->>T: Normal execution
    T-->>C: Normal result
    Note over C,P: Result is admitted on the next model request
  else Remedy or approval required
    P->>P: Persist held response and continuation
    Note over P,A: No executable calls are released before authorization
  else Any call denied
    P-->>C: Existing refusal envelope with APPA text; no executable calls
  end
  P->>A: turn_end or child_end when no continuation is pending
```

Chat does not recheck APPA before execution or submit results directly. Its
normal result storage and rendering remain intact. The proxy consumes
client-reported completion and explicit protocol errors; it does not independently
prove execution. Repeated history reuses persisted admitted output.

## Remedies

The `archestra__execute_remedy_plan` MCP tool is available when enabled and
executes remedies directly through the Rust binding. Registered remote
authorities, sanitizers, and narrowing remedies remain available.

The stateful path persists held batches and exposes approval and quarantine management routes with a reviewer UI. Approval grants are bound to stored requests; an unresolved hold does not authorize execution. Deferred responses release request-local plugin state without aborting the durable continuation. The existing MCP remedy entry point remains separate from held-response remediation; interoperability between the two workflows is not established by the proxy boundary tests.

## Persistence and current limits

The existing five `openappa_*` tables remain the native runtime's persistence boundary. Migration `0474_restore-appa-stateful-lifecycle.sql` adds nine `appa_proxy_*` tables for proxy sessions, calls, event receipts, approvals, wire aliases/frames, history, and checkpoint bindings. TypeScript owns this delivery and correlation bookkeeping, not policy evaluation. Uncertain or undelivered authorized work can be quarantined rather than replayed as successful execution.

The proxy sends `prompt` and, after outstanding work completes, `turn_end`. Child requests require an authorized spawn binding. Their lifecycle uses `child_start` and `child_end`, with a child return value when available. A held response or pending client continuation keeps the durable turn open rather than ending the child prematurely.

Signed prompt carriers may appear in client chats or transcripts; no reliably invisible transport is established. Child callbacks describe observed proxy boundaries, not independently attested client execution. Root `turn_end` does not submit the final answer text, so general final-answer enforcement remains a gap. Full native restart, approval, sanitizer, fork/compaction, and stock-client live qualification remain incomplete. Start new conversations when enabling APPA: old tool results have no receipts.

## Build and deployment

The addon is compiled alongside Archestra's existing native addons and packaged
inside the normal platform image. Cargo fetches OpenAPPA at the revision
pinned in `openappa-rs/Cargo.toml` and `archestra-rs/Cargo.lock`; neither a sibling
checkout nor an extra Docker build context is required. Archestra's existing
release workflow stays unchanged. There is no separate addon release.
