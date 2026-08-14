import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DocumentPermissions,
  GroupMembershipYield,
  GroupMemberYield,
  PermissionSnapshotYield,
  PermissionSyncParams,
  ResolveMappedEmail,
  ServiceNowCheckpoint,
  ServiceNowConfig,
} from "@/types";
import { ServiceNowConfigSchema } from "@/types";
import { stripHtmlTags } from "@/utils/strip-html";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INITIAL_SYNC_MONTHS = 6;

export class ServiceNowConnector extends BaseConnector {
  type = "servicenow" as const;
  supportsPermissionSync = true;

  // ----- Per-pass permission-sync state (armed by initPermissionPass) -----
  private permBaseUrl = "";
  private permHost = "";
  private permHeaders: HeadersInit = {};
  /** sys_user sys_id → {email, name} (email null = unresolvable this pass). */
  private userInfoCache = new Map<
    string,
    { email: string | null; name: string | null }
  >();
  /** user_criteria sys_id → matching user sys_ids (null = unevaluatable). */
  private criteriaUsersCache = new Map<string, Set<string> | null>();
  /**
   * sys_user sys_id → display name seen on a referencing record or membership
   * row. The fallback label for principals whose own `sys_user` row the
   * credential cannot read — without it they surface as a bare sys_id.
   */
  private principalNameHints = new Map<string, string>();
  private knowledgeProps: KnowledgeProps | null = null;
  /** Active sys_user sys_ids (null = enumeration failed). */
  private allActiveUsersCache: string[] | null | undefined;
  /** kb sys_id → ingested article sourceIds (built once per pass). */
  private kbArticlesCache: Map<string, string[]> | null = null;
  private droppedPrincipals = 0;
  private mappedEmailResolver: ResolveMappedEmail | null = null;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid ServiceNow configuration: instanceUrl (string) is required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.instanceUrl)) {
      return {
        valid: false,
        error: "instanceUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid ServiceNow configuration" };
    }

    this.log.debug({ instanceUrl: parsed.instanceUrl }, "Testing connection");

    try {
      const url = this.joinUrl(
        parsed.instanceUrl,
        "/api/now/table/incident?sysparm_limit=1&sysparm_fields=sys_id",
      );
      const response = await this.fetchWithRetry(url, {
        headers: buildHeaders(params.credentials),
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      }

      this.log.debug("Connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as ServiceNowCheckpoint | null) ?? {
        type: "servicenow" as const,
      };
      const headers = buildHeaders(params.credentials);
      const entities = getEnabledEntities(parsed);
      let total = 0;

      for (const entity of entities) {
        const query = buildQuery({
          config: parsed,
          checkpoint,
          useStatesAndGroups: entity.useStatesAndGroups,
          extraQuery: entity.extraQuery,
        });
        const url = this.joinUrl(
          parsed.instanceUrl,
          `/api/now/table/${entity.table}?sysparm_query=${encodeURIComponent(query)}&sysparm_limit=1&sysparm_fields=sys_id`,
        );

        const response = await this.fetchWithRetry(url, { headers });
        if (!response.ok) continue;

        const totalCount = response.headers.get("X-Total-Count");
        if (totalCount) {
          const count = Number.parseInt(totalCount, 10);
          if (!Number.isNaN(count)) total += count;
        }
      }

      return total > 0 ? total : null;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Failed to estimate total items",
      );
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
    const parsed = parseConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid ServiceNow configuration");
    }

    const checkpoint = (params.checkpoint as ServiceNowCheckpoint | null) ?? {
      type: "servicenow" as const,
    };
    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const headers = buildHeaders(params.credentials);
    const entities = getEnabledEntities(parsed);

    this.log.debug(
      {
        instanceUrl: parsed.instanceUrl,
        states: parsed.states,
        entities: entities.map((e) => e.table),
        checkpoint,
      },
      "Starting sync",
    );

    for (let entityIdx = 0; entityIdx < entities.length; entityIdx++) {
      const entity = entities[entityIdx];
      const isLastEntity = entityIdx === entities.length - 1;
      const query = buildQuery({
        config: parsed,
        checkpoint,
        startTime: params.startTime,
        useStatesAndGroups: entity.useStatesAndGroups,
        extraQuery: entity.extraQuery,
      });

      let offset = entityIdx === 0 ? (checkpoint.lastOffset ?? 0) : 0;
      let pageHasMore = true;
      let batchIndex = 0;

      while (pageHasMore) {
        await this.rateLimit();

        try {
          this.log.debug(
            { table: entity.table, batchIndex, offset },
            "Fetching batch",
          );

          const url = this.joinUrl(
            parsed.instanceUrl,
            `/api/now/table/${entity.table}?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=${entity.fields}&sysparm_limit=${batchSize}&sysparm_offset=${offset}&sysparm_display_value=all`,
          );

          const response = await this.fetchWithRetry(url, { headers });

          if (!response.ok) {
            const body = await response.text();
            throw new Error(
              `ServiceNow API error: HTTP ${response.status} - ${body.slice(0, 500)}`,
            );
          }

          const data = (await response.json()) as {
            result: ServiceNowRecord[];
          };
          const records = data.result ?? [];
          const documents: ConnectorDocument[] = [];

          for (const record of records) {
            documents.push(
              recordToDocument(record, parsed.instanceUrl, entity.table),
            );
          }

          offset += records.length;
          pageHasMore = records.length >= batchSize;

          const lastRecord = records[records.length - 1];
          const lastUpdatedAt = lastRecord?.sys_updated_on?.value;
          const hasMore = pageHasMore || !isLastEntity;

          this.log.debug(
            {
              table: entity.table,
              batchIndex,
              recordCount: records.length,
              documentCount: documents.length,
              hasMore,
            },
            "Batch fetched",
          );

          batchIndex++;
          yield {
            documents,
            failures: this.flushFailures(),
            checkpoint: buildCheckpoint({
              type: "servicenow",
              itemUpdatedAt: lastUpdatedAt,
              previousLastSyncedAt: checkpoint.lastSyncedAt,
              extra: {
                lastOffset: hasMore ? offset : undefined,
              },
            }),
            hasMore,
          };
        } catch (error) {
          this.log.error(
            {
              table: entity.table,
              batchIndex,
              error: extractErrorMessage(error),
            },
            "Batch fetch failed",
          );
          throw error;
        }
      }
    }
  }

  // ===== Permission sync =====

  /**
   * ServiceNow permission snapshot. Two top-level container families, both
   * corpus-bound, keyed so `kb:` sorts before `table:` (monotonic cursor):
   *
   * - `table:<name>` for the ITSM/CMDB tables. ServiceNow gates record reads
   *   with ACL rules (roles + conditions + server-side scripts) that no REST
   *   surface can evaluate, so the audience is the fail-closed participant
   *   approximation: a record is visible to the members of its referenced
   *   groups (assignment/support group) and to its referenced users (caller,
   *   opener, assignee, …), plus — only when the admin declares it via
   *   `roleAudiences` — the holders of the named ServiceNow roles. Records
   *   sharing a group set share a nested `table:<t>/groups:<ids>` container;
   *   per-record users ride as exceptionUsers. This never over-grants
   *   relative to a stock instance; role-wide read access is opt-in.
   *
   * - `kb:<sys_id>` for knowledge bases (the kb_knowledge corpus), audienced
   *   from ServiceNow's own permission model: `user_criteria` rows linked
   *   through kb_uc_can_read_mtom / kb_uc_cannot_read_mtom at both KB and
   *   article level (both levels store their links in those two m2m tables).
   *   Evaluatable criteria become criteria-groups; deny criteria and
   *   article-level overrides — inexpressible through group union — are
   *   materialized as concrete user sets. Script-based ("advanced") criteria
   *   cannot be evaluated over the Table API: on an allow path they grant
   *   nobody, on a deny path the container fails closed. The glide.knowman.*
   *   properties govern criteria-less KBs; unreadable properties take the
   *   restrictive reading, with audienceResolutionFailed marking the
   *   containers whose emptiness comes from that failure.
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseConfig(params.config);
    if (!config) {
      throw new Error("Invalid ServiceNow configuration for permission sync");
    }
    this.initPermissionPass(config, params);

    const tableKeys = getEnabledEntities(config)
      .filter((entity) => entity.table !== "kb_knowledge")
      .map((entity) => `table:${entity.table}`)
      .sort();
    const kbKeys =
      config.includeKnowledgeArticles === true
        ? [...(await this.readKnowledgeCorpus(params)).keys()]
            .sort()
            .map((id) => `kb:${id}`)
        : [];
    const topKeys = [...kbKeys, ...tableKeys];
    const scope = params.scope ? new Set(params.scope.containerKeys) : null;

    for (const key of topKeys) {
      if (scope && !scope.has(key)) continue;
      // Resume: containers strictly before the cursor are done; the cursor
      // container is re-processed (idempotent — same audiences).
      if (params.cursor && key < params.cursor) continue;
      if (key.startsWith("kb:")) {
        yield* this.syncKnowledgeBaseSnapshot(key, params);
      } else {
        yield* this.syncTableSnapshot(key, config, params);
      }
    }

    this.reportDroppedPrincipals();
  }

  /**
   * Groups whose tokens can appear in container audiences, each expanded to
   * its member roster: ServiceNow groups referenced by ingested records,
   * declared role audiences (rostered from sys_user_has_role, inherited
   * grants included), and evaluatable KB can-read criteria. All ids embed the
   * instance host — group and criteria sys_ids (and role names) are unique
   * only within an instance, and a bare id would collide across two
   * ServiceNow connectors, letting one instance's roster satisfy the other's
   * container tokens (`group:servicenow_<id>` is namespaced by type only).
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseConfig(params.config);
    if (!config) {
      throw new Error("Invalid ServiceNow configuration for group sync");
    }
    this.initPermissionPass(config, params);

    const descriptors = new Map<string, SnGroupDescriptor>();
    const participantIds = new Set<string>();

    for (const entity of getEnabledEntities(config)) {
      if (entity.table === "kb_knowledge") continue;
      const spec = TABLE_AUDIENCE_SPECS[entity.table];
      if (!spec) continue;
      const recordIds = await this.collectIngestedIds(params, {
        kind: entity.table,
      });
      const audiences = await this.fetchRecordParticipants(
        entity.table,
        spec,
        recordIds,
      );
      for (const audience of audiences.values()) {
        for (const groupId of audience.groupIds) {
          descriptors.set(this.snGroupRef(groupId), {
            kind: "group",
            sysId: groupId,
            name: null,
          });
        }
        for (const userId of audience.userIds) participantIds.add(userId);
      }
    }

    const groupSysIds = [...descriptors.values()]
      .filter(
        (d): d is SnGroupDescriptor & { kind: "group" } => d.kind === "group",
      )
      .map((d) => d.sysId);
    const groupNames = await this.fetchGroupNames(groupSysIds);
    for (const descriptor of descriptors.values()) {
      if (descriptor.kind === "group") {
        descriptor.name = groupNames.get(descriptor.sysId) ?? null;
      }
    }

    for (const roles of Object.values(config.roleAudiences ?? {})) {
      for (const role of roles) {
        descriptors.set(this.snRoleRef(role), {
          kind: "role",
          role,
          name: `Role: ${role}`,
        });
      }
    }

    // KB-level can-read criteria become groups; deny paths and article-level
    // overrides grant through inline users instead, so they roster nothing.
    if (config.includeKnowledgeArticles === true) {
      try {
        const kbIds = [...(await this.readKnowledgeCorpus(params)).keys()];
        const criteria = await this.fetchCriteriaFor(kbIds);
        for (const { can } of criteria.values()) {
          for (const criterion of can) {
            if (criterion.advanced) continue;
            descriptors.set(this.snCriteriaRef(criterion.sysId), {
              kind: "criteria",
              criterion,
              name: criterion.name,
            });
          }
        }
      } catch (error) {
        // Criteria discovery reads the same tables as the KB snapshot path,
        // which already fail-closes the affected knowledge bases and counts
        // them as audience failures. Losing it must not also abort the ITSM
        // group, role, and direct-grant rosters below.
        this.log.warn(
          { error: extractErrorMessage(error) },
          "Could not enumerate ServiceNow criteria groups; knowledge-base criteria rosters are skipped this pass",
        );
      }
    }

    for (const groupId of [...descriptors.keys()].sort()) {
      const descriptor = descriptors.get(groupId);
      if (!descriptor) continue;
      let members: GroupMemberYield[];
      let failed = false;
      try {
        members = await this.rosterMembers(descriptor);
      } catch (error) {
        // Per-group failure isolation: one unreadable group fail-closes its
        // own grants only, never the whole enumeration.
        this.log.warn(
          { groupId, error: extractErrorMessage(error) },
          "Could not resolve ServiceNow group members; the group's grants stay fail-closed",
        );
        members = [];
        failed = true;
      }
      yield {
        groupId,
        name: descriptor.name,
        members,
        membershipResolutionFailed: failed || undefined,
        cursor: groupId,
      };
    }

    // Participants granted inline via exceptionUsers roster under the
    // synthetic direct-grants group so accounts without a matching Archestra
    // user are visible and override-assignable. Access itself flows through
    // user_email tokens, never through this group's token (Salesforce
    // precedent), so its constant id cannot cross-grant between connectors.
    if (participantIds.size > 0) {
      yield {
        groupId: DIRECT_GRANTS_GROUP_ID,
        members: await this.toMemberYields([...participantIds].sort()),
      };
    }
  }

  /**
   * Local-adoption scoping for delta passes — pure metadata read stamped by
   * content-sync. Scoping only: assignment comes from the authoritative
   * enumeration, so a stale value can delay adoption but never over-grant.
   */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const kind = metadata.kind;
    if (typeof kind !== "string" || kind.length === 0) return null;
    if (kind === "kb_knowledge") {
      const kbId = metadata.knowledgeBaseId;
      return typeof kbId === "string" && kbId.length > 0 ? `kb:${kbId}` : null;
    }
    return `table:${kind}`;
  }

  // ----- Private permission-sync helpers -----

  private initPermissionPass(
    config: ServiceNowConfig,
    params: PermissionSyncParams,
  ): void {
    this.permBaseUrl = config.instanceUrl;
    this.permHost = instanceHost(config.instanceUrl);
    this.permHeaders = buildHeaders(params.credentials);
    this.userInfoCache = new Map();
    this.criteriaUsersCache = new Map();
    this.principalNameHints = new Map();
    this.knowledgeProps = null;
    this.allActiveUsersCache = undefined;
    this.kbArticlesCache = null;
    this.droppedPrincipals = 0;
    this.mappedEmailResolver = params.resolveMappedEmail ?? null;
  }

  /** One ITSM/CMDB table: boundary container + per-group-set nested containers. */
  private async *syncTableSnapshot(
    containerKey: string,
    config: ServiceNowConfig,
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const table = containerKey.slice("table:".length);
    const recordIds = await this.collectIngestedIds(params, { kind: table });
    const roleRefs = (config.roleAudiences?.[table] ?? []).map((role) =>
      this.snRoleRef(role),
    );

    // The top-level container carries the declared role audience (empty
    // boundary otherwise). Not a resolution failure either way.
    yield {
      kind: "container",
      containerKey,
      permissions: { isPublic: false, users: [], groups: roleRefs },
      audienceResolutionFailed: false,
      cursor: containerKey,
    };
    if (recordIds.length === 0) return;

    const spec = TABLE_AUDIENCE_SPECS[table];
    if (!spec) {
      for (const sysId of recordIds) {
        yield {
          kind: "document",
          sourceId: sysId,
          containerKey,
          cursor: containerKey,
        };
      }
      return;
    }

    const audiences = await this.fetchRecordParticipants(
      table,
      spec,
      recordIds,
    );
    const allUserIds = new Set<string>();
    for (const audience of audiences.values()) {
      for (const userId of audience.userIds) allUserIds.add(userId);
    }
    const userInfo = await this.resolveUsers([...allUserIds]);

    const nestedGroupIds = new Map<string, string[]>();
    const docsByContainer = new Map<
      string,
      { sourceId: string; exceptionUsers: string[] }[]
    >();
    for (const sysId of recordIds) {
      const audience = audiences.get(sysId);
      // A record whose participant fetch failed keeps only the top-level
      // audience — an under-grant, never an over-grant.
      const groupIds = audience ? [...audience.groupIds].sort() : [];
      const exceptionUsers: string[] = [];
      for (const userId of audience?.userIds ?? []) {
        const email = userInfo.get(userId)?.email ?? null;
        if (email) exceptionUsers.push(email);
        else this.droppedPrincipals++;
      }
      const key =
        groupIds.length > 0
          ? `${containerKey}/groups:${groupIds.join("+")}`
          : containerKey;
      if (groupIds.length > 0) nestedGroupIds.set(key, groupIds);
      const docs = docsByContainer.get(key) ?? [];
      docs.push({ sourceId: sysId, exceptionUsers: exceptionUsers.sort() });
      docsByContainer.set(key, docs);
    }

    for (const key of [...nestedGroupIds.keys()].sort()) {
      const groupIds = nestedGroupIds.get(key) ?? [];
      yield {
        kind: "container",
        containerKey: key,
        permissions: {
          isPublic: false,
          users: [],
          groups: [
            ...groupIds.map((groupId) => this.snGroupRef(groupId)),
            ...roleRefs,
          ],
        },
        audienceResolutionFailed: false,
        cursor: containerKey,
      };
      for (const doc of docsByContainer.get(key) ?? []) {
        yield {
          kind: "document",
          sourceId: doc.sourceId,
          containerKey: key,
          exceptionUsers: doc.exceptionUsers,
          cursor: containerKey,
        };
      }
    }
    for (const doc of docsByContainer.get(containerKey) ?? []) {
      yield {
        kind: "document",
        sourceId: doc.sourceId,
        containerKey,
        exceptionUsers: doc.exceptionUsers,
        cursor: containerKey,
      };
    }
  }

  /** One knowledge base: criteria-derived audience + article-level overrides. */
  private async *syncKnowledgeBaseSnapshot(
    containerKey: string,
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const kbId = containerKey.slice("kb:".length);
    const articleIds = [
      ...((await this.readKnowledgeCorpus(params)).get(kbId) ?? []),
    ].sort();

    let kbCan: SnUserCriteria[];
    let kbCannot: SnUserCriteria[];
    let articleCriteria: Map<
      string,
      { can: SnUserCriteria[]; cannot: SnUserCriteria[] }
    >;
    try {
      const props = await this.getKnowledgeProps();
      const kbCriteria = await this.fetchCriteriaFor([kbId]);
      kbCan = kbCriteria.get(kbId)?.can ?? [];
      kbCannot = kbCriteria.get(kbId)?.cannot ?? [];
      articleCriteria =
        props.applyArticleCriteria && articleIds.length > 0
          ? await this.fetchCriteriaFor(articleIds)
          : new Map();
    } catch (error) {
      // The criteria surface itself is unreadable: everything in this KB
      // fails closed, marked as a resolution failure.
      this.log.error(
        { kbId, error: extractErrorMessage(error) },
        "Could not read ServiceNow knowledge-base criteria; the knowledge base fails closed",
      );
      yield {
        kind: "container",
        containerKey,
        permissions: emptyAudience(),
        audienceResolutionFailed: true,
        cursor: containerKey,
      };
      for (const sysId of articleIds) {
        yield {
          kind: "document",
          sourceId: sysId,
          containerKey,
          cursor: containerKey,
        };
      }
      return;
    }

    const kbAudience = await this.computeKbAudience({
      can: kbCan,
      cannot: kbCannot,
    });
    yield {
      kind: "container",
      containerKey,
      permissions: kbAudience.permissions,
      audienceResolutionFailed: kbAudience.failed,
      cursor: containerKey,
    };

    for (const sysId of articleIds) {
      const criteria = articleCriteria.get(sysId);
      if (
        !criteria ||
        (criteria.can.length === 0 && criteria.cannot.length === 0)
      ) {
        yield {
          kind: "document",
          sourceId: sysId,
          containerKey,
          cursor: containerKey,
        };
        continue;
      }
      const audience = await this.computeArticleAudience({
        kbCan,
        kbCannot,
        articleCan: criteria.can,
        articleCannot: criteria.cannot,
      });
      const nestedKey = `${containerKey}/article:${sysId}`;
      yield {
        kind: "container",
        containerKey: nestedKey,
        permissions: audience.permissions,
        audienceResolutionFailed: audience.failed,
        cursor: containerKey,
      };
      yield {
        kind: "document",
        sourceId: sysId,
        containerKey: nestedKey,
        cursor: containerKey,
      };
    }
  }

  /**
   * KB-level audience. The cheap common case (allow criteria only) keeps the
   * group indirection — each evaluatable criteria is a group. Deny criteria
   * are inexpressible as a group union, so their presence materializes the
   * concrete allow−deny user set.
   */
  private async computeKbAudience(params: {
    can: SnUserCriteria[];
    cannot: SnUserCriteria[];
  }): Promise<SnAudience> {
    const { can, cannot } = params;
    if (cannot.some((criterion) => criterion.advanced)) {
      // A script-based deny could deny anyone — fail the whole container
      // closed rather than risk over-granting (Microsoft's connector
      // documents the same deny-all convention for its simple flow).
      return failedAudience();
    }
    if (cannot.length === 0) {
      if (can.length === 0) return this.noCriteriaAudience();
      const evaluatable = can.filter((criterion) => !criterion.advanced);
      if (evaluatable.length === 0) return failedAudience();
      return {
        permissions: {
          isPublic: false,
          users: [],
          groups: evaluatable.map((criterion) =>
            this.snCriteriaRef(criterion.sysId),
          ),
        },
        failed: false,
      };
    }

    const denyUsers = await this.expandCriteriaUnion(cannot, {
      strict: true,
    });
    if (denyUsers === null) return failedAudience();
    let allowUsers: Set<string> | null;
    if (can.length === 0) {
      const base = await this.noCriteriaAudience();
      if (base.failed || base.permissions.isPublic !== true) return base;
      const all = await this.getAllActiveUserIds();
      if (all === null) return failedAudience();
      allowUsers = new Set(all);
    } else {
      const evaluatable = can.filter((criterion) => !criterion.advanced);
      if (evaluatable.length === 0) return failedAudience();
      allowUsers = await this.expandCriteriaUnion(evaluatable, {
        strict: false,
      });
      if (allowUsers === null) return failedAudience();
    }
    const users = await this.emailsFor(
      [...allowUsers].filter((userId) => !denyUsers.has(userId)),
    );
    return {
      permissions: { isPublic: false, users, groups: [] },
      failed: false,
    };
  }

  /**
   * Article-level audience: the article's own can-read criteria take
   * precedence over the KB-level set; denies at either level always apply.
   * Always a concrete user set (an intersection/subtraction has no group
   * form).
   */
  private async computeArticleAudience(params: {
    kbCan: SnUserCriteria[];
    kbCannot: SnUserCriteria[];
    articleCan: SnUserCriteria[];
    articleCannot: SnUserCriteria[];
  }): Promise<SnAudience> {
    const denies = [...params.kbCannot, ...params.articleCannot];
    if (denies.some((criterion) => criterion.advanced)) {
      return failedAudience();
    }
    const denyUsers = await this.expandCriteriaUnion(denies, { strict: true });
    if (denyUsers === null) return failedAudience();

    const allowCriteria =
      params.articleCan.length > 0 ? params.articleCan : params.kbCan;
    let allowUsers: Set<string> | null;
    if (allowCriteria.length === 0) {
      const base = await this.noCriteriaAudience();
      if (base.failed || base.permissions.isPublic !== true) return base;
      const all = await this.getAllActiveUserIds();
      if (all === null) return failedAudience();
      allowUsers = new Set(all);
    } else {
      const evaluatable = allowCriteria.filter(
        (criterion) => !criterion.advanced,
      );
      if (evaluatable.length === 0) return failedAudience();
      allowUsers = await this.expandCriteriaUnion(evaluatable, {
        strict: false,
      });
      if (allowUsers === null) return failedAudience();
    }
    const users = await this.emailsFor(
      [...allowUsers].filter((userId) => !denyUsers.has(userId)),
    );
    return {
      permissions: { isPublic: false, users, groups: [] },
      failed: false,
    };
  }

  /**
   * Audience of a KB/article with no criteria at all, governed by
   * glide.knowman.block_access_with_no_user_criteria: open to the whole
   * organization when the instance says so, genuinely nobody when blocking is
   * on, fail-closed when the properties could not be read.
   */
  private async noCriteriaAudience(): Promise<SnAudience> {
    const props = await this.getKnowledgeProps();
    if (props.readFailed) return failedAudience();
    if (props.blockNoCriteria) {
      return { permissions: emptyAudience(), failed: false };
    }
    return { permissions: { isPublic: true }, failed: false };
  }

  /**
   * Union of the criteria's matching users. `strict` (deny paths) returns
   * null when ANY criteria is unevaluatable — an incomplete deny set would
   * over-grant. Lenient (allow paths) skips unevaluatable criteria — an
   * under-grant — unless none evaluated.
   */
  private async expandCriteriaUnion(
    criteria: SnUserCriteria[],
    opts: { strict: boolean },
  ): Promise<Set<string> | null> {
    const result = new Set<string>();
    let evaluated = 0;
    for (const criterion of criteria) {
      const users = await this.expandCriteriaUsers(criterion);
      if (users === null) {
        if (opts.strict) return null;
        continue;
      }
      evaluated++;
      for (const userId of users) result.add(userId);
    }
    if (criteria.length > 0 && evaluated === 0 && !opts.strict) return null;
    return result;
  }

  /** The user sys_ids matching one criteria (cached; null = unevaluatable). */
  private async expandCriteriaUsers(
    criterion: SnUserCriteria,
  ): Promise<Set<string> | null> {
    if (criterion.advanced) return null;
    const cached = this.criteriaUsersCache.get(criterion.sysId);
    if (cached !== undefined) return cached;
    let result: Set<string> | null;
    try {
      result = await this.expandCriteriaUsersUncached(criterion);
    } catch (error) {
      this.log.warn(
        { criteriaId: criterion.sysId, error: extractErrorMessage(error) },
        "Could not expand ServiceNow user criteria; it grants nobody this pass",
      );
      result = null;
    }
    this.criteriaUsersCache.set(criterion.sysId, result);
    return result;
  }

  private async expandCriteriaUsersUncached(
    criterion: SnUserCriteria,
  ): Promise<Set<string>> {
    const dimensions: Set<string>[] = [];
    if (criterion.users.length > 0) {
      dimensions.push(new Set(criterion.users));
    }
    if (criterion.groups.length > 0) {
      const rows = await this.tableQueryAll({
        table: "sys_user_grmember",
        query: `groupIN${criterion.groups.join(",")}`,
        fields: "user",
      });
      dimensions.push(collectRefs(rows, "user"));
    }
    if (criterion.roles.length > 0) {
      const rows = await this.tableQueryAll({
        table: "sys_user_has_role",
        query: `roleIN${criterion.roles.join(",")}`,
        fields: "user",
      });
      dimensions.push(collectRefs(rows, "user"));
    }
    const orgFields: [string, string[]][] = [
      ["company", criterion.companies],
      ["department", criterion.departments],
      ["location", criterion.locations],
    ];
    for (const [field, ids] of orgFields) {
      if (ids.length === 0) continue;
      const rows = await this.tableQueryAll({
        table: "sys_user",
        query: `${field}IN${ids.join(",")}^active=true`,
        fields: "sys_id",
      });
      dimensions.push(collectRefs(rows, "sys_id"));
    }
    if (dimensions.length === 0) return new Set();
    if (!criterion.matchAll) {
      const union = new Set<string>();
      for (const dimension of dimensions) {
        for (const userId of dimension) union.add(userId);
      }
      return union;
    }
    // match_all: a user must satisfy every specified dimension.
    let intersection = dimensions[0];
    for (const dimension of dimensions.slice(1)) {
      intersection = new Set(
        [...intersection].filter((userId) => dimension.has(userId)),
      );
    }
    return intersection;
  }

  /**
   * Can/cannot-read criteria linked to KBs or articles. Both levels store
   * their links in the same kb_uc_*_mtom m2m tables (the reference column
   * carries the KB or article sys_id). A referenced criteria row that cannot
   * be read is synthesized as advanced (unevaluatable), so a missing deny
   * still fails closed instead of silently un-denying.
   */
  private async fetchCriteriaFor(
    targetIds: string[],
  ): Promise<Map<string, { can: SnUserCriteria[]; cannot: SnUserCriteria[] }>> {
    const result = new Map<
      string,
      { can: SnUserCriteria[]; cannot: SnUserCriteria[] }
    >(targetIds.map((id) => [id, { can: [], cannot: [] }]));
    const refs: { target: string; criteriaId: string; deny: boolean }[] = [];
    const m2mTables = [
      { table: "kb_uc_can_read_mtom", deny: false },
      { table: "kb_uc_cannot_read_mtom", deny: true },
    ];
    for (const { table, deny } of m2mTables) {
      for (const chunk of chunked(targetIds, SYS_ID_IN_CHUNK_SIZE)) {
        const rows = await this.tableQueryAll({
          table,
          query: `kb_knowledge_baseIN${chunk.join(",")}`,
          fields: "kb_knowledge_base,user_criteria",
        });
        for (const row of rows) {
          const target = rawRef(row.kb_knowledge_base);
          const criteriaId = rawRef(row.user_criteria);
          if (target && criteriaId) refs.push({ target, criteriaId, deny });
        }
      }
    }

    const criteriaIds = [...new Set(refs.map((ref) => ref.criteriaId))];
    const criteriaById = new Map<string, SnUserCriteria>();
    for (const chunk of chunked(criteriaIds, SYS_ID_IN_CHUNK_SIZE)) {
      const rows = await this.tableQueryAll({
        table: "user_criteria",
        query: `sys_idIN${chunk.join(",")}`,
        fields: USER_CRITERIA_FIELDS,
      });
      for (const row of rows) {
        const criterion = parseUserCriteria(row);
        if (criterion) criteriaById.set(criterion.sysId, criterion);
      }
    }

    for (const ref of refs) {
      const criterion =
        criteriaById.get(ref.criteriaId) ?? unreadableCriteria(ref.criteriaId);
      if (!criterion.active) continue;
      const bucket = result.get(ref.target);
      if (!bucket) continue;
      (ref.deny ? bucket.cannot : bucket.can).push(criterion);
    }
    return result;
  }

  private async getKnowledgeProps(): Promise<KnowledgeProps> {
    if (this.knowledgeProps) return this.knowledgeProps;
    let props: KnowledgeProps;
    try {
      const rows = await this.tableQueryAll({
        table: "sys_properties",
        query: `nameIN${KNOWMAN_APPLY_ARTICLE_CRITERIA},${KNOWMAN_BLOCK_NO_CRITERIA}`,
        fields: "name,value",
      });
      const byName = new Map<string, string>();
      for (const row of rows) {
        const name = typeof row.name === "string" ? row.name : "";
        const value = typeof row.value === "string" ? row.value : "";
        if (name) byName.set(name, value);
      }
      // A missing property row takes the restrictive reading, same as an
      // unreadable table — under-grant is the acceptable direction.
      props = {
        applyArticleCriteria: parseSnBool(
          byName.get(KNOWMAN_APPLY_ARTICLE_CRITERIA),
          true,
        ),
        blockNoCriteria: parseSnBool(
          byName.get(KNOWMAN_BLOCK_NO_CRITERIA),
          true,
        ),
        readFailed: false,
      };
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Could not read glide.knowman properties; criteria-less knowledge bases fail closed",
      );
      props = {
        applyArticleCriteria: true,
        blockNoCriteria: true,
        readFailed: true,
      };
    }
    this.knowledgeProps = props;
    return props;
  }

  /** Ingested sourceIds for one metadata filter (keyset-paged read-back). */
  private async collectIngestedIds(
    params: PermissionSyncParams,
    metadataFilter: Record<string, string>,
  ): Promise<string[]> {
    const ids: string[] = [];
    let afterId: string | null = null;
    for (;;) {
      const { documents, nextAfterId } = await params.readIngestedDocuments({
        metadataFilter,
        afterId,
        limit: PERMISSION_READBACK_PAGE_SIZE,
      });
      for (const doc of documents) ids.push(doc.sourceId);
      if (documents.length < PERMISSION_READBACK_PAGE_SIZE) break;
      afterId = nextAfterId;
    }
    return ids.sort();
  }

  /** kb sys_id → ingested article sourceIds, read once per pass. */
  private async readKnowledgeCorpus(
    params: PermissionSyncParams,
  ): Promise<Map<string, string[]>> {
    if (this.kbArticlesCache) return this.kbArticlesCache;
    const map = new Map<string, string[]>();
    let afterId: string | null = null;
    for (;;) {
      const { documents, nextAfterId } = await params.readIngestedDocuments({
        metadataFilter: { kind: "kb_knowledge" },
        afterId,
        limit: PERMISSION_READBACK_PAGE_SIZE,
      });
      for (const doc of documents) {
        const kbId = doc.metadata?.knowledgeBaseId;
        // An article without a KB reference joins no container; the full
        // pass's unassigned-document sweep fails it closed.
        if (typeof kbId !== "string" || kbId.length === 0) continue;
        const list = map.get(kbId) ?? [];
        list.push(doc.sourceId);
        map.set(kbId, list);
      }
      if (documents.length < PERMISSION_READBACK_PAGE_SIZE) break;
      afterId = nextAfterId;
    }
    this.kbArticlesCache = map;
    return map;
  }

  /** Per-record group/user references for one table, chunked sys_idIN reads. */
  private async fetchRecordParticipants(
    table: string,
    spec: SnTableAudienceSpec,
    recordIds: string[],
  ): Promise<Map<string, SnRecordAudience>> {
    const result = new Map<string, SnRecordAudience>();
    const fields = ["sys_id", ...spec.groupFields, ...spec.userFields].join(
      ",",
    );
    for (const chunk of chunked(recordIds, SYS_ID_IN_CHUNK_SIZE)) {
      let rows: SnRawRecord[];
      try {
        rows = await this.tableQueryAll({
          table,
          query: `sys_idIN${chunk.join(",")}`,
          fields,
          withDisplayValues: true,
        });
        this.rememberNameHints(rows, spec.userFields);
      } catch (error) {
        // Records in a failed chunk keep only the table-level audience (an
        // under-grant); the next pass retries them.
        this.log.warn(
          { table, count: chunk.length, error: extractErrorMessage(error) },
          "Could not read record participants; affected records keep the table-level audience only",
        );
        continue;
      }
      for (const row of rows) {
        const sysId = rawRef(row.sys_id);
        if (!sysId) continue;
        const groupIds = new Set<string>();
        for (const field of spec.groupFields) {
          const ref = rawRef(row[field]);
          if (ref) groupIds.add(ref);
        }
        const userIds = new Set<string>();
        for (const field of spec.userFields) {
          const ref = rawRef(row[field]);
          if (ref) userIds.add(ref);
        }
        result.set(sysId, {
          groupIds: [...groupIds],
          userIds: [...userIds],
        });
      }
    }
    return result;
  }

  /** Keep the display names carried by reference fields on the given rows. */
  private rememberNameHints(rows: SnRawRecord[], fields: string[]): void {
    for (const row of rows) {
      for (const field of fields) {
        const sysId = rawRef(row[field]);
        const display = refDisplay(row[field]);
        if (sysId && display && display !== sysId) {
          this.principalNameHints.set(sysId, display);
        }
      }
    }
  }

  private async fetchGroupNames(
    groupSysIds: string[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const chunk of chunked(groupSysIds, SYS_ID_IN_CHUNK_SIZE)) {
      try {
        const rows = await this.tableQueryAll({
          table: "sys_user_group",
          query: `sys_idIN${chunk.join(",")}`,
          fields: "sys_id,name",
        });
        for (const row of rows) {
          const sysId = rawRef(row.sys_id);
          const name = typeof row.name === "string" ? row.name : "";
          if (sysId && name) names.set(sysId, name);
        }
      } catch (error) {
        this.log.debug(
          { error: extractErrorMessage(error) },
          "Could not read ServiceNow group names; groups keep their id as name",
        );
      }
    }
    return names;
  }

  private async rosterMembers(
    descriptor: SnGroupDescriptor,
  ): Promise<GroupMemberYield[]> {
    if (descriptor.kind === "group") {
      const rows = await this.tableQueryAll({
        table: "sys_user_grmember",
        query: `group=${descriptor.sysId}`,
        fields: "user",
        withDisplayValues: true,
      });
      this.rememberNameHints(rows, ["user"]);
      return this.toMemberYields([...collectRefs(rows, "user")].sort());
    }
    if (descriptor.kind === "role") {
      // sys_user_has_role holds inherited grants too (group-assigned roles,
      // contained roles), so this roster matches ServiceNow's own semantics.
      const rows = await this.tableQueryAll({
        table: "sys_user_has_role",
        query: `role.name=${descriptor.role}`,
        fields: "user",
        withDisplayValues: true,
      });
      this.rememberNameHints(rows, ["user"]);
      return this.toMemberYields([...collectRefs(rows, "user")].sort());
    }
    const users = await this.expandCriteriaUsers(descriptor.criterion);
    if (users === null) {
      throw new Error("user criteria is not evaluatable");
    }
    return this.toMemberYields([...users].sort());
  }

  private async toMemberYields(userIds: string[]): Promise<GroupMemberYield[]> {
    const info = await this.resolveUsers(userIds);
    return userIds.map((userId) => ({
      accountId: userId,
      displayName: info.get(userId)?.name ?? null,
      email: info.get(userId)?.email ?? null,
    }));
  }

  /**
   * sys_user sys_id → {email, name}, chunked and cached per pass. Inactive
   * users never resolve (a deactivated account holds no access upstream
   * either); a hidden email falls back to the admin mapping.
   */
  private async resolveUsers(
    userIds: string[],
  ): Promise<Map<string, { email: string | null; name: string | null }>> {
    const missing = userIds.filter((id) => !this.userInfoCache.has(id));
    // Not every principal reference is a sys_id: some ServiceNow fields carry
    // the account's user_name instead (`glide.maint`, `felix.bait`). Those
    // resolve against user_name, or they would look like unknown principals.
    const bySysId = missing.filter(isSysId);
    const byUserName = missing.filter((id) => !isSysId(id));
    const lookups: { query: string; ids: string[] }[] = [
      ...chunked(bySysId, SYS_ID_IN_CHUNK_SIZE).map((chunk) => ({
        query: `sys_idIN${chunk.join(",")}`,
        ids: chunk,
      })),
      ...chunked(byUserName, SYS_ID_IN_CHUNK_SIZE).map((chunk) => ({
        query: `user_nameIN${chunk.join(",")}`,
        ids: chunk,
      })),
    ];

    for (const lookup of lookups) {
      const chunk = lookup.ids;
      let rows: SnRawRecord[] = [];
      try {
        rows = await this.tableQueryAll({
          table: "sys_user",
          query: lookup.query,
          fields: "sys_id,user_name,email,name,active",
        });
      } catch (error) {
        this.log.warn(
          { count: chunk.length, error: extractErrorMessage(error) },
          "Could not resolve ServiceNow users; affected principals stay unresolvable this pass",
        );
      }
      const byId = new Map<string, SnRawRecord>();
      for (const row of rows) {
        const sysId = rawRef(row.sys_id);
        if (sysId) byId.set(sysId, row);
        const userName = rawRef(row.user_name);
        if (userName) byId.set(userName, row);
      }
      for (const userId of chunk) {
        const row = byId.get(userId);
        const active = row ? parseSnBool(row.active, true) : false;
        const upstreamEmail =
          row && typeof row.email === "string" && row.email.length > 0
            ? row.email
            : null;
        const email = active
          ? (upstreamEmail ?? this.mappedEmailResolver?.(userId) ?? null)
          : null;
        const ownName =
          row && typeof row.name === "string" && row.name.length > 0
            ? row.name
            : null;
        this.userInfoCache.set(userId, {
          email,
          // An unreadable sys_user row still has a label if some record or
          // membership referenced this principal by display value — and when
          // the reference itself was a user_name (`glide.maint`), that name
          // beats showing an admin nothing at all.
          name:
            ownName ??
            this.principalNameHints.get(userId) ??
            (isSysId(userId) ? null : userId),
        });
      }
    }
    const result = new Map<
      string,
      { email: string | null; name: string | null }
    >();
    for (const userId of userIds) {
      result.set(
        userId,
        this.userInfoCache.get(userId) ?? { email: null, name: null },
      );
    }
    return result;
  }

  private async emailsFor(userIds: string[]): Promise<string[]> {
    const info = await this.resolveUsers(userIds);
    const emails: string[] = [];
    for (const userId of userIds) {
      const email = info.get(userId)?.email ?? null;
      if (email) emails.push(email);
      else this.droppedPrincipals++;
    }
    return emails.sort();
  }

  private async getAllActiveUserIds(): Promise<string[] | null> {
    if (this.allActiveUsersCache !== undefined) {
      return this.allActiveUsersCache;
    }
    try {
      const rows = await this.tableQueryAll({
        table: "sys_user",
        query: "active=true",
        fields: "sys_id",
      });
      this.allActiveUsersCache = [...collectRefs(rows, "sys_id")];
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Could not enumerate active ServiceNow users; open audiences fail closed",
      );
      this.allActiveUsersCache = null;
    }
    return this.allActiveUsersCache;
  }

  /** One Table API read, paginated to exhaustion (raw values, sys_id order). */
  private async tableQueryAll(opts: {
    table: string;
    query: string;
    fields: string;
    /**
     * Return reference fields as `{display_value, value}` so the caller can
     * keep the upstream display name alongside the sys_id. Used on the reads
     * that REFERENCE users (records, group members, role grants): when
     * `sys_user` itself is unreadable, that name is the only human label the
     * principal will ever have.
     */
    withDisplayValues?: boolean;
  }): Promise<SnRawRecord[]> {
    const rows: SnRawRecord[] = [];
    let offset = 0;
    for (;;) {
      await this.rateLimit();
      const query = `${opts.query}^ORDERBYsys_id`;
      const url = this.joinUrl(
        this.permBaseUrl,
        `/api/now/table/${opts.table}?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=${encodeURIComponent(opts.fields)}&sysparm_display_value=${opts.withDisplayValues ? "all" : "false"}&sysparm_limit=${PERMISSION_QUERY_PAGE_SIZE}&sysparm_offset=${offset}`,
      );
      const response = await this.fetchWithRetry(url, {
        headers: this.permHeaders,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `ServiceNow API error: HTTP ${response.status} - ${body.slice(0, 300)}`,
        );
      }
      const data = (await response.json()) as { result?: SnRawRecord[] };
      const page = data.result ?? [];
      rows.push(...page);
      if (page.length < PERMISSION_QUERY_PAGE_SIZE) return rows;
      offset += page.length;
    }
  }

  // Group-id builders. The platform namespaces group tokens by connector
  // TYPE only (`group:servicenow_<id>`), so the id itself must be globally
  // distinctive — every ref embeds the instance host.
  private snGroupRef(sysId: string): string {
    return `${this.permHost}/group/${sysId}`;
  }

  private snRoleRef(role: string): string {
    return `${this.permHost}/role/${role}`;
  }

  private snCriteriaRef(sysId: string): string {
    return `${this.permHost}/criteria/${sysId}`;
  }

  private reportDroppedPrincipals(): void {
    if (this.droppedPrincipals > 0) {
      this.log.warn(
        { dropped: this.droppedPrincipals },
        "ServiceNow principals without a resolvable email were dropped from audiences (fail-closed)",
      );
    }
  }
}

// ===== Entity definitions =====

interface EntityDef {
  table: string;
  fields: string;
  useStatesAndGroups: boolean;
  /** Extra encoded-query clauses ANDed into every page fetch. */
  extraQuery?: string;
}

const INCIDENT_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "urgency",
  "impact",
  "category",
  "assignment_group",
  "assigned_to",
  "caller_id",
  "opened_at",
  "resolved_at",
  "closed_at",
  "sys_updated_on",
  "sys_created_on",
  "active",
  "severity",
  "company",
  "business_service",
  "problem_id",
].join(",");

const CHANGE_REQUEST_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "urgency",
  "impact",
  "category",
  "assignment_group",
  "assigned_to",
  "opened_at",
  "closed_at",
  "sys_updated_on",
  "sys_created_on",
  "active",
  "risk",
  "type",
  "close_code",
  "reason",
  "start_date",
  "end_date",
  "requested_by",
].join(",");

const CHANGE_TASK_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "urgency",
  "impact",
  "category",
  "assignment_group",
  "assigned_to",
  "opened_at",
  "closed_at",
  "sys_updated_on",
  "sys_created_on",
  "active",
  "change_request",
  "planned_start_date",
  "planned_end_date",
].join(",");

const PROBLEM_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "urgency",
  "impact",
  "category",
  "assignment_group",
  "assigned_to",
  "opened_at",
  "closed_at",
  "sys_updated_on",
  "sys_created_on",
  "active",
  "known_error",
  "first_reported_by_task",
  "opened_by",
].join(",");

const BUSINESS_APP_FIELDS = [
  "sys_id",
  "name",
  "short_description",
  "version",
  "vendor",
  "operational_status",
  "install_status",
  "sys_updated_on",
  "sys_created_on",
].join(",");

const KB_KNOWLEDGE_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "text",
  "workflow_state",
  "active",
  "kb_knowledge_base",
  "kb_category",
  "author",
  "sys_updated_on",
  "sys_created_on",
].join(",");

// ===== Module-level helpers =====

interface ServiceNowDisplayValue {
  display_value: string;
  value: string;
  link?: string;
}

type ServiceNowRecord = Record<string, ServiceNowDisplayValue>;

function parseConfig(config: Record<string, unknown>): ServiceNowConfig | null {
  const result = ServiceNowConfigSchema.safeParse({
    type: "servicenow",
    ...config,
  });
  return result.success ? result.data : null;
}

function getEnabledEntities(config: ServiceNowConfig): EntityDef[] {
  const entities: EntityDef[] = [];

  if (config.includeIncidents !== false) {
    entities.push({
      table: "incident",
      fields: INCIDENT_FIELDS,
      useStatesAndGroups: true,
    });
  }

  if (config.includeChanges === true) {
    entities.push({
      table: "change_request",
      fields: CHANGE_REQUEST_FIELDS,
      useStatesAndGroups: true,
    });
  }

  if (config.includeChangeRequests === true) {
    entities.push({
      table: "change_task",
      fields: CHANGE_TASK_FIELDS,
      useStatesAndGroups: true,
    });
  }

  if (config.includeProblems === true) {
    entities.push({
      table: "problem",
      fields: PROBLEM_FIELDS,
      useStatesAndGroups: true,
    });
  }

  if (config.includeBusinessApps === true) {
    entities.push({
      table: "cmdb_ci_business_app",
      fields: BUSINESS_APP_FIELDS,
      useStatesAndGroups: false,
    });
  }

  if (config.includeKnowledgeArticles === true) {
    entities.push({
      table: "kb_knowledge",
      fields: KB_KNOWLEDGE_FIELDS,
      useStatesAndGroups: false,
      extraQuery: "workflow_state=published^active=true",
    });
  }

  return entities;
}

function buildQuery(params: {
  config: ServiceNowConfig;
  checkpoint: ServiceNowCheckpoint;
  startTime?: Date;
  useStatesAndGroups: boolean;
  extraQuery?: string;
}): string {
  const { config, checkpoint, startTime, useStatesAndGroups, extraQuery } =
    params;
  const clauses: string[] = [];

  if (extraQuery) {
    clauses.push(extraQuery);
  }

  if (useStatesAndGroups) {
    if (config.states && config.states.length > 0) {
      const stateFilter = config.states.map((s) => `state=${s}`).join("^OR");
      clauses.push(stateFilter);
    }

    if (config.assignmentGroups && config.assignmentGroups.length > 0) {
      const groupFilter = config.assignmentGroups
        .map((g) => `assignment_group=${g}`)
        .join("^OR");
      clauses.push(groupFilter);
    }
  }

  let syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
  if (!syncFrom) {
    const months = config.syncDataForLastMonths ?? DEFAULT_INITIAL_SYNC_MONTHS;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    syncFrom = cutoff.toISOString();
  }
  const snDate = formatServiceNowDate(syncFrom);
  clauses.push(`sys_created_on>${snDate}`);

  clauses.push("ORDERBYsys_created_on");

  return clauses.join("^");
}

function formatServiceNowDate(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  const seconds = String(d.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function buildHeaders(credentials: ConnectorCredentials): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (credentials.email) {
    const encoded = Buffer.from(
      `${credentials.email}:${credentials.apiToken}`,
    ).toString("base64");
    headers.Authorization = `Basic ${encoded}`;
  } else {
    headers.Authorization = `Bearer ${credentials.apiToken}`;
  }

  return headers;
}

function dv(field: ServiceNowDisplayValue | undefined): string {
  return field?.display_value ?? field?.value ?? "";
}

function recordToDocument(
  record: ServiceNowRecord,
  instanceUrl: string,
  table: string,
): ConnectorDocument {
  if (table === "cmdb_ci_business_app") {
    return businessAppToDocument(record, instanceUrl);
  }
  if (table === "kb_knowledge") {
    return articleToDocument(record, instanceUrl);
  }

  const description = dv(record.description);
  const plainText = stripHtmlTags(description);
  const title = dv(record.short_description) || "Untitled";
  const recordNumber = dv(record.number);
  const sysId = record.sys_id?.value ?? "";

  const normalizedBase = instanceUrl.replace(/\/+$/, "");
  const sourceUrl = sysId
    ? `${normalizedBase}/${table}.do?sys_id=${sysId}`
    : undefined;

  const metadata: Record<string, unknown> = {
    sysId,
    number: recordNumber,
    kind: table,
    state: dv(record.state),
    priority: dv(record.priority),
    urgency: dv(record.urgency),
    impact: dv(record.impact),
    category: dv(record.category),
    assignmentGroup: dv(record.assignment_group),
    assignedTo: dv(record.assigned_to),
    active: record.active?.value === "true",
  };

  if (table === "incident") {
    metadata.caller = dv(record.caller_id);
    const severity = dv(record.severity);
    if (severity) metadata.severity = severity;
    const company = dv(record.company);
    if (company) metadata.company = company;
    const businessService = dv(record.business_service);
    if (businessService) metadata.businessService = businessService;
    const problem = dv(record.problem_id);
    if (problem) metadata.problem = problem;
  }

  if (table === "change_request") {
    metadata.risk = dv(record.risk);
    metadata.changeType = dv(record.type);
    metadata.closeCode = dv(record.close_code);
    metadata.reason = dv(record.reason);
    metadata.startDate = dv(record.start_date);
    metadata.endDate = dv(record.end_date);
    metadata.requestedBy = dv(record.requested_by);
  }

  if (table === "change_task") {
    metadata.changeRequest = dv(record.change_request);
    metadata.plannedStartDate = dv(record.planned_start_date);
    metadata.plannedEndDate = dv(record.planned_end_date);
  }

  if (table === "problem") {
    metadata.knownError = dv(record.known_error);
    metadata.firstReportedByTask = dv(record.first_reported_by_task);
    metadata.openedBy = dv(record.opened_by);
  }

  return {
    id: sysId,
    title,
    content: `# ${title}\n\n${plainText}`,
    sourceUrl,
    metadata,
    updatedAt: record.sys_updated_on?.value
      ? new Date(record.sys_updated_on.value)
      : undefined,
  };
}

function articleToDocument(
  record: ServiceNowRecord,
  instanceUrl: string,
): ConnectorDocument {
  const title = dv(record.short_description) || "Untitled";
  const plainText = stripHtmlTags(dv(record.text));
  const sysId = record.sys_id?.value ?? "";

  const normalizedBase = instanceUrl.replace(/\/+$/, "");
  const sourceUrl = sysId
    ? `${normalizedBase}/kb_view.do?sys_kb_id=${sysId}`
    : undefined;

  return {
    id: sysId,
    title,
    content: `# ${title}\n\n${plainText}`,
    sourceUrl,
    metadata: {
      sysId,
      number: dv(record.number),
      kind: "kb_knowledge",
      knowledgeBase: dv(record.kb_knowledge_base),
      // Raw sys_id of the parent knowledge base — the permission pass keys
      // its `kb:<sys_id>` containers on it (see scopeKeyForDocument).
      knowledgeBaseId: record.kb_knowledge_base?.value ?? "",
      category: dv(record.kb_category),
      author: dv(record.author),
      workflowState: dv(record.workflow_state),
      active: record.active?.value === "true",
    },
    updatedAt: record.sys_updated_on?.value
      ? new Date(record.sys_updated_on.value)
      : undefined,
  };
}

function businessAppToDocument(
  record: ServiceNowRecord,
  instanceUrl: string,
): ConnectorDocument {
  const name = dv(record.name) || "Untitled";
  const shortDescription = dv(record.short_description);
  const sysId = record.sys_id?.value ?? "";

  const normalizedBase = instanceUrl.replace(/\/+$/, "");
  const sourceUrl = sysId
    ? `${normalizedBase}/cmdb_ci_business_app.do?sys_id=${sysId}`
    : undefined;

  return {
    id: sysId,
    title: name,
    content: `# ${name}\n\n${shortDescription}`,
    sourceUrl,
    metadata: {
      sysId,
      kind: "cmdb_ci_business_app",
      name,
      version: dv(record.version),
      vendor: dv(record.vendor),
      operationalStatus: dv(record.operational_status),
      installStatus: dv(record.install_status),
    },
    updatedAt: record.sys_updated_on?.value
      ? new Date(record.sys_updated_on.value)
      : undefined,
  };
}

// ===== Permission-sync types & helpers =====

const PERMISSION_READBACK_PAGE_SIZE = 1000;
const PERMISSION_QUERY_PAGE_SIZE = 1000;
const SYS_ID_IN_CHUNK_SIZE = 100;
const DIRECT_GRANTS_GROUP_ID = "direct-grants";
const KNOWMAN_APPLY_ARTICLE_CRITERIA =
  "glide.knowman.apply_article_read_criteria";
const KNOWMAN_BLOCK_NO_CRITERIA =
  "glide.knowman.block_access_with_no_user_criteria";
const USER_CRITERIA_FIELDS =
  "sys_id,name,active,advanced,user,group,role,company,department,location,match_all";

/**
 * The participant surface per synced table: which reference fields carry the
 * record's group and user grants under the fail-closed approximation.
 */
const TABLE_AUDIENCE_SPECS: Record<string, SnTableAudienceSpec> = {
  incident: {
    groupFields: ["assignment_group"],
    userFields: ["assigned_to", "caller_id", "opened_by"],
  },
  change_request: {
    groupFields: ["assignment_group"],
    userFields: ["assigned_to", "requested_by", "opened_by"],
  },
  change_task: {
    groupFields: ["assignment_group"],
    userFields: ["assigned_to", "opened_by"],
  },
  problem: {
    groupFields: ["assignment_group"],
    userFields: ["assigned_to", "opened_by"],
  },
  cmdb_ci_business_app: {
    groupFields: ["assignment_group", "support_group"],
    userFields: ["assigned_to", "owned_by", "managed_by"],
  },
};

interface SnTableAudienceSpec {
  groupFields: string[];
  userFields: string[];
}

interface SnRecordAudience {
  groupIds: string[];
  userIds: string[];
}

interface SnUserCriteria {
  sysId: string;
  name: string | null;
  active: boolean;
  advanced: boolean;
  users: string[];
  groups: string[];
  roles: string[];
  companies: string[];
  departments: string[];
  locations: string[];
  matchAll: boolean;
}

interface KnowledgeProps {
  applyArticleCriteria: boolean;
  blockNoCriteria: boolean;
  readFailed: boolean;
}

interface SnAudience {
  permissions: DocumentPermissions;
  failed: boolean;
}

type SnGroupDescriptor =
  | { kind: "group"; sysId: string; name: string | null }
  | { kind: "role"; role: string; name: string | null }
  | { kind: "criteria"; criterion: SnUserCriteria; name: string | null };

/** Raw Table API row (sysparm_display_value=false). */
type SnRawRecord = Record<string, unknown>;

/** Raw reference-field value: plain sys_id string or `{value, link}`. */
function rawRef(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "value" in value &&
    typeof (value as { value: unknown }).value === "string"
  ) {
    return (value as { value: string }).value;
  }
  return "";
}

/** ServiceNow sys_ids are 32 lowercase hex characters. */
function isSysId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value);
}

/** Display label of a reference field read with `sysparm_display_value=all`. */
function refDisplay(value: unknown): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "display_value" in value &&
    typeof (value as { display_value: unknown }).display_value === "string"
  ) {
    return (value as { display_value: string }).display_value;
  }
  return "";
}

function collectRefs(rows: SnRawRecord[], field: string): Set<string> {
  const refs = new Set<string>();
  for (const row of rows) {
    const ref = rawRef(row[field]);
    if (ref) refs.add(ref);
  }
  return refs;
}

function parseSnBool(value: unknown, fallback: boolean): boolean {
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  return fallback;
}

/** Glide list field: comma-separated sys_ids (raw value form). */
function parseIdList(value: unknown): string[] {
  const raw = rawRef(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function parseUserCriteria(row: SnRawRecord): SnUserCriteria | null {
  const sysId = rawRef(row.sys_id);
  if (!sysId) return null;
  return {
    sysId,
    name: typeof row.name === "string" && row.name.length > 0 ? row.name : null,
    active: parseSnBool(row.active, true),
    advanced: parseSnBool(row.advanced, false),
    users: parseIdList(row.user),
    groups: parseIdList(row.group),
    roles: parseIdList(row.role),
    companies: parseIdList(row.company),
    departments: parseIdList(row.department),
    locations: parseIdList(row.location),
    matchAll: parseSnBool(row.match_all, false),
  };
}

/**
 * A criteria referenced by an m2m row whose user_criteria record could not be
 * read: treated as advanced (unevaluatable), so a deny reference still fails
 * closed instead of silently un-denying.
 */
function unreadableCriteria(sysId: string): SnUserCriteria {
  return {
    sysId,
    name: null,
    active: true,
    advanced: true,
    users: [],
    groups: [],
    roles: [],
    companies: [],
    departments: [],
    locations: [],
    matchAll: false,
  };
}

function instanceHost(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host.toLowerCase();
  } catch {
    return instanceUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function emptyAudience(): DocumentPermissions {
  return { isPublic: false, users: [], groups: [] };
}

function failedAudience(): SnAudience {
  return { permissions: emptyAudience(), failed: true };
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
