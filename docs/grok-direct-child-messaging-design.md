# Grok Direct Messaging

Status: implemented; automated verification covers the managed adapter, real PostgreSQL guardrails ledger, full Responses and Chat Completions proxy paths, and official Grok 1.0.70. Manual preview checks are listed in `grok-guardrails-manual-verification.md` and remain separate from automated results.

## Native Contract

The managed launcher enables `GROK_ACTIVE_AGENT_MESSAGES` only in its protected child process. Native `send_subagent_message` accepts an exact subagent UUID, text, and `steer`, `queue`, or `interject` delivery. Legacy `queue` remains supported. An accepted receipt means delivery was accepted, not that the child has consumed the message or returned a result.

Official Grok 1.0.70 (`f50904eaee6c`) accepts parent-to-child messages and eligible sibling-to-sibling messages, including waking a completed child. Its native permissions, quotas and child tool catalog still apply. Children cannot message the root. Upstream supports one delegation level; nested spawning remains unavailable.

Source reference: `xai-org/grok-build` at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`, particularly `crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md` and `crates/codegen/xai-grok-tools/src/implementations/grok_build/send_subagent_message.rs`. Installed-binary probes establish the tested release's behavior independently of that source revision.

## Guardrails Boundaries

`adapters/grok-relay.ts` supplies Grok framing to the shared peer-message implementation in `plugin.ts`. It reuses the same runtime send, admission and held-message reads as Claude Code and Codex.

When Grok discovers only part of the remedy pair, an attempted signed control is replaced by one native search for its missing companion. Discovery does not execute or authorize the original control. Both controls must have verified catalog evidence and pass the shared gateway-identity checks before use. An unsuccessful search cannot repeat within the same user turn.

- Validate the complete native argument shape. Reject unknown fields, conflicting delivery options, invalid Unicode, oversized messages, nested framing, prefix IDs and `use_tool` dispatch of the native tool.
- Normalize the policy identity to `host/archestra/SendMessage`. Resolve the recipient through the authenticated caller's persisted parent/child relationships. Foreign families, unknown children, self messages and children started without enforcement are refused.
- Retain verified native IDs in an immutable identity index. A resumed native ID resolves to its original governed actor, including before the next child return.
- Persist one send per released tool-call operation. Exact replay reuses it; changed bytes under that ID cannot reuse authorization. Preserve the requested native delivery mode.
- Carry a versioned envelope containing a sender hint, exact body and runtime message ID. The hint grants no authority. Persisted lineage and the runtime's captured sender, recipient and digest establish the crossing.
- Admit actual message turns before provider inference, including flattened text and serialized memory transcripts. Reject malformed, duplicate, nested, mixed or trailing framing. Assistant quotations do not establish incoming messages. Keep the native indication that a message is agent-authored rather than human approval.
- Accept only recognized native delivery receipts. Grok's active-message coordinator uses a bare UUID; its completed-child wake path uses `parent-agent-message-<UUID>`. Both exact forms are supported in text and structured receipts. Withhold unknown or augmented receipts; they cannot carry an unchecked child return. Uncertain acceptance must not trigger an automatic resend.

## Labels and History

The runtime captures the sender's label at send time and compares it with the recipient's live label. A recipient that cannot read the message receives a held-message notice without the body. `list_peer_messages` and `read_peer_message` use the standard remedy flow; repeated delivery creates neither another send nor another approval.

Peer reads preserve their captured body and label. A general tool-output sanitizer does not silently redact or relabel a peer message. Child-return sanitizers remain part of the separate declared-return boundary.

A normal child reply does not end its guarded trajectory. Messaging therefore does not rebind the child or refresh its inherited label from the parent. This preserves the original actor and return contract while letting the peer boundary decide any required narrowing. A child that has actually ended through a no-return terminal stays closed; a message cannot reopen it.

Outgoing native tool-call history is restored to the sender’s original plain text before model inference, including serialized memory history. This keeps the model from copying host transport framing into a new message. Incoming peer turns remain intact until runtime admission. New calls containing reserved framing are still refused, with a specific diagnostic.

Direct admission removes a message from the unread inbox. History replay must therefore validate an explicit message proof against the retained runtime row, not rediscover it in that inbox. The NAPI binding now does this while retaining sender, recipient, digest, expiry, status and live-label checks.

## Verification

- Adapter tests: arguments, framing, protocol shapes, memory, receipt validation and spoofing.
- Real-ledger proxy tests: parent and sibling routing, native ID binding, exact replay, altered send, forged sender/body, completed-child delivery, original return contract and memory replay through both supported HTTP protocols.
- Official CLI tests: native execution and arrival for all three delivery modes, same child identity and guarded return.
- Real-ledger peer tests: held body, explicit narrowing remedy, repeated read, single persisted send, and configured sanitizer behavior.
- Shared native binding tests: direct history replay, altered proof, wrong recipient, interrupted send recovery and family isolation.
- Regression checks: Claude Code/Codex relays, managed launcher environment, persisted identity binding, TypeScript, import boundaries, Rust formatting, Clippy and unit tests.

Synthetic model responses make refusal cases deterministic. They do not replace live manual checks of native presentation or paid subscription inference.
