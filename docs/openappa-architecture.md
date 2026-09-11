# Archestra × OpenAPPA

Prototype integration · 11 September 2026

## 01 · Tool execution

```mermaid
sequenceDiagram
  participant L as LLM
  participant P as Archestra proxy
  participant A as APPA native binding
  participant C as Chat tool executor
  participant T as MCP tool

  L-->>P: Proposed tool call · ID, name, arguments
  Note over P: Buffer streamed arguments until complete
  P->>A: dispatchHook(tool_call)
  A-->>P: Allow or deny · save decision
  P-->>C: Original tool call
  Note over P,C: Authenticated in-process Chat
  C->>A: dispatchHook(tool_call) · same ID and arguments
  A-->>C: Return stored decision

  alt Allowed
    C->>T: Execute tool
    T-->>C: Output + execution outcome
    C->>A: dispatchHook(tool_result)
    A-->>C: Approved or replaced output
  else Denied
    Note over C,T: Tool is not executed
    C->>C: Use APPA ruling as tool result
  end

  C->>P: Next LLM request · includes tool result
  P->>A: dispatchHook(tool_result)
  A-->>P: Stored approved output or authoritative denial
  P->>L: Tool result admitted by APPA
  L-->>C: Explanation or next tool call · via proxy
```

The second `tool_call` check is at the execution boundary. For the same call ID and arguments, it returns the persisted decision rather than evaluating policy again. Changed arguments are rejected.

## 02 · Human review and narrowing

```mermaid
sequenceDiagram
  participant C as Archestra Chat
  participant A as APPA binding
  participant H as Human
  C->>A: tool_call
  A-->>C: deny_call + human-review offer
  C->>A: remedy_review
  A-->>C: Exact action to review
  C->>H: Native approval card
  H-->>C: Approve / decline / cancel
  opt Approved
    C->>A: remedy + host-only ruling
    A-->>C: Remedy result
    C->>A: resume_tool_call · identical arguments
    A-->>C: Allowed receipt
  end
```

```mermaid
flowchart LR
  R[Read proposed] --> W[Read withheld + narrowing offer]
  W --> I[Independent action]
  I --> E[Model executes offered remedy]
  E --> A[Restriction accepted]
  A --> D[Retry read · receive document]
```

**Approval does not reset restrictions.** Narrowing offers are never automatically accepted.

## 03 · Interface and ownership

```mermaid
flowchart LR
  subgraph AR[Added to Archestra]
    A[Identity + Chat/proxy hooks]
    B[Approval UI + review bridge]
    C[Native adapter + receipts]
    D[PostgreSQL migrations]
  end
  subgraph API[Native API]
    I["initializeOpenappa(databaseUrl, policyPath)"]
    J["dispatchHook(scopedEvent)"]
  end
  subgraph AP[Added to APPA]
    S[PostgreSQL event-store backend]
    O[Runtime.open_with_store]
    E[execute_embedded_remedy]
    H[Embedded host-ruling propagation]
  end
  A --> J
  B --> J
  C --> I
  C --> J
  I --> O --> S
  J --> E --> H
  D -.-> S
```

Scope: `organization_id` · `caller_id` · `session_id` · optional `parent_id`.

Events: `session_start` · `prompt` · `tool_call` · `tool_result` · `remedy_review` · `remedy` · `resume_tool_call` · `turn_end`.

## 04 · Remaining boundaries

```mermaid
flowchart LR
  P[Current prototype]
  P -.-> A[Child / subagent return lifecycle]
  P -.-> B[Other execution surfaces]
  P -.-> C[Rich results + locked-chat encryption]
  P -.-> D[Policy deployment + reload]
  P -.-> E[Concurrency + recovery + retention]
  P -.-> F[General prompt / final-answer enforcement]
```

Not included: demo tools, Policy Studio, team resolver, GitHub annotator, status line.
