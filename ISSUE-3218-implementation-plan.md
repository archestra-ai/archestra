# Issue #3218 – Auto-sync permissions ACL support for Jira + Confluence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement secure, automated document-level permission syncing from Jira Cloud and Confluence Cloud into Archestra's Knowledge Base, materializing upstream permissions to user-specific search filters.

**Architecture:** Extend Archestra's Knowledge Base connector visibility with a new `auto-sync-permissions` mode. During sync, connectors extract upstream read permissions (page restrictions in Confluence; project browse grants & issue security levels in Jira), convert them to local `user_email:<email>` ACL entries, and store them alongside content. Query-time vector and keyword search filters remain unchanged, checking the query user's email against document ACL entries to ensure strict access control.

**Tech Stack:** TypeScript, Node.js (Fastify), PostgreSQL, Drizzle ORM, Zod, React, Next.js, Jira Cloud API, Confluence Cloud API.

---

## Technical Overview & Baseline

### 1. Existing ACL Architecture
Archestra uses PostgreSQL `jsonb` array columns (`acl`) on both `kb_documents` and `kb_chunks`.
Search queries filter results using the PG `?|` operator (contains any of these keys) against the user's ACL.
At query time, `buildUserAccessControlList` constructs the user's runtime ACL:
```typescript
const acl = ["org:*", `user_email:${userEmail}`, ...teamIds.map(id => `team:${id}`)]
```

### 2. Identity Mapping Strategy
Upstream groups and users are converted to Archestra members:
1. **Direct Email Mapping**: Upstream user account email maps to Archestra user email.
2. **External Group Mapping**: Upstream groups are mapped to Archestra teams using the existing `team_external_group` database mappings. These teams are then expanded to their user email memberships.
3. **Fail-Closed Policy**: If any permission holder cannot be mapped (e.g., an unmapped group, or a user without a public email address), the document must be **skipped** from ingestion, and a sync status warning recorded.

### 3. Eventual Consistency of Mappings
Materializing permissions to local user emails means that changes to Archestra team memberships or group mappings do not immediately reflect on stored document ACLs. To guarantee security, an explicit re-materialization job must run when these local mappings change.

---

## File Structure Changes

| Subsystem | File Path | Action | Description |
|-----------|-----------|--------|-------------|
| Types | `platform/backend/src/types/knowledge-base.ts` | Modify | Add `auto-sync-permissions` visibility option |
| Types | `platform/backend/src/types/knowledge-connector.ts` | Modify | Extend `ConnectorDocument.permissions` shape |
| Database | `platform/backend/src/database/schemas/kb-document.ts` | Modify | Add `permissionSyncStatus` and `permissionSyncMetadata` |
| Database | `platform/backend/src/database/migrations/xxxx_add_kb_permission_columns.sql` | Create | Database migration for status/metadata columns |
| Service | `platform/backend/src/knowledge-base/identity-resolution.ts` | Create | Resolve emails and external groups to local users |
| Service | `platform/backend/src/knowledge-base/acl-materializer.ts` | Create | Build final `AclEntry[]` from resolved permissions |
| Service | `platform/backend/src/knowledge-base/source-access-control.ts` | Modify | Implement per-document ACL builders |
| Service | `platform/backend/src/knowledge-base/connector-sync.ts` | Modify | Integrate per-document ACL matching and status tracking |
| Connector | `platform/backend/src/knowledge-base/connectors/base-connector.ts` | Modify | Declare optional `resolveDocumentPermissions` hook |
| Connector | `platform/backend/src/knowledge-base/connectors/confluence/confluence-connector.ts` | Modify | Retrieve restrictions and traverse ancestor tree |
| Connector | `platform/backend/src/knowledge-base/connectors/jira/jira-connector.ts` | Modify | Fetch `security` fields and project scheme actors |
| Backend | `platform/backend/src/routes/knowledge-base.ts` | Modify | Validate routes with new visibility enum + enterprise gate |
| Frontend | `platform/frontend/src/app/knowledge/_parts/knowledge-source-visibility-selector.tsx` | Modify | Add visibility option UI toggle |

---

## Detailed Phases & Tasks

### Phase 1 – Schema & Visibility Mode Groundwork

#### Task 1: Add Visibility Enum & Database Columns
- [ ] **Step 1: Modify backend visibility types**
  File: `platform/backend/src/types/knowledge-base.ts:1-13`
  Change the enum definition to:
  ```typescript
  export const KnowledgeSourceVisibilitySchema = z.enum([
    "org-wide",
    "team-scoped",
    "auto-sync-permissions", // Added
  ]);
  export type KnowledgeSourceVisibility = z.infer<typeof KnowledgeSourceVisibilitySchema>;
  ```

- [ ] **Step 2: Add database columns to `kb_documents`**
  File: `platform/backend/src/database/schemas/kb-document.ts`
  Add columns:
  ```typescript
  permissionSyncStatus: text("permission_sync_status")
    .$type<"synced" | "skipped_unresolvable">()
    .notNull()
    .default("synced"),
  permissionSyncMetadata: jsonb("permission_sync_metadata")
    .$type<{
      provider: string;
      rawPermissions?: Record<string, unknown>;
      resolvedEmails?: string[];
      skippedGroups?: string[];
      lastSyncedAt?: string;
    }>(),
  ```

- [ ] **Step 3: Generate the Drizzle database migration**
  Run command in `platform/`:
  ```bash
  pnpm db:generate
  ```
  Expected: A new migration file created in `platform/backend/src/database/migrations/`. Verify it adds the two columns to `kb_documents`.

- [ ] **Step 4: Run the migration**
  Run command in `platform/`:
  ```bash
  pnpm db:migrate
  ```
  Expected: Successful application of SQL migrations.

- [ ] **Step 5: Commit changes**
  Run:
  ```bash
  git add backend/src/types/knowledge-base.ts backend/src/database/schemas/kb-document.ts backend/src/database/migrations/
  git commit -m "feat: add auto-sync-permissions visibility enum and database columns"
  ```

#### Task 2: Route Gating & Validation Tests
- [ ] **Step 1: Apply route validation and enterprise gate**
  File: `platform/backend/src/routes/knowledge-base.ts`
  Update POST `/api/connectors` and PUT `/api/connectors/:id` validation logic. Ensure `auto-sync-permissions` requires `enterpriseTier.isKnowledgeBaseActive()`.
  ```typescript
  if (visibility === "auto-sync-permissions" && !enterpriseTier.isKnowledgeBaseActive()) {
    throw new ApiError(403, "Auto-sync permissions requires an Enterprise license");
  }
  ```

- [ ] **Step 2: Write route gating tests**
  File: `platform/backend/src/routes/knowledge-base.test.ts`
  Write tests verifying that non-enterprise configurations fail to set `auto-sync-permissions` with a 403 status, while enterprise or small teams (<30) succeed.
  Run:
  ```bash
  pnpm --filter backend test src/routes/knowledge-base.test.ts
  ```
  Expected: PASS

- [ ] **Step 3: Commit changes**
  Run:
  ```bash
  git add backend/src/routes/knowledge-base.ts backend/src/routes/knowledge-base.test.ts
  git commit -m "feat: enforce enterprise license gating for permission sync visibility"
  ```

#### Task 3: Frontend Visibility Selector & Connector Dialogs
- [ ] **Step 1: Add new option to Visibility Selector**
  File: `platform/frontend/src/app/knowledge/_parts/knowledge-source-visibility-selector.tsx`
  Add `"auto-sync-permissions"` option with Shield/Lock icon and appropriate helper copy:
  "Auto-sync permissions: Synchronize upstream file-level restrictions directly to Archestra."
  Ensure it behaves similarly to `team-scoped` regarding `enterpriseLocked`.

- [ ] **Step 2: Adapt Dialog forms to permit third visibility mode**
  Files:
  - `platform/frontend/src/app/knowledge/knowledge-bases/_parts/create-connector-dialog.tsx`
  - `platform/frontend/src/app/knowledge/knowledge-bases/_parts/edit-connector-dialog.tsx`
  Make sure form submission handles `"auto-sync-permissions"` and serializes it to the backend payload.

- [ ] **Step 3: Commit changes**
  Run:
  ```bash
  git commit -am "frontend: add auto-sync-permissions visibility options to UI selectors and dialogs"
  ```

---

### Phase 2 – Identity Resolution & ACL Materializer

#### Task 1: Create Identity Resolution Service
- [ ] **Step 1: Implement Identity Resolver**
  Create File: `platform/backend/src/knowledge-base/identity-resolution.ts`
  Add resolution code to map emails and external groups:
  ```typescript
  import { memberModel } from "@/models/member";
  import { teamModel } from "@/models/team";

  export class IdentityResolutionService {
    private orgId: string;

    constructor(orgId: string) {
      this.orgId = orgId;
    }

    async resolveEmailsToMembers(emails: string[]): Promise<string[]> {
      const activeMembers = await memberModel.findAllByOrganization(this.orgId);
      const memberEmails = new Set(activeMembers.map(m => m.email.toLowerCase()));
      return emails.filter(email => memberEmails.has(email.toLowerCase()));
    }

    async resolveGroupsToEmails(groupIds: string[]): Promise<{
      resolvedEmails: string[];
      unmappedGroups: string[];
    }> {
      const resolvedEmails: string[] = [];
      const unmappedGroups: string[] = [];

      for (const groupId of groupIds) {
        const teams = await teamModel.findTeamsByExternalGroup(this.orgId, groupId);
        if (teams.length === 0) {
          unmappedGroups.push(groupId);
          continue;
        }
        for (const team of teams) {
          const members = await teamModel.getTeamMembersWithUsers(team.id);
          for (const member of members) {
            if (member.email) {
              resolvedEmails.push(member.email.toLowerCase());
            }
          }
        }
      }

      return {
        resolvedEmails: [...new Set(resolvedEmails)],
        unmappedGroups,
      };
    }
  }
  ```

- [ ] **Step 2: Commit changes**
  Run:
  ```bash
  git add backend/src/knowledge-base/identity-resolution.ts
  git commit -m "feat: implement IdentityResolutionService for emails and group mappings"
  ```

#### Task 2: Create ACL Materializer Service
- [ ] **Step 1: Implement Materializer**
  Create File: `platform/backend/src/knowledge-base/acl-materializer.ts`
  Add code to materialize Resolved upstream permissions:
  ```typescript
  import { AclEntry } from "@/types/kb-document";
  import { IdentityResolutionService } from "./identity-resolution";

  export interface UpstreamPermissions {
    isPublic: boolean;
    users?: string[];
    groups?: string[];
  }

  export class AclMaterializer {
    private resolver: IdentityResolutionService;

    constructor(resolver: IdentityResolutionService) {
      this.resolver = resolver;
    }

    async materialize(permissions: UpstreamPermissions): Promise<{
      acl: AclEntry[];
      complete: boolean;
      skippedGroups: string[];
      resolvedEmails: string[];
    }> {
      if (permissions.isPublic) {
        return { acl: ["org:*"], complete: true, skippedGroups: [], resolvedEmails: [] };
      }

      const rawEmails = permissions.users || [];
      const rawGroups = permissions.groups || [];

      const resolvedUserEmails = await this.resolver.resolveEmailsToMembers(rawEmails);
      const { resolvedEmails: groupEmails, unmappedGroups } = await this.resolver.resolveGroupsToEmails(rawGroups);

      const allEmails = [...new Set([...resolvedUserEmails, ...groupEmails])];
      const aclEntries: AclEntry[] = allEmails.map((email): AclEntry => `user_email:${email.toLowerCase()}`);

      // Fail-closed condition: if unmapped groups exist, resolution is incomplete
      const complete = unmappedGroups.length === 0;

      return {
        acl: aclEntries.sort(),
        complete,
        skippedGroups: unmappedGroups,
        resolvedEmails: allEmails,
      };
    }
  }
  ```

- [ ] **Step 2: Write materializer unit tests**
  Create File: `platform/backend/src/knowledge-base/acl-materializer.test.ts`
  Assert:
  - Correct email matching to existing org users
  - Proper team mapping lookup and expansion to user emails
  - Correct complete status handling (false when unmapped groups exist)
  - Sorting and deduplication of ACL output
  Run:
  ```bash
  pnpm --filter backend test src/knowledge-base/acl-materializer.test.ts
  ```
  Expected: PASS

- [ ] **Step 3: Commit changes**
  Run:
  ```bash
  git add backend/src/knowledge-base/acl-materializer.ts backend/src/knowledge-base/acl-materializer.test.ts
  git commit -m "feat: implement AclMaterializer and verify behavior with unit tests"
  ```

---

### Phase 3 – Sync Pipeline & Access Control Integration

#### Task 1: Update Source Access Control
- [ ] **Step 1: Wire permissions parameter handling**
  File: `platform/backend/src/knowledge-base/source-access-control.ts`
  Modify `buildDocumentAccessControlList` to properly handle and materialize permissions when the visibility mode matches `auto-sync-permissions`:
  ```typescript
  function buildDocumentAccessControlList(params: {
    visibility: KnowledgeSourceVisibility;
    teamIds: string[];
    permissions?: { users?: string[]; groups?: string[]; isPublic?: boolean; };
    materializedAcl?: AclEntry[]; // Added hook for pre-materialized auto-sync ACL
  }): AclEntry[] {
    if (params.visibility === "auto-sync-permissions") {
      return params.materializedAcl || [];
    }
    switch (params.visibility) {
      case "org-wide": return ["org:*"];
      case "team-scoped": return params.teamIds.map((id): AclEntry => `team:${id}`);
    }
  }
  ```

- [ ] **Step 2: Commit changes**
  Run:
  ```bash
  git add backend/src/knowledge-base/source-access-control.ts
  git commit -m "feat: adapt source access control to process pre-materialized ACLs"
  ```

#### Task 2: Extend Connector Typings
- [ ] **Step 1: Update `ConnectorDocument` and Base Interface**
  File: `platform/backend/src/types/knowledge-connector.ts`
  Add status fields and verify base types:
  ```typescript
  export interface ConnectorDocument {
    id: string;
    title: string;
    content: string;
    sourceUrl?: string;
    metadata: Record<string, unknown>;
    updatedAt?: Date;
    permissions?: {
      users?: string[];
      groups?: string[];
      isPublic?: boolean;
      complete?: boolean;
      debug?: Record<string, unknown>;
    };
    mediaContent?: { mimeType: string; data: string; };
  }
  ```
  File: `platform/backend/src/knowledge-base/connectors/base-connector.ts`
  Define optional abstract method:
  ```typescript
  // Inside BaseConnector
  resolveDocumentPermissions?(
    document: ConnectorDocument
  ): Promise<ConnectorDocument["permissions"]>;
  ```

- [ ] **Step 2: Commit changes**
  Run:
  ```bash
  git commit -am "feat: extend ConnectorDocument typings with status fields"
  ```

#### Task 3: Modify the Ingestion Loop
- [ ] **Step 1: Update `ingestDocument` to support per-doc ACLs and skips**
  File: `platform/backend/src/knowledge-base/connector-sync.ts`
  Locate `ingestDocument` and adapt the signature and logic:
  1. Add `visibility: KnowledgeSourceVisibility` to signature.
  2. Include `permissionSyncMetadata` in the document's content hash to ensure permission modifications force re-sync:
     ```typescript
     const permissionHashString = doc.permissions ? JSON.stringify(doc.permissions) : "";
     const contentHash = computeHash(doc.content + JSON.stringify(doc.metadata) + permissionHashString);
     ```
  3. Resolve ACL for `"auto-sync-permissions"` mode:
     ```typescript
     let targetAcl = acl;
     let syncStatus: "synced" | "skipped_unresolvable" = "synced";
     let syncMetadata: Record<string, any> | undefined = undefined;

     if (visibility === "auto-sync-permissions") {
       if (!doc.permissions) {
         // Missing upstream metadata -> default to fail-closed skip
         logger.warn(`Skipping document ${doc.id} - missing permission metadata`);
         return { status: "skipped", reason: "missing_permissions" };
       }

       const materializer = new AclMaterializer(new IdentityResolutionService(organizationId));
       const resolved = await materializer.materialize(doc.permissions);

       syncMetadata = {
         provider: connector.type,
         rawPermissions: doc.permissions,
         resolvedEmails: resolved.resolvedEmails,
         skippedGroups: resolved.skippedGroups,
         lastSyncedAt: new Date().toISOString(),
       };

       if (!resolved.complete) {
         // Fail closed because group mapping is incomplete
         await KbDocumentModel.updatePermissionStatus(docId, "skipped_unresolvable", syncMetadata);
         return { status: "skipped", reason: "unmapped_groups" };
       }

       targetAcl = resolved.acl;
     }
     ```
  4. Write `targetAcl`, `syncStatus`, and `syncMetadata` into the database models.

- [ ] **Step 2: Update model CRUD methods to persist columns**
  File: `platform/backend/src/models/kb-document.ts`
  Modify insert and update queries to handle `permissionSyncStatus` and `permissionSyncMetadata`.

- [ ] **Step 3: Commit changes**
  Run:
  ```bash
  git add backend/src/knowledge-base/connector-sync.ts backend/src/models/kb-document.ts
  git commit -m "feat: integrate per-document permission materialization into the sync ingestion flow"
  ```

---

### Phase 4 – Confluence Cloud Implementation

#### Task 1: Retrieve Restrictions and Ancestors
- [ ] **Step 1: Implement permission extraction helper**
  Create File: `platform/backend/src/knowledge-base/connectors/confluence/confluence-permissions.ts`
  Add page permissions fetching and ancestor walk caching:
  ```typescript
  import { ConfluenceClient } from "./confluence-client"; // Hypothetical/existing client reference

  export class ConfluencePermissionResolver {
    private client: any;
    private spacePermissionsCache = new Map<string, any>();
    private pageRestrictionsCache = new Map<string, any>();

    constructor(client: any) {
      this.client = client;
    }

    async resolvePermissions(pageId: string, spaceKey: string): Promise<{
      users: string[];
      groups: string[];
      isPublic: boolean;
    }> {
      const pageRestrictions = await this.fetchPageRestrictions(pageId);
      const ancestorRestrictions = await this.fetchAncestorRestrictions(pageId);

      // Merge direct page restrictions with inherited ancestor restrictions (AND semantics)
      const allowedUsers = this.intersectAllowedUsers(pageRestrictions.users, ancestorRestrictions.users);
      const allowedGroups = this.intersectAllowedGroups(pageRestrictions.groups, ancestorRestrictions.groups);

      // If unrestricted, space permissions determine access
      const isPublic = pageRestrictions.isPublic && ancestorRestrictions.isPublic;

      return {
        users: allowedUsers,
        groups: allowedGroups,
        isPublic,
      };
    }

    private async fetchPageRestrictions(pageId: string) {
      if (this.pageRestrictionsCache.has(pageId)) {
        return this.pageRestrictionsCache.get(pageId);
      }
      // Call GET /rest/api/content/{id}/restriction
      const response = await this.client.sendRequest({
        url: `/rest/api/content/${pageId}/restriction/byOperation/read`,
        method: "GET",
      });
      // Extract users and groups
      const users = (response.data.restrictions?.user?.results || []).map((u: any) => u.email);
      const groups = (response.data.restrictions?.group?.results || []).map((g: any) => g.name);
      const isPublic = users.length === 0 && groups.length === 0;

      const result = { users, groups, isPublic };
      this.pageRestrictionsCache.set(pageId, result);
      return result;
    }

    private async fetchAncestorRestrictions(pageId: string) {
      // Traverse page ancestors and intersect their read restrictions
      const ancestors = await this.client.getAncestors(pageId);
      const usersList: string[][] = [];
      const groupsList: string[][] = [];

      for (const ancestor of ancestors) {
        const restrictions = await this.fetchPageRestrictions(ancestor.id);
        if (!restrictions.isPublic) {
          usersList.push(restrictions.users);
          groupsList.push(restrictions.groups);
        }
      }

      if (usersList.length === 0 && groupsList.length === 0) {
        return { users: [], groups: [], isPublic: true };
      }

      return {
        users: this.intersectArrays(usersList),
        groups: this.intersectArrays(groupsList),
        isPublic: false,
      };
    }

    private intersectArrays(arrays: string[][]): string[] {
      if (arrays.length === 0) return [];
      return arrays.reduce((a, b) => a.filter(c => b.includes(c)));
    }

    private intersectAllowedUsers(a: string[], b: string[]) {
      if (a.length === 0) return b;
      if (b.length === 0) return a;
      return a.filter(x => b.includes(x));
    }

    private intersectAllowedGroups(a: string[], b: string[]) {
      if (a.length === 0) return b;
      if (b.length === 0) return a;
      return a.filter(x => b.includes(x));
    }
  }
  ```

- [ ] **Step 2: Integrate resolver inside Confluence Connector**
  File: `platform/backend/src/knowledge-base/connectors/confluence/confluence-connector.ts`
  Update page fetching logic in `sync()`. If visibility is `auto-sync-permissions`, invoke `ConfluencePermissionResolver.resolvePermissions` for each synced page and write permissions metadata to the produced `ConnectorDocument`.

- [ ] **Step 3: Test Confluence sync integrations**
  File: `platform/backend/src/knowledge-base/connectors/confluence/confluence-connector.test.ts`
  Add test blocks checking:
  - Space level visibility mapping
  - Page level restriction extraction
  - Deep parent-child constraint intersections
  Run:
  ```bash
  pnpm --filter backend test src/knowledge-base/connectors/confluence/confluence-connector.test.ts
  ```
  Expected: PASS

- [ ] **Step 4: Commit changes**
  Run:
  ```bash
  git add backend/src/knowledge-base/connectors/confluence/
  git commit -m "feat: implement Confluence permission resolution with ancestor traversal and caching"
  ```

---

### Phase 5 – Core Recomputation & Local Change Propagation (Mandatory)

#### Task 1: Create Per-Document Recomputation Service
- [ ] **Step 1: Implement recompute action handler**
  File: `platform/backend/src/knowledge-base/source-access-control.ts`
  Add the `refreshAutoSyncDocumentAccessControlLists(connectorId)` method:
  ```typescript
  async refreshAutoSyncDocumentAccessControlLists(connectorId: string): Promise<void> {
    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
    if (!connector || connector.visibility !== "auto-sync-permissions") return;

    const documents = await KbDocumentModel.findAllByConnector(connectorId);
    const materializer = new AclMaterializer(new IdentityResolutionService(connector.organizationId));

    for (const doc of documents) {
      const syncMeta = doc.permissionSyncMetadata;
      if (!syncMeta || !syncMeta.rawPermissions) continue;

      const resolved = await materializer.materialize(syncMeta.rawPermissions);

      // Re-save recomputed ACLs and mappings
      const updatedMetadata = {
        ...syncMeta,
        resolvedEmails: resolved.resolvedEmails,
        skippedGroups: resolved.skippedGroups,
        lastSyncedAt: new Date().toISOString(),
      };

      const newStatus = resolved.complete ? "synced" : "skipped_unresolvable";

      await KbDocumentModel.updateAclAndSyncStatus(
        doc.id,
        resolved.complete ? resolved.acl : [],
        newStatus,
        updatedMetadata
      );
    }
  }
  ```

- [ ] **Step 2: Hook recomputation to Local mutation paths**
  Files:
  - `platform/backend/src/routes/team.ts` (Trigger sync/async queue job when team membership changes or team gets deleted)
  - `platform/backend/src/routes/organization.ts` (Trigger sync when members leave or join)
  Write unit tests validating that mutating team memberships propagates modifications directly to the relevant document ACLs.

- [ ] **Step 3: Commit changes**
  Run:
  ```bash
  git commit -am "feat: implement mandatory auto-sync ACL recomputation and membership propagation"
  ```

---

### Phase 6 – Jira Cloud Implementation

#### Task 1: Fetch Project Schemas & Issue Fields
- [ ] **Step 1: Request Security fields**
  File: `platform/backend/src/knowledge-base/connectors/jira/jira-connector.ts`
  Modify `SEARCH_FIELDS` array, appending the `security` property:
  ```typescript
  const SEARCH_FIELDS = [
    // ... existing fields ...
    "security" // Added
  ];
  ```

- [ ] **Step 2: Build Jira Permissions Resolver**
  Create File: `platform/backend/src/knowledge-base/connectors/jira/jira-permissions.ts`
  Add logic resolving browse rules and security levels:
  ```typescript
  export class JiraPermissionResolver {
    private client: any;
    private projectBrowseRulesCache = new Map<string, any>();
    private securityLevelsCache = new Map<string, any>();

    constructor(client: any) {
      this.client = client;
    }

    async resolveIssuePermissions(issue: any): Promise<{
      users: string[];
      groups: string[];
      isPublic: boolean;
    }> {
      const projectId = issue.fields.project.id;
      const securityLevelId = issue.fields.security?.id;

      const projectBrowseRules = await this.getProjectBrowseRules(projectId);
      let allowedActors = projectBrowseRules;

      if (securityLevelId) {
        const securityRules = await this.getSecurityLevelRules(projectId, securityLevelId);
        allowedActors = this.intersectPermissions(projectBrowseRules, securityRules);
      }

      return {
        users: allowedActors.users,
        groups: allowedActors.groups,
        isPublic: allowedActors.isPublic,
      };
    }

    private async getProjectBrowseRules(projectId: string) {
      if (this.projectBrowseRulesCache.has(projectId)) {
        return this.projectBrowseRulesCache.get(projectId);
      }
      // Call GET /rest/api/3/project/{projectIdOrKey}/permissionscheme
      const response = await this.client.sendRequest({
        url: `/rest/api/3/project/${projectId}/permissionscheme?expand=permissions.grantee`,
        method: "GET",
      });
      // Extract actors allowed to 'BROWSE_PROJECTS'
      const browseGrants = response.data.permissions?.filter(
        (p: any) => p.permission === "BROWSE_PROJECTS"
      ) || [];
      const result = this.extractGrantees(browseGrants);
      this.projectBrowseRulesCache.set(projectId, result);
      return result;
    }

    private async getSecurityLevelRules(projectId: string, levelId: string) {
      const cacheKey = `${projectId}:${levelId}`;
      if (this.securityLevelsCache.has(cacheKey)) {
        return this.securityLevelsCache.get(cacheKey);
      }
      // Call GET /rest/api/3/issuesecurityschemes
      const response = await this.client.sendRequest({
        url: `/rest/api/3/issuesecuritylevelmember/member?issueSecurityLevelId=${levelId}`,
        method: "GET",
      });
      const result = this.extractGrantees(response.data.results || []);
      this.securityLevelsCache.set(cacheKey, result);
      return result;
    }

    private extractGrantees(grants: any[]) {
      const users: string[] = [];
      const groups: string[] = [];
      let isPublic = false;

      for (const grant of grants) {
        const holder = grant.holder || grant.grantee;
        if (!holder) continue;

        switch (holder.type) {
          case "user":
            if (holder.parameter) users.push(holder.parameter);
            break;
          case "group":
            if (holder.parameter) groups.push(holder.parameter);
            break;
          case "anyone":
            isPublic = true;
            break;
        }
      }

      return { users, groups, isPublic };
    }

    private intersectPermissions(a: any, b: any) {
      if (a.isPublic) return b;
      if (b.isPublic) return a;
      return {
        users: a.users.filter((u: string) => b.users.includes(u)),
        groups: a.groups.filter((g: string) => b.groups.includes(g)),
        isPublic: false,
      };
    }
  }
  ```

- [ ] **Step 3: Integrate permissions in Jira Sync loop**
  File: `platform/backend/src/knowledge-base/connectors/jira/jira-connector.ts`
  Map output of `JiraPermissionResolver.resolveIssuePermissions` onto `ConnectorDocument` during ingestion.

- [ ] **Step 4: Test Jira permission mapping**
  File: `platform/backend/src/knowledge-base/connectors/jira/jira-connector.test.ts`
  Assert project-wide constraints, assignee validations, security schema configurations, and missing/null values skips.
  Run:
  ```bash
  pnpm --filter backend test src/knowledge-base/connectors/jira/jira-connector.test.ts
  ```
  Expected: PASS

- [ ] **Step 5: Commit changes**
  Run:
  ```bash
  git add backend/src/knowledge-base/connectors/jira/
  git commit -m "feat: implement Jira security level matching and browse permission resolving"
  ```

---

### Phase 7 – UI Dashboard & Admin Visibility

#### Task 1: Render skipped documents report
- [ ] **Step 1: Expose skipped/unresolved counts in detail page**
  File: `platform/frontend/src/app/knowledge/knowledge-bases/_parts/connector-sync-warnings.tsx`
  Create a component displaying skipped documents list referencing unmapped groups.
  Link to Team Settings mapping pages directly from the warnings layout.

- [ ] **Step 2: Add force recompute action**
  Add a "Recompute Permissions" button triggering backend recomputation routes.

- [ ] **Step 3: Commit changes**
  Run:
  ```bash
  git commit -am "frontend: render permission-sync skipped report layout and recompute action buttons"
  ```

---

## Acceptance Criteria Checklist

- [ ] **Enterprise Gating:** Attempting to configure `auto-sync-permissions` without an active enterprise license returns a 403 Forbidden response.
- [ ] **Identity Mapping completeness:** Document is fully skipped (empty ACL) when it references a group missing mapping configurations.
- [ ] **Confluence restrictions mapping:** Restricted Confluence pages are accessible only to resolved user emails from matching groups/users.
- [ ] **Jira security rules mapping:** Issues with security levels or restrictive browse permissions are skipped if unmapped actors exist, and match materialized user emails when synced.
- [ ] **Change propagation consistency:** Changing external team assignments triggers automatic ACL updates on next run or via direct manual trigger.
- [ ] **Performance benchmark:** Sync loop does not exceed 1 API request per document when walking Confluence hierarchies or resolving Jira metadata caches.
