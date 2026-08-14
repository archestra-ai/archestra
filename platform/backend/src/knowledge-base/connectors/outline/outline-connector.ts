import * as metrics from "@/observability/metrics";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorItemFailure,
  ConnectorSyncBatch,
  DocumentPermissions,
  GroupMembershipYield,
  GroupMemberYield,
  OutlineCheckpoint,
  OutlineConfig,
  PermissionSnapshotYield,
  PermissionSyncParams,
  ResolveMappedEmail,
} from "@/types";
import { OutlineConfigSchema } from "@/types";
import { BaseConnector, extractErrorMessage } from "../base-connector";

const DEFAULT_BATCH_SIZE = 25;

type OutlineDocument = {
  id: string;
  title: string;
  text: string;
  urlId: string;
  collectionId: string | null;
  parentDocumentId: string | null;
  url?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
};

type OutlineListResponse = {
  ok: boolean;
  data: OutlineDocument[];
  pagination: {
    offset: number;
    limit: number;
    nextPath?: string;
  };
};

type OutlineAuthResponse = {
  ok: boolean;
  data?: {
    user?: { id: string; name: string };
    team?: { id: string; name: string };
  };
};

// Sentinel collectionId used when the user did not configure a collection
// filter. Lets us use the same resume-bookmark machinery for the full-workspace
// sweep without branching all over the place.
const ALL_COLLECTIONS_SENTINEL = "__all__";

function buildHeaders(credentials: ConnectorCredentials): HeadersInit {
  return {
    Authorization: `Bearer ${credentials.apiToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function parseOutlineConfig(
  config: Record<string, unknown>,
): OutlineConfig | null {
  const parsed = OutlineConfigSchema.safeParse({
    type: "outline",
    ...config,
  });
  return parsed.success ? parsed.data : null;
}

export class OutlineConnector extends BaseConnector {
  type = "outline" as const;
  supportsPermissionSync = true;

  // ----- Per-pass permission-sync state (armed by initPermissionPass) -----
  private permConfig: OutlineConfig | null = null;
  private permCredentials: ConnectorCredentials | null = null;
  /** Workspace identity from auth.info; scopes every synthetic group id. */
  private teamInfo: { id: string; name: string | null } | null = null;
  /**
   * Every workspace user by id, loaded once per pass. THE source of member
   * emails: Outline serializes `email` only when the endpoint asks for it
   * (`presentUser(user, { includeEmail, includeDetails })`), and only the
   * `users.*` endpoints do. The user objects nested in `groups.memberships`
   * and `collections.memberships` come from a bare `presentUser(user)`, so
   * they NEVER carry an email — no matter how privileged the API key is.
   */
  private userDirectory: Map<string, OutlineApiUser> | null = null;
  /** Published (public) share links, loaded once per pass. */
  private publicShares: PublicShares | null = null;
  private droppedPrincipals = 0;
  private mappedEmailResolver: ResolveMappedEmail | null = null;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseOutlineConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid Outline configuration" };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing Outline connection");

    const parsed = parseOutlineConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Outline configuration" };
    }

    try {
      const response = await this.fetchWithRetry(
        `${parsed.outlineUrl}/api/auth.info`,
        {
          method: "POST",
          headers: buildHeaders(params.credentials),
          body: JSON.stringify({}),
        },
      );

      const body = (await response.json()) as OutlineAuthResponse;

      if (!response.ok || !body.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: Authentication failed`,
        };
      }

      this.log.debug("Outline connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Outline connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseOutlineConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Outline configuration");
    }

    const checkpoint = (params.checkpoint as OutlineCheckpoint | null) ?? {
      type: "outline" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;

    // syncFrom anchors "what counts as new this run." It is the previous
    // successful run's syncStart (promoted to lastSyncedAt on completion).
    // Any document edited at or before this instant is skipped.
    const syncFrom = checkpoint.lastSyncedAt;

    // syncStart anchors "what counts as new *next* run." We persist it to the
    // checkpoint the moment the sweep begins; if a run is interrupted and
    // resumed, we reuse the persisted syncStart so the eventual lastSyncedAt
    // still covers edits that landed between the original start and any
    // resume. Only overwritten (to a fresh timestamp) on a fully fresh run.
    // The clamp guards against a clock regression (NTP skew, container host
    // change) that would otherwise let a promotion to lastSyncedAt slip below
    // the previous successful run's cutoff.
    const syncStartCandidate = checkpoint.syncStart ?? new Date().toISOString();
    const syncStart =
      checkpoint.lastSyncedAt && checkpoint.lastSyncedAt > syncStartCandidate
        ? checkpoint.lastSyncedAt
        : syncStartCandidate;

    const configuredCollectionIds =
      parsed.collectionIds && parsed.collectionIds.length > 0
        ? parsed.collectionIds
        : null;

    // Unify the collection-filter and no-filter paths: the no-filter sweep is
    // a single "virtual collection" identified by ALL_COLLECTIONS_SENTINEL.
    const sweepCollectionIds = configuredCollectionIds ?? [
      ALL_COLLECTIONS_SENTINEL,
    ];

    // Resume: if lastCollectionId is still in the configured list, pick up
    // from there. If the config changed and the bookmark is stale, restart
    // from the beginning — correct at the cost of re-scanning. We still reuse
    // the persisted syncStart so the sweep's sync window is preserved.
    let startIdx = 0;
    if (checkpoint.lastCollectionId) {
      const idx = sweepCollectionIds.indexOf(checkpoint.lastCollectionId);
      if (idx >= 0) startIdx = idx;
    }

    this.log.debug(
      {
        collectionIds: configuredCollectionIds,
        syncFrom,
        syncStart,
        batchSize,
        startIdx,
        resumeFromDocumentId: checkpoint.lastDocumentId,
      },
      "Starting Outline sync",
    );

    let yieldedAny = false;

    for (let i = startIdx; i < sweepCollectionIds.length; i++) {
      const collectionId = sweepCollectionIds[i];
      const isLastCollection = i === sweepCollectionIds.length - 1;

      // Only apply the document-level resume bookmark to the collection that
      // was actively being scanned when the previous run stopped.
      const resumeFromDocumentId =
        i === startIdx && collectionId === checkpoint.lastCollectionId
          ? checkpoint.lastDocumentId
          : undefined;

      for await (const batch of this.syncCollection({
        config: parsed,
        credentials: params.credentials,
        collectionId:
          collectionId === ALL_COLLECTIONS_SENTINEL ? undefined : collectionId,
        syncFrom,
        batchSize,
        resumeFromDocumentId,
      })) {
        yieldedAny = true;
        const isFinalSweepBatch = isLastCollection && !batch.hasMore;
        // The sweep's hasMore spans every collection, not just the current
        // one, so the runner does not treat an intermediate collection's last
        // page as "done."
        const sweepHasMore = batch.hasMore || !isLastCollection;

        yield {
          documents: batch.documents,
          failures: batch.failures,
          checkpoint: isFinalSweepBatch
            ? {
                type: "outline" as const,
                // Successful completion: promote syncStart to lastSyncedAt,
                // drop the transient resume fields so the next fresh run
                // picks up cleanly.
                lastSyncedAt: syncStart,
              }
            : {
                type: "outline" as const,
                syncStart,
                lastCollectionId: collectionId,
                lastDocumentId: batch.lastDocumentId,
                // Keep the previous successful lastSyncedAt. The sync runner
                // persists every yielded checkpoint; advancing lastSyncedAt
                // mid-sweep would let a follow-up run filter out edits that
                // landed in not-yet-visited collections.
                lastSyncedAt: checkpoint.lastSyncedAt,
              },
          hasMore: sweepHasMore,
        };
      }
    }

    // Covers two edge cases: startIdx past the end of the (possibly shrunk)
    // collection list, or a resuming sweep whose bookmarked collection is the
    // last one and the final batch already yielded. Either way, emit a
    // terminal batch so the runner can persist the completed checkpoint.
    if (!yieldedAny) {
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: {
          type: "outline" as const,
          lastSyncedAt: syncStart,
        },
        hasMore: false,
      };
    }
  }

  private async *syncCollection(params: {
    config: OutlineConfig;
    credentials: ConnectorCredentials;
    collectionId: string | undefined;
    syncFrom: string | undefined;
    batchSize: number;
    resumeFromDocumentId: string | undefined;
  }): AsyncGenerator<{
    documents: ConnectorDocument[];
    failures: ConnectorItemFailure[];
    hasMore: boolean;
    lastDocumentId: string | undefined;
  }> {
    const {
      config,
      credentials,
      collectionId,
      syncFrom,
      batchSize,
      resumeFromDocumentId,
    } = params;

    let offset = 0;
    let hasMore = true;
    // pastResumePoint is false while we walk past already-observed docs on
    // resume; it flips to true once we see the bookmark (or on the fallback
    // retry). When it is false we suppress yields, because those pages
    // represent re-scanning, not new progress.
    let pastResumePoint = !resumeFromDocumentId;
    // Allows exactly one retry if the bookmark doc was deleted between runs;
    // without this guard the skip phase would drain the collection silently
    // and drop any docs edited in the (prev-run → current-run) window.
    let bookmarkRetryDone = !resumeFromDocumentId;
    let lastDocumentId: string | undefined = resumeFromDocumentId;

    const syncFromDate = syncFrom ? new Date(syncFrom) : null;

    while (hasMore) {
      await this.rateLimit();

      // createdAt ASC gives stable iteration under concurrent writes:
      // Outline's document order by creation time is immutable, so offset
      // pagination does not shift already-visited positions when a doc is
      // edited mid-sweep. New docs created mid-sweep append to the tail and
      // are reached on later pages.
      const body: Record<string, unknown> = {
        limit: batchSize,
        offset,
        sort: "createdAt",
        direction: "ASC",
        statusFilter: ["published"],
      };
      if (collectionId) {
        body.collectionId = collectionId;
      }

      const response = await this.fetchWithRetry(
        `${config.outlineUrl}/api/documents.list`,
        {
          method: "POST",
          headers: buildHeaders(credentials),
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Outline API error ${response.status}: ${text.slice(0, 200)}`,
        );
      }

      const data = (await response.json()) as OutlineListResponse;

      if (!data.ok || !Array.isArray(data.data)) {
        throw new Error("Unexpected Outline API response format");
      }

      const rawDocs = data.data;
      const documents: ConnectorDocument[] = [];

      for (const doc of rawDocs) {
        // Resume skip: walk past the bookmark (and the bookmark doc itself),
        // then start processing. If we never find the bookmark on this
        // collection, the retry branch below resets state and re-scans
        // without the skip so no post-bookmark doc is silently dropped.
        if (!pastResumePoint) {
          if (doc.id === resumeFromDocumentId) {
            pastResumePoint = true;
          }
          continue;
        }

        // Advance the resume bookmark even if the doc is filtered out, so a
        // follow-up run does not need to re-scan already-inspected items.
        lastDocumentId = doc.id;

        // No server-side updatedAt filter is available, so filter client-side.
        // Docs whose updatedAt is at or before the last successful run's
        // syncStart were fully captured by that run and are skipped here.
        if (
          syncFromDate &&
          doc.updatedAt &&
          new Date(doc.updatedAt) <= syncFromDate
        ) {
          continue;
        }

        documents.push({
          id: doc.id,
          title: doc.title,
          content: doc.text
            ? `# ${doc.title}\n\n${doc.text}`
            : `# ${doc.title}`,
          sourceUrl: doc.url ?? buildDocumentUrl(config.outlineUrl, doc.urlId),
          metadata: {
            collectionId: doc.collectionId,
            parentDocumentId: doc.parentDocumentId,
            urlId: doc.urlId,
          },
          updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : undefined,
        });
      }

      const morePagesAvailable =
        rawDocs.length >= batchSize && !!data.pagination.nextPath;

      // Bookmark-missing retry: we drained the collection without ever seeing
      // resumeFromDocumentId, which means the bookmark was deleted from
      // Outline between runs. Restart the collection from offset=0 with the
      // skip disabled so docs that followed the bookmark are not dropped.
      // bookmarkRetryDone prevents a second retry if the collection remains
      // empty on the rescan.
      if (!pastResumePoint && !morePagesAvailable && !bookmarkRetryDone) {
        this.log.warn(
          { resumeFromDocumentId, collectionId },
          "Outline resume bookmark missing; re-scanning collection to avoid silently dropping post-bookmark documents",
        );
        bookmarkRetryDone = true;
        pastResumePoint = true;
        offset = 0;
        lastDocumentId = undefined;
        hasMore = true;
        continue;
      }

      offset += batchSize;
      hasMore = morePagesAvailable;

      // Skip-phase pages re-traverse already-observed docs and carry no new
      // progress; suppress the yield so the runner does not persist redundant
      // checkpoints.
      if (!pastResumePoint) {
        continue;
      }

      yield {
        documents,
        failures: this.flushFailures(),
        hasMore,
        lastDocumentId,
      };
    }
  }

  // ===== Permission sync =====

  /**
   * Container model: `collection:<collectionId>` per collection —
   * byte-matching the `metadata.collectionId` every ingested document
   * already carries, so existing corpora need no re-ingestion and
   * `scopeKeyForDocument` stays a pure metadata read.
   *
   * A collection's audience is its individual memberships (resolved to
   * emails through the per-pass user directory — a membership payload
   * never carries one), its group memberships (group
   * refs resolved at query time through the roster `syncGroups`
   * maintains), and — when the collection grants workspace-wide default
   * access (`permission` = read/read_write) — the synthetic
   * `workspace-default-<teamId>` group rostered from all active non-guest
   * members. The team id comes from auth.info and scopes every synthetic
   * group id: raw group tokens overlap across connectors of one type, so
   * a constant id would leak grants between two Outline workspaces.
   * Guests deliberately never ride the default group (Outline grants
   * guests nothing implicitly); they appear only via explicit
   * memberships.
   *
   * Published share links (shares.list) are the only public surface:
   * a published collection share marks the collection audience
   * `isPublic`; published document shares collect into one nested
   * `collection:<id>/public` container per collection (child documents
   * included when the share says so, closed over the ingested corpus's
   * `parentDocumentId` chains — no per-document API calls). A failed
   * share enumeration degrades to "no public shares": public access is
   * purely additive, so missing it can only under-grant.
   *
   * Everything else fails closed: any error while resolving a
   * collection's audience empties that audience (never a partial grant),
   * and a missing workspace id fails the whole pass rather than minting
   * collision-prone group ids.
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseOutlineConfig(params.config);
    if (!config) {
      throw new Error("Invalid Outline configuration for permission sync");
    }
    this.initPermissionPass(config, params.credentials);
    this.mappedEmailResolver = params.resolveMappedEmail ?? null;
    await this.resolveTeam();
    await this.loadUserDirectory();
    await this.loadPublicShares();

    const containers = (await this.listCollectionCandidateIds(config)).map(
      (collectionId) => ({
        collectionId,
        key: containerKeyForCollection(collectionId),
      }),
    );
    const scope = params.scope ? new Set(params.scope.containerKeys) : null;

    for (const container of containers) {
      if (scope && !scope.has(container.key)) continue;
      // Resume: containers strictly before the cursor are done; the cursor
      // container is re-processed (idempotent — same audiences).
      if (params.cursor && container.key < params.cursor) continue;
      yield* this.syncCollectionSnapshot(
        container.collectionId,
        container.key,
        params,
      );
    }

    this.reportDroppedPrincipals();
  }

  /**
   * Group roster sync (Users/Groups tabs + member overrides). Yields every
   * workspace group (groups.list expanded via groups.memberships), the
   * synthetic workspace-default group (active non-guest members — the
   * audience of collections with workspace-wide default access), and the
   * synthetic direct-grants roster (every user holding an individual
   * collection membership, so a member whose email is hidden stays visible
   * and override-assignable). Every roster's members are resolved through
   * the per-pass user directory, the only place Outline serializes emails.
   * Group and user enumeration failures THROW —
   * aborting the phase and keeping the previous rosters — rather than
   * yielding truncated members: the pass replaces a yielded group's roster
   * wholesale, so a partial yield would silently revoke the tail. Only the
   * per-collection direct-grants reads degrade to a skip: that roster is
   * visibility-only and never referenced by an audience.
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseOutlineConfig(params.config);
    if (!config) {
      throw new Error("Invalid Outline configuration for group sync");
    }
    this.initPermissionPass(config, params.credentials);
    const team = await this.resolveTeam();
    await this.loadUserDirectory();

    const groups: OutlineGroup[] = [];
    for await (const page of this.paginatePermissionApi<OutlineGroup>({
      method: "groups.list",
      extract: (data) => (data as { groups?: OutlineGroup[] }).groups,
    })) {
      groups.push(...page);
    }
    groups.sort((a, b) => a.id.localeCompare(b.id));
    for (const group of groups) {
      const members: GroupMemberYield[] = [];
      for await (const page of this.paginatePermissionApi<OutlineApiUser>({
        method: "groups.memberships",
        body: { id: group.id },
        extract: (data) => (data as { users?: OutlineApiUser[] }).users,
      })) {
        for (const membershipUser of page) {
          const user = this.directoryUser(membershipUser);
          if (user.isSuspended) continue;
          members.push(memberYieldFromUser(user));
        }
      }
      yield {
        groupId: group.id,
        name: group.name ?? null,
        members: sortMembers(members),
      };
    }

    const defaults: GroupMemberYield[] = [];
    for await (const page of this.paginatePermissionApi<OutlineApiUser>({
      method: "users.list",
      body: { filter: "active" },
      extract: (data) => data as OutlineApiUser[],
    })) {
      for (const user of page) {
        // Guests get no workspace-default access in Outline — only explicit
        // collection/group membership, which the audience path carries.
        if (user.role === "guest") continue;
        defaults.push(memberYieldFromUser(user));
      }
    }
    yield {
      groupId: workspaceDefaultGroupId(team.id),
      name: team.name
        ? `${team.name} default access`
        : "Workspace default access",
      members: sortMembers(defaults),
    };

    const direct = new Map<string, GroupMemberYield>();
    for (const collectionId of await this.listCollectionCandidateIds(config)) {
      try {
        for await (const page of this.paginatePermissionApi<OutlineApiUser>({
          method: "collections.memberships",
          body: { id: collectionId },
          extract: (data) => (data as { users?: OutlineApiUser[] }).users,
        })) {
          for (const membershipUser of page) {
            const user = this.directoryUser(membershipUser);
            if (user.isSuspended) continue;
            direct.set(user.id, memberYieldFromUser(user));
          }
        }
      } catch (error) {
        this.log.warn(
          { collectionId, error: extractErrorMessage(error) },
          "Could not read a collection's memberships for the direct-grants roster; its members are skipped this pass",
        );
      }
    }
    if (direct.size > 0) {
      yield {
        groupId: DIRECT_GRANTS_GROUP_ID,
        members: sortMembers([...direct.values()]),
      };
    }
  }

  /** `metadata.collectionId` → top-level container key (scoping only). */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const collectionId = metadata.collectionId;
    return typeof collectionId === "string" && collectionId
      ? containerKeyForCollection(collectionId)
      : null;
  }

  // ===== Permission-sync internals =====

  /** Arm (or re-arm) the per-pass state every permission hook shares. */
  private initPermissionPass(
    config: OutlineConfig,
    credentials: ConnectorCredentials,
  ): void {
    this.permConfig = config;
    this.permCredentials = credentials;
    this.teamInfo = null;
    this.userDirectory = null;
    this.publicShares = null;
    this.droppedPrincipals = 0;
    this.mappedEmailResolver = null;
  }

  /**
   * Every workspace user by id — guests, suspended, and not-yet-accepted
   * invitees included, because any of them can hold an explicit grant whose
   * email must still resolve. Loaded once per pass; a failure throws so the
   * caller fail-closes rather than silently resolving nobody.
   */
  private async loadUserDirectory(): Promise<Map<string, OutlineApiUser>> {
    if (this.userDirectory) return this.userDirectory;
    const directory = new Map<string, OutlineApiUser>();
    for await (const page of this.paginatePermissionApi<OutlineApiUser>({
      method: "users.list",
      body: { filter: "all" },
      extract: (data) => data as OutlineApiUser[],
    })) {
      for (const user of page) directory.set(user.id, user);
    }
    this.userDirectory = directory;
    return directory;
  }

  /**
   * A membership entry's authoritative record: the directory copy when the
   * pass could see it, else the (email-less) payload Outline nested in the
   * membership response.
   */
  private directoryUser(user: OutlineApiUser): OutlineApiUser {
    return this.userDirectory?.get(user.id) ?? user;
  }

  private async *syncCollectionSnapshot(
    collectionId: string,
    containerKey: string,
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const docs: ReadbackDoc[] = [];
    let afterId: string | null = null;
    for (;;) {
      const { documents, nextAfterId } = await params.readIngestedDocuments({
        metadataFilter: { collectionId },
        afterId,
        limit: PERMISSION_READBACK_PAGE_SIZE,
      });
      for (const doc of documents) {
        const parent = doc.metadata?.parentDocumentId;
        docs.push({
          sourceId: doc.sourceId,
          parentDocumentId:
            typeof parent === "string" && parent ? parent : null,
        });
      }
      if (documents.length < PERMISSION_READBACK_PAGE_SIZE) break;
      afterId = nextAfterId;
    }
    docs.sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));

    if (docs.length === 0) {
      // Empty corpus: emit the fail-closed boundary container WITHOUT
      // resolving its audience (Jira precedent — not a resolution failure).
      yield {
        kind: "container",
        containerKey,
        permissions: emptyAudience(),
        audienceResolutionFailed: false,
        cursor: containerKey,
      };
      return;
    }

    const audience = await this.resolveCollectionAudience(collectionId);
    yield {
      kind: "container",
      containerKey,
      permissions: audience.permissions,
      audienceResolutionFailed: audience.resolutionFailed,
      cursor: containerKey,
    };

    // Published document shares are independently verified truth from
    // shares.list, so they stay applied even when the collection audience
    // fail-closed above.
    const publicDocIds = collectPublicDocIds(docs, this.publicShares);
    const publicKey = `${containerKey}/public`;
    if (publicDocIds.size > 0) {
      yield {
        kind: "container",
        containerKey: publicKey,
        permissions: { isPublic: true, users: [], groups: [] },
        audienceResolutionFailed: false,
        cursor: containerKey,
      };
    }

    for (const doc of docs) {
      yield {
        kind: "document",
        sourceId: doc.sourceId,
        containerKey: publicDocIds.has(doc.sourceId) ? publicKey : containerKey,
        cursor: containerKey,
      };
    }
  }

  /**
   * A collection's full audience, or the empty fail-closed audience when
   * any part of it could not be read — never a partial grant.
   */
  private async resolveCollectionAudience(collectionId: string): Promise<{
    permissions: DocumentPermissions;
    resolutionFailed: boolean;
  }> {
    try {
      const collection = await this.fetchCollectionInfo(collectionId);
      const users = new Set<string>();
      const groups = new Set<string>();

      for await (const page of this.paginatePermissionApi<OutlineApiUser>({
        method: "collections.memberships",
        body: { id: collectionId },
        extract: (data) => (data as { users?: OutlineApiUser[] }).users,
      })) {
        for (const membershipUser of page) {
          // The membership payload carries no email (see userDirectory) —
          // the directory record does.
          const user = this.directoryUser(membershipUser);
          if (user.isSuspended) continue;
          const email = user.email?.trim().toLowerCase();
          if (email) {
            users.add(email);
            continue;
          }
          const mapped = this.mappedEmailResolver?.(user.id);
          if (mapped) {
            users.add(mapped.trim().toLowerCase());
          } else {
            this.droppedPrincipals += 1;
          }
        }
      }

      for await (const page of this.paginatePermissionApi<OutlineGroup>({
        method: "collections.group_memberships",
        body: { id: collectionId },
        extract: (data) => (data as { groups?: OutlineGroup[] }).groups,
      })) {
        for (const group of page) groups.add(group.id);
      }

      if (
        collection.permission === "read" ||
        collection.permission === "read_write"
      ) {
        groups.add(workspaceDefaultGroupId(this.requireTeam().id));
      }

      return {
        permissions: {
          isPublic: this.publicShares?.collectionIds.has(collectionId) ?? false,
          users: [...users].sort(),
          groups: [...groups].sort(),
        },
        resolutionFailed: false,
      };
    } catch (error) {
      this.log.error(
        { collectionId, error: extractErrorMessage(error) },
        "Could not resolve an Outline collection's audience; its documents are fail-closed for this pass",
      );
      return { permissions: emptyAudience(), resolutionFailed: true };
    }
  }

  private async fetchCollectionInfo(
    collectionId: string,
  ): Promise<OutlineCollection> {
    const { config, credentials } = this.requirePass();
    await this.rateLimit();
    const response = await this.fetchWithRetry(
      `${config.outlineUrl}/api/collections.info`,
      {
        method: "POST",
        headers: buildHeaders(credentials),
        body: JSON.stringify({ id: collectionId }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Outline API error ${response.status} on collections.info: ${text.slice(0, 200)}`,
      );
    }
    const body = (await response.json()) as {
      ok: boolean;
      data?: OutlineCollection;
    };
    if (!body.ok || !body.data?.id) {
      throw new Error("Unexpected Outline API response on collections.info");
    }
    return body.data;
  }

  /**
   * The workspace identity every synthetic group id embeds. Missing means
   * the pass cannot mint collision-safe ids, so it throws (previous
   * snapshot retained) instead of degrading.
   */
  private async resolveTeam(): Promise<{ id: string; name: string | null }> {
    if (this.teamInfo) return this.teamInfo;
    const { config, credentials } = this.requirePass();
    await this.rateLimit();
    const response = await this.fetchWithRetry(
      `${config.outlineUrl}/api/auth.info`,
      {
        method: "POST",
        headers: buildHeaders(credentials),
        body: JSON.stringify({}),
      },
    );
    if (!response.ok) {
      throw new Error(`Outline API error ${response.status} on auth.info`);
    }
    const body = (await response.json()) as OutlineAuthResponse;
    const team = body.ok ? body.data?.team : undefined;
    if (!team?.id) {
      throw new Error(
        "Outline auth.info returned no workspace id; refusing to mint workspace-scoped group ids",
      );
    }
    this.teamInfo = { id: team.id, name: team.name ?? null };
    return this.teamInfo;
  }

  private requireTeam(): { id: string; name: string | null } {
    if (!this.teamInfo) {
      throw new Error("Outline permission pass not initialized (team)");
    }
    return this.teamInfo;
  }

  /**
   * Published share links, loaded once per pass. Public access is purely
   * additive, so a failed read degrades to "no public shares" (under-grant)
   * instead of failing the pass.
   */
  private async loadPublicShares(): Promise<void> {
    const collectionIds = new Set<string>();
    const documentShares: PublicShares["documentShares"] = [];
    try {
      for await (const page of this.paginatePermissionApi<OutlineShare>({
        method: "shares.list",
        extract: (data) => data as OutlineShare[],
      })) {
        for (const share of page) {
          if (!share.published) continue;
          if (share.collectionId) {
            collectionIds.add(share.collectionId);
          } else if (share.documentId) {
            documentShares.push({
              documentId: share.documentId,
              includeChildDocuments: share.includeChildDocuments ?? false,
            });
          }
        }
      }
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Could not enumerate Outline share links; publicly shared documents keep only their collection audience this pass",
      );
      collectionIds.clear();
      documentShares.length = 0;
    }
    this.publicShares = { collectionIds, documentShares };
  }

  /**
   * The container candidates: the configured collection filter, or every
   * collection the credential can see. Sorted so container keys ascend
   * (the monotonic-cursor contract). Documents whose collection fell out
   * of this set are fail-closed by the pass's unassigned sweep.
   */
  private async listCollectionCandidateIds(
    config: OutlineConfig,
  ): Promise<string[]> {
    if (config.collectionIds && config.collectionIds.length > 0) {
      return [...new Set(config.collectionIds)].sort();
    }
    const ids = new Set<string>();
    for await (const page of this.paginatePermissionApi<OutlineCollection>({
      method: "collections.list",
      extract: (data) => data as OutlineCollection[],
    })) {
      for (const collection of page) ids.add(collection.id);
    }
    return [...ids].sort();
  }

  /**
   * Drain an offset-paginated Outline RPC endpoint. `extract` picks the
   * page's primary item array out of the response's `data` (some endpoints
   * wrap it: `{ users, memberships }`). Throws on any non-OK response —
   * callers own fail-close/degrade semantics.
   */
  private async *paginatePermissionApi<T>(params: {
    method: string;
    body?: Record<string, unknown>;
    extract: (data: unknown) => T[] | undefined;
  }): AsyncGenerator<T[]> {
    const { config, credentials } = this.requirePass();
    let offset = 0;
    for (;;) {
      await this.rateLimit();
      const response = await this.fetchWithRetry(
        `${config.outlineUrl}/api/${params.method}`,
        {
          method: "POST",
          headers: buildHeaders(credentials),
          body: JSON.stringify({
            ...params.body,
            limit: PERMISSION_PAGE_SIZE,
            offset,
          }),
        },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Outline API error ${response.status} on ${params.method}: ${text.slice(0, 200)}`,
        );
      }
      const envelope = (await response.json()) as {
        ok: boolean;
        data?: unknown;
        pagination?: { nextPath?: string };
      };
      if (!envelope.ok) {
        throw new Error(
          `Unexpected Outline API response format on ${params.method}`,
        );
      }
      const items = params.extract(envelope.data);
      if (!Array.isArray(items)) {
        throw new Error(
          `Unexpected Outline API response format on ${params.method}`,
        );
      }
      yield items;
      if (
        items.length < PERMISSION_PAGE_SIZE ||
        !envelope.pagination?.nextPath
      ) {
        break;
      }
      offset += PERMISSION_PAGE_SIZE;
    }
  }

  private requirePass(): {
    config: OutlineConfig;
    credentials: ConnectorCredentials;
  } {
    if (!this.permConfig || !this.permCredentials) {
      throw new Error("Outline permission pass not initialized");
    }
    return { config: this.permConfig, credentials: this.permCredentials };
  }

  /** Surface principals dropped this pass (fail-closed under-grant). */
  private reportDroppedPrincipals(): void {
    if (this.droppedPrincipals <= 0) return;
    const count = this.droppedPrincipals;
    this.droppedPrincipals = 0;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped Outline principals that could not be resolved (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }
}

function buildDocumentUrl(baseUrl: string, urlId: string): string {
  return `${baseUrl}/doc/${urlId}`;
}

// ===== Permission-sync types & helpers =====

const PERMISSION_PAGE_SIZE = 100;
const PERMISSION_READBACK_PAGE_SIZE = 1000;
/**
 * Synthetic roster group for individual collection grantees. Roster-only —
 * never referenced by an audience (direct grants carry emails inline), so
 * the constant id cannot collide grants across connectors.
 */
const DIRECT_GRANTS_GROUP_ID = "direct-grants";

type OutlineCollection = {
  id: string;
  name?: string;
  permission?: "read" | "read_write" | null;
};

type OutlineApiUser = {
  id: string;
  name?: string;
  email?: string | null;
  role?: string;
  isSuspended?: boolean;
};

type OutlineGroup = { id: string; name?: string };

type OutlineShare = {
  documentId?: string | null;
  collectionId?: string | null;
  published?: boolean;
  includeChildDocuments?: boolean;
};

type PublicShares = {
  collectionIds: Set<string>;
  documentShares: Array<{
    documentId: string;
    includeChildDocuments: boolean;
  }>;
};

/** One read-back document (id + the parent chain the public closure walks). */
type ReadbackDoc = { sourceId: string; parentDocumentId: string | null };

function containerKeyForCollection(collectionId: string): string {
  return `collection:${collectionId}`;
}

/**
 * Audience-referenced synthetic group id — MUST be workspace-scoped: raw
 * group tokens overlap across connectors of one type, so a constant id
 * would share grants between two Outline workspaces.
 */
function workspaceDefaultGroupId(teamId: string): string {
  return `workspace-default-${teamId}`;
}

function emptyAudience(): DocumentPermissions {
  return { isPublic: false, users: [], groups: [] };
}

function memberYieldFromUser(user: OutlineApiUser): GroupMemberYield {
  return {
    accountId: user.id,
    displayName: user.name ?? null,
    email: user.email ? user.email.trim().toLowerCase() : null,
    accountType: user.role ?? null,
  };
}

function sortMembers(members: GroupMemberYield[]): GroupMemberYield[] {
  return members.sort((a, b) => a.accountId.localeCompare(b.accountId));
}

/**
 * The ingested documents covered by a published document share: the shared
 * document itself plus — when the share includes child documents — every
 * ingested descendant, closed over the corpus's own `parentDocumentId`
 * chains (the share root itself need not be ingested).
 */
function collectPublicDocIds(
  docs: ReadbackDoc[],
  shares: PublicShares | null,
): Set<string> {
  const result = new Set<string>();
  if (!shares || shares.documentShares.length === 0) return result;

  const inCollection = new Set(docs.map((doc) => doc.sourceId));
  const childrenByParent = new Map<string, string[]>();
  for (const doc of docs) {
    if (!doc.parentDocumentId) continue;
    const siblings = childrenByParent.get(doc.parentDocumentId);
    if (siblings) siblings.push(doc.sourceId);
    else childrenByParent.set(doc.parentDocumentId, [doc.sourceId]);
  }

  for (const share of shares.documentShares) {
    if (inCollection.has(share.documentId)) result.add(share.documentId);
    if (!share.includeChildDocuments) continue;
    const queue = [share.documentId];
    while (queue.length > 0) {
      const parentId = queue.pop();
      if (!parentId) break;
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (!result.has(childId)) {
          result.add(childId);
          queue.push(childId);
        }
      }
    }
  }
  return result;
}
