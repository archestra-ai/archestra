# Issue #3218 – Auto-sync permissions ACL support for Jira + Confluence

## Status after research

This is **not implemented** in `main`.

The codebase already has useful groundwork:
- connector-level visibility (`org-wide`, `team-scoped`)
- ACL columns on `kb_documents` + `kb_chunks`
- query-time ACL filtering in `query_knowledge_sources`
- team external group mappings that can be reused for identity mapping
- a placeholder `ConnectorDocument.permissions` field

But the missing parts are the hard ones:
- third visibility mode (`auto-sync-permissions`)
- extraction of upstream ACL/permission data from Jira + Confluence
- identity mapping between upstream principals and Archestra users/teams
- refresh behavior when permissions or mappings change
- UI, docs, tests, and enterprise gating

---

## Hard research conclusions

### 1) Confluence is feasible, but Cloud inherited restrictions are awkward
- Confluence Cloud REST restrictions endpoints exist for page restrictions.
- Confluence Cloud REST **does not expose inherited restrictions directly**; Atlassian’s own support article says you must combine `Get restrictions` with `Get ancestors`, or use an unsupported internal GraphQL endpoint.
- Confluence Data Center has a `relevantViewRestrictions` endpoint that returns direct + inherited view restrictions.

### 2) Jira is much harder than Confluence
Jira visibility is a combination of:
- project "Browse Projects" permission scheme
- optional issue security scheme / security level
- role-based grants
- issue-role grants (reporter / assignee / project lead)
- sometimes custom user/group picker fields
- possibly public / anyone access

APIs exist for many of these pieces, but not as a single "effective ACL for issue" endpoint.

### 3) Current ACL model is OR-only
Current KB ACL storage is an array like:
- `org:*`
- `team:<id>`
- `user_email:<email>`
- `group:<id>`

That means it models **OR** semantics well.

This becomes important because Confluence inherited restrictions can act like an **AND across ancestors** when evaluated against real users. So for strict correctness, you should not try to flatten inherited restrictions into a single abstract principal list unless you are okay with approximation.

### 4) The cleanest v1 is to materialize ACLs to Archestra-local principals
Recommended v1 strategy:
- compute a document’s **effective access for current Archestra org members only**
- materialize the result into normal ACL entries (mostly `user_email:*`, sometimes `org:*`, optionally `team:*` if exact)
- reuse existing query-time filtering unchanged

This avoids inventing a complex new query engine.

The tradeoff:
- ACLs must be refreshed if relevant local mappings change (team membership / external group mappings / org members)

---

## Recommended product/engineering decisions

### Decision A – ship as a multi-phase feature
Do **not** try to land everything in one PR.

Recommended phases:
1. groundwork + visibility mode
2. identity/materialization layer
3. Confluence implementation
4. Jira implementation
5. refresh + admin tooling + docs/demo hardening

### Decision B – Cloud-first for both connectors
Even though the connectors support `isCloud`, the safest implementation path is:
- **Confluence Cloud first**
- **Jira Cloud classic/company-managed first**
- then add Data Center parity

Reason:
- Cloud docs/APIs are more standardized
- Jira issue security APIs explicitly mention classic project behavior
- Confluence Cloud inherited restrictions need special handling anyway

### Decision C – v1 identity mapping strategy should be fixed, not configurable
Do **not** introduce a big UI/config matrix for identity mapping in v1.

Use this fixed strategy:
1. **direct user match by email** when upstream email is available
2. **group match through existing Team External Groups mappings**
   - admins map upstream group identifiers to Archestra teams
   - users gain access through membership in those teams
3. if a document’s effective permissions cannot be resolved confidently:
   - **fail closed** (skip ingest or mark as skipped/unresolved)
   - never fall back to org-wide

### Decision D – materialize only to existing ACL primitives in v1
Try hard not to expand the ACL grammar for v1.

Use:
- `org:*`
- `user_email:<email>`
- optionally `team:<id>` only when it is exactly correct

Avoid relying on `group:*` at query time in v1 unless you also add a robust user-ACL builder from team external groups and are comfortable with the semantics.

---

## Target architecture

## A. New visibility mode
Extend connector visibility from:
- `org-wide`
- `team-scoped`

to:
- `org-wide`
- `team-scoped`
- `auto-sync-permissions`

This mode is enterprise-only.

## B. Two-layer permission pipeline

### Layer 1 – connector/provider extraction
Each provider must extract enough upstream permission facts to decide document visibility.

### Layer 2 – ACL materialization
A backend service converts provider permission facts into document/chunk ACL arrays that the current query system already understands.

## C. Fail-closed behavior
If auto-sync is enabled and permissions for a document cannot be fully resolved:
- the document should **not** be ingested as broadly accessible
- it should be:
  - skipped, or
  - ingested with empty ACL and marked as unresolved

Prefer **skip + run warning** in v1 because it is safer and easier to reason about.

---

## Detailed implementation plan

# Phase 1 – groundwork / visibility mode / plumbing

## Goal
Make the platform understand a third visibility mode without yet doing provider-specific ACL resolution.

## Files to change

### Backend types / schema / model
- `platform/backend/src/types/knowledge-base.ts`
- `platform/backend/src/types/knowledge-base-connector.ts`
- `platform/backend/src/database/schemas/knowledge-base-connector.ts`
- migration file under `platform/backend/src/database/migrations/`
- `platform/backend/src/models/knowledge-base-connector.ts`

### Routes / MCP tool schemas
- `platform/backend/src/routes/knowledge-base.ts`
- `platform/backend/src/archestra-mcp-server/knowledge-management.ts`

### Frontend
- `platform/frontend/src/app/knowledge/_parts/knowledge-source-visibility-selector.tsx`
- `platform/frontend/src/app/knowledge/knowledge-bases/_parts/create-connector-dialog.tsx`
- `platform/frontend/src/app/knowledge/knowledge-bases/_parts/edit-connector-dialog.tsx`
- any connector list/detail UI that renders visibility badges

### Docs / generated docs
- `docs/pages/platform-knowledge-connectors.md`
- `docs/pages/platform-archestra-mcp-server.md`
- `docs/openapi.json` (generated)

## Tasks
1. Add `"auto-sync-permissions"` to `KnowledgeSourceVisibilitySchema`
2. Update insert/update/select schemas for connectors
3. Gate create/update routes:
   - allowed only when `config.enterpriseFeatures.knowledgeBase` is enabled
4. UI should expose the mode again
   - but label it clearly as enterprise
5. Do not yet ingest provider ACLs in this phase
6. Add route/tool validation tests

## Tests
- `platform/backend/src/routes/knowledge-base.test.ts`
- `platform/backend/src/archestra-mcp-server/knowledge-management.test.ts`
- frontend dialog tests

## Acceptance criteria
- connectors can be created/updated with `auto-sync-permissions`
- enterprise gating works
- docs and tool schemas reflect the new enum

---

# Phase 2 – identity mapping + ACL materialization foundation

## Goal
Create the reusable service that converts upstream principals into KB ACL entries.

## New service(s) to add

### 1. `platform/backend/src/knowledge-base/identity-resolution.ts`
Responsibilities:
- load org members (`MemberModel.findAllByOrganization`)
- load teams + members
- load team external group mappings
- provide fast lookups:
  - email -> org user
  - external group identifier -> Archestra team(s)
  - team -> member emails

### 2. `platform/backend/src/knowledge-base/acl-materializer.ts`
Responsibilities:
- accept provider-resolved permission facts
- output final `AclEntry[]`
- apply fail-closed rules
- optionally return a reason/status if unresolved

## Proposed v1 input shape
Add a stronger internal type, e.g.

```ts
type ResolvedDocumentPermissions = {
  isPublic: boolean;
  allowedEmails: string[];
  allowedExternalGroups: string[];
  complete: boolean;
  debug?: Record<string, unknown>;
};
```

If you want to keep `ConnectorDocument.permissions`, evolve it toward this shape instead of the current loose object.

## Materialization rules
1. if `isPublic === true` -> `["org:*"]`
2. include `user_email:<email>` for org members whose email matches `allowedEmails`
3. for each `allowedExternalGroups`:
   - find mapped Archestra teams from `team_external_group`
   - expand those teams to member emails
   - include `user_email:<memberEmail>` for those members
4. if `complete === false`:
   - return unresolved status
   - caller decides to skip ingest
5. de-duplicate + sort output for stable writes/tests

## Important choice
For v1, materialize to **user_email ACLs** for auto-sync documents.

Why:
- it keeps query-time behavior unchanged
- it avoids incorrect OR semantics for complex upstream inheritance/role combinations
- it can represent exact access for current org members

## Additional metadata to store
Add permission-resolution debug metadata to document metadata, e.g.

```ts
metadata.permissionSync = {
  provider: "jira" | "confluence",
  mode: "auto-sync-permissions",
  complete: true,
  source: { ...provider-specific identifiers... }
}
```

This helps later ACL refreshes without refetching everything.

## Tests
Add new unit tests for:
- email mapping
- group->team->member expansion
- unresolved/partial behavior
- dedupe/stable ordering

---

# Phase 3 – connector sync integration

## Goal
Teach the sync pipeline to use provider permissions when visibility is `auto-sync-permissions`.

## Files to change
- `platform/backend/src/knowledge-base/connector-sync.ts`
- `platform/backend/src/knowledge-base/source-access-control.ts`
- maybe `platform/backend/src/types/knowledge-connector.ts`
- maybe `platform/backend/src/knowledge-base/connectors/base-connector.ts`

## Changes

### 1. Add visibility branch in sync
Current logic always builds one connector-level ACL and applies it to every doc.

Change flow:
- if connector visibility is `org-wide` or `team-scoped`
  - keep existing behavior
- if connector visibility is `auto-sync-permissions`
  - resolve per-document ACL before ingest

### 2. Introduce a sync-time hook
Recommended abstraction:

```ts
interface PermissionAwareConnector {
  resolveDocumentPermissions?(params): Promise<ResolvedDocumentPermissions>
}
```

or have connectors populate `doc.permissions` directly during `sync()`.

### 3. Update `source-access-control.ts`
This file currently ignores `permissions` entirely.

Do **not** make it responsible for provider semantics.
Instead:
- keep it as the simple visibility ACL builder for org/team modes
- add helper(s) for auto-sync materialization if needed

### 4. Skip unresolved docs in strict mode
If `auto-sync-permissions` doc permissions are incomplete/unresolved:
- add an item failure/skipped record to the sync batch
- do not ingest the document

## Tests
- extend `connector-sync.test.ts`
- add tests for per-document ACL application
- add tests proving unchanged docs are still skipped correctly
- add tests for unresolved docs being skipped

---

# Phase 4 – Confluence implementation

## Recommendation
Implement Confluence **before** Jira.

It is a better first end-to-end slice because the upstream model is easier to reason about.

## Scope recommendation for v1
### Confluence Cloud v1
Support:
- page-level read restrictions
- ancestor-derived inherited read restrictions (via ancestor walk)
- space-level read permissions for groups/users where available
- anonymous/public space access -> `org:*` only if your product policy says that means org-wide within Archestra

### Confluence Data Center v1.1
Support:
- `relevantViewRestrictions` endpoint for effective inherited view restrictions
- space permissions if needed for unrestricted pages

## Files to change
- `platform/backend/src/knowledge-base/connectors/confluence/confluence-connector.ts`
- maybe add `confluence-permissions.ts`
- `platform/backend/src/types/knowledge-connector.ts`
- tests under `confluence-connector.test.ts`

## Recommended implementation shape

### Option A – keep logic in connector helper(s)
Add Confluence-specific helpers:
- `fetchPageRestrictions(pageId)`
- `fetchAncestorRestrictions(pageId)` (Cloud)
- `fetchRelevantViewRestrictions(pageId)` (Data Center)
- `fetchSpaceReadPermissions(spaceKey)`
- `resolveEffectiveConfluencePermissions(page)`

### Option B – separate provider service
Add:
- `platform/backend/src/knowledge-base/connectors/confluence/confluence-permissions.ts`

This is easier to unit test and keeps connector file readable.

## Confluence Cloud algorithm (recommended)
1. Sync page content as today
2. For each page, get direct restrictions
3. Get ancestors for the page
4. For each ancestor, fetch direct restrictions
5. Determine whether the page is effectively restricted by any ancestor
6. Combine with space-level read permissions
7. Produce provider permission facts:
   - `isPublic`
   - `allowedEmails`
   - `allowedExternalGroups`
   - `complete`

## Important caveat
Because Cloud REST does not directly expose inherited restrictions, do **not** assume page-level restrictions alone are enough.

You must at least do the ancestor walk documented by Atlassian support.

## Safe v1 policy
If inherited restriction evaluation is ambiguous or incomplete:
- mark incomplete
- skip document

## Confluence-specific tests
Cases to cover:
1. unrestricted page in unrestricted space
2. page directly restricted to a group
3. page directly restricted to a user
4. page inheriting parent restriction
5. page with both ancestor + direct restrictions
6. page with unmapped group
7. page with no resolvable principals -> skipped
8. Data Center relevantViewRestrictions path

---

# Phase 5 – Jira implementation

## Warning
This is the hardest phase.

## Scope recommendation for v1
### Jira Cloud v1
Support only **classic/company-managed** projects and only these holder types initially:
- user
- group
- project role
- reporter
- current assignee
- project lead
- anyone/public

Defer for later if needed:
- custom user picker fields
- custom group picker fields
- all edge-case issue role types
- full team-managed parity if APIs behave differently

## Files to change
- `platform/backend/src/knowledge-base/connectors/jira/jira-connector.ts`
- maybe add `jira-permissions.ts`
- tests under `jira-connector.test.ts`

## Required upstream facts to gather
For each issue:
- project key / project id
- security level id (if any)
- reporter / assignee identifiers
- maybe project lead
- maybe project role actors

For each project:
- browse permission scheme grants
- project role memberships

For each security level:
- issue security level members

## Suggested Jira service structure
Create a separate helper/service with caches:

```ts
class JiraPermissionResolver {
  getProjectBrowseRules(projectId)
  getProjectRoleActors(projectId)
  getIssueSecurityMembers(projectId, securityLevelId)
  resolveIssuePermissions(issue)
}
```

This service should cache per-sync-run data because otherwise sync will explode into too many API calls.

## Jira Cloud algorithm (recommended)
1. Add `security` to fetched issue fields if not already included
2. For each issue, determine baseline project viewers from Browse Projects grants
3. If issue has security level, intersect/bound with security level members
4. Expand supported holders:
   - `user` -> direct user email if available
   - `group` -> canonical group identifier
   - `projectRole` -> project role actors -> users/groups
   - `reporter` -> issue reporter
   - `assignee` -> issue assignee
   - `projectLead` -> project lead
   - `anyone` -> public
5. Materialize to Archestra-local ACLs
6. If any required holder cannot be resolved confidently, mark incomplete and skip doc

## Why skip-on-uncertain matters
Jira permission schemes can include holder types that are not safely flattenable without more context.
If you guess wrong, you overexpose data.

## Jira-specific risks
1. Browse permissions can be granted via roles/groups/users/issue roles/custom fields
2. Issue security members API has classic-project caveats
3. User email may be unavailable because of privacy settings
4. Some issues may depend on role membership + group membership + issue fields simultaneously
5. Team-managed projects may need different handling

## Jira-specific tests
Cases to cover:
1. project browse granted to group only
2. project browse granted to project role -> role actor group
3. issue security level narrows project viewers
4. reporter-only issue security
5. assignee-only issue security
6. project lead issue security
7. public/anyone access
8. unsupported holder -> skipped
9. no security level -> browse-project-only ACL
10. company-managed supported / team-managed unsupported behavior

---

# Phase 6 – refresh and change propagation

## Goal
Handle changes after initial sync.

This phase is required for production quality.

## What changes can invalidate ACLs?
### Upstream changes
- Confluence page restriction changed
- Confluence space permission changed
- page moved under a different parent
- Jira permission scheme changed
- Jira project role membership changed
- Jira issue security level changed
- issue reporter/assignee changed

### Local changes
- Archestra team membership changed
- team external group mapping changed
- org member added/removed
- user email changed

## Minimal practical v1 behavior
1. upstream changes are picked up on next connector sync
2. local mapping changes require an explicit ACL refresh job

## Recommended admin affordances
Add a new action:
- "Recompute permissions ACLs"

This should:
- keep document content as-is
- rebuild document/chunk ACLs from stored permission metadata
- not require full remote resync if enough metadata is stored

## Optional later automation
Trigger ACL refresh jobs when:
- team member added/removed
- external group mapping added/removed

This likely touches:
- `platform/backend/src/routes/team.ts`
- team member / external group mutation handlers
- a new background task type

---

# Phase 7 – query path / runtime behavior

## Goal
Keep query path as unchanged as possible.

## Desired outcome
`query_knowledge_sources` should not need provider-specific logic.

It should continue to:
- build a normal user ACL
- run the existing KB chunk filtering query

## Files
- `platform/backend/src/archestra-mcp-server/knowledge-management.ts`
- `platform/backend/src/knowledge-base/query.ts`
- maybe `platform/backend/src/models/kb-chunk.ts`

## Query-time changes needed
Probably only minor ones:
- keep `buildUserAccessControlList` as-is if docs are materialized to `user_email:*` / `org:*`
- if you choose to keep `group:*` entries, extend user ACL builder to include group tokens derived from the user’s mapped teams/external groups

## Recommendation
For v1, prefer materialized `user_email:*` and avoid query-time group logic changes unless necessary.

---

# Phase 8 – UI / DX / docs / demo

## UI behavior
### Connector create/edit dialogs
Allow selecting `Auto-sync permissions`.

Suggested help text:
- "Enterprise only"
- "Requires mapping upstream groups to Archestra teams via Team External Groups"
- "Documents whose permissions can’t be resolved are skipped"

### Connector details page
Add visibility indicators and maybe sync warnings such as:
- X documents skipped because permissions could not be resolved

## Docs to update
- knowledge connector docs
- knowledge base visibility docs
- MCP tool docs for create/update connector visibility enum
- enterprise feature docs
- team external group docs (cross-link them)

## Demo scenario to record
1. create team `Engineering`
2. map external group `engineering` to that team
3. add user A to team, leave user B out
4. create Confluence/Jira connector with `auto-sync-permissions`
5. sync restricted docs
6. query as user A -> sees restricted doc
7. query as user B -> does not see restricted doc
8. change upstream restriction or local mapping
9. resync/recompute ACLs
10. show changed visibility taking effect

---

## Exact code hotspots to hand to agents

### Core backend
- `platform/backend/src/types/knowledge-base.ts`
- `platform/backend/src/types/knowledge-base-connector.ts`
- `platform/backend/src/types/knowledge-connector.ts`
- `platform/backend/src/knowledge-base/connector-sync.ts`
- `platform/backend/src/knowledge-base/source-access-control.ts`
- `platform/backend/src/knowledge-base/query.ts`
- `platform/backend/src/models/kb-document.ts`
- `platform/backend/src/models/kb-chunk.ts`
- `platform/backend/src/routes/knowledge-base.ts`
- `platform/backend/src/archestra-mcp-server/knowledge-management.ts`

### Identity / teams
- `platform/backend/src/models/team.ts`
- `platform/backend/src/models/member.ts`
- `platform/backend/src/routes/team.ts`
- `platform/backend/src/database/schemas/team-external-group.ts`

### Connector implementations
- `platform/backend/src/knowledge-base/connectors/base-connector.ts`
- `platform/backend/src/knowledge-base/connectors/jira/jira-connector.ts`
- `platform/backend/src/knowledge-base/connectors/confluence/confluence-connector.ts`

### Frontend
- `platform/frontend/src/app/knowledge/_parts/knowledge-source-visibility-selector.tsx`
- `platform/frontend/src/app/knowledge/knowledge-bases/_parts/create-connector-dialog.tsx`
- `platform/frontend/src/app/knowledge/knowledge-bases/_parts/edit-connector-dialog.tsx`
- connector visibility badges/pages

### Tests
- `platform/backend/src/routes/knowledge-base.test.ts`
- `platform/backend/src/archestra-mcp-server/knowledge-management.test.ts`
- `platform/backend/src/knowledge-base/source-access-control.test.ts`
- `platform/backend/src/knowledge-base/connector-sync.test.ts`
- `platform/backend/src/knowledge-base/query.test.ts`
- Jira/Confluence connector tests
- frontend dialog tests

---

## Suggested PR breakdown

### PR 1 – Visibility mode groundwork
Small, mechanical, low-risk.

### PR 2 – ACL materializer + identity mapping service
No Jira/Confluence yet; just reusable services + tests.

### PR 3 – Sync integration for per-document ACLs
Wire connector sync to use per-document ACLs in auto-sync mode.

### PR 4 – Confluence Cloud support
First real end-to-end provider.

### PR 5 – Confluence DC support
Add `relevantViewRestrictions` path.

### PR 6 – Jira Cloud company-managed support
Supported holder types only; fail closed for unsupported cases.

### PR 7 – Refresh/recompute ACL job + admin UX
Optional but strongly recommended.

### PR 8 – Docs/demo/polish
Finalize docs, screenshots, changelog, demo.

---

## What I would explicitly tell agents NOT to do
1. **Do not** fall back to `org:*` when permissions are unclear
2. **Do not** try to land Jira + Confluence + refresh automation in one PR
3. **Do not** rely on Confluence Cloud direct page restrictions alone; inherited restrictions matter
4. **Do not** invent a huge new ACL query engine for v1 unless forced
5. **Do not** assume Jira emails are always present
6. **Do not** assume abstract group/user principal lists can always flatten correctly without considering inherited/role semantics

---

## Recommended implementation order if you are using multiple agents

### Agent 1 – groundwork / schemas / routes / UI
Owns PR 1.

### Agent 2 – ACL materializer + org/team mapping layer
Owns PR 2.

### Agent 3 – sync pipeline integration
Owns PR 3.

### Agent 4 – Confluence provider implementation
Owns PR 4/5.

### Agent 5 – Jira provider implementation
Owns PR 6.

### Agent 6 – tests / docs / demo / cleanup
Owns PR 7/8.

---

## My final recommendation

If you need the best chance of shipping this successfully:

1. restore the visibility mode first
2. build the materialization layer second
3. ship **Confluence first**
4. ship **Jira second**, Cloud classic/company-managed first, fail closed for unsupported holder types
5. add refresh/recompute tooling before calling it “done”

The hardest technical decision is not the enum or the UI.
It is this:

> **whether you store abstract upstream principals or materialized Archestra-local ACLs**

My recommendation is:

> **materialize to Archestra-local ACLs in v1**

because it reuses the current query system and gives you a realistic path to correctness.
