import * as cheerio from "cheerio";
import { ConfluenceClient } from "confluence.js";
import type pino from "pino";
import { LRUCacheManager } from "@/cache-manager";
import type {
  ConfluenceCheckpoint,
  ConfluenceConfig,
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DocumentPermissions,
  GroupMembershipYield,
  GroupMemberYield,
  PermissionProbeResult,
  PermissionSnapshotYield,
  PermissionSyncParams,
  PermissionSyncState,
  ResolveMappedEmail,
} from "@/types";

/** Read restriction subjects for one Confluence content id. */
type ConfluenceRestriction = {
  // biome-ignore lint/suspicious/noExplicitAny: SDK subject shape
  users: any[];
  // biome-ignore lint/suspicious/noExplicitAny: SDK subject shape
  groups: any[];
};

import * as metrics from "@/observability/metrics";
import { ConfluenceConfigSchema } from "@/types";
import { AtlassianAdminEmailResolver } from "../atlassian-admin-email-resolver";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
  isoCursorWithSkewBuffer,
  trailingAuditCursor,
} from "../base-connector";
import { ConnectorIdentityCache } from "../identity-cache";

const DEFAULT_BATCH_SIZE = 50;

/**
 * Expansions for the permission pass's per-space CQL search: each page's own
 * read restrictions ride along INLINE with the search results (one upstream
 * request per result page instead of one per document) plus the ancestor chain
 * for local inheritance resolution. Verified supported on Cloud v1; servers
 * that ignore the restriction expands (older DC) are detected per result and
 * fall back to the per-content restriction endpoint.
 */
const PERMISSION_SEARCH_EXPANDS = [
  "ancestors",
  "restrictions.read.restrictions.user",
  "restrictions.read.restrictions.group",
];

/** One corpus page buffered during a space's enumeration phase. */
type SpacePageEntry = { id: string; ancestorIds: string[] };

/** A container audience the connector resolved, and whether it could read it at all. */
type ResolvedAudience = {
  permissions: DocumentPermissions;
  resolutionFailed: boolean;
};

/**
 * Why a page's read restrictions had to come from a per-content API call rather
 * than the search's inline expansion.
 * - `truncated` — the embedded subject list is one page with no cursor, and the
 *   page has more principals than fit.
 * - `expand_unsupported` — the server ignored or rejected the expand (older DC).
 * - `ancestor_outside_corpus` — an ancestor the corpus filter never enumerated,
 *   so its restriction was never inlined anywhere.
 */
type RestrictionFallbackReason =
  | "truncated"
  | "expand_unsupported"
  | "ancestor_outside_corpus";

/**
 * Built-in Confluence groups that mean "any logged-in user" (Cloud:
 * `confluence-users` / `_licensed-confluence`; Server/DC: `users`). A read grant
 * to one of these is not a normal named group — it is "every authenticated
 * user" — so it is mapped to the synthetic all-members group below.
 */
const CONFLUENCE_ALL_LOGGED_IN_GROUP_NAMES = new Set([
  "confluence-users",
  "_licensed-confluence",
  "users",
]);

/**
 * Stable synthetic group id modelling the "any logged-in user" audience. Its
 * membership (emitted by `syncGroups`) is the union of every resolvable member
 * across the instance's real groups, so a page/space readable by all
 * authenticated users resolves to those members without depending on a built-in
 * group being separately enumerable. Namespaced by the connector type into
 * `group:confluence_confluence-any-logged-in-user` like any other group token.
 */
const CONFLUENCE_ANY_LOGGED_IN_USER_GROUP_ID = "confluence-any-logged-in-user";

// Caps for the per-pass audience-resolution caches: sized so a normal site
// never evicts (restrictions are per page + ancestor, the others per space /
// distinct principal).
const RESTRICTION_CACHE_MAX_SIZE = 20_000;
const SPACE_AUDIENCE_CACHE_MAX_SIZE = 2_000;
const ACCOUNT_EMAIL_CACHE_MAX_SIZE = 10_000;

export class ConfluenceConnector extends BaseConnector {
  type = "confluence" as const;
  supportsPermissionSync = true;

  // Per-pass caches so audience resolution is O(containers), not O(pages):
  // space audiences, content read-restrictions (pages + ancestors), and
  // account → email lookups are each resolved once. Size-bounded LRU (no TTL —
  // instances are per-pass) so a pathologically large site cannot grow them
  // without limit; eviction only costs a re-fetch.
  private spaceAudienceCache = new LRUCacheManager<ResolvedAudience>({
    maxSize: SPACE_AUDIENCE_CACHE_MAX_SIZE,
    defaultTtl: 0,
  });
  private restrictionCache = new LRUCacheManager<ConfluenceRestriction | null>({
    maxSize: RESTRICTION_CACHE_MAX_SIZE,
    defaultTtl: 0,
  });
  private accountEmailCache = new LRUCacheManager<string | null>({
    maxSize: ACCOUNT_EMAIL_CACHE_MAX_SIZE,
    defaultTtl: 0,
  });
  /**
   * Cloud-only fallback for emails the product API hides (set per permission
   * pass): the Atlassian admin APIs, reachable when the connector credential is
   * an org-admin API key. Null on Server/DC and outside permission passes.
   */
  private adminEmailResolver: AtlassianAdminEmailResolver | null = null;
  /**
   * Admin member-mapping lookup injected by the pass (see ResolveMappedEmail).
   * Consulted FIRST in principal-email resolution. Armed per permission pass.
   */
  private resolveMappedEmail: ResolveMappedEmail | null = null;
  /**
   * Set when the server hard-rejects the restriction expands (older DC): the
   * pass retries the failed search page without them once, then keeps them off
   * — every page's restriction is fetched via the per-content endpoint instead
   * (the pre-inline behavior).
   */
  private inlineRestrictionsUnsupported = false;
  /**
   * Cross-pass persistence behind `accountEmailCache`: account → email results
   * (including hidden-email negatives) survive the pass so the next run does
   * not re-probe every distinct principal. Armed per permission pass.
   */
  private persistentEmailCache: ConnectorIdentityCache<string | null> | null =
    null;
  /**
   * Per-space tally of pages whose restrictions could NOT be taken from the
   * inline search expansion, by reason. Inline expansion is the whole reason a
   * pass costs one request per RESULT PAGE instead of one per document, so a
   * space quietly falling back to per-page lookups is a request storm that has
   * to be visible — it is the difference between ~1 and ~200 requests for the
   * same 200 pages.
   */
  private restrictionFallbacks = new Map<RestrictionFallbackReason, number>();

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseConfluenceConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid Confluence configuration: confluenceUrl (string) and isCloud (boolean) are required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.confluenceUrl)) {
      return {
        valid: false,
        error: "confluenceUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Confluence configuration" };
    }

    this.log.debug(
      { baseUrl: parsed.confluenceUrl, isCloud: parsed.isCloud },
      "Testing connection",
    );

    try {
      const client = createConfluenceClient(
        parsed,
        params.credentials,
        this.log,
      );
      await client.space.getSpaces({ limit: 1 });
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
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as ConfluenceCheckpoint | null) ?? {
        type: "confluence" as const,
      };
      const cql = buildCql(parsed, checkpoint);

      this.log.debug({ cql }, "Estimating total items");

      const client = createConfluenceClient(
        parsed,
        params.credentials,
        this.log,
      );

      const result = await client.content.searchContentByCQL({
        cql,
        limit: 1,
      });

      // Server/DC returns totalSize in the response; Cloud does not.
      // biome-ignore lint/suspicious/noExplicitAny: SDK type missing totalSize field
      const rawResult = result as any;
      const totalSize = rawResult.totalSize as number | undefined;

      this.log.debug(
        { totalSize, size: rawResult.size, start: rawResult.start },
        "Estimate response",
      );

      return totalSize ?? null;
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
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Confluence configuration");
    }

    const checkpoint = (params.checkpoint as ConfluenceCheckpoint | null) ?? {
      type: "confluence" as const,
    };
    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const cql = buildCql(parsed, checkpoint, params.startTime);
    const client = createConfluenceClient(parsed, params.credentials, this.log);

    this.log.debug(
      {
        baseUrl: parsed.confluenceUrl,
        isCloud: parsed.isCloud,
        spaceKeys: parsed.spaceKeys,
        cql,
        checkpoint,
      },
      "Starting sync",
    );

    let cursor: string | undefined;
    let start = 0;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug({ batchIndex, cursor, start }, "Fetching batch");

        // biome-ignore lint/suspicious/noExplicitAny: SDK response type
        let searchResult: any;

        if (parsed.isCloud) {
          // Cloud: cursor-based pagination via SDK
          searchResult = await client.content.searchContentByCQL({
            cql,
            cursor,
            limit: batchSize,
            expand: ["body.storage", "version", "space", "metadata.labels"],
          });
        } else {
          // Server/DC: offset-based pagination — the SDK's searchContentByCQL
          // doesn't accept a 'start' param, so use sendRequest directly.
          searchResult = await client.sendRequest(
            {
              url: "/api/content/search",
              method: "GET",
              params: {
                cql,
                start,
                limit: batchSize,
                expand: ["body.storage", "version", "space", "metadata.labels"],
              },
            },
            // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
            undefined as any,
          );
        }

        const results = searchResult.results ?? [];
        const documents: ConnectorDocument[] = [];

        for (const page of results) {
          if (shouldSkipPage(page, parsed.labelsToSkip)) {
            continue;
          }

          documents.push(
            pageToDocument(page, parsed.confluenceUrl, parsed.isCloud),
          );
        }

        const nextUrl: string | undefined = searchResult._links?.next;

        if (parsed.isCloud) {
          // Cloud: extract cursor from _links.next
          if (nextUrl) {
            const cursorMatch = nextUrl.match(/cursor=([^&]+)/);
            cursor = cursorMatch
              ? decodeURIComponent(cursorMatch[1])
              : undefined;
          } else {
            cursor = undefined;
          }
          hasMore = results.length >= batchSize && !!cursor;
        } else {
          // Server/DC: increment offset by actual results count.
          // Confluence may return fewer results than requested due to server
          // limits, so we rely on _links.next presence rather than count.
          start += results.length;
          hasMore = results.length > 0 && !!nextUrl;
        }

        const lastPage = results[results.length - 1];
        const rawModifiedAt: string | undefined = lastPage?.version?.when;

        this.log.debug(
          {
            batchIndex,
            pageCount: results.length,
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
            type: "confluence",
            itemUpdatedAt: rawModifiedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: {
              lastPageId: lastPage?.id ?? checkpoint.lastPageId,
              lastRawModifiedAt: rawModifiedAt ?? checkpoint.lastRawModifiedAt,
            },
          }),
          hasMore,
        };
      } catch (error) {
        this.log.error(
          { batchIndex, error: extractErrorMessage(error) },
          "Batch fetch failed",
        );
        throw error;
      }
    }
  }

  // ===== Permission sync hooks =====

  /**
   * Space-scoped snapshot with page read-restrictions expanded INLINE in the
   * CQL search — one upstream request per result page instead of one per
   * document. Each space is one top-level container `space:<KEY>` holding the
   * space's read audience; a page governed by a read restriction (its own, or
   * the closest restricted ancestor's) lands in a nested
   * `space:<KEY>/page:<restrictedPageId>` container holding that restriction's
   * audience. Each space runs in two phases: enumerate and buffer (page ids,
   * ancestor chains, own restrictions — a restricted ancestor may be
   * enumerated after its descendants), then resolve every page's container
   * locally. The per-content restriction endpoint survives only as a fallback
   * (truncated inline lists, ancestors outside the corpus filter, servers
   * ignoring the expand). `cursor` is the space container key: spaces strictly
   * before it are done; the cursor space is re-processed (idempotent).
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseConfluenceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Confluence configuration for permission sync");
    }
    const client = createConfluenceClient(config, params.credentials, this.log);
    this.initAdminEmailResolver(
      config,
      params.credentials,
      params.refreshIdentities,
    );
    this.resolveMappedEmail = params.resolveMappedEmail ?? null;

    const scope = params.scope ? new Set(params.scope.containerKeys) : null;
    const spaceKeys = await this.listCorpusSpaceKeys(client, config);
    for (const spaceKey of spaceKeys) {
      if (scope && !scope.has(`space:${spaceKey}`)) continue;
      if (params.cursor && `space:${spaceKey}` < params.cursor) continue;
      yield* this.syncSpaceSnapshot(client, config, spaceKey);
    }
  }

  /**
   * Delta-pass change probe (a handful of requests, never a corpus scan):
   * - A `lastModified` CQL window catches content drift (new/edited pages
   *   needing container adoption), mapped to space containers.
   * - The audit window (`/api/audit`, admin credential, Cloud + DC) exists
   *   ONLY to catch restriction drift: a restriction edit moves pages between
   *   containers (an ASSIGNMENT change) without bumping lastmodified, so it
   *   promotes to a full reconcile. Audiences and group memberships are NOT
   *   inferred from audit events — every delta pass re-verifies them directly
   *   (see PermissionProbeResult). Where the audit API is unavailable (403,
   *   Free plan), restriction drift is bounded by the periodic full
   *   reconcile instead.
   */
  async probePermissionChanges(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    state: PermissionSyncState | null;
  }): Promise<PermissionProbeResult> {
    const config = parseConfluenceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Confluence configuration for permission probe");
    }
    const client = createConfluenceClient(config, params.credentials, this.log);

    const now = new Date().toISOString();
    // The content cursor sits at wall-clock (CQL search is index-backed,
    // near-realtime); the audit cursor trails it — see trailingAuditCursor.
    const nextState: PermissionSyncState = {
      contentCursor: now,
      auditCursor: trailingAuditCursor(now),
    };
    const contentCursor =
      typeof params.state?.contentCursor === "string"
        ? params.state.contentCursor
        : null;
    if (!contentCursor) {
      // First probe: no cursors yet — the full pass establishes them.
      return { dirtyContainerKeys: [], fullRequired: true, nextState };
    }

    let fullRequired = false;
    const auditCursor =
      typeof params.state?.auditCursor === "string"
        ? params.state.auditCursor
        : contentCursor;
    try {
      await this.rateLimit();
      // biome-ignore lint/suspicious/noExplicitAny: SDK response type
      const response: any = await client.sendRequest(
        {
          url: "/api/audit",
          method: "GET",
          // The cursor is rewound a few minutes so clock skew against the
          // upstream cannot hide events stamped just before it was taken.
          params: {
            startDate: isoCursorWithSkewBuffer(auditCursor),
            limit: 1000,
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
        undefined as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: audit record shape
      const records: any[] = response?.results ?? [];
      // Event-type strings only (summary/category/created) — enough to
      // explain a full-reconcile promotion without logging object names.
      this.log.debug(
        {
          recordsFetched: records.length,
          sample: records.slice(0, 10).map((r) => ({
            created: r?.creationDate,
            category: r?.category,
            summary: r?.summary,
          })),
        },
        "Confluence audit window fetched",
      );
      const matched: Record<string, unknown>[] = [];
      for (const record of records) {
        const text =
          `${record?.summary ?? ""} ${record?.category ?? ""}`.toLowerCase();
        // ONLY restriction drift matters here: a restriction edit moves pages
        // between containers (a page becomes/stops being its own container) —
        // an ASSIGNMENT change invisible to the lastmodified window, so it
        // demands the full reconcile. Audience/membership drift is verified
        // directly by every delta pass, never matched from audit wording.
        if (text.includes("restriction")) {
          fullRequired = true;
          if (matched.length < 5) {
            matched.push({
              created: record?.creationDate,
              category: record?.category,
              summary: record?.summary,
            });
          }
        }
      }
      if (matched.length > 0) {
        this.log.info(
          { matchedAuditRecords: matched },
          "Confluence audit records flag restriction drift since the last probe; promoting to a full reconcile",
        );
      }
    } catch (error) {
      this.log.debug(
        { error: extractErrorMessage(error) },
        "Confluence audit log unavailable; restriction drift is bounded by the periodic full reconcile",
      );
    }

    // Content drift since the cursor → the spaces needing adoption passes.
    const dirtySpaces = new Set<string>();
    const cql = buildCql(config, {
      type: "confluence",
      lastSyncedAt: contentCursor,
    });
    let cursor: string | undefined;
    let start = 0;
    let hasMore = true;
    while (hasMore) {
      await this.rateLimit();
      // biome-ignore lint/suspicious/noExplicitAny: SDK response type
      let searchResult: any;
      if (config.isCloud) {
        searchResult = await client.content.searchContentByCQL({
          cql,
          cursor,
          limit: DEFAULT_BATCH_SIZE,
          expand: ["space"],
        });
      } else {
        searchResult = await client.sendRequest(
          {
            url: "/api/content/search",
            method: "GET",
            params: {
              cql,
              start,
              limit: DEFAULT_BATCH_SIZE,
              expand: ["space"],
            },
          },
          // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
          undefined as any,
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: SDK page shape
      const results: any[] = searchResult.results ?? [];
      for (const page of results) {
        if (page?.space?.key) dirtySpaces.add(String(page.space.key));
      }
      const nextUrl: string | undefined = searchResult._links?.next;
      if (config.isCloud) {
        const match = nextUrl?.match(/cursor=([^&]+)/);
        cursor = match ? decodeURIComponent(match[1]) : undefined;
        hasMore = results.length >= DEFAULT_BATCH_SIZE && !!cursor;
      } else {
        start += results.length;
        hasMore = results.length > 0 && !!nextUrl;
      }
    }

    return {
      dirtyContainerKeys: [...dirtySpaces].sort().map((key) => `space:${key}`),
      fullRequired,
      nextState,
    };
  }

  /**
   * Audience verification, run on every delta pass: re-resolve each stored
   * `space:<KEY>` container's audience without enumerating pages. Nested
   * `space:<KEY>/page:<ID>` restriction containers are deliberately NOT
   * yielded — a restriction change moves pages between containers (an
   * assignment change owned by the enumerating passes), and their stored
   * audience stays valid meanwhile.
   */
  async *refreshContainerAudiences(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    containerKeys: string[];
    resolveMappedEmail?: ResolveMappedEmail;
  }): AsyncGenerator<{
    containerKey: string;
    permissions: DocumentPermissions;
    fingerprint?: string | null;
    audienceResolutionFailed?: boolean;
  }> {
    const config = parseConfluenceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Confluence configuration for audience refresh");
    }
    const client = createConfluenceClient(config, params.credentials, this.log);
    this.initAdminEmailResolver(config, params.credentials);
    this.resolveMappedEmail = params.resolveMappedEmail ?? null;

    for (const containerKey of params.containerKeys) {
      const parsed = containerKey.match(/^space:([^/]+)$/);
      if (!parsed) continue;
      const audience = await this.resolveSpaceAudience(client, parsed[1]);
      yield {
        containerKey,
        permissions: audience.permissions,
        audienceResolutionFailed: audience.resolutionFailed,
      };
    }
  }

  /**
   * Local-adoption scoping for delta passes: a stored page document is covered
   * by its space's enumeration (content-sync writes `metadata.spaceKey`).
   * Scoping only — the space enumeration resolves the authoritative
   * assignment, including nested `page:` restriction containers, so this can
   * never over-grant.
   */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const spaceKey = metadata.spaceKey;
    return typeof spaceKey === "string" && spaceKey.length > 0
      ? `space:${spaceKey}`
      : null;
  }

  /**
   * Confluence groups → members. Group ids are the group name, matching
   * the `group.name` written on documents from read-restrictions.
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseConfluenceConfig(params.config);
    if (!config) {
      throw new Error("Invalid Confluence configuration for permission sync");
    }
    const client = createConfluenceClient(config, params.credentials, this.log);
    this.initAdminEmailResolver(
      config,
      params.credentials,
      params.refreshIdentities,
    );

    // Accumulate every member across all real groups so the synthetic
    // "any logged-in user" group (emitted last) can grant a doc readable by all
    // authenticated users. Built-in all-users groups are folded into the
    // synthetic id rather than stored under their raw name.
    const allMembers = new Map<string, GroupMemberYield>();

    for await (const group of this.paginate(client, "/api/group")) {
      // Per-group failure isolation (mirrors the Jira connector): a hidden
      // system group can be listed but 404 on member lookup — one such group
      // must not abort the whole enumeration (which would leave the snapshot
      // unrefreshed and skip the revocation sweep for every group). A failed
      // group yields no members: fail-closed for that group only.
      let members: GroupMemberYield[] = [];
      // Cloud removed the by-name member endpoints (`/api/group/member?name=`
      // 404s into the SPA's HTML page, observed live); the surviving endpoint
      // is by group id. The group list carries ids on Cloud only, so Server/DC
      // (no ids) keeps the by-name form, which is still served there.
      const memberPath = group.id
        ? `/api/group/${encodeURIComponent(String(group.id))}/membersByGroupId`
        : `/api/group/member?name=${encodeURIComponent(group.name)}`;
      try {
        for await (const member of this.paginate(client, memberPath)) {
          // Every member is recorded; a hidden email yields `email: null`
          // (fail-closed at resolution, visible to admins as unresolvable).
          const accountId =
            member?.accountId ?? member?.username ?? member?.userKey;
          if (!accountId) continue; // no stable identity at all — nothing to record
          const email = await this.resolveConfluenceEmail(client, member);
          members.push({
            accountId: String(accountId),
            displayName: member?.displayName ?? member?.publicName ?? null,
            email,
            // Cloud reports "atlassian" | "app"; Server/DC omits it.
            accountType: member?.accountType ?? null,
          });
        }
      } catch (error) {
        members = [];
        this.log.warn(
          { group: group.name, error: extractErrorMessage(error) },
          "Could not resolve Confluence group members; skipping group (its grants stay fail-closed)",
        );
      }
      for (const entry of members) {
        allMembers.set(entry.accountId, entry);
      }
      const groupId = this.mapConfluenceGroupName(group.name);
      yield { groupId, members, cursor: group.name };
    }

    // Synthetic all-members group: models "any logged-in user". Fail-closed —
    // only members whose email actually resolved are granted access; the rest
    // are recorded as unresolvable.
    yield {
      groupId: CONFLUENCE_ANY_LOGGED_IN_USER_GROUP_ID,
      members: [...allMembers.values()],
      cursor: CONFLUENCE_ANY_LOGGED_IN_USER_GROUP_ID,
    };
  }

  /**
   * Fold Confluence's built-in "any logged-in user" groups into the stable
   * synthetic group id so the audience resolves to every member; ordinary named
   * groups pass through unchanged.
   */
  private mapConfluenceGroupName(name: string): string {
    return CONFLUENCE_ALL_LOGGED_IN_GROUP_NAMES.has(name)
      ? CONFLUENCE_ANY_LOGGED_IN_USER_GROUP_ID
      : name;
  }

  /** Space keys holding corpus content, sorted so the resume cursor is monotonic. */
  private async listCorpusSpaceKeys(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    config: ConfluenceConfig,
  ): Promise<string[]> {
    if (config.spaceKeys && config.spaceKeys.length > 0) {
      return [...config.spaceKeys].sort();
    }
    const keys: string[] = [];
    let start = 0;
    const limit = 200;
    for (;;) {
      await this.rateLimit();
      const response = await client.space.getSpaces({ start, limit });
      // biome-ignore lint/suspicious/noExplicitAny: SDK space shape
      const results: any[] = response?.results ?? [];
      for (const space of results) {
        if (space?.key) keys.push(String(space.key));
      }
      if (results.length < limit) break;
      start += results.length;
    }
    return keys.sort();
  }

  private async *syncSpaceSnapshot(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    config: ConfluenceConfig,
    spaceKey: string,
  ): AsyncGenerator<PermissionSnapshotYield> {
    // ---- Phase A: enumerate the space's corpus with inline restrictions.
    // Buffered per space (ids + ancestor chains only; restriction principals
    // are kept for restricted pages alone) so inheritance resolves locally
    // regardless of enumeration order. ----
    const pages: SpacePageEntry[] = [];
    const enumerated = new Set<string>();
    const restrictedById = new Map<string, ConfluenceRestriction>();

    const cql = buildSpaceScopedCql(config, spaceKey);
    let cursor: string | undefined;
    let start = 0;
    let hasMore = true;

    while (hasMore) {
      const searchResult = await this.searchSpacePage(client, config, {
        cql,
        cursor,
        start,
      });

      // biome-ignore lint/suspicious/noExplicitAny: SDK page shape
      const results: any[] = searchResult.results ?? [];
      for (const page of results) {
        const id = String(page.id);
        enumerated.add(id);
        pages.push({
          id,
          // biome-ignore lint/suspicious/noExplicitAny: SDK ancestor shape
          ancestorIds: (page.ancestors ?? []).map((a: any) => String(a.id)),
        });
        const inline = readInlineRestriction(page);
        if (inline === undefined) {
          // Expand ignored by the server or the inline list truncated — the
          // per-content endpoint is authoritative for this page. That is one
          // extra upstream request per page, so which of the two it was gets
          // counted (see `restrictionFallbacks`).
          this.countRestrictionFallback(
            this.inlineRestrictionsUnsupported
              ? "expand_unsupported"
              : "truncated",
          );
          const fetched = await this.getReadRestrictions(client, id);
          if (fetched) restrictedById.set(id, fetched);
        } else if (inline) {
          restrictedById.set(id, inline);
        }
      }

      const nextUrl: string | undefined = searchResult._links?.next;
      if (config.isCloud) {
        const match = nextUrl?.match(/cursor=([^&]+)/);
        cursor = match ? decodeURIComponent(match[1]) : undefined;
        hasMore = results.length >= DEFAULT_BATCH_SIZE && !!cursor;
      } else {
        start += results.length;
        hasMore = results.length > 0 && !!nextUrl;
      }
    }

    // ---- Phase B: resolve every buffered page's container locally. ----
    const spaceContainerKey = `space:${spaceKey}`;
    // The space container is emitted even when the space has no corpus pages,
    // so the pass fail-closes documents of a space that lost them all; its
    // audience is only worth resolving when pages exist (an empty space is
    // deliberately left unresolved, which is not a failure).
    const spaceAudience: ResolvedAudience =
      pages.length > 0
        ? await this.resolveSpaceAudience(client, spaceKey)
        : {
            permissions: { isPublic: false, users: [], groups: [] },
            resolutionFailed: false,
          };
    yield {
      kind: "container",
      containerKey: spaceContainerKey,
      permissions: spaceAudience.permissions,
      audienceResolutionFailed: spaceAudience.resolutionFailed,
      cursor: spaceContainerKey,
    };

    const emittedRestrictionContainers = new Set<string>();
    for (const page of pages) {
      const governing = await this.findGoverningRestriction({
        client,
        page,
        enumerated,
        restrictedById,
      });
      let containerKey = spaceContainerKey;
      if (governing) {
        containerKey = `${spaceContainerKey}/page:${governing.ownerId}`;
        if (!emittedRestrictionContainers.has(containerKey)) {
          // Per-container failure isolation: a restriction audience that fails
          // to resolve fail-closes ITS pages only, never the pass.
          let permissions: DocumentPermissions = {
            isPublic: false,
            users: [],
            groups: [],
          };
          let resolutionFailed = false;
          try {
            permissions = await this.restrictionToAudience(
              client,
              governing.restriction,
            );
          } catch (error) {
            resolutionFailed = true;
            this.log.error(
              {
                restrictedPageId: governing.ownerId,
                error: extractErrorMessage(error),
              },
              "Could not read the page restriction's audience; every page it governs is fail-closed for this pass",
            );
          }
          yield {
            kind: "container",
            containerKey,
            permissions,
            audienceResolutionFailed: resolutionFailed,
            cursor: spaceContainerKey,
          };
          emittedRestrictionContainers.add(containerKey);
        }
      }
      yield {
        kind: "document",
        sourceId: page.id,
        containerKey,
        cursor: spaceContainerKey,
      };
    }

    // Reported once the space is fully done — Phase B's ancestor lookups are
    // fallbacks too, so tallying any earlier would undercount them.
    this.reportRestrictionFallbacks(spaceKey, pages.length);
  }

  /**
   * One CQL search page for the permission pass. A hard rejection of the
   * restriction expands (older DC) is retried once without them and remembered
   * for the rest of the pass — every page then resolves via the per-content
   * fallback instead of failing the pass.
   */
  private async searchSpacePage(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    config: ConfluenceConfig,
    params: { cql: string; cursor: string | undefined; start: number },
    // biome-ignore lint/suspicious/noExplicitAny: SDK response type
  ): Promise<any> {
    for (;;) {
      await this.rateLimit();
      const expand = this.inlineRestrictionsUnsupported
        ? ["ancestors"]
        : PERMISSION_SEARCH_EXPANDS;
      try {
        if (config.isCloud) {
          return await client.content.searchContentByCQL({
            cql: params.cql,
            cursor: params.cursor,
            limit: DEFAULT_BATCH_SIZE,
            expand,
          });
        }
        return await client.sendRequest(
          {
            url: "/api/content/search",
            method: "GET",
            params: {
              cql: params.cql,
              start: params.start,
              limit: DEFAULT_BATCH_SIZE,
              expand,
            },
          },
          // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
          undefined as any,
        );
      } catch (error) {
        if (this.inlineRestrictionsUnsupported) throw error;
        this.inlineRestrictionsUnsupported = true;
        this.log.warn(
          { error: extractErrorMessage(error) },
          "Confluence rejected inline restriction expansion; falling back to per-content restriction lookups for this pass",
        );
      }
    }
  }

  /**
   * The restriction governing a page's audience: the page's own read
   * restriction, or the closest restricted ancestor's (the array is
   * root→parent, so reverse). Null = unrestricted, the space audience
   * governs. An ancestor outside the corpus filter (pageIds/cqlQuery) was
   * never enumerated — its restriction is fetched (cached across pages).
   * Never throws: a failed restriction lookup fail-closes inside
   * `getReadRestrictions` (an empty restriction governs the page).
   */
  private async findGoverningRestriction(params: {
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any;
    page: SpacePageEntry;
    enumerated: Set<string>;
    restrictedById: Map<string, ConfluenceRestriction>;
  }): Promise<{ ownerId: string; restriction: ConfluenceRestriction } | null> {
    const { client, page, enumerated, restrictedById } = params;

    const own = restrictedById.get(page.id);
    if (own) return { ownerId: page.id, restriction: own };

    for (const ancestorId of [...page.ancestorIds].reverse()) {
      if (enumerated.has(ancestorId)) {
        const restriction = restrictedById.get(ancestorId) ?? null;
        if (restriction) return { ownerId: ancestorId, restriction };
        continue;
      }
      // Outside the corpus filter, so nothing inlined its restriction — one
      // per-content request (memoized across the pages that share the ancestor).
      this.countRestrictionFallback("ancestor_outside_corpus");
      const restriction = await this.getReadRestrictions(client, ancestorId);
      if (restriction) return { ownerId: ancestorId, restriction };
    }

    return null;
  }

  private async restrictionToAudience(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    restriction: ConfluenceRestriction,
  ): Promise<DocumentPermissions> {
    const users: string[] = [];
    let dropped = 0;
    for (const user of restriction.users) {
      const email = await this.resolveConfluenceEmail(client, user);
      if (email) users.push(email);
      else dropped++;
    }
    this.meterDroppedPrincipals(dropped);
    const groups = restriction.groups
      .map((group) => group.name as string)
      .filter(Boolean)
      .map((name) => this.mapConfluenceGroupName(name));
    return { isPublic: false, users, groups };
  }

  /**
   * Meter upstream principals dropped because their email could not be resolved
   * (Cloud email privacy). Fail-closed under-grant — surfaced so admins see the
   * coverage gap rather than silently narrowing an audience.
   */
  private meterDroppedPrincipals(count: number): void {
    if (count <= 0) return;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped Confluence principals with no resolvable email (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }

  private countRestrictionFallback(reason: RestrictionFallbackReason): void {
    this.restrictionFallbacks.set(
      reason,
      (this.restrictionFallbacks.get(reason) ?? 0) + 1,
    );
  }

  /**
   * Report (and reset) one space's inline-restriction fallbacks. Each fallback
   * is an extra upstream request the inline expansion was supposed to save, so a
   * space where they dominate is quietly costing a request per page — visible
   * here rather than only as unexplained pass duration.
   */
  private reportRestrictionFallbacks(spaceKey: string, pages: number): void {
    if (this.restrictionFallbacks.size === 0) return;

    let total = 0;
    const byReason: Record<string, number> = {};
    for (const [reason, count] of this.restrictionFallbacks) {
      total += count;
      byReason[reason] = count;
      metrics.rag.reportPermissionSyncRestrictionFallbacks({
        connectorType: this.type,
        reason,
        count,
      });
    }
    this.restrictionFallbacks.clear();
    this.log.info(
      { spaceKey, pages, restrictionFallbacks: total, byReason },
      "Confluence space needed per-content restriction lookups that the inline search expansion could not supply",
    );
  }

  private async getReadRestrictions(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    contentId: string,
  ): Promise<ConfluenceRestriction | null> {
    const cached = this.restrictionCache.get(contentId);
    if (cached !== undefined) return cached;

    let restriction: ConfluenceRestriction | null = null;
    try {
      await this.rateLimit();
      const response = await client.sendRequest(
        {
          url: `/api/content/${contentId}/restriction/byOperation/read`,
          method: "GET",
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
        undefined as any,
      );
      const users = response?.restrictions?.user?.results ?? [];
      const groups = response?.restrictions?.group?.results ?? [];
      restriction =
        users.length > 0 || groups.length > 0 ? { users, groups } : null;
    } catch (error) {
      // `null` means "confirmed unrestricted" and would hand the page the
      // space audience — an over-grant if it IS restricted and this failure
      // was a transient 429/5xx. Fail closed instead: an empty restriction
      // puts the page in its own container with no audience for this pass.
      restriction = { users: [], groups: [] };
      this.log.warn(
        { contentId, error: extractErrorMessage(error) },
        "Could not read content restrictions; fail-closing the content for this pass",
      );
    }
    this.restrictionCache.set(contentId, restriction);
    return restriction;
  }

  private async resolveSpaceAudience(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    spaceKey: string | undefined,
  ): Promise<ResolvedAudience> {
    // No space key at all — nothing to read, and nothing to chase either.
    if (!spaceKey) return { permissions: {}, resolutionFailed: false };
    const cached = this.spaceAudienceCache.get(spaceKey);
    if (cached) return cached;

    // Reading space read-permission subjects requires space-admin scope; when it
    // is unavailable the page is fail-closed (documented limitation).
    let resolved: DocumentPermissions = {};
    let resolutionFailed = false;
    try {
      await this.rateLimit();
      const space = await client.sendRequest(
        {
          url: `/api/space/${spaceKey}`,
          method: "GET",
          params: { expand: "permissions" },
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
        undefined as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: SDK permission shape
      const permissions: any[] = space?.permissions ?? [];
      const users: string[] = [];
      const groups: string[] = [];
      let isPublic = false;
      let dropped = 0;
      for (const permission of permissions) {
        const operation =
          permission?.operation?.operation ?? permission?.operationKey;
        if (operation !== "read" && operation !== "use") continue;
        if (permission?.anonymousAccess) isPublic = true;
        for (const user of permission?.subjects?.user?.results ?? []) {
          const email = await this.resolveConfluenceEmail(client, user);
          if (email) users.push(email);
          else dropped++;
        }
        for (const group of permission?.subjects?.group?.results ?? []) {
          if (group?.name) groups.push(this.mapConfluenceGroupName(group.name));
        }
      }
      this.meterDroppedPrincipals(dropped);
      resolved = { isPublic, users, groups };
    } catch (error) {
      resolutionFailed = true;
      this.log.error(
        { spaceKey, error: extractErrorMessage(error) },
        "Could not read the space's permissions; every page in the space is fail-closed for this pass (the credential needs space-admin scope)",
      );
    }
    const audience: ResolvedAudience = {
      permissions: resolved,
      resolutionFailed,
    };
    this.spaceAudienceCache.set(spaceKey, audience);
    return audience;
  }

  /**
   * Resolve a Confluence principal to an email. Cloud largely hides emails
   * (privacy) — an unresolved principal is fail-closed (documented limitation).
   */
  private async resolveConfluenceEmail(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    // biome-ignore lint/suspicious/noExplicitAny: SDK subject shape
    user: any,
  ): Promise<string | null> {
    const key = user?.accountId ?? user?.username ?? user?.userKey;
    // The upstream email always wins (automatic matching takes precedence —
    // same contract as the query-time group join). The admin mapping is only
    // the fallback that keeps a directly-granted account with a hidden
    // upstream email from being dropped from the audience.
    const mapped = key ? (this.resolveMappedEmail?.(key) ?? null) : null;
    const direct = user?.email ?? user?.emailAddress ?? null;
    if (direct) return direct;
    if (!key) return mapped;
    const cached = this.accountEmailCache.get(key);
    if (cached !== undefined) return cached ?? mapped;
    const persisted = await this.persistentEmailCache?.get(key);
    if (persisted !== undefined) {
      this.accountEmailCache.set(key, persisted);
      return persisted ?? mapped;
    }
    let email: string | null = null;
    try {
      await this.rateLimit();
      const params = user?.accountId
        ? { accountId: user.accountId }
        : { username: key };
      const response = await client.sendRequest(
        { url: "/api/user", method: "GET", params },
        // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
        undefined as any,
      );
      email = response?.email ?? response?.emailAddress ?? null;
    } catch (error) {
      this.log.debug(
        { key, error: extractErrorMessage(error) },
        "Could not resolve Confluence user email",
      );
    }
    // Cloud hides the email from the product API for most accounts; the admin
    // APIs (org-admin API key credential) still resolve managed accounts.
    if (!email && user?.accountId && this.adminEmailResolver) {
      email = await this.adminEmailResolver.resolveEmail(
        String(user.accountId),
      );
    }
    this.accountEmailCache.set(key, email);
    await this.persistentEmailCache?.set(key, email);
    return email ?? mapped;
  }

  /**
   * Arm the per-pass identity helpers: the Cloud-only admin-API email fallback
   * (Server/DC returns emails to admin credentials directly; a fresh resolver
   * per pass keeps its directory snapshot as fresh as the pass itself) and the
   * cross-pass persistent email cache.
   */
  private initAdminEmailResolver(
    config: ConfluenceConfig,
    credentials: ConnectorCredentials,
    refresh?: boolean,
  ): void {
    // The dedicated org-admin API key unlocks the admin APIs; the product
    // apiToken is only a long-shot fallback bearer (the admin APIs reject
    // plain user tokens and the resolver disables itself on the first
    // 401/403).
    const adminBearerKey = credentials.adminApiKey ?? credentials.apiToken;
    this.adminEmailResolver =
      config.isCloud && adminBearerKey
        ? new AtlassianAdminEmailResolver({
            apiKey: adminBearerKey,
            log: this.log,
            rateLimit: () => this.rateLimit(),
          })
        : null;
    this.persistentEmailCache = new ConnectorIdentityCache<string | null>({
      namespace: "confluence-email",
      host: config.confluenceUrl,
      credentials,
      refresh,
    });
  }

  /** Rate-limited pager over a Confluence `results`-shaped list endpoint. */
  private async *paginate(
    // biome-ignore lint/suspicious/noExplicitAny: SDK client
    client: any,
    path: string,
    // biome-ignore lint/suspicious/noExplicitAny: SDK result shape
  ): AsyncGenerator<any> {
    let start = 0;
    const limit = 200;
    const separator = path.includes("?") ? "&" : "?";
    for (;;) {
      await this.rateLimit();
      const response = await client.sendRequest(
        {
          url: `${path}${separator}limit=${limit}&start=${start}`,
          method: "GET",
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK requires callback arg
        undefined as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: SDK result shape
      const results: any[] = response?.results ?? [];
      for (const item of results) yield item;
      if (results.length < limit) break;
      start += results.length;
    }
  }
}

// ===== Module-level helpers =====

function createConfluenceClient(
  config: ConfluenceConfig,
  credentials: ConnectorCredentials,
  log: pino.Logger,
) {
  const host = config.confluenceUrl.replace(/\/+$/, "");
  return new ConfluenceClient({
    host,
    noCheckAtlassianToken: true,
    authentication: credentials.email
      ? { basic: { email: credentials.email, apiToken: credentials.apiToken } }
      : { oauth2: { accessToken: credentials.apiToken } },
    apiPrefix: config.isCloud ? "/wiki/rest/" : "/rest/",
    middlewares: {
      onError: (error: unknown) => {
        // biome-ignore lint/suspicious/noExplicitAny: Axios error shape
        const err = error as any;
        log.debug(
          {
            status: err?.response?.status,
            method: err?.config?.method?.toUpperCase(),
            url: err?.config?.url,
            error: err?.message ?? String(error),
          },
          "HTTP error",
        );
      },
      onResponse: (response: unknown) => {
        // biome-ignore lint/suspicious/noExplicitAny: Axios response shape
        const res = response as any;
        log.debug(
          {
            status: res?.status,
            method: res?.config?.method?.toUpperCase(),
            url: res?.config?.url,
          },
          "HTTP response",
        );
      },
    },
  });
}

function parseConfluenceConfig(
  config: Record<string, unknown>,
): ConfluenceConfig | null {
  const result = ConfluenceConfigSchema.safeParse({
    type: "confluence",
    ...config,
  });
  return result.success ? result.data : null;
}

/**
 * Corpus filter for one space's permission enumeration: the content-sync
 * corpus clauses (type/pageIds/cqlQuery) scoped to a single space, with no
 * lastModified bound (permissions change without content edits). `created`
 * ordering keeps cursor pagination stable while pages are edited mid-pass.
 */
function buildSpaceScopedCql(
  config: ConfluenceConfig,
  spaceKey: string,
): string {
  const clauses: string[] = ["type = page", `space = "${spaceKey}"`];

  if (config.pageIds && config.pageIds.length > 0) {
    const idList = config.pageIds.map((id) => `"${id}"`).join(", ");
    clauses.push(`content = (${idList})`);
  }

  if (config.cqlQuery) {
    clauses.push(`(${config.cqlQuery})`);
  }

  return `${clauses.join(" AND ")} ORDER BY created ASC`;
}

/**
 * Read a search result's inline read-restriction expansion.
 *
 * - `undefined` — the inline data is unusable: the server ignored the expand
 *   (older DC) or an embedded list is truncated (inline collections are a
 *   single page with no cursor). The caller must use the per-content endpoint.
 * - `null` — expansion applied, page has no read restrictions.
 * - restriction — expansion applied, page is restricted to these subjects.
 */
function readInlineRestriction(
  // biome-ignore lint/suspicious/noExplicitAny: SDK page shape
  page: any,
): ConfluenceRestriction | null | undefined {
  const read = page?.restrictions?.read?.restrictions;
  const userList = read?.user;
  const groupList = read?.group;
  // An applied expand materializes both subject collections (possibly empty);
  // their absence means the expand was ignored — NOT "unrestricted".
  if (!userList || !groupList) return undefined;
  // biome-ignore lint/suspicious/noExplicitAny: SDK subject shape
  const users: any[] = userList.results ?? [];
  // biome-ignore lint/suspicious/noExplicitAny: SDK subject shape
  const groups: any[] = groupList.results ?? [];
  const truncated =
    (typeof userList.size === "number" && users.length < userList.size) ||
    (typeof groupList.size === "number" && groups.length < groupList.size);
  if (truncated) return undefined;
  return users.length > 0 || groups.length > 0 ? { users, groups } : null;
}

function buildCql(
  config: ConfluenceConfig,
  checkpoint: ConfluenceCheckpoint,
  startTime?: Date,
): string {
  const clauses: string[] = ["type = page"];

  if (config.spaceKeys && config.spaceKeys.length > 0) {
    const spaceList = config.spaceKeys.map((k) => `"${k}"`).join(", ");
    clauses.push(`space IN (${spaceList})`);
  }

  if (config.pageIds && config.pageIds.length > 0) {
    const idList = config.pageIds.map((id) => `"${id}"`).join(", ");
    clauses.push(`content = (${idList})`);
  }

  if (config.cqlQuery) {
    clauses.push(`(${config.cqlQuery})`);
  }

  // Prefer the raw Confluence timestamp (includes timezone offset) so the CQL date
  // is formatted in the user's local timezone.  Fall back to UTC lastSyncedAt for
  // backward compatibility with old checkpoints — subtract 1 day as safety buffer
  // to account for unknown timezone offsets (CQL uses day-level precision).
  const rawTimestamp = checkpoint.lastRawModifiedAt;
  if (rawTimestamp) {
    const cqlDate = formatCqlLocalDate(rawTimestamp);
    clauses.push(`lastModified >= "${cqlDate}"`);
  } else {
    const syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
    if (syncFrom) {
      const cqlDate = formatCqlDateWithSafetyBuffer(syncFrom);
      clauses.push(`lastModified >= "${cqlDate}"`);
    }
  }

  return `${clauses.join(" AND ")} ORDER BY lastModified ASC`;
}

/**
 * Extract the LOCAL date from an ISO 8601 timestamp with timezone offset.
 * CQL interprets date literals in the authenticating user's timezone.
 * @public — exported for testability
 */
export function formatCqlLocalDate(rawTimestamp: string): string {
  const match = rawTimestamp.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const d = new Date(rawTimestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Format a UTC ISO timestamp for CQL, subtracting 1 day to account for
 * timezone offsets. CQL uses day precision so 1 day buffer is sufficient.
 * Used only for old checkpoints that lack `lastRawModifiedAt`.
 */
function formatCqlDateWithSafetyBuffer(isoDate: string): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() - 1);
  return formatCqlDate(d.toISOString());
}

function formatCqlDate(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// biome-ignore lint/suspicious/noExplicitAny: SDK content types
function shouldSkipPage(page: any, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const pageLabels: string[] =
    page.metadata?.labels?.results?.map((l: { name: string }) => l.name) ?? [];
  return pageLabels.some((label) => labelsToSkip.includes(label));
}

function pageToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: SDK content types
  page: any,
  baseUrl: string,
  isCloud: boolean,
): ConnectorDocument {
  const htmlContent: string = page.body?.storage?.value ?? "";
  const plainText = stripHtmlTags(htmlContent);

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const basePath = isCloud ? "/wiki" : "";
  const webUiPath: string = page._links?.webui ?? "";
  const sourceUrl = webUiPath
    ? `${normalizedBase}${basePath}${webUiPath}`
    : undefined;

  return {
    id: page.id,
    title: page.title,
    content: `# ${page.title}\n\n${plainText}`,
    sourceUrl,
    metadata: {
      pageId: page.id,
      spaceKey: page.space?.key,
      spaceName: page.space?.name,
      status: page.status,
      labels:
        page.metadata?.labels?.results?.map((l: { name: string }) => l.name) ??
        [],
    },
    updatedAt: page.version?.when ? new Date(page.version.when) : undefined,
  };
}

/**
 * Strip HTML tags from Confluence storage format to produce clean plain text.
 *
 * Uses cheerio (DOM parser) instead of regex to correctly handle:
 *  - Confluence structured macros (status lozenges, panels, etc.)
 *  - Decorative parameters (colour, icon) that should not appear in text
 *  - Table structure (cells separated by tabs, rows by newlines)
 *  - Proper spacing between adjacent inline elements
 * @public — exported for testability
 */
export function stripHtmlTags(html: string): string {
  if (!html) return "";

  const $ = cheerio.load(html, { xml: true });

  // Remove decorative ac:parameter elements so values like "Red" from
  // status lozenges don't leak into indexed text
  $(
    'ac\\:parameter[ac\\:name="colour"], ac\\:parameter[ac\\:name="color"], ac\\:parameter[ac\\:name="subtle"], ac\\:parameter[ac\\:name="icon"], ac\\:parameter[ac\\:name="style"], ac\\:parameter[ac\\:name="class"]',
  ).remove();

  // Process tables: add structural separators before extracting text
  $("td, th").each((_i, el) => {
    $(el).prepend("\t");
  });
  $("tr").each((_i, el) => {
    $(el).append("\n");
  });

  // Block elements → newlines
  $("p, div, h1, h2, h3, h4, h5, h6, li, br").each((_i, el) => {
    $(el).after("\n");
  });

  let text = $.text();

  // Decode HTML entities that cheerio's XML mode doesn't handle
  text = text.replace(/&nbsp;/g, " ");

  // Collapse whitespace
  text = text.replace(/ {2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
