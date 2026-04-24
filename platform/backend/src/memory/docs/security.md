# Durable Memory Security Runbook

## Summary
Stage 15 rollout-1 hardens the durable memory pipeline with deterministic controls before persistence and before prompt-time injection. The implementation remains intentionally conservative: candidate-only writes stay intact, high-risk content is blocked before insert, medium-risk instruction-like content is retained only as flagged candidates, and prompt-time memory injection is disabled whenever trust posture or active tool capabilities make the session unsafe.

This document describes the enforced runtime contract, the operational signals to watch, and the expected operator response.

## Enforced Controls
### Candidate-only invariant
- Automated paths never write approved memory directly.
- MCP memory propose writes only `candidate` records.
- Async extraction writes only `candidate` records.
- Manual create also writes only `candidate` records.
- Approved memory can only be created through an explicit review action.

### Pre-write screening
Every candidate written through the supported rollout-1 paths is screened before persistence:
- `extractor`
- `mcp_propose`
- `manual_create`
- `supersede`

The shared pre-write screen enforces:
- secret detection
- high-risk PII detection
- high-confidence instruction-like detection
- tombstone replay suppression
- external-context marker blocking for MCP propose

Decision model:
- `allow`: candidate is written without extra policy flags
- `flag`: candidate is written with policy flags for reviewer visibility
- `block`: candidate is rejected before DB insert

### Review-path approval guard
Candidates carrying high-risk policy flags cannot pass through the normal approve path.

Blocked approval flags:
- `instruction_like`
- `instruction_like_high`
- `instruction_like_medium`
- `external_context`

When this guard triggers:
- the approve endpoint returns a deterministic policy error
- `archestra_memory_review_policy_block_total{reason="high_risk_policy_flags"}` is incremented
- the candidate remains in reviewable state instead of becoming approved memory

### Prompt-time injection guard
Prompt-time durable memory injection is enabled only when all of the following are true:
- `ARCHESTRA_MEMORY_INJECTION_ENABLED=true`
- the agent is not operating in untrusted-context posture
- the active tool set does not expose external communication capability

The external-tool gate is `metadata-first`:
- if a tool definition exposes explicit capability metadata, that metadata is used
- if metadata is absent, rollout-1 falls back to legacy tool-name heuristics
- fallback usage is logged so the tool inventory can be migrated toward explicit metadata

## Policy Reasons and Meaning
### Pre-write block reasons
- `sensitive`: secret-like content was detected
- `high_risk_pii`: sensitive personal or financial data was detected
- `instruction_like_high`: high-confidence prompt-injection style content was detected
- `tombstone_hit`: content matches an active tombstone
- `external_context`: MCP propose content contained external-context markers

### Flag-only reasons
- `instruction_like_medium`: content remains reviewable but is marked with `instruction_like` and `instruction_like_medium`

### Injection block reasons
- `feature_flag_off`: injection is disabled globally
- `untrusted_context`: agent posture forbids prompt-time memory injection
- `external_tools_with_trusted_context`: the session has active external-capable tools

### Review block reasons
- `high_risk_policy_flags`: the candidate reached review with high-risk flags and requires stronger handling than the normal approve path

## Metrics to Monitor
Primary rollout-1 security metrics:
- `archestra_memory_policy_blocked_total{reason}`
- `archestra_memory_screen_decision_total{decision,reason}`
- `archestra_memory_injection_block_total{reason}`
- `archestra_memory_review_policy_block_total{reason}`
- `archestra_memory_tombstone_hit_total{reason,match_type}`
- `archestra_memory_mcp_propose_block_total{reason}`

Suggested initial alert thresholds:
- `archestra_memory_policy_blocked_total`: alert if 5-minute rate is at least 3x above baseline after a rollout
- `archestra_memory_injection_block_total{reason="external_tools_with_trusted_context"}`: alert if the 15-minute rate exceeds expected tool-enabled traffic baseline
- `archestra_memory_review_policy_block_total{reason="high_risk_policy_flags"}`: alert if approvals begin failing repeatedly for a new candidate class after policy or prompt changes
- `archestra_memory_tombstone_hit_total`: alert on sudden spikes that suggest replay attempts or overly broad normalization

Thresholds must be re-baselined after the first production week because rollout-1 adds new deterministic blocks and fallback logging.

## Operator Triage
### Candidate creation or supersede is failing
1. Check the API error message for `blocked by policy`.
2. Correlate with `archestra_memory_policy_blocked_total` and `archestra_memory_screen_decision_total`.
3. If the reason is `tombstone_hit`, inspect the prior reject/delete decision before allowing any workaround.
4. If the reason is `instruction_like_high`, do not downgrade the policy without evidence; review the content and detector match first.

### Approve endpoint is failing
1. Check whether the candidate carries high-risk flags.
2. Verify `archestra_memory_review_policy_block_total`.
3. Treat the failure as a governance/security gate, not as an authorization regression.

### Memory injection is unexpectedly absent
1. Check `ARCHESTRA_MEMORY_INJECTION_ENABLED`.
2. Check whether the agent is configured as untrusted context.
3. Inspect active tool capability assessment.
4. If fallback classification was used, review the tool inventory and add explicit metadata at the source rather than weakening the gate.

## Rollback Guidance
Safe containment steps:
1. Set `ARCHESTRA_MEMORY_INJECTION_ENABLED=false` to disable prompt-time use of durable memory.
2. Set `ARCHESTRA_MEMORY_EXTRACTION_ENABLED=false` to stop new automated candidate creation.
3. Preserve metrics, logs, and candidate/tombstone state for analysis.

Unsafe rollback patterns:
- bypassing pre-write screening
- re-enabling injection while keeping untrusted context or external-capable tool sessions unchanged
- deleting tombstones to suppress symptoms without understanding the original rejection reason

## Known Rollout-1 Limits
- External tool capability metadata is not yet guaranteed for every tool definition, so a legacy heuristic fallback still exists.
- The rollout does not include an LLM judge layer. Deterministic controls remain the only blocking layer.
- The normal approve endpoint blocks high-risk flagged candidates, but rollout-1 does not yet introduce a separate multi-step security review workflow.
- Team and organization scopes remain outside automatic extraction and automatic injection.

## Deferred Follow-Ups
- replace remaining tool-name fallback with mandatory capability metadata coverage
- introduce a dedicated escalated review path for high-risk candidates
- add judge-model review assistance only after deterministic false-negative and false-positive baselines are stable
- formalize dashboard panels and alert rules in shared observability documentation
