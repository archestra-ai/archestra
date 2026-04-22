# Platform Memory

> [!NOTE]
> Preview feature (rollout 1). Automatic prompt injection is disabled by default and can be enabled with `ARCHESTRA_MEMORY_INJECTION_ENABLED=true`.

## Stage 1 Preview ADR

### Rollout 1 Scope Statement
- Durable Memory is a separate subsystem from chat history and knowledge base.
- Data model, API contracts, ACL, and review flow support `user`, `team`, and `organization` scopes.
- Automatic extraction and prompt injection are rollout-1 active only for `user` scope.
- Team and organization scope entries are reviewable and manually manageable, but not auto-extracted or auto-injected.

### Safety and Governance Constraints
- Human review is mandatory before activation: extractor output is persisted as `candidate`, not active memory.
- Sensitive content policy is enforced before persistence: high-risk PII/secrets are hard-blocked.
- Scope isolation is mandatory: ACL filtering occurs before retrieval/ranking.
- Approved memory editing is append-only supersede flow (`approved -> candidate` with `supersedes_memory_id`), not in-place mutation.
- Deletion/rejection may emit tombstones to prevent immediate recreation of removed content.

### Operator Feature Flags (Rollout 1)
- `ARCHESTRA_MEMORY_EXTRACTION_ENABLED` controls async extractor execution.
- `ARCHESTRA_MEMORY_INJECTION_ENABLED` is the injection kill switch for prompt hot-path.
- `ARCHESTRA_MEMORY_INJECTION_TOKEN_BUDGET` and `ARCHESTRA_MEMORY_INJECTION_TOP_K` constrain injected memory volume.
- `ARCHESTRA_MEMORY_CANDIDATE_TTL_DAYS` and `ARCHESTRA_MEMORY_TOMBSTONE_TTL_DAYS` govern queue/tombstone lifecycle.

### Merge Defaults and Review Requirement
- Default posture for rollout 1 is extraction on (environment-controlled) and injection off.
- Promotion from candidate to approved requires explicit human review.
- Extractor prompt is frozen at `v1.0.0` for rollout 1 decisions.
- Fixed rejection taxonomy:
  - `inaccurate`
  - `sensitive`
  - `manipulative`
  - `wrong_scope`
  - `temporary`
  - `duplicate`
  - `vague`
  - `not_useful`
  - `conflicts_with_existing`
  - `policy_violation`
