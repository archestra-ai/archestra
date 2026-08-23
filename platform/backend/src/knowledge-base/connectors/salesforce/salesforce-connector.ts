import { Connection } from "jsforce";
import * as metrics from "@/observability/metrics";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorItemFailure,
  ConnectorSyncBatch,
  DocumentPermissions,
  GroupMembershipYield,
  GroupMemberYield,
  PermissionProbeResult,
  PermissionSnapshotYield,
  PermissionSyncParams,
  PermissionSyncState,
  ResolveMappedEmail,
  SalesforceCheckpoint,
  SalesforceConfig,
} from "@/types";
import { SalesforceConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
  isoCursorWithSkewBuffer,
  truncateConnectorContent,
} from "../base-connector";

const DEFAULT_BATCH_SIZE = 200;
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const TEST_CONNECTION_SOQL = "SELECT Id FROM User LIMIT 1";

/**
 * Maximum text length per document (500KB), matching GDrive connector.
 * Prevents oversized documents from very large Description fields or
 * many CaseComments.
 */
const MAX_CONTENT_LENGTH = 500_000;

/**
 * Maximum number of CaseComments to embed per Case document.
 * Beyond this limit we log a truncation warning (matching Linear's
 * comment truncation pattern).
 */
const MAX_CASE_COMMENTS = 100;

/**
 * Default Salesforce objects synced when no explicit objects are configured.
 * Matches the issue scope: Accounts, Contacts, Opportunities, Cases.
 * CaseComments are fetched inline via SOQL subquery on Case.
 */
const DEFAULT_OBJECTS = ["Account", "Contact", "Opportunity", "Case"];
const BASE_FIELDS = ["Id", "LastModifiedDate"];

/**
 * Per-object default fields for richer simple-mode documents.
 * These are standard fields available in every Salesforce org.
 * Custom objects fall back to BASE_FIELDS.
 */
const DEFAULT_FIELDS_BY_OBJECT: Record<string, string[]> = {
  Account: [
    "Id",
    "Name",
    "Industry",
    "Type",
    "Website",
    "Phone",
    "BillingCity",
    "BillingState",
    "OwnerId",
    "LastModifiedDate",
  ],
  Contact: [
    "Id",
    "Name",
    "FirstName",
    "LastName",
    "Email",
    "Phone",
    "Title",
    "AccountId",
    "LastModifiedDate",
  ],
  Opportunity: [
    "Id",
    "Name",
    "Amount",
    "StageName",
    "CloseDate",
    "Probability",
    "AccountId",
    "OwnerId",
    "LastModifiedDate",
  ],
  Case: [
    "Id",
    "CaseNumber",
    "Subject",
    "Status",
    "Priority",
    "Description",
    "ContactId",
    "AccountId",
    "OwnerId",
    "LastModifiedDate",
  ],
  // Knowledge Articles — opt-in via objects list: "Knowledge__kav"
  Knowledge__kav: [
    "Id",
    "Title",
    "Summary",
    "ArticleNumber",
    "PublishStatus",
    "VersionNumber",
    "LastModifiedDate",
  ],
};

/** SOQL relationship subquery to fetch Case Comments inline. */
const CASE_COMMENTS_SUBQUERY =
  "(SELECT Id, CommentBody, CreatedDate FROM CaseComments ORDER BY CreatedDate ASC LIMIT " +
  MAX_CASE_COMMENTS +
  ")";

/**
 * Safe pattern for SOQL identifiers (object names and field names).
 * Allows standard API names, custom fields (__c), relationship paths (Account.Name).
 */
const SAFE_SOQL_IDENTIFIER =
  /^[a-zA-Z_][a-zA-Z0-9_]*(?:__[a-zA-Z0-9]+)?(?:\.[a-zA-Z_][a-zA-Z0-9_]*(?:__[a-zA-Z0-9]+)?)*$/;

// ===== Internal types =====

type AdvancedObjectConfig = Record<
  string,
  {
    fields?: string[];
    associations?: Record<string, string[]>;
  }
>;

type ObjectSyncSpec = {
  objectName: string;
  fields: string[];
  associationFields: string[];
  includeCaseComments: boolean;
};

type SyncProgress = {
  objectCursorMap: Record<string, string>;
  maxLastSyncedAt?: string;
};

type SfQueryResult = {
  done: boolean;
  totalSize: number;
  records: SfRecord[];
  nextRecordsUrl?: string;
};

type SfRecord = Record<string, unknown> & {
  Id?: string;
  Name?: string;
  LastModifiedDate?: string;
  CaseNumber?: string;
  Subject?: string;
  attributes?: { type?: string; url?: string };
  CaseComments?: {
    totalSize: number;
    done: boolean;
    records: Array<{
      CommentBody?: string;
      CreatedDate?: string;
    }>;
  };
};

// ===== Connector =====

export class SalesforceConnector extends BaseConnector {
  type = "salesforce" as const;
  supportsPermissionSync = true;

  /** Per-permission-pass state; re-armed by every permission hook entry. */
  private permConnection: Connection | null = null;
  /** Object name → OWD sharing model (null = metadata read failed). */
  private sharingModelCache = new Map<string, string | null>();
  /** Salesforce user id → email (null = inactive/unresolvable). */
  private userEmailCache = new Map<string, string | null>();
  /** Account id → resolved audience (Contact parent-inheritance reuse). */
  private recordAudienceCache = new Map<
    string,
    { permissions: DocumentPermissions; resolutionFailed: boolean }
  >();
  /** Objects whose <Obj>Share table is absent/unqueryable this pass. */
  private shareTableBroken = new Set<string>();
  private droppedPrincipals = 0;
  /** Admin member-override lookup, injected by the pass (null = none). */
  private mappedEmailResolver: ResolveMappedEmail | null = null;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseSalesforceConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid Salesforce configuration: loginUrl must be a URL and advancedObjectConfigJson must be valid JSON object text when provided",
      };
    }

    // Validate loginUrl is a proper HTTP(S) URL (matching Linear's URL check)
    if (!/^https?:\/\/.+/.test(parsed.loginUrl)) {
      return {
        valid: false,
        error: "loginUrl must be a valid HTTP(S) URL",
      };
    }

    if (parsed.advancedObjectConfigJson) {
      try {
        const obj = JSON.parse(parsed.advancedObjectConfigJson);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
          return {
            valid: false,
            error:
              "Invalid Salesforce configuration: advancedObjectConfigJson must be a JSON object",
          };
        }
        // Validate all object names and field names are safe identifiers
        const identifierError = validateAdvancedConfigIdentifiers(obj);
        if (identifierError) {
          return { valid: false, error: identifierError };
        }
      } catch {
        return {
          valid: false,
          error:
            "Invalid Salesforce configuration: advancedObjectConfigJson must be valid JSON object text",
        };
      }
    }

    // Validate object names when specified
    if (parsed.objects && parsed.objects.length > 0) {
      for (const objectName of parsed.objects) {
        if (!SAFE_SOQL_IDENTIFIER.test(objectName)) {
          return {
            valid: false,
            error: `Invalid object name "${objectName}": must be a valid Salesforce API name`,
          };
        }
      }
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseSalesforceConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Salesforce configuration" };
    }

    try {
      const conn = await this.createConnection({
        credentials: params.credentials,
        loginUrl: parsed.loginUrl,
      });

      await conn.query(TEST_CONNECTION_SOQL);
      this.log.debug("Salesforce connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Salesforce connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseSalesforceConfig(params.config);
    if (!parsed) return null;

    try {
      const conn = await this.createConnection({
        credentials: params.credentials,
        loginUrl: parsed.loginUrl,
      });

      const advancedConfig = parseAdvancedObjectConfig(
        parsed.advancedObjectConfigJson,
      );
      const objectSpecs = buildObjectSyncSpecs({
        config: parsed,
        advancedConfig,
      });

      let total = 0;
      for (const spec of objectSpecs) {
        await this.rateLimit();
        try {
          const countResult = (await conn.query(
            `SELECT COUNT() FROM ${spec.objectName}`,
          )) as { totalSize: number };
          total += countResult.totalSize;
        } catch {
          // If COUNT fails for one object (e.g. permissions), skip it
          this.log.debug(
            { objectName: spec.objectName },
            "Salesforce: COUNT query failed, skipping estimate for this object",
          );
        }
      }

      return total > 0 ? total : null;
    } catch {
      return null;
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseSalesforceConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Salesforce configuration");
    }

    const checkpoint: SalesforceCheckpoint = {
      type: "salesforce",
      ...(params.checkpoint as SalesforceCheckpoint | null),
    };

    const conn = await this.createConnection({
      credentials: params.credentials,
      loginUrl: parsed.loginUrl,
    });

    const advancedConfig = parseAdvancedObjectConfig(
      parsed.advancedObjectConfigJson,
    );
    const objectSpecs = buildObjectSyncSpecs({
      config: parsed,
      advancedConfig,
    });
    const progress = createSyncProgress(checkpoint);

    this.log.debug(
      {
        objectCount: objectSpecs.length,
        objects: objectSpecs.map((s) => s.objectName),
        instanceUrl: conn.instanceUrl,
      },
      "Starting Salesforce sync",
    );

    for (const objectSpec of objectSpecs) {
      // Per-object error resilience: if one object fails entirely (e.g.
      // insufficient permissions), log the error and continue to the next
      // object rather than aborting the entire sync run. This matches the
      // resilience pattern used by GDrive (safeItemFetch) and the QA matrix
      // requirement "partial object query failures do not abort the sync."
      yield* this.syncObject({
        conn,
        objectSpec,
        checkpoint,
        progress,
        batchSize: DEFAULT_BATCH_SIZE,
        objectSpecs,
      });
    }
  }

  // ===== Permission sync =====

  /**
   * Container model: `sobject:<ObjectName>` per synced object. The object's
   * org-wide default (OWD) sharing model — read via the Metadata API, no
   * extra credential tier — decides the shape:
   *  - Public Read/ReadWrite ⇒ the container is isPublic (every internal
   *    user) and every document assigns to it. Cheapest possible pass.
   *  - Private ⇒ per-record nested containers `sobject:<Obj>/record:<id>`
   *    whose audience is the owner plus the object's share table
   *    (`<Obj>Share`, RowCause filtered — Owner excluded, guest causes
   *    excluded), chunked by ParentId. Group grantees become group tokens
   *    (byte-matching syncGroups' Group.Id); user grantees become emails.
   *  - ControlledByParent (Contact) ⇒ the record inherits its parent
   *    Account's resolved audience (owner + AccountShare), materialized as
   *    its own nested container — cross-container assignment would break
   *    the cursor-grouping contract.
   * A metadata read failure treats the object as Private (the safe
   * direction). UserRecordAccess was rejected for this design: it prices at
   * O(users × records / 200) per pass and ignores restriction rules anyway.
   * Known under-grant gaps (documented, never over-grant): restriction
   * rules, territory hierarchies, and high-volume portal shares.
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseSalesforceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Salesforce configuration for permission sync");
    }
    const conn = await this.createConnection({
      credentials: params.credentials,
      loginUrl: config.loginUrl,
    });
    this.initPermissionPass(conn);
    this.mappedEmailResolver = params.resolveMappedEmail ?? null;

    const specs = buildObjectSyncSpecs({
      config,
      advancedConfig: parseAdvancedObjectConfig(
        config.advancedObjectConfigJson,
      ),
    });
    const containerKeys = specs
      .map((spec) => `sobject:${spec.objectName}`)
      .sort();
    const scope = params.scope ? new Set(params.scope.containerKeys) : null;

    for (const key of containerKeys) {
      if (scope && !scope.has(key)) continue;
      // Resume: containers strictly before the cursor are done; the cursor
      // container is re-processed (idempotent — same audiences).
      if (params.cursor && key < params.cursor) continue;
      yield* this.syncObjectSnapshot(conn, key, params);
    }

    this.reportDroppedPrincipals();
  }

  /**
   * Salesforce groups → member emails. Group ids are the 15-char Group.Id,
   * byte-matching the UserOrGroupId on share rows. Public groups nest, and
   * Salesforce maintains expanded membership rows for role-hierarchy groups
   * (Role / RoleAndSubordinates*), so expansion is a recursive walk over one
   * GroupMember snapshot. The Organization group ("all internal users") has
   * no membership rows — it expands to every active user. Inactive users
   * never resolve (a deactivated account holds no access upstream either).
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseSalesforceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Salesforce configuration for group sync");
    }
    const conn = await this.createConnection({
      credentials: params.credentials,
      loginUrl: config.loginUrl,
    });
    this.initPermissionPass(conn);

    const groups = await this.queryAll<{
      Id: string;
      Name?: string;
      Type?: string;
    }>(conn, "SELECT Id, Name, Type FROM Group");
    const memberRows = await this.queryAll<{
      GroupId: string;
      UserOrGroupId: string;
    }>(conn, "SELECT GroupId, UserOrGroupId FROM GroupMember");
    const membersByGroup = new Map<string, Set<string>>();
    for (const row of memberRows) {
      let set = membersByGroup.get(row.GroupId);
      if (!set) {
        set = new Set();
        membersByGroup.set(row.GroupId, set);
      }
      set.add(row.UserOrGroupId);
    }

    for (const group of groups.sort((a, b) => (a.Id < b.Id ? -1 : 1))) {
      let members: GroupMemberYield[];
      try {
        const userIds = new Set<string>();
        this.collectGroupUserIds(group.Id, membersByGroup, userIds, new Set());
        if (group.Type === "Organization") {
          // "All internal users" has no GroupMember rows — every active user.
          for (const user of await this.queryAll<{
            Id: string;
            IsActive?: boolean;
          }>(conn, "SELECT Id, IsActive FROM User")) {
            if (user.IsActive !== false) userIds.add(user.Id);
          }
        }
        members = await this.toMemberYields([...userIds]);
      } catch (error) {
        // Per-group failure isolation: one unreadable group fail-closes its
        // own grants only, never the whole enumeration.
        this.log.warn(
          { groupId: group.Id, error: extractErrorMessage(error) },
          "Could not resolve Salesforce group members; the group's grants stay fail-closed",
        );
        members = [];
      }
      yield { groupId: group.Id, members, cursor: group.Id };
    }

    yield* this.syncDirectGrantRoster(conn, config);
  }

  /**
   * Direct (non-group) grant-holders — record owners and per-user share
   * grantees of the synced objects — roster under the synthetic
   * `direct-grants` group, so an account whose email is hidden or matches no
   * Archestra user is VISIBLE in the Users tab and override-assignable
   * (access itself flows through inline `user_email:` tokens, resolved with
   * the override fallback at audience time, not through this group's token).
   * One distinct-value SOQL per surface, bounded by distinct grant-holders;
   * a failed surface skips its contribution (partial roster over none).
   */
  private async *syncDirectGrantRoster(
    conn: Connection,
    config: SalesforceConfig,
  ): AsyncGenerator<GroupMembershipYield> {
    const directIds = new Set<string>();
    const specs = buildObjectSyncSpecs({
      config,
      advancedConfig: parseAdvancedObjectConfig(
        config.advancedObjectConfigJson,
      ),
    });
    for (const spec of specs) {
      try {
        await this.rateLimit();
        for (const row of await this.queryAll<{ OwnerId?: string }>(
          conn,
          `SELECT OwnerId FROM ${spec.objectName} GROUP BY OwnerId`,
        )) {
          if (row.OwnerId?.startsWith("005")) directIds.add(row.OwnerId);
        }
      } catch (error) {
        this.log.debug(
          { objectName: spec.objectName, error: extractErrorMessage(error) },
          "Could not enumerate record owners for the direct-grants roster",
        );
      }
      const shareObject = shareObjectName(spec.objectName);
      if (!shareObject) continue;
      try {
        await this.rateLimit();
        for (const row of await this.queryAll<{
          UserOrGroupId?: string;
          RowCause?: string;
        }>(
          conn,
          `SELECT UserOrGroupId, RowCause FROM ${shareObject} GROUP BY UserOrGroupId, RowCause`,
        )) {
          if (!row.UserOrGroupId?.startsWith("005")) continue;
          if (row.RowCause && EXCLUDED_SHARE_ROW_CAUSES.has(row.RowCause)) {
            continue;
          }
          if (row.RowCause?.startsWith("Guest")) continue;
          directIds.add(row.UserOrGroupId);
        }
      } catch (error) {
        this.log.debug(
          { objectName: spec.objectName, error: extractErrorMessage(error) },
          "Could not enumerate share grantees for the direct-grants roster",
        );
      }
    }
    if (directIds.size > 0) {
      yield {
        groupId: DIRECT_GRANTS_GROUP_ID,
        members: await this.toMemberYields([...directIds].sort()),
      };
    }
  }

  /**
   * Delta-pass probe: per object, three cheap drift checks since the stored
   * cursor — record edits (ownership changes bump LastModifiedDate), share
   * rows created/modified, and share rows DELETED via getDeleted (a missed
   * revocation must never wait for the daily full reconcile). Contact
   * inherits Account's dirty flag (its audiences are derived from accounts).
   * An object whose share table does not support getDeleted is always dirty
   * — deletions there are invisible, so the safe fallback is re-enumeration.
   */
  async probePermissionChanges(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    state: PermissionSyncState | null;
  }): Promise<PermissionProbeResult> {
    const config = parseSalesforceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Salesforce configuration for permission probe");
    }
    const conn = await this.createConnection({
      credentials: params.credentials,
      loginUrl: config.loginUrl,
    });

    const specs = buildObjectSyncSpecs({
      config,
      advancedConfig: parseAdvancedObjectConfig(
        config.advancedObjectConfigJson,
      ),
    });
    const now = new Date().toISOString();
    const nextState: PermissionSyncState = { soqlCursor: now };
    const cursor =
      typeof params.state?.soqlCursor === "string"
        ? params.state.soqlCursor
        : null;
    if (!cursor) {
      // First probe: no cursor yet — the full pass establishes it.
      return { dirtyContainerKeys: [], fullRequired: true, nextState };
    }
    const since = toSalesforceDateLiteral(isoCursorWithSkewBuffer(cursor));
    const probeStart = new Date(isoCursorWithSkewBuffer(cursor));
    const probeEnd = new Date(now);

    const dirty = new Set<string>();
    for (const spec of specs) {
      const objectName = spec.objectName;
      let isDirty = false;
      try {
        await this.rateLimit();
        const records = (await conn.query(
          `SELECT Id FROM ${objectName} WHERE LastModifiedDate >= ${since} LIMIT 1`,
        )) as { records: unknown[] };
        isDirty = records.records.length > 0;
      } catch (error) {
        this.log.debug(
          { objectName, error: extractErrorMessage(error) },
          "Record drift probe failed for object",
        );
      }

      const shareObject = shareObjectName(objectName);
      if (!isDirty && shareObject) {
        try {
          await this.rateLimit();
          const shares = (await conn.query(
            `SELECT Id FROM ${shareObject} WHERE LastModifiedDate >= ${since} LIMIT 1`,
          )) as { records: unknown[] };
          isDirty = shares.records.length > 0;
        } catch {
          // No share table (public OWD, ControlledByParent): no share drift
          // possible — record drift above is the only signal.
        }
      }
      if (!isDirty && shareObject) {
        try {
          await this.rateLimit();
          const deleted = await conn.deleted(shareObject, probeStart, probeEnd);
          isDirty = (deleted.deletedRecords ?? []).length > 0;
        } catch {
          // getDeleted unsupported here ⇒ share deletions are invisible to
          // the probe — always re-enumerate this object (safe direction).
          isDirty = true;
        }
      }
      if (isDirty) dirty.add(`sobject:${objectName}`);
    }
    // Contact audiences derive from their parent Account: Account sharing
    // drift must re-resolve Contacts too.
    if (
      dirty.has("sobject:Account") &&
      specs.some((s) => s.objectName === "Contact")
    ) {
      dirty.add("sobject:Contact");
    }

    return {
      dirtyContainerKeys: [...dirty].sort(),
      fullRequired: false,
      nextState,
    };
  }

  /**
   * Audience verification, run on every delta pass: re-resolve top-level
   * object containers (the OWD check) AND nested record containers (owner +
   * shares) without enumerating the corpus. Chunked SOQL, no document
   * enumeration.
   */
  async *refreshContainerAudiences(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    containerKeys: string[];
    resolveMappedEmail?: ResolveMappedEmail;
  }): AsyncGenerator<{
    containerKey: string;
    permissions: DocumentPermissions;
    audienceResolutionFailed?: boolean;
  }> {
    const config = parseSalesforceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Salesforce configuration for audience refresh");
    }
    const conn = await this.createConnection({
      credentials: params.credentials,
      loginUrl: config.loginUrl,
    });
    this.initPermissionPass(conn);
    this.mappedEmailResolver = params.resolveMappedEmail ?? null;

    const recordKeysByObject = new Map<string, string[]>();
    for (const containerKey of params.containerKeys) {
      const top = containerKey.match(/^sobject:([^/]+)$/);
      if (top) {
        const objectName = top[1];
        const sharing = await this.resolveSharingModel(conn, objectName);
        yield {
          containerKey,
          permissions:
            sharing === "Read" || sharing === "ReadWrite"
              ? { isPublic: true }
              : { isPublic: false, users: [], groups: [] },
          audienceResolutionFailed: sharing === null,
        };
        continue;
      }
      const nested = containerKey.match(/^sobject:([^/]+)\/record:([^/]+)$/);
      if (nested) {
        const list = recordKeysByObject.get(nested[1]) ?? [];
        list.push(nested[2]);
        recordKeysByObject.set(nested[1], list);
      }
      // Unknown shapes: skipped, left for the periodic full reconcile.
    }

    for (const [objectName, recordIds] of recordKeysByObject) {
      const audiences = await this.resolveRecordAudiences(
        conn,
        objectName,
        recordIds,
      );
      for (const recordId of recordIds) {
        const audience = audiences.get(recordId);
        yield {
          containerKey: `sobject:${objectName}/record:${recordId}`,
          permissions: audience?.permissions ?? {
            isPublic: false,
            users: [],
            groups: [],
          },
          audienceResolutionFailed: audience?.resolutionFailed ?? true,
        };
      }
    }

    this.reportDroppedPrincipals();
  }

  /**
   * Local-adoption scoping for delta passes: content-sync stamps
   * `metadata.objectName`. Scoping only — the object enumeration resolves
   * the authoritative assignment, so this can never over-grant.
   */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const objectName = metadata.objectName;
    return typeof objectName === "string" && objectName.length > 0
      ? `sobject:${objectName}`
      : null;
  }

  /**
   * Sync a single Salesforce object, yielding paginated batches.
   *
   * If the initial query for this object fails entirely (e.g. object does
   * not exist, insufficient permissions), we yield a single batch with the
   * failure recorded and move on to the next object — matching the resilience
   * pattern from the QA matrix.
   */
  private async *syncObject(params: {
    conn: Connection;
    objectSpec: ObjectSyncSpec;
    checkpoint: SalesforceCheckpoint;
    progress: SyncProgress;
    batchSize: number;
    objectSpecs: ObjectSyncSpec[];
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { conn, objectSpec, checkpoint, progress, batchSize, objectSpecs } =
      params;

    const bufferedSyncFrom = resolveObjectSyncLowerBound({
      checkpoint,
      objectName: objectSpec.objectName,
    });
    const soql = buildSoqlQuery({
      objectSpec,
      syncFrom: bufferedSyncFrom,
      batchSize,
    });

    this.log.debug(
      { objectName: objectSpec.objectName, soql },
      "Querying Salesforce object",
    );

    await this.rateLimit();
    let queryResult: SfQueryResult;
    try {
      queryResult = (await conn.query(soql)) as SfQueryResult;
    } catch (error) {
      // Per-object resilience: record the failure and continue
      const message = extractErrorMessage(error);
      this.log.warn(
        { objectName: objectSpec.objectName, error: message },
        "Salesforce object query failed, skipping object",
      );

      const hasRemainingObjects =
        objectSpecs[objectSpecs.length - 1]?.objectName !==
        objectSpec.objectName;
      yield {
        documents: [],
        failures: [
          {
            itemId: objectSpec.objectName,
            resource: `salesforce.${objectSpec.objectName}`,
            error: `Query failed: ${message}`,
          },
        ],
        checkpoint: buildSalesforceCheckpoint({
          previous: checkpoint,
          progress,
        }),
        hasMore: hasRemainingObjects,
      };
      return;
    }

    const failures: ConnectorItemFailure[] = [];
    let batchIndex = 0;

    while (true) {
      const documents: ConnectorDocument[] = [];
      for (const record of queryResult.records) {
        try {
          const doc = salesforceRecordToDocument({
            objectName: objectSpec.objectName,
            record,
            instanceUrl: conn.instanceUrl,
          });
          documents.push(doc);
          advanceProgress({
            progress,
            objectName: objectSpec.objectName,
            record,
          });
        } catch (error) {
          failures.push({
            itemId: String(record.Id ?? "unknown"),
            resource: `salesforce.${objectSpec.objectName}`,
            error: extractErrorMessage(error),
          });
        }
      }

      // Warn about CaseComment truncation (like Linear warns about >50 comments)
      if (objectSpec.includeCaseComments) {
        for (const record of queryResult.records) {
          const comments = record.CaseComments;
          if (comments && !comments.done) {
            this.log.warn(
              {
                caseId: record.Id,
                totalComments: comments.totalSize,
                fetchedComments: comments.records.length,
              },
              "Case has more comments than the subquery limit; truncating",
            );
          }
        }
      }

      const hasMoreWithinObject =
        !queryResult.done && !!queryResult.nextRecordsUrl;
      const hasRemainingObjects =
        objectSpecs[objectSpecs.length - 1]?.objectName !==
        objectSpec.objectName;
      const nextCheckpoint = buildSalesforceCheckpoint({
        previous: checkpoint,
        progress,
      });
      const batchFailures = [...failures, ...this.flushFailures()];
      failures.length = 0;

      batchIndex++;
      this.log.debug(
        {
          objectName: objectSpec.objectName,
          batchIndex,
          documentCount: documents.length,
          failureCount: batchFailures.length,
          totalSize: queryResult.totalSize,
          hasMoreWithinObject,
          hasRemainingObjects,
        },
        "Salesforce batch complete",
      );

      yield {
        documents,
        failures: batchFailures,
        checkpoint: nextCheckpoint,
        hasMore: hasMoreWithinObject || hasRemainingObjects,
      };

      if (!hasMoreWithinObject) {
        break;
      }

      // Guard: nextRecordsUrl is guaranteed non-null when hasMoreWithinObject
      // is true, but we check explicitly to avoid the non-null assertion lint.
      const nextUrl = queryResult.nextRecordsUrl;
      if (!nextUrl) break;

      await this.rateLimit();
      try {
        queryResult = (await conn.queryMore(nextUrl)) as SfQueryResult;
      } catch (error) {
        throw new Error(
          `Salesforce pagination failed for ${objectSpec.objectName}: ${extractErrorMessage(error)}`,
        );
      }
    }
  }

  // ===== Permission-sync internals =====

  /** Arm (or re-arm) the per-pass state every permission hook shares. */
  private initPermissionPass(conn: Connection): void {
    this.permConnection = conn;
    this.sharingModelCache = new Map();
    this.userEmailCache = new Map();
    this.recordAudienceCache = new Map();
    this.shareTableBroken = new Set();
    this.droppedPrincipals = 0;
    this.mappedEmailResolver = null;
  }

  private async *syncObjectSnapshot(
    conn: Connection,
    containerKey: string,
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const objectName = containerKey.slice("sobject:".length);
    const recordIds = await this.collectIngestedRecordIds(params, objectName);

    if (recordIds.length === 0) {
      // Empty corpus: emit the fail-closed boundary container WITHOUT
      // resolving anything (Jira precedent — not a resolution failure).
      yield {
        kind: "container",
        containerKey,
        permissions: { isPublic: false, users: [], groups: [] },
        audienceResolutionFailed: false,
        cursor: containerKey,
      };
      return;
    }

    const sharing = await this.resolveSharingModel(conn, objectName);

    if (sharing === "Read" || sharing === "ReadWrite") {
      // Public OWD: every internal user reads every record of this object.
      yield {
        kind: "container",
        containerKey,
        permissions: { isPublic: true },
        audienceResolutionFailed: false,
        cursor: containerKey,
      };
      for (const recordId of recordIds) {
        yield {
          kind: "document",
          sourceId: `salesforce:${objectName}:${recordId}`,
          containerKey,
          cursor: containerKey,
        };
      }
      return;
    }

    // Private / ControlledByParent / unknown (failed metadata read): the
    // top-level container is a pure boundary — audiences live on the nested
    // record containers.
    yield {
      kind: "container",
      containerKey,
      permissions: { isPublic: false, users: [], groups: [] },
      audienceResolutionFailed: false,
      cursor: containerKey,
    };

    if (objectName === "Contact" || sharing === "ControlledByParent") {
      // Contact inherits its parent Account's audience; a contact without
      // an account is private to its owner.
      const parents = await this.fetchRecordFields(conn, "Contact", recordIds, [
        "AccountId",
      ]);
      for (const recordId of recordIds) {
        const accountId = parents.get(recordId)?.AccountId;
        const audience =
          typeof accountId === "string" && accountId
            ? await this.resolveAccountAudienceCached(conn, accountId)
            : ((
                await this.resolveRecordAudiences(conn, "Contact", [recordId])
              ).get(recordId) ?? failedAudience());
        yield {
          kind: "container",
          containerKey: `${containerKey}/record:${recordId}`,
          permissions: audience.permissions,
          audienceResolutionFailed: audience.resolutionFailed,
          cursor: containerKey,
        };
        yield {
          kind: "document",
          sourceId: `salesforce:Contact:${recordId}`,
          containerKey: `${containerKey}/record:${recordId}`,
          cursor: containerKey,
        };
      }
      return;
    }

    // Private OWD: per-record owner + share-table audiences.
    const audiences = await this.resolveRecordAudiences(
      conn,
      objectName,
      recordIds,
    );
    for (const recordId of recordIds) {
      const audience = audiences.get(recordId) ?? failedAudience();
      yield {
        kind: "container",
        containerKey: `${containerKey}/record:${recordId}`,
        permissions: audience.permissions,
        audienceResolutionFailed: audience.resolutionFailed,
        cursor: containerKey,
      };
      yield {
        kind: "document",
        sourceId: `salesforce:${objectName}:${recordId}`,
        containerKey: `${containerKey}/record:${recordId}`,
        cursor: containerKey,
      };
    }
  }

  /** Ingested record ids for one object (keyset-paged read-back). */
  private async collectIngestedRecordIds(
    params: PermissionSyncParams,
    objectName: string,
  ): Promise<string[]> {
    const prefix = `salesforce:${objectName}:`;
    const ids: string[] = [];
    let afterId: string | null = null;
    for (;;) {
      const { documents, nextAfterId } = await params.readIngestedDocuments({
        metadataFilter: { objectName },
        afterId,
        limit: PERMISSION_READBACK_PAGE_SIZE,
      });
      for (const doc of documents) {
        if (doc.sourceId.startsWith(prefix)) {
          ids.push(doc.sourceId.slice(prefix.length));
        }
      }
      if (documents.length < PERMISSION_READBACK_PAGE_SIZE) break;
      afterId = nextAfterId;
    }
    return ids.sort();
  }

  /**
   * The object's OWD sharing model via the Metadata API (same session — no
   * extra credential tier). Cached per pass; a read failure caches null,
   * which callers treat as Private (the safe direction).
   */
  private async resolveSharingModel(
    conn: Connection,
    objectName: string,
  ): Promise<string | null> {
    const cached = this.sharingModelCache.get(objectName);
    if (cached !== undefined) return cached;
    let sharingModel: string | null = null;
    try {
      await this.rateLimit();
      const meta = (await conn.metadata.read("CustomObject", objectName)) as
        | { sharingModel?: string }
        | Array<{ sharingModel?: string }>;
      const entry = Array.isArray(meta) ? meta[0] : meta;
      sharingModel = entry?.sharingModel ?? null;
      if (!sharingModel) {
        this.log.warn(
          { objectName },
          "Salesforce metadata read returned no sharingModel; treating the object as Private",
        );
      }
    } catch (error) {
      this.log.warn(
        { objectName, error: extractErrorMessage(error) },
        "Could not read the object's sharing model; treating it as Private (fail-closed)",
      );
    }
    this.sharingModelCache.set(objectName, sharingModel);
    return sharingModel;
  }

  /**
   * Per-record audiences for a private-OWD object: owner + share rows,
   * chunked (SOQL IN-clause sized). User grantees resolve to emails; group
   * grantees (00G…) become group tokens byte-matching syncGroups. A missing
   * or unqueryable share table degrades the object to owner-only for this
   * pass (fail-closed, logged once per object) — never an over-grant, never
   * an abort.
   */
  private async resolveRecordAudiences(
    conn: Connection,
    objectName: string,
    recordIds: string[],
  ): Promise<
    Map<string, { permissions: DocumentPermissions; resolutionFailed: boolean }>
  > {
    const out = new Map<
      string,
      { permissions: DocumentPermissions; resolutionFailed: boolean }
    >();
    const shareObject = shareObjectName(objectName);
    for (const chunk of chunkArray(recordIds, SOQL_IN_CHUNK_SIZE)) {
      const owners = await this.fetchRecordFields(conn, objectName, chunk, [
        "OwnerId",
      ]);
      const sharesByParent = new Map<
        string,
        Array<{ UserOrGroupId: string }>
      >();
      if (shareObject && !this.shareTableBroken.has(objectName)) {
        try {
          await this.rateLimit();
          const shareRows = await this.queryAll<{
            ParentId: string;
            UserOrGroupId: string;
            RowCause?: string;
          }>(
            conn,
            `SELECT ParentId, UserOrGroupId, RowCause FROM ${shareObject} WHERE ParentId IN (${soqlIn(
              chunk,
            )})`,
          );
          for (const row of shareRows) {
            if (row.RowCause && EXCLUDED_SHARE_ROW_CAUSES.has(row.RowCause)) {
              continue;
            }
            if (row.RowCause?.startsWith("Guest")) continue;
            const list = sharesByParent.get(row.ParentId) ?? [];
            list.push(row);
            sharesByParent.set(row.ParentId, list);
          }
        } catch (error) {
          this.shareTableBroken.add(objectName);
          this.log.warn(
            { objectName, shareObject, error: extractErrorMessage(error) },
            "Share table unavailable; the object's records resolve owner-only for this pass (fail-closed)",
          );
        }
      }

      const userIds = new Set<string>();
      for (const recordId of chunk) {
        const ownerId = owners.get(recordId)?.OwnerId;
        if (typeof ownerId === "string" && ownerId.startsWith("005")) {
          userIds.add(ownerId);
        }
        for (const row of sharesByParent.get(recordId) ?? []) {
          if (row.UserOrGroupId.startsWith("005")) {
            userIds.add(row.UserOrGroupId);
          }
        }
      }
      const emails = await this.resolveUserEmails(conn, [...userIds]);

      for (const recordId of chunk) {
        const users = new Set<string>();
        const groups = new Set<string>();
        // Direct grants: upstream email, else the admin member-override
        // mapping (a user id whose email Salesforce hides or that matches no
        // Archestra account can be assigned from the Users tab).
        const grantEmail = (userId: string): string | null =>
          emails.get(userId) ?? this.mappedEmailResolver?.(userId) ?? null;
        const ownerId = owners.get(recordId)?.OwnerId;
        if (typeof ownerId === "string") {
          if (ownerId.startsWith("005")) {
            const email = grantEmail(ownerId);
            if (email) users.add(email.toLowerCase());
          } else if (ownerId.startsWith("00G")) {
            // Queue/group-owned record: the owning group's members get access.
            groups.add(ownerId);
          }
        }
        for (const row of sharesByParent.get(recordId) ?? []) {
          if (row.UserOrGroupId.startsWith("005")) {
            const email = grantEmail(row.UserOrGroupId);
            if (email) users.add(email.toLowerCase());
          } else if (row.UserOrGroupId.startsWith("00G")) {
            groups.add(row.UserOrGroupId);
          }
        }
        out.set(recordId, {
          permissions: {
            isPublic: false,
            users: [...users],
            groups: [...groups],
          },
          resolutionFailed: false,
        });
      }
    }
    return out;
  }

  /** A parent Account's audience, memoized for Contact inheritance. */
  private async resolveAccountAudienceCached(
    conn: Connection,
    accountId: string,
  ): Promise<{ permissions: DocumentPermissions; resolutionFailed: boolean }> {
    const cached = this.recordAudienceCache.get(accountId);
    if (cached) return cached;
    const audience =
      (await this.resolveRecordAudiences(conn, "Account", [accountId])).get(
        accountId,
      ) ?? failedAudience();
    this.recordAudienceCache.set(accountId, audience);
    return audience;
  }

  /** Chunked field fetch: SELECT Id, <fields> FROM <obj> WHERE Id IN (...). */
  private async fetchRecordFields(
    conn: Connection,
    objectName: string,
    recordIds: string[],
    fields: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    for (const chunk of chunkArray(recordIds, SOQL_IN_CHUNK_SIZE)) {
      await this.rateLimit();
      const rows = await this.queryAll<Record<string, unknown>>(
        conn,
        `SELECT Id, ${fields.join(", ")} FROM ${objectName} WHERE Id IN (${soqlIn(chunk)})`,
      );
      for (const row of rows) {
        if (typeof row.Id === "string") out.set(row.Id, row);
      }
    }
    return out;
  }

  /** Salesforce user ids → emails (inactive users resolve null). Cached. */
  private async resolveUserEmails(
    conn: Connection,
    userIds: string[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const missing: string[] = [];
    for (const id of userIds) {
      const cached = this.userEmailCache.get(id);
      if (cached !== undefined) out.set(id, cached);
      else missing.push(id);
    }
    for (const chunk of chunkArray(missing, SOQL_IN_CHUNK_SIZE)) {
      let rows: Array<{ Id: string; Email?: string; IsActive?: boolean }>;
      try {
        rows = await this.queryAll(
          conn,
          `SELECT Id, Email, IsActive FROM User WHERE Id IN (${soqlIn(chunk)})`,
        );
      } catch (error) {
        this.log.warn(
          { error: extractErrorMessage(error) },
          "Could not resolve Salesforce user emails; those principals drop fail-closed",
        );
        rows = [];
      }
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.Id);
        const email =
          row.IsActive === false ? null : (row.Email?.toLowerCase() ?? null);
        this.userEmailCache.set(row.Id, email);
        out.set(row.Id, email);
        if (!email) this.droppedPrincipals += 1;
      }
      for (const id of chunk) {
        if (!seen.has(id)) {
          this.userEmailCache.set(id, null);
          out.set(id, null);
          this.droppedPrincipals += 1;
        }
      }
    }
    return out;
  }

  /** Expand a group to its user ids, recursing into nested groups. */
  private collectGroupUserIds(
    groupId: string,
    membersByGroup: Map<string, Set<string>>,
    out: Set<string>,
    visited: Set<string>,
  ): void {
    if (visited.has(groupId)) return;
    visited.add(groupId);
    for (const memberId of membersByGroup.get(groupId) ?? []) {
      if (memberId.startsWith("005")) out.add(memberId);
      else if (memberId.startsWith("00G")) {
        this.collectGroupUserIds(memberId, membersByGroup, out, visited);
      }
    }
  }

  private async toMemberYields(userIds: string[]): Promise<GroupMemberYield[]> {
    const conn = this.permConnection;
    if (!conn) throw new Error("permission pass not armed");
    const emails = await this.resolveUserEmails(conn, userIds);
    return userIds.map((id) => ({
      accountId: id,
      displayName: null,
      email: emails.get(id) ?? null,
    }));
  }

  /** query + queryMore loop (jsforce pages large result sets). */
  private async queryAll<T>(conn: Connection, soql: string): Promise<T[]> {
    await this.rateLimit();
    let result = (await conn.query(soql)) as unknown as {
      done: boolean;
      records: T[];
      nextRecordsUrl?: string;
    };
    const records = [...result.records];
    while (!result.done && result.nextRecordsUrl) {
      await this.rateLimit();
      result = (await conn.queryMore(result.nextRecordsUrl)) as unknown as {
        done: boolean;
        records: T[];
        nextRecordsUrl?: string;
      };
      records.push(...result.records);
    }
    return records;
  }

  /** Surface principals dropped this pass (fail-closed under-grant). */
  private reportDroppedPrincipals(): void {
    if (this.droppedPrincipals <= 0) return;
    const count = this.droppedPrincipals;
    this.droppedPrincipals = 0;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped Salesforce principals that could not be resolved (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }

  /** Create an authenticated jsforce Connection. */
  private async createConnection(params: {
    credentials: ConnectorCredentials;
    loginUrl: string;
  }): Promise<Connection> {
    const username = params.credentials.email?.trim();
    const passwordAndToken = params.credentials.apiToken?.trim();
    if (!username || !passwordAndToken) {
      throw new Error("Missing Salesforce username or password+security token");
    }

    const conn = new Connection({ loginUrl: params.loginUrl });
    await conn.login(username, passwordAndToken);
    this.log.debug(
      { instanceUrl: conn.instanceUrl },
      "Salesforce login successful",
    );
    return conn;
  }
}

// ===== Internal helpers =====

function parseSalesforceConfig(
  config: Record<string, unknown>,
): SalesforceConfig | null {
  const result = SalesforceConfigSchema.safeParse({
    type: "salesforce",
    loginUrl: "https://login.salesforce.com",
    ...config,
  });

  if (!result.success) return null;

  // Normalize object names to avoid accidental invalid identifiers due to whitespace.
  const objects = result.data.objects
    ?.map((o) => o.trim())
    .filter((o) => o.length > 0);

  // Default to core CRM objects when none are specified.
  return {
    ...result.data,
    objects: objects && objects.length > 0 ? objects : DEFAULT_OBJECTS,
  };
}

function parseAdvancedObjectConfig(
  advancedObjectConfigJson?: string,
): AdvancedObjectConfig | null {
  if (!advancedObjectConfigJson) return null;
  try {
    const parsed = JSON.parse(advancedObjectConfigJson) as AdvancedObjectConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Validate that all object names and field names in an advanced config
 * are safe SOQL identifiers to prevent injection.
 */
function validateAdvancedConfigIdentifiers(
  config: Record<string, unknown>,
): string | null {
  for (const objectName of Object.keys(config)) {
    if (!SAFE_SOQL_IDENTIFIER.test(objectName)) {
      return `Invalid object name "${objectName}" in advanced config: must be a valid Salesforce API name`;
    }
    const spec = config[objectName] as {
      fields?: string[];
      associations?: Record<string, string[]>;
    };
    if (spec.fields) {
      for (const field of spec.fields) {
        if (!SAFE_SOQL_IDENTIFIER.test(field)) {
          return `Invalid field name "${field}" on ${objectName}: must be a valid Salesforce API name`;
        }
      }
    }
    if (spec.associations) {
      for (const [assocName, assocFields] of Object.entries(
        spec.associations,
      )) {
        if (!SAFE_SOQL_IDENTIFIER.test(assocName)) {
          return `Invalid association name "${assocName}" on ${objectName}: must be a valid Salesforce API name`;
        }
        for (const field of assocFields) {
          if (!SAFE_SOQL_IDENTIFIER.test(field)) {
            return `Invalid field "${field}" in association ${assocName}: must be a valid Salesforce API name`;
          }
        }
      }
    }
  }
  return null;
}

function buildObjectSyncSpecs(params: {
  config: SalesforceConfig;
  advancedConfig: AdvancedObjectConfig | null;
}): ObjectSyncSpec[] {
  if (params.advancedConfig) {
    const entries = Object.entries(params.advancedConfig);
    if (entries.length === 0) return [];
    return entries.map(([objectName, spec]) => {
      const fields = dedupeAndEnsureBaseFields(spec.fields ?? []);
      const associationFields = flattenAssociationFields(
        spec.associations ?? {},
      );
      return {
        objectName,
        fields,
        associationFields,
        includeCaseComments: objectName === "Case",
      };
    });
  }

  const objects =
    params.config.objects && params.config.objects.length > 0
      ? params.config.objects
      : DEFAULT_OBJECTS;

  return objects.map((objectName) => ({
    objectName,
    fields: DEFAULT_FIELDS_BY_OBJECT[objectName] ?? [...BASE_FIELDS],
    associationFields: [],
    includeCaseComments: objectName === "Case",
  }));
}

function buildSoqlQuery(params: {
  objectSpec: ObjectSyncSpec;
  syncFrom?: string;
  batchSize: number;
}): string {
  const fieldList = [...params.objectSpec.fields];

  // Add association/relationship fields (e.g. Account.Name)
  for (const assocField of params.objectSpec.associationFields) {
    if (!fieldList.includes(assocField)) {
      fieldList.push(assocField);
    }
  }

  // Append Case Comments relationship subquery for Case objects
  if (params.objectSpec.includeCaseComments) {
    fieldList.push(CASE_COMMENTS_SUBQUERY);
  }

  const selected = fieldList.join(", ");
  const whereClause = params.syncFrom
    ? ` WHERE LastModifiedDate >= ${toSalesforceDateLiteral(params.syncFrom)}`
    : "";
  return `SELECT ${selected} FROM ${params.objectSpec.objectName}${whereClause} ORDER BY LastModifiedDate ASC, Id ASC LIMIT ${params.batchSize}`;
}

function salesforceRecordToDocument(params: {
  objectName: string;
  record: SfRecord;
  instanceUrl: string;
}): ConnectorDocument {
  const recordId = String(params.record.Id ?? "");
  if (!recordId) {
    throw new Error("Salesforce record missing Id");
  }

  const title = buildRecordTitle(params.objectName, params.record, recordId);

  // Build field content, excluding internal/nested keys
  const excludeKeys = new Set(["attributes", "CaseComments"]);
  const flatFields = Object.entries(params.record)
    .filter(([key]) => !excludeKeys.has(key))
    .map(([key, value]) => `**${key}:** ${serializeValue(value)}`);

  const contentParts = [`# ${params.objectName}: ${title}`, "", ...flatFields];

  // Append Case Comments as a thread (like Linear appends issue comments)
  const caseComments = params.record.CaseComments;
  if (caseComments?.records && caseComments.records.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const comment of caseComments.records) {
      const date = comment.CreatedDate
        ? new Date(comment.CreatedDate).toISOString()
        : "unknown date";
      contentParts.push(
        "---",
        `**${date}**`,
        comment.CommentBody ?? "(empty comment)",
        "",
      );
    }
  }

  const limited = truncateConnectorContent({
    content: contentParts.join("\n"),
    maxLength: MAX_CONTENT_LENGTH,
  });
  const sourceUrl = params.instanceUrl
    ? `${params.instanceUrl}/${recordId}`
    : undefined;
  const lastModified = params.record.LastModifiedDate;

  return {
    id: `salesforce:${params.objectName}:${recordId}`,
    title,
    content: limited.content,
    contentTruncation: limited.truncation,
    sourceUrl,
    metadata: {
      objectName: params.objectName,
      recordId,
      lastModifiedDate: lastModified,
    },
    updatedAt: lastModified ? new Date(lastModified) : undefined,
  };
}

/** Build a human-readable title, preferring Name then CaseNumber+Subject. */
function buildRecordTitle(
  objectName: string,
  record: SfRecord,
  recordId: string,
): string {
  if (record.Name) return String(record.Name);
  if (record.CaseNumber) {
    const subject = record.Subject ? ` — ${String(record.Subject)}` : "";
    return `Case #${String(record.CaseNumber)}${subject}`;
  }
  return `${objectName} ${recordId.slice(0, 8)}`;
}

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function dedupeAndEnsureBaseFields(fields: string[]): string[] {
  const normalized = fields.filter((field) => field.trim().length > 0);
  const merged = [...normalized];
  for (const base of BASE_FIELDS) {
    if (!merged.includes(base)) {
      merged.push(base);
    }
  }
  return [...new Set(merged)];
}

function flattenAssociationFields(
  associations: Record<string, string[]>,
): string[] {
  const fields: string[] = [];
  for (const [associationName, associationFields] of Object.entries(
    associations,
  )) {
    for (const field of associationFields) {
      if (!field.trim()) continue;
      fields.push(`${associationName}.${field}`);
    }
  }
  return fields;
}

function createSyncProgress(checkpoint: SalesforceCheckpoint): SyncProgress {
  const objectCursorMap = { ...(checkpoint.objectCursorMap ?? {}) };
  const maxLastSyncedAt = checkpoint.lastSyncedAt;
  return { objectCursorMap, maxLastSyncedAt };
}

function advanceProgress(params: {
  progress: SyncProgress;
  objectName: string;
  record: SfRecord;
}): void {
  const candidate = params.record.LastModifiedDate;
  if (!candidate) return;

  const previousObjectCursor =
    params.progress.objectCursorMap[params.objectName];
  if (!previousObjectCursor || candidate > previousObjectCursor) {
    params.progress.objectCursorMap[params.objectName] = candidate;
  }
  if (
    !params.progress.maxLastSyncedAt ||
    candidate > params.progress.maxLastSyncedAt
  ) {
    params.progress.maxLastSyncedAt = candidate;
  }
}

function buildSalesforceCheckpoint(params: {
  previous: SalesforceCheckpoint;
  progress: SyncProgress;
}): SalesforceCheckpoint {
  return buildCheckpoint({
    type: "salesforce",
    itemUpdatedAt: params.progress.maxLastSyncedAt,
    previousLastSyncedAt: params.previous.lastSyncedAt,
    extra: {
      objectCursorMap: params.progress.objectCursorMap,
    },
  });
}

function resolveObjectSyncLowerBound(params: {
  checkpoint: SalesforceCheckpoint;
  objectName: string;
}): string | undefined {
  const objectCursor = params.checkpoint.objectCursorMap?.[params.objectName];
  if (objectCursor) {
    return subtractSafetyBuffer(objectCursor);
  }
  if (params.checkpoint.lastSyncedAt) {
    return subtractSafetyBuffer(params.checkpoint.lastSyncedAt);
  }
  return undefined;
}

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function toSalesforceDateLiteral(isoDate: string): string {
  return new Date(isoDate).toISOString();
}

// ===== Permission-sync helpers =====

const PERMISSION_READBACK_PAGE_SIZE = 1000;
/** Conservative IN-clause chunk (SOQL statement-length limits). */
const SOQL_IN_CHUNK_SIZE = 100;

/**
 * Share rows that never grant READ access beyond what ownership already
 * covers. Everything else (Manual, Rule, Team, Sales Team, Implicit*) is
 * kept — a generous union under-grants nothing; Guest* causes are dropped
 * (portal guests are never Archestra users).
 */
const EXCLUDED_SHARE_ROW_CAUSES = new Set(["Owner"]);

/** Synthetic roster group for direct (non-group) grant-holders. */
const DIRECT_GRANTS_GROUP_ID = "direct-grants";

/** The share object for an object, or null when none exists. */
function shareObjectName(objectName: string): string | null {
  // Contact sharing is ControlledByParent — there is no ContactShare.
  if (objectName === "Contact") return null;
  if (objectName.endsWith("__c")) {
    return `${objectName.slice(0, -"__c".length)}__Share`;
  }
  // Standard objects: AccountShare, CaseShare, OpportunityShare, …
  return `${objectName}Share`;
}

function failedAudience(): {
  permissions: DocumentPermissions;
  resolutionFailed: boolean;
} {
  return {
    permissions: { isPublic: false, users: [], groups: [] },
    resolutionFailed: true,
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Quote a SOQL IN clause's ids (ids are validated Salesforce identifiers). */
function soqlIn(ids: string[]): string {
  return ids.map((id) => `'${id}'`).join(", ");
}
