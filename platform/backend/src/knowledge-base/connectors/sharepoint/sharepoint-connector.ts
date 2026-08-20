import type { ModelInputModality } from "@archestra/shared";
import { ClientSecretCredential } from "@azure/identity";
import { Client, ResponseType } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import type {
  DriveItem as GraphDriveItem,
  SitePage as GraphSitePage,
} from "@microsoft/microsoft-graph-types";
import { extractPdfText, type OcrRunContext } from "@/knowledge-base/pdf-ocr";
import * as metrics from "@/observability/metrics";
import type {
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
  SharePointCheckpoint,
  SharePointConfig,
} from "@/types";
import { SharePointConfigSchema } from "@/types";
import { stripHtmlTags } from "@/utils/strip-html";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
  resolveIngestibleImageMimeTypes,
} from "../base-connector";
import { extractTextFromDocx } from "../docx-text-extractor";
import {
  type FolderTraversalAdapter,
  traverseFolders,
} from "../folder-traversal";
import {
  describePdfEmptyText,
  describePdfExtractionWarning,
} from "../pdf-utils";
import { extractTextFromPptx } from "../pptx-text-extractor";
import { extractTextFromXlsx } from "../xlsx-text-extractor";

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
const DEFAULT_BATCH_SIZE = 50;
const MAX_CONTENT_LENGTH = 500_000; // 500 KB text limit per document
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB image size limit
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

// File extensions whose text content we can extract via Graph download
const SUPPORTED_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".yaml",
  ".yml",
]);

// Binary file extensions we can extract text from using libraries
const SUPPORTED_BINARY_EXTENSIONS = new Set([
  ".docx",
  ".pdf",
  ".pptx",
  ".xlsx",
]);

// Image file extensions supported for multimodal embedding
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);

// MIME type mapping for image extensions
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export class SharePointConnector extends BaseConnector {
  type = "sharepoint" as const;
  supportsPermissionSync = true;

  /** Per-permission-pass state; re-armed by every permission hook entry. */
  private permCredentials: ConnectorCredentials | null = null;
  private permConfig: SharePointConfig | null = null;
  /** Graph user id → email (null = unresolvable this pass). */
  private userEmailCache = new Map<string, string | null>();
  /** Entra/M365 group id → member roster (null = tier unavailable/failed). */
  private entraGroupCache = new Map<string, GroupMemberYield[] | null>();
  /** SharePoint group title → member roster (null = tier unavailable/failed). */
  private spGroupCache = new Map<string, GroupMemberYield[] | null>();
  /** Admin member-override lookup, injected by the pass (null = none). */
  private mappedEmailResolver: ResolveMappedEmail | null = null;
  /** All active tenant users (undefined = not fetched this pass). */
  private tenantUsersCache: string[] | null | undefined;
  /** Progressive-elevation tiers, probed lazily and cached per pass. */
  private graphUsersTier: boolean | null = null;
  private graphGroupsTier: boolean | null = null;
  private spRestTier: boolean | null = null;
  private deltaSharingTier: boolean | null = null;
  private spAccessToken: string | null = null;
  private droppedPrincipals = 0;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseSharePointConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid SharePoint configuration" };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing SharePoint connection");

    try {
      const config = parseSharePointConfig(params.config);
      if (!config) {
        return { success: false, error: "Invalid configuration" };
      }

      const client = this.getGraphClient(params.credentials, config);
      const siteResolution = await this.resolveSite(client, config.siteUrl);

      if (!siteResolution.siteId) {
        return {
          success: false,
          error: buildResolveSiteErrorMessage(siteResolution.error),
        };
      }

      this.log.debug("SharePoint connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "SharePoint connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    embeddingInputModalities?: ModelInputModality[];
    embeddingAcceptedImageMimeTypes?: string[];
  }): Promise<number | null> {
    const parsed = parseSharePointConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as SharePointCheckpoint | null) ?? {
        type: "sharepoint" as const,
      };
      const syncFrom = checkpoint.lastSyncedAt;
      const safetyBufferedSyncFrom = syncFrom
        ? subtractSafetyBuffer(syncFrom)
        : undefined;
      const imageMimeTypes = resolveIngestibleImageMimeTypes({
        connectorImageMimeTypes: Object.values(IMAGE_MIME_TYPES),
        embeddingInputModalities: params.embeddingInputModalities,
        embeddingAcceptedImageMimeTypes: params.embeddingAcceptedImageMimeTypes,
      });

      const client = this.getGraphClient(params.credentials, parsed);
      const siteResolution = await this.resolveSite(client, parsed.siteUrl);

      if (!siteResolution.siteId) {
        return null;
      }

      const driveIds =
        parsed.driveIds && parsed.driveIds.length > 0
          ? parsed.driveIds
          : await this.listDriveIds(client, siteResolution.siteId);

      let total = 0;

      const recursive = parsed.recursive ?? true;
      const maxDepth = parsed.maxDepth;

      for (const driveId of driveIds) {
        total += await this.countDriveItems({
          client,
          driveId,
          folderPath: parsed.folderPath,
          recursive,
          maxDepth,
          syncFrom: safetyBufferedSyncFrom,
          imageMimeTypes,
        });
      }

      if (parsed.includePages !== false) {
        total += await this.countSitePages({
          client,
          siteId: siteResolution.siteId,
          syncFrom: safetyBufferedSyncFrom,
        });
      }

      return total;
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
    embeddingInputModalities?: ModelInputModality[];
    embeddingAcceptedImageMimeTypes?: string[];
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseSharePointConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid SharePoint configuration");
    }

    const checkpoint = (params.checkpoint as SharePointCheckpoint | null) ?? {
      type: "sharepoint" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;
    const imageMimeTypes = resolveIngestibleImageMimeTypes({
      connectorImageMimeTypes: Object.values(IMAGE_MIME_TYPES),
      embeddingInputModalities: params.embeddingInputModalities,
      embeddingAcceptedImageMimeTypes: params.embeddingAcceptedImageMimeTypes,
    });

    // Single client instance — SDK handles token acquisition and refresh automatically.
    const client = this.getGraphClient(params.credentials, parsed);
    const siteResolution = await this.resolveSite(client, parsed.siteUrl);

    if (!siteResolution.siteId) {
      throw new Error(buildResolveSiteErrorMessage(siteResolution.error));
    }
    const siteId = siteResolution.siteId;

    // Track the highest lastModifiedDateTime seen across all phases (drives + pages)
    // so the checkpoint only advances monotonically and a later phase with older
    // timestamps cannot regress progress from an earlier phase.
    // safeLastSyncedAt is the original checkpoint value and never changes — it is
    // emitted on intermediate batches (hasMore=true) so a resumed run always
    // re-visits any not-yet-processed folders/drives rather than skipping them
    // because the checkpoint advanced past their file timestamps.
    const progress = {
      maxLastModified: checkpoint.lastSyncedAt as string | undefined,
      safeLastSyncedAt: checkpoint.lastSyncedAt as string | undefined,
    };

    const recursive = parsed.recursive ?? true;
    const maxDepth = parsed.maxDepth;

    this.log.debug(
      {
        siteId,
        driveIds: parsed.driveIds,
        folderPath: parsed.folderPath,
        recursive,
        includePages: parsed.includePages,
        syncFrom,
        imageMimeTypes: [...imageMimeTypes],
      },
      "Starting SharePoint sync",
    );

    // Sync drive items (documents/files)
    yield* this.syncDriveItems({
      client,
      siteId,
      config: parsed,
      recursive,
      maxDepth,
      progress,
      syncFrom: safetyBufferedSyncFrom,
      batchSize,
      imageMimeTypes,
    });

    // Sync site pages if enabled
    if (parsed.includePages !== false) {
      yield* this.syncSitePages({
        client,
        siteId,
        progress,
        syncFrom: safetyBufferedSyncFrom,
        batchSize,
      });
    }
  }

  // ===== Permission sync =====

  /**
   * Container model: `drive:<driveId>` per document library in scope, plus
   * `site:<siteId>` for site pages. A drive's root audience comes from the
   * root item's effective permission list. Items that BREAK permission
   * inheritance (a permission-hierarchy root, surfaced by the delta feed's
   * `hierarchicalsharing` preference — the mechanism Microsoft's scanning
   * guidance builds on) become nested `drive:<id>/item:<itemId>` containers;
   * a document's container is its nearest uniquely-permissioned ancestor,
   * resolved locally over the buffered walk (the Confluence governing-
   * restriction pattern). `site:<siteId>` takes the DEFAULT drive's root
   * audience — SharePoint pages have no v1.0 permission API; site-level
   * groups govern both (documented approximation; per-page unique sharing
   * is not modeled).
   *
   * Group grants emit GROUP TOKENS (`entra:<guid>` / `sitegroup:<title>` —
   * byte-matched into `group:sharepoint_…` ACL tokens), and `syncGroups`
   * persists the membership roster from the same expansions, so the
   * Users/Groups tabs and member overrides work like every other roster
   * connector. Direct (non-group) grantees stay inline `user_email:` tokens
   * — with the pass's `resolveMappedEmail` override fallback — and are
   * rostered under the synthetic `direct-grants` group so unmatched accounts
   * are visible and assignable. The roster walks the TOP-LEVEL permission
   * surfaces (drive roots); a group granted only on a nested
   * unique-permission item still emits its token (visible in the Groups tab)
   * but resolves no members until it also appears at top level — bounded
   * fail-closed, since neither site groups nor granted Entra groups are
   * globally enumerable. Every pass re-resolves audiences and roster
   * (revocation latency = pass interval). Tiers are progressive, probed
   * lazily, cached per pass, and always degrade fail-closed:
   *  - base (Sites.Read.All): root/item permission lists, siteUser claims,
   *    group-token emission (identity only — no membership)
   *  - + User.Read.All: Graph user-id → email, tenant-wide link expansion
   *  - + GroupMember.Read.All: Entra/M365 roster expansion (syncGroups)
   *  - + SharePoint Sites.FullControl.All: site-group roster expansion via
   *    the site's REST API, and sharing-aware delta probing
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseSharePointConfig(params.config);
    if (!config) {
      throw new Error("Invalid SharePoint configuration for permission sync");
    }
    this.initPermissionPass(params.credentials, config);
    this.mappedEmailResolver = params.resolveMappedEmail ?? null;
    const client = this.getGraphClient(params.credentials, config);
    const siteResolution = await this.resolveSite(client, config.siteUrl);
    if (!siteResolution.siteId) {
      throw new Error(buildResolveSiteErrorMessage(siteResolution.error));
    }
    const siteId = siteResolution.siteId;

    const containers = await this.topContainers(client, config, siteId);
    const scope = params.scope ? new Set(params.scope.containerKeys) : null;

    for (const container of containers) {
      if (scope && !scope.has(container.key)) continue;
      // Resume: containers strictly before the cursor are done; the cursor
      // container is re-processed (idempotent — same audiences).
      if (params.cursor && container.key < params.cursor) continue;
      if (container.kind === "drive") {
        yield* this.syncDriveContainerSnapshot(client, container.key, params);
      } else {
        yield* this.syncSiteContainerSnapshot(client, container.key, params);
      }
    }

    this.reportDroppedPrincipals();
  }

  /**
   * Group roster sync (Users/Groups tabs + member overrides). Walks the
   * TOP-LEVEL permission surfaces (each drive root), collects every granted
   * group and direct grantee, and expands each group to members. Yielded
   * groupIds byte-match the refs the audience path emits (`entra:<guid>`,
   * `sitegroup:<title>`), so query-time group tokens resolve through this
   * roster. Direct grantees roster under the synthetic `direct-grants`
   * group — they grant via inline `user_email:` tokens, and the roster row
   * is what makes an unmatched account visible and override-assignable.
   * Expansion failure yields `members: []` (fail-closed — the platform
   * revokes that group's stored memberships; Salesforce precedent). A
   * surface whose permission read fails is skipped here: the audience phase
   * owns fail-closing its containers.
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseSharePointConfig(params.config);
    if (!config) {
      throw new Error("Invalid SharePoint configuration for group sync");
    }
    this.initPermissionPass(params.credentials, config);
    const client = this.getGraphClient(params.credentials, config);
    const siteResolution = await this.resolveSite(client, config.siteUrl);
    if (!siteResolution.siteId) {
      throw new Error(buildResolveSiteErrorMessage(siteResolution.error));
    }
    const containers = await this.topContainers(
      client,
      config,
      siteResolution.siteId,
    );

    const entraIds = new Set<string>();
    const spTitles = new Set<string>();
    const direct = new Map<string, GroupMemberYield>();
    for (const container of containers) {
      if (container.kind !== "drive") continue; // site: mirrors a drive root
      const driveId = container.key.slice("drive:".length);
      let permissions: SpPermission[];
      try {
        permissions = await this.listItemPermissions(
          client,
          `/drives/${driveId}/root/permissions`,
        );
      } catch (error) {
        this.log.warn(
          { driveId, error: extractErrorMessage(error) },
          "Could not read a drive root's permissions for the group roster; its groups keep their previous roster this pass",
        );
        continue;
      }
      for (const permission of permissions) {
        const identitySets = [
          permission.grantedToV2,
          ...(permission.grantedToIdentitiesV2 ?? []),
        ];
        for (const identitySet of identitySets) {
          await this.collectRosterIdentity(
            identitySet,
            entraIds,
            spTitles,
            direct,
          );
        }
      }
    }

    for (const groupId of [...entraIds].sort()) {
      const members = await this.expandEntraGroup(groupId);
      yield { groupId: entraGroupRef(groupId), members: members ?? [] };
    }
    for (const title of [...spTitles].sort()) {
      const members = await this.expandSpGroup(title);
      yield { groupId: spGroupRef(title), members: members ?? [] };
    }
    if (direct.size > 0) {
      yield {
        groupId: DIRECT_GRANTS_GROUP_ID,
        members: [...direct.values()].sort((a, b) =>
          a.accountId.localeCompare(b.accountId),
        ),
      };
    }

    this.reportDroppedPrincipals();
  }

  /** Roster-side principal collection (audience-side is applyIdentitySet). */
  private async collectRosterIdentity(
    identitySet: SpIdentitySet | undefined,
    entraIds: Set<string>,
    spTitles: Set<string>,
    direct: Map<string, GroupMemberYield>,
  ): Promise<void> {
    if (!identitySet) return;
    if (identitySet.group?.id) entraIds.add(identitySet.group.id);
    if (identitySet.siteGroup?.displayName) {
      spTitles.add(identitySet.siteGroup.displayName);
    }
    if (identitySet.user?.id) {
      // Roster the UPSTREAM identity: email stays null when hidden — that is
      // exactly the row an admin assigns manually.
      const email = await this.resolveGraphUserEmail(identitySet.user.id);
      direct.set(identitySet.user.id, {
        accountId: identitySet.user.id,
        displayName: identitySet.user.displayName ?? null,
        email,
        accountType: "user",
      });
      return;
    }
    const loginName = identitySet.siteUser?.loginName;
    if (!loginName) return;
    const lowered = loginName.toLowerCase();
    if (lowered.includes("|federateddirectoryclaimprovider|")) {
      const groupId = loginName.split("|").pop();
      if (groupId) entraIds.add(groupId);
      return;
    }
    if (
      lowered.includes("spo-grid-all-users") ||
      lowered.includes("|rolemanager|") ||
      lowered === "c:0(.s|true"
    ) {
      return; // whole-tenant claims are not rosterable
    }
    const claimEmail = lowered.startsWith("i:0#.f|membership|")
      ? loginName.split("|").pop()?.toLowerCase()
      : undefined;
    direct.set(loginName, {
      accountId: loginName,
      displayName: identitySet.siteUser?.displayName ?? null,
      email: claimEmail?.includes("@") ? claimEmail : null,
      accountType: "siteUser",
    });
  }

  /**
   * Delta-pass probe over each drive's delta feed. With the elevated
   * `deltashowsharingchanges` preference (requires Sites.FullControl.All),
   * items whose SHARING changed carry an annotation and only those dirty the
   * container; without the elevation the preference is dropped and any item
   * drift dirties it (the feed cannot isolate sharing drift — the safe
   * coarse fallback). 410 Gone / rejected token ⇒ fullRequired. The pages
   * container has no change feed — it is always dirty (pages re-verify
   * cheaply: read-back + the default drive's root audience).
   */
  async probePermissionChanges(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    state: PermissionSyncState | null;
  }): Promise<PermissionProbeResult> {
    const config = parseSharePointConfig(params.config);
    if (!config) {
      throw new Error("Invalid SharePoint configuration for permission probe");
    }
    this.initPermissionPass(params.credentials, config);
    const client = this.getGraphClient(params.credentials, config);
    const siteResolution = await this.resolveSite(client, config.siteUrl);
    if (!siteResolution.siteId) {
      throw new Error(buildResolveSiteErrorMessage(siteResolution.error));
    }
    const containers = await this.topContainers(
      client,
      config,
      siteResolution.siteId,
    );

    const stored =
      params.state?.deltaTokens && typeof params.state.deltaTokens === "object"
        ? (params.state.deltaTokens as Record<string, unknown>)
        : null;
    if (!stored) {
      return {
        dirtyContainerKeys: [],
        fullRequired: true,
        nextState: {
          deltaTokens: await this.captureDeltaTokens(client, containers),
        },
      };
    }

    const dirty: string[] = [];
    const nextTokens: Record<string, string> = {};
    for (const container of containers) {
      if (container.kind === "site") {
        dirty.push(container.key);
        continue;
      }
      const token = stored[container.key];
      if (typeof token !== "string" || !token) {
        nextTokens[container.key] = await this.getLatestDeltaToken(
          client,
          container.key,
        );
        dirty.push(container.key);
        continue;
      }
      try {
        const outcome = await this.walkDriveDelta(client, container.key, {
          token,
          forProbe: true,
        });
        nextTokens[container.key] = outcome.deltaLink;
        if (outcome.sawChange) dirty.push(container.key);
      } catch (error) {
        // Rejected/expired delta token (410 resync etc.) — the drift window
        // is lost, so only a full reconcile restores correctness.
        this.log.warn(
          { containerKey: container.key, error: extractErrorMessage(error) },
          "SharePoint delta token rejected; promoting to a full reconcile",
        );
        return {
          dirtyContainerKeys: [],
          fullRequired: true,
          nextState: {
            deltaTokens: await this.captureDeltaTokens(client, containers),
          },
        };
      }
    }

    return {
      dirtyContainerKeys: dirty.sort(),
      fullRequired: false,
      nextState: { deltaTokens: nextTokens },
    };
  }

  /**
   * Audience verification, run on every delta pass: re-resolve each stored
   * top-level container's audience without enumerating items. Nested
   * `.../item:<id>` containers are deliberately NOT yielded — their audiences
   * follow assignment drift, which the enumerating passes own.
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
    const config = parseSharePointConfig(params.config);
    if (!config) {
      throw new Error("Invalid SharePoint configuration for audience refresh");
    }
    this.initPermissionPass(params.credentials, config);
    this.mappedEmailResolver = params.resolveMappedEmail ?? null;
    const client = this.getGraphClient(params.credentials, config);

    for (const containerKey of params.containerKeys) {
      const driveMatch = containerKey.match(/^drive:([^/]+)$/);
      if (driveMatch) {
        const audience = await this.resolveDriveRootAudience(
          client,
          driveMatch[1],
        );
        yield {
          containerKey,
          permissions: audience.permissions,
          audienceResolutionFailed: audience.resolutionFailed,
        };
        continue;
      }
      if (/^site:[^/]+$/.test(containerKey)) {
        const audience = await this.resolveSitePagesAudience(
          client,
          containerKey,
        );
        yield {
          containerKey,
          permissions: audience.permissions,
          audienceResolutionFailed: audience.resolutionFailed,
        };
      }
      // Nested item containers: skipped (assignment-tier).
    }

    this.reportDroppedPrincipals();
  }

  /**
   * Local-adoption scoping for delta passes: content-sync stamps
   * `metadata.driveId` on drive items and `metadata.siteId` on pages.
   * Scoping only — the container enumeration resolves the authoritative
   * assignment, so this can never over-grant.
   */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const driveId = metadata.driveId;
    if (typeof driveId === "string" && driveId.length > 0) {
      return `drive:${driveId}`;
    }
    const siteId = metadata.siteId;
    if (typeof siteId === "string" && siteId.length > 0) {
      return `site:${siteId}`;
    }
    return null;
  }

  // ===== Private methods =====

  private getGraphClient(
    credentials: ConnectorCredentials,
    config: SharePointConfig,
  ): Client {
    // SharePoint reuses ConnectorCredentials.email to store the Azure AD
    // Application (client) ID so we can fit the existing connector credential
    // schema without a SharePoint-specific secret shape.
    const clientId = credentials.email;

    if (!clientId) {
      throw new Error("Client ID is required");
    }

    const credential = new ClientSecretCredential(
      config.tenantId,
      clientId,
      credentials.apiToken,
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ["https://graph.microsoft.com/.default"],
    });

    return Client.initWithMiddleware({ authProvider });
  }

  private async resolveSite(
    client: Client,
    siteUrl: string,
  ): Promise<{ siteId: string | null; error?: string }> {
    const url = new URL(siteUrl);
    const hostname = url.hostname;
    const sitePath = url.pathname.replace(/^\//, "").replace(/\/$/, "");

    const apiPath = sitePath
      ? `/sites/${hostname}:/${sitePath}`
      : `/sites/${hostname}`;

    try {
      const site = (await client.api(apiPath).get()) as { id: string };
      return { siteId: site.id ?? null };
    } catch (error) {
      const message = formatSharePointGraphError({
        error,
        apiPath,
      });
      this.log.warn(
        { siteUrl, apiPath, error: message },
        "Failed to resolve SharePoint site",
      );
      return { siteId: null, error: message };
    }
  }

  private async *syncDriveItems(params: {
    client: Client;
    siteId: string;
    config: SharePointConfig;
    recursive: boolean;
    maxDepth: number | undefined;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    imageMimeTypes: ReadonlySet<string>;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      siteId,
      config,
      recursive,
      maxDepth,
      progress,
      syncFrom,
      batchSize,
      imageMimeTypes,
    } = params;

    const driveIds =
      config.driveIds && config.driveIds.length > 0
        ? config.driveIds
        : await this.listDriveIds(client, siteId);

    for (let i = 0; i < driveIds.length; i++) {
      const driveId = driveIds[i];
      const isLastDrive = i === driveIds.length - 1;

      yield* this.syncSingleDrive({
        client,
        driveId,
        folderPath: config.folderPath,
        recursive,
        maxDepth,
        progress,
        syncFrom,
        batchSize,
        hasMoreDrives: !isLastDrive,
        imageMimeTypes,
      });
    }
  }

  private async listDriveIds(
    client: Client,
    siteId: string,
  ): Promise<string[]> {
    let result: { value: Array<{ id: string }> };

    try {
      result = await client
        .api(`${GRAPH_API_BASE}/sites/${siteId}/drives?$select=id`)
        .get();
    } catch (error) {
      throw new Error(`Failed to list drives: ${extractErrorMessage(error)}`);
    }

    return result.value.map((d) => d.id);
  }

  private async *syncSingleDrive(params: {
    client: Client;
    driveId: string;
    folderPath: string | undefined;
    recursive: boolean;
    maxDepth: number | undefined;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    hasMoreDrives: boolean;
    imageMimeTypes: ReadonlySet<string>;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      driveId,
      folderPath,
      recursive,
      maxDepth,
      progress,
      syncFrom,
      batchSize,
      hasMoreDrives,
      imageMimeTypes,
    } = params;

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (parentId) =>
        this.listDirectSubfolders({
          client,
          driveId,
          parentId,
          rootFolderPath: folderPath,
        }),
    };

    const folderGen = traverseFolders(
      adapter,
      { rootFolderId: "root", recursive, maxDepth },
      this.log,
    );

    let next = await folderGen.next();
    while (!next.done) {
      const folderId = next.value;
      next = await folderGen.next();
      const hasMoreFolders = !next.done;

      yield* this.syncFilesInFolder({
        client,
        driveId,
        folderId,
        rootFolderPath: folderId === "root" ? folderPath : undefined,
        progress,
        syncFrom,
        batchSize,
        hasMoreFolders: hasMoreFolders || hasMoreDrives,
        imageMimeTypes,
      });
    }
  }

  private async *syncFilesInFolder(params: {
    client: Client;
    driveId: string;
    folderId: string;
    rootFolderPath: string | undefined;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    hasMoreFolders: boolean;
    imageMimeTypes: ReadonlySet<string>;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      driveId,
      folderId,
      rootFolderPath,
      progress,
      syncFrom,
      batchSize,
      hasMoreFolders,
      imageMimeTypes,
    } = params;

    let url: string =
      folderId === "root"
        ? buildRootChildrenUrl(driveId, rootFolderPath, batchSize)
        : buildItemChildrenUrl(driveId, folderId, batchSize);
    let hasMorePages = true;
    let batchIndex = 0;

    while (hasMorePages) {
      await this.rateLimit();

      let result: GraphListResponse<DriveItem>;
      try {
        result = await client.api(url).get();
      } catch (error) {
        throw new Error(
          `Drive items query failed: ${extractErrorMessage(error)}`,
        );
      }

      const items = result.value.filter(
        (item) =>
          item.file &&
          !item.folder &&
          isSupportedFile(item.name, imageMimeTypes) &&
          // Client-side incremental filter: Graph API does not support
          // $filter on lastModifiedDateTime for drive item children.
          isModifiedSince(item.lastModifiedDateTime, syncFrom),
      );

      const documents: ConnectorDocument[] = [];

      for (const item of items) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const result = await this.downloadFileData(
              client,
              driveId,
              item.id,
              item.name,
            );
            // Skip files with no extractable content or media to avoid indexing
            // title-only documents that provide no search value.
            if (!result.text.trim() && !result.mediaContent) {
              this.trackSkipped({
                itemId: item.id,
                name: item.name,
                reason:
                  result.emptyReason ??
                  "Empty content — no text or media could be extracted",
                category: "no_extractable_text",
                sourceScope: { metadataField: "driveId", value: driveId },
              });
              return null;
            }
            return driveItemToDocument(
              item,
              driveId,
              result.text,
              result.mediaContent,
            );
          },
          fallback: null,
          itemId: item.id,
          resource: "driveItem",
          itemUnavailable: true,
        });
        if (doc) documents.push(doc);
      }

      const nextLink = result["@odata.nextLink"];
      hasMorePages = !!nextLink;
      if (nextLink) url = nextLink;

      // Use unfiltered results for checkpoint so it advances past non-text
      // files that were skipped by the client-side filter.
      const lastResult = result.value[result.value.length - 1];
      const lastModified = lastResult?.lastModifiedDateTime;

      // Advance the monotonic high-water mark
      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      const hasMore = hasMorePages || hasMoreFolders;

      // Only advance the checkpoint on the final batch. Intermediate batches
      // (hasMore=true) keep the original checkpoint so a resumed run re-visits
      // not-yet-processed folders whose files may have older timestamps.
      const checkpointAt = hasMore
        ? progress.safeLastSyncedAt
        : progress.maxLastModified;

      batchIndex++;
      this.log.debug(
        {
          driveId,
          folderId,
          batchIndex,
          itemCount: items.length,
          documentCount: documents.length,
          hasMore,
        },
        "SharePoint drive batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: buildCheckpoint({
          type: "sharepoint",
          itemUpdatedAt: checkpointAt ? new Date(checkpointAt) : undefined,
          previousLastSyncedAt: checkpointAt,
        }),
        hasMore,
      };
    }
  }

  private async listDirectSubfolders(params: {
    client: Client;
    driveId: string;
    parentId: string;
    rootFolderPath: string | undefined;
  }): Promise<string[]> {
    const { client, driveId, parentId, rootFolderPath } = params;
    const subfolders: string[] = [];

    let url: string | undefined =
      parentId === "root"
        ? buildRootSubfoldersUrl(driveId, rootFolderPath, 500)
        : buildItemSubfoldersUrl(driveId, parentId, 500);

    while (url) {
      await this.rateLimit();
      const result = (await client.api(url).get()) as GraphListResponse<{
        id: string;
        folder?: object;
        file?: object;
      }>;
      for (const item of result.value) {
        if (item.folder && !item.file) {
          subfolders.push(item.id);
        }
      }
      url = result["@odata.nextLink"];
    }

    return subfolders;
  }

  private async downloadFileData(
    client: Client,
    driveId: string,
    itemId: string,
    fileName: string,
  ): Promise<{
    text: string;
    mediaContent?: { mimeType: string; data: string };
    /** Why the text came back empty, for skip reporting on the run. */
    emptyReason?: string;
  }> {
    const ext = getFileExtension(fileName);
    const contentPath = `/drives/${driveId}/items/${itemId}/content`;

    // Plain text files: download and read as text
    if (SUPPORTED_TEXT_EXTENSIONS.has(ext)) {
      const arrayBuffer = (await client
        .api(contentPath)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      return {
        text: Buffer.from(arrayBuffer)
          .toString("utf-8")
          .slice(0, MAX_CONTENT_LENGTH),
      };
    }

    // Binary files (.docx, .pdf, .pptx): download as buffer and extract text
    if (SUPPORTED_BINARY_EXTENSIONS.has(ext)) {
      const arrayBuffer = (await client
        .api(contentPath)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      const extracted = await extractTextFromBinary({
        buffer: Buffer.from(arrayBuffer),
        ext,
        filename: fileName,
        ocr: this.ocrContext,
      });
      if (extracted.warning) {
        this.log.warn(
          { itemId, fileName, reason: extracted.warning },
          "SharePoint: PDF page extraction warning",
        );
      }
      return {
        text: extracted.text.slice(0, MAX_CONTENT_LENGTH),
        emptyReason: extracted.emptyReason,
      };
    }

    // Image files: download as base64 for multimodal embedding
    if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      const arrayBuffer = (await client
        .api(contentPath)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      if (arrayBuffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
        this.log.debug(
          { fileName, sizeBytes: arrayBuffer.byteLength },
          "SharePoint: skipping oversized image",
        );
        return {
          text: "",
          emptyReason: "Image exceeds the maximum size supported for embedding",
        };
      }
      const mimeType = IMAGE_MIME_TYPES[ext] ?? "application/octet-stream";
      const data = Buffer.from(arrayBuffer).toString("base64");
      return { text: "", mediaContent: { mimeType, data } };
    }

    this.log.debug(
      { fileName, ext },
      "SharePoint: skipping unsupported file type",
    );
    return { text: "" };
  }

  private async *syncSitePages(params: {
    client: Client;
    siteId: string;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { client, siteId, progress, syncFrom, batchSize } = params;

    let url = buildSitePagesUrl(siteId, batchSize);
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      let result: GraphListResponse<SitePage>;
      try {
        result = await client.api(url).get();
      } catch (error) {
        throw new Error(
          `Site pages query failed: ${extractErrorMessage(error)}`,
        );
      }

      const documents: ConnectorDocument[] = [];

      // Client-side incremental filter for pages (same reason as drive items:
      // $filter on lastModifiedDateTime is not reliably supported by the pages API).
      const pages = syncFrom
        ? result.value.filter((p) =>
            isModifiedSince(p.lastModifiedDateTime, syncFrom),
          )
        : result.value;

      for (const page of pages) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const content = await this.fetchPageContent(
              client,
              siteId,
              page.id,
            );
            // Skip pages with no extractable content to avoid indexing
            // title-only documents that provide no search value.
            if (!content.trim()) {
              this.trackSkipped({
                itemId: page.id,
                sourceId: `page-${page.id}`,
                name: page.title || page.name,
                reason: "Page has no extractable content",
                category: "no_extractable_text",
              });
              return null;
            }
            return sitePageToDocument(page, siteId, content);
          },
          fallback: null,
          itemId: page.id,
          resource: "sitePage",
          itemUnavailable: true,
        });
        if (doc) documents.push(doc);
      }

      const nextLink = result["@odata.nextLink"];
      hasMore = !!nextLink;
      if (nextLink) url = nextLink;

      const lastPage = result.value[result.value.length - 1];
      const lastModified = lastPage?.lastModifiedDateTime;

      // Advance the monotonic high-water mark
      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      const checkpointAt = hasMore
        ? progress.safeLastSyncedAt
        : progress.maxLastModified;

      batchIndex++;
      this.log.debug(
        {
          batchIndex,
          pageCount: result.value.length,
          documentCount: documents.length,
          hasMore,
        },
        "SharePoint site pages batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: buildCheckpoint({
          type: "sharepoint",
          itemUpdatedAt: checkpointAt ? new Date(checkpointAt) : undefined,
          previousLastSyncedAt: checkpointAt,
        }),
        hasMore,
      };
    }
  }

  private async fetchPageContent(
    client: Client,
    siteId: string,
    pageId: string,
  ): Promise<string> {
    const apiPath = `${GRAPH_API_BASE}/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage/webParts`;

    let result: {
      value: Array<{
        "@odata.type"?: string;
        innerHtml?: string;
        data?: { properties?: Record<string, unknown> };
      }>;
    };

    try {
      result = await client.api(apiPath).get();
    } catch (error) {
      throw new Error(
        `Failed to fetch page content for ${pageId}: ${extractErrorMessage(error)}`,
      );
    }

    const parts: string[] = [];
    for (const webPart of result.value) {
      if (webPart.innerHtml) {
        parts.push(stripHtmlTags(webPart.innerHtml));
      }
    }

    return parts.join("\n\n").slice(0, MAX_CONTENT_LENGTH);
  }

  private async countDriveItems(params: {
    client: Client;
    driveId: string;
    folderPath: string | undefined;
    recursive: boolean;
    maxDepth: number | undefined;
    syncFrom: string | undefined;
    imageMimeTypes: ReadonlySet<string>;
  }): Promise<number> {
    const {
      client,
      driveId,
      folderPath,
      recursive,
      maxDepth,
      syncFrom,
      imageMimeTypes,
    } = params;

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (parentId) =>
        this.listDirectSubfolders({
          client,
          driveId,
          parentId,
          rootFolderPath: folderPath,
        }),
    };

    let count = 0;
    for await (const folderId of traverseFolders(
      adapter,
      { rootFolderId: "root", recursive, maxDepth },
      this.log,
    )) {
      count += await this.countFilesInFolder({
        client,
        driveId,
        folderId,
        rootFolderPath: folderId === "root" ? folderPath : undefined,
        syncFrom,
        imageMimeTypes,
      });
    }

    return count;
  }

  private async countFilesInFolder(params: {
    client: Client;
    driveId: string;
    folderId: string;
    rootFolderPath: string | undefined;
    syncFrom: string | undefined;
    imageMimeTypes: ReadonlySet<string>;
  }): Promise<number> {
    const {
      client,
      driveId,
      folderId,
      rootFolderPath,
      syncFrom,
      imageMimeTypes,
    } = params;

    let url: string | undefined =
      folderId === "root"
        ? buildRootChildrenUrl(driveId, rootFolderPath, 500)
        : buildItemChildrenUrl(driveId, folderId, 500);

    let count = 0;
    while (url) {
      const result = (await client
        .api(url)
        .get()) as GraphListResponse<DriveItem>;
      count += result.value.filter(
        (item) =>
          item.file &&
          !item.folder &&
          isSupportedFile(item.name, imageMimeTypes) &&
          isModifiedSince(item.lastModifiedDateTime, syncFrom),
      ).length;
      url = result["@odata.nextLink"] ?? undefined;
    }

    return count;
  }

  private async countSitePages(params: {
    client: Client;
    siteId: string;
    syncFrom: string | undefined;
  }): Promise<number> {
    let url = buildSitePagesUrl(params.siteId, 500);
    let count = 0;

    while (url) {
      const result = (await params.client
        .api(url)
        .get()) as GraphListResponse<SitePage>;
      count += result.value.filter((page) =>
        isModifiedSince(page.lastModifiedDateTime, params.syncFrom),
      ).length;
      url = result["@odata.nextLink"] ?? "";
    }

    return count;
  }

  // ===== Permission-sync internals =====

  /** Arm (or re-arm) the per-pass state every permission hook shares. */
  private initPermissionPass(
    credentials: ConnectorCredentials,
    config: SharePointConfig,
  ): void {
    this.permCredentials = credentials;
    this.permConfig = config;
    this.userEmailCache = new Map();
    this.entraGroupCache = new Map();
    this.spGroupCache = new Map();
    this.tenantUsersCache = undefined;
    this.graphUsersTier = null;
    this.graphGroupsTier = null;
    this.spRestTier = null;
    this.deltaSharingTier = null;
    this.spAccessToken = null;
    this.droppedPrincipals = 0;
    this.mappedEmailResolver = null;
  }

  /** The connector's top-level containers, sorted for a monotonic cursor. */
  private async topContainers(
    client: Client,
    config: SharePointConfig,
    siteId: string,
  ): Promise<SpContainer[]> {
    const driveIds =
      config.driveIds && config.driveIds.length > 0
        ? config.driveIds
        : await this.listDriveIds(client, siteId);
    const containers: SpContainer[] = driveIds.map((id) => ({
      key: `drive:${id}`,
      kind: "drive",
    }));
    if (config.includePages !== false) {
      containers.push({ key: `site:${siteId}`, kind: "site" });
    }
    return containers.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
  }

  private async *syncDriveContainerSnapshot(
    client: Client,
    containerKey: string,
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const driveId = containerKey.slice("drive:".length);
    // The corpus enumeration: one delta walk with hierarchicalsharing, which
    // marks permission-hierarchy roots (items whose permissions no longer
    // inherit) so unique-permission detection costs no per-item requests.
    const walk = await this.walkDriveDelta(client, containerKey, {
      forProbe: false,
    });
    const items = walk.items ?? new Map();

    const docIds: string[] = [];
    let afterId: string | null = null;
    for (;;) {
      const { documents, nextAfterId } = await params.readIngestedDocuments({
        metadataFilter: { driveId },
        afterId,
        limit: PERMISSION_READBACK_PAGE_SIZE,
      });
      for (const doc of documents) docIds.push(doc.sourceId);
      if (documents.length < PERMISSION_READBACK_PAGE_SIZE) break;
      afterId = nextAfterId;
    }
    docIds.sort();

    if (docIds.length === 0) {
      // Empty corpus: emit the fail-closed boundary container WITHOUT
      // resolving its audience (Jira precedent — not a resolution failure).
      yield {
        kind: "container",
        containerKey,
        permissions: { isPublic: false, users: [], groups: [] },
        audienceResolutionFailed: false,
        cursor: containerKey,
      };
      return;
    }

    const root = await this.resolveDriveRootAudience(client, driveId);
    yield {
      kind: "container",
      containerKey,
      permissions: root.permissions,
      audienceResolutionFailed: root.resolutionFailed,
      cursor: containerKey,
    };

    const emittedNested = new Set<string>();
    for (const sourceId of docIds) {
      const governingItemId = this.findGoverningScopeRoot(items, sourceId);
      if (!governingItemId) {
        yield {
          kind: "document",
          sourceId,
          containerKey,
          cursor: containerKey,
        };
        continue;
      }
      const nestedKey = `${containerKey}/item:${governingItemId}`;
      if (!emittedNested.has(nestedKey)) {
        const audience = await this.resolveItemAudience(
          client,
          driveId,
          governingItemId,
        );
        yield {
          kind: "container",
          containerKey: nestedKey,
          permissions: audience.permissions,
          audienceResolutionFailed: audience.resolutionFailed,
          cursor: containerKey,
        };
        emittedNested.add(nestedKey);
      }
      yield {
        kind: "document",
        sourceId,
        containerKey: nestedKey,
        cursor: containerKey,
      };
    }
  }

  private async *syncSiteContainerSnapshot(
    client: Client,
    containerKey: string,
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const siteId = containerKey.slice("site:".length);
    const docIds: string[] = [];
    let afterId: string | null = null;
    for (;;) {
      const { documents, nextAfterId } = await params.readIngestedDocuments({
        metadataFilter: { siteId },
        afterId,
        limit: PERMISSION_READBACK_PAGE_SIZE,
      });
      for (const doc of documents) docIds.push(doc.sourceId);
      if (documents.length < PERMISSION_READBACK_PAGE_SIZE) break;
      afterId = nextAfterId;
    }
    docIds.sort();

    const audience =
      docIds.length > 0
        ? await this.resolveSitePagesAudience(client, containerKey)
        : // Empty corpus: boundary container only (Jira precedent).
          { permissions: emptyAudience(), resolutionFailed: false };
    yield {
      kind: "container",
      containerKey,
      permissions: audience.permissions,
      audienceResolutionFailed: audience.resolutionFailed,
      cursor: containerKey,
    };
    for (const sourceId of docIds) {
      yield {
        kind: "document",
        sourceId,
        containerKey,
        cursor: containerKey,
      };
    }
  }

  /**
   * The nearest ancestor (or self) whose permissions no longer inherit —
   * the item whose audience governs this document. `null` means the drive
   * root's audience governs. The delta walk covers the whole drive, so a
   * chain that leaves the buffer exited at the root.
   */
  private findGoverningScopeRoot(
    items: Map<string, DeltaItemEntry>,
    sourceId: string,
  ): string | null {
    let currentId: string | null = sourceId;
    while (currentId) {
      const entry = items.get(currentId);
      if (!entry || entry.parentId === null) return null;
      if (entry.scopeRoot) return currentId;
      currentId = entry.parentId;
    }
    return null;
  }

  /**
   * One drive's delta feed. Enumeration mode (`forProbe: false`) buffers
   * every item's id/parent/scope-root flag and asks for `hierarchicalsharing`
   * so scope roots carry a `shared` facet. Probe mode walks a stored delta
   * link and reports whether anything drifted — sharing-only drift when the
   * elevated `deltashowsharingchanges` preference is honored, any drift when
   * the tenant denies it (403 ⇒ cache the denial, retry coarse).
   */
  private async walkDriveDelta(
    client: Client,
    containerKey: string,
    opts: { token?: string; forProbe: boolean },
  ): Promise<{
    items: Map<string, DeltaItemEntry> | null;
    deltaLink: string;
    sawChange: boolean;
  }> {
    const driveId = containerKey.slice("drive:".length);
    const startUrl =
      opts.token ?? `${GRAPH_API_BASE}/drives/${driveId}/root/delta`;

    let sharingPreference = opts.forProbe && this.deltaSharingTier !== false;
    let url: string | undefined = startUrl;
    const items = opts.forProbe ? null : new Map<string, DeltaItemEntry>();
    let sawChange = false;

    for (;;) {
      if (!url) break;
      await this.rateLimit();
      let result: GraphDeltaPage;
      try {
        result = (await client
          .api(url)
          .header(
            "Prefer",
            opts.forProbe
              ? sharingPreference
                ? DELTA_SHARING_PREFER
                : DELTA_PLAIN_PREFER
              : DELTA_ENUM_PREFER,
          )
          .get()) as GraphDeltaPage;
      } catch (error) {
        if (opts.forProbe && sharingPreference && isGraphForbidden(error)) {
          // Progressive degradation: the app lacks Sites.FullControl.All —
          // the sharing-aware preference is rejected, so probe coarsely (any
          // drift dirties the container) for the rest of this pass.
          sharingPreference = false;
          this.deltaSharingTier = false;
          this.log.warn(
            "SharePoint delta sharing-change preference rejected (Sites.FullControl.All missing); probing coarsely",
          );
          url = startUrl;
          sawChange = false;
          continue;
        }
        throw error;
      }

      for (const item of result.value ?? []) {
        if (opts.forProbe) {
          if (sharingPreference) {
            const marker = item["@microsoft.graph.sharedChanged"];
            if (marker === "True" || marker === "true" || marker === true) {
              sawChange = true;
            }
          } else {
            sawChange = true;
          }
          continue;
        }
        if (item.deleted) continue;
        const parentId = item.parentReference?.id ?? null;
        items?.set(item.id, {
          parentId,
          // hierarchicalsharing marks permission-hierarchy roots with a
          // `shared` facet (empty when the root establishes an unshared
          // scope) — presence is the unique-permissions signal.
          scopeRoot: parentId !== null && item.shared !== undefined,
        });
      }

      const deltaLink = result["@odata.deltaLink"];
      if (deltaLink) {
        return { items, deltaLink, sawChange };
      }
      url = result["@odata.nextLink"] ?? undefined;
    }
    // A delta walk always ends in a deltaLink; reaching here means the feed
    // ended without one — treat as a rejected token upstream of the caller.
    throw new Error("SharePoint delta walk ended without a delta link");
  }

  private async getLatestDeltaToken(
    client: Client,
    containerKey: string,
  ): Promise<string> {
    const driveId = containerKey.slice("drive:".length);
    await this.rateLimit();
    const result = (await client
      .api(`${GRAPH_API_BASE}/drives/${driveId}/root/delta?token=latest`)
      .get()) as GraphDeltaPage;
    return result["@odata.deltaLink"] ?? "";
  }

  private async captureDeltaTokens(
    client: Client,
    containers: SpContainer[],
  ): Promise<Record<string, string>> {
    const tokens: Record<string, string> = {};
    for (const container of containers) {
      if (container.kind !== "drive") continue;
      tokens[container.key] = await this.getLatestDeltaToken(
        client,
        container.key,
      );
    }
    return tokens;
  }

  /** A drive root's effective audience; failure fail-closes the corpus. */
  private async resolveDriveRootAudience(
    client: Client,
    driveId: string,
  ): Promise<{ permissions: DocumentPermissions; resolutionFailed: boolean }> {
    try {
      const permissions = await this.listItemPermissions(
        client,
        `/drives/${driveId}/root/permissions`,
      );
      return {
        permissions: await this.permissionsToAudience(permissions),
        resolutionFailed: false,
      };
    } catch (error) {
      this.log.error(
        { driveId, error: extractErrorMessage(error) },
        "Could not read the drive root's permissions; every document in it is fail-closed for this pass",
      );
      return { permissions: emptyAudience(), resolutionFailed: true };
    }
  }

  /**
   * One item's effective audience (the permission list folds inherited
   * entries in — no inheritance math here). A read failure fail-closes THIS
   * item's subtree only — never fall back to the parent audience on error
   * (a transient 429/5xx must not become an over-grant).
   */
  private async resolveItemAudience(
    client: Client,
    driveId: string,
    itemId: string,
  ): Promise<{ permissions: DocumentPermissions; resolutionFailed: boolean }> {
    try {
      const permissions = await this.listItemPermissions(
        client,
        `/drives/${driveId}/items/${itemId}/permissions`,
      );
      return {
        permissions: await this.permissionsToAudience(permissions),
        resolutionFailed: false,
      };
    } catch (error) {
      this.log.warn(
        { driveId, itemId, error: extractErrorMessage(error) },
        "Could not read the item's permissions; its documents are fail-closed for this pass",
      );
      return { permissions: emptyAudience(), resolutionFailed: true };
    }
  }

  /**
   * Site pages have no v1.0 permission API, so the pages container takes the
   * site's DEFAULT drive root audience — site-level groups govern both
   * (documented approximation).
   */
  private async resolveSitePagesAudience(
    client: Client,
    containerKey: string,
  ): Promise<{ permissions: DocumentPermissions; resolutionFailed: boolean }> {
    const siteId = containerKey.slice("site:".length);
    try {
      await this.rateLimit();
      const drive = (await client
        .api(`${GRAPH_API_BASE}/sites/${siteId}/drive?$select=id`)
        .get()) as { id?: string };
      if (!drive.id) throw new Error("site has no default drive");
      return await this.resolveDriveRootAudience(client, drive.id);
    } catch (error) {
      this.log.error(
        { siteId, error: extractErrorMessage(error) },
        "Could not read the site's default drive permissions; every page is fail-closed for this pass",
      );
      return { permissions: emptyAudience(), resolutionFailed: true };
    }
  }

  /** Paginate a Graph permission collection. */
  private async listItemPermissions(
    client: Client,
    path: string,
  ): Promise<SpPermission[]> {
    const out: SpPermission[] = [];
    let url: string | undefined = `${GRAPH_API_BASE}${path}`;
    while (url) {
      await this.rateLimit();
      const result = (await client
        .api(url)
        .get()) as GraphListResponse<SpPermission>;
      out.push(...(result.value ?? []));
      url = result["@odata.nextLink"] ?? undefined;
    }
    return out;
  }

  /**
   * Map Graph permission principals to a document audience. Group grants
   * emit group REFERENCES (`entra:<guid>` / `sitegroup:<title>`) — resolved
   * to users at query time through the roster `syncGroups` maintains — and
   * direct users resolve inline to emails (with the admin member-override
   * fallback for accounts whose upstream email is hidden). Anonymous links
   * are genuinely public (isPublic — the Jira "anyone" precedent);
   * organization links expand to the tenant's active users, NOT org-wide
   * (a revocable set — the Jira applicationRole precedent). Application
   * grants carry no user access and are ignored.
   */
  private async permissionsToAudience(
    permissions: SpPermission[],
  ): Promise<DocumentPermissions> {
    const users = new Set<string>();
    const groups = new Set<string>();
    let isPublic = false;
    for (const permission of permissions) {
      const scope = permission.link?.scope;
      if (scope === "anonymous") {
        isPublic = true;
      } else if (scope === "organization") {
        const tenantUsers = await this.expandTenantUsers();
        if (tenantUsers) {
          for (const email of tenantUsers) users.add(email);
        }
      }
      const identitySets = [
        permission.grantedToV2,
        ...(permission.grantedToIdentitiesV2 ?? []),
      ];
      for (const identitySet of identitySets) {
        await this.applyIdentitySet(identitySet, users, groups);
      }
    }
    return { isPublic, users: [...users], groups: [...groups] };
  }

  private async applyIdentitySet(
    identitySet: SpIdentitySet | undefined,
    users: Set<string>,
    groups: Set<string>,
  ): Promise<void> {
    if (!identitySet) return;
    if (identitySet.user?.id) {
      const email = await this.resolveGraphUserEmail(identitySet.user.id);
      const mapped = email ?? this.mappedEmailResolver?.(identitySet.user.id);
      if (mapped) users.add(mapped.toLowerCase());
      else this.droppedPrincipals += 1;
    }
    if (identitySet.siteUser?.loginName) {
      await this.applyLoginName(identitySet.siteUser.loginName, users, groups);
    }
    if (identitySet.siteGroup?.displayName) {
      groups.add(spGroupRef(identitySet.siteGroup.displayName));
    }
    if (identitySet.group?.id) {
      groups.add(entraGroupRef(identitySet.group.id));
    }
  }

  /**
   * A SharePoint claims login name → whoever it denotes: a user email
   * (`i:0#.f|membership|user@domain`), an Entra group
   * (`…|federateddirectoryclaimprovider|<guid>`), or the whole-tenant claim
   * (`spo-grid-all-users` / `rolemanager|…|true`).
   */
  private async applyLoginName(
    loginName: string,
    users: Set<string>,
    groups: Set<string>,
  ): Promise<void> {
    const lowered = loginName.toLowerCase();
    if (
      lowered.includes("spo-grid-all-users") ||
      lowered.includes("|rolemanager|") ||
      lowered === "c:0(.s|true"
    ) {
      const tenantUsers = await this.expandTenantUsers();
      if (tenantUsers) {
        for (const email of tenantUsers) users.add(email);
      }
      return;
    }
    if (lowered.includes("|federateddirectoryclaimprovider|")) {
      const groupId = loginName.split("|").pop();
      if (groupId) groups.add(entraGroupRef(groupId));
      else this.droppedPrincipals += 1;
      return;
    }
    if (lowered.startsWith("i:0#.f|membership|")) {
      const email = loginName.split("|").pop()?.toLowerCase();
      if (email?.includes("@")) {
        users.add(email);
        return;
      }
    }
    const mapped = this.mappedEmailResolver?.(loginName);
    if (mapped) {
      users.add(mapped.toLowerCase());
      return;
    }
    this.droppedPrincipals += 1;
  }

  /** Graph user id → email. Tier: User.Read.All (probed once per pass). */
  private async resolveGraphUserEmail(userId: string): Promise<string | null> {
    const cached = this.userEmailCache.get(userId);
    if (cached !== undefined) return cached;
    let email: string | null = null;
    if (await this.hasGraphUsersTier()) {
      try {
        const client = this.getGraphClient(
          this.requirePermCredentials(),
          this.requirePermConfig(),
        );
        await this.rateLimit();
        const user = (await client
          .api(
            `${GRAPH_API_BASE}/users/${userId}?$select=mail,userPrincipalName`,
          )
          .get()) as { mail?: string | null; userPrincipalName?: string };
        email = (user.mail ?? user.userPrincipalName)?.toLowerCase() ?? null;
      } catch (error) {
        this.log.debug(
          { error: extractErrorMessage(error) },
          "Could not resolve Graph user email",
        );
      }
    }
    this.userEmailCache.set(userId, email);
    return email;
  }

  /**
   * Entra/M365 group → transitive member roster. Tier: GroupMember.Read.All.
   * Nested groups arrive pre-flattened (transitiveMembers); non-user
   * directory objects are skipped. A member whose email is hidden is still
   * rostered (email: null — admin-visible, override-assignable).
   */
  private async expandEntraGroup(
    groupId: string,
  ): Promise<GroupMemberYield[] | null> {
    const cached = this.entraGroupCache.get(groupId);
    if (cached !== undefined) return cached;
    if (this.graphGroupsTier === false) return null;
    let members: GroupMemberYield[] | null = null;
    try {
      const client = this.getGraphClient(
        this.requirePermCredentials(),
        this.requirePermConfig(),
      );
      const byAccount = new Map<string, GroupMemberYield>();
      let url: string | undefined =
        `${GRAPH_API_BASE}/groups/${groupId}/transitiveMembers?$select=id,displayName,mail,userPrincipalName,accountEnabled&$top=999`;
      while (url) {
        await this.rateLimit();
        const result = (await client.api(url).get()) as GraphListResponse<{
          "@odata.type"?: string;
          id?: string;
          displayName?: string | null;
          mail?: string | null;
          userPrincipalName?: string;
          accountEnabled?: boolean;
        }>;
        for (const member of result.value ?? []) {
          if (!member.id) continue;
          const odataType = member["@odata.type"];
          // transitiveMembers mixes users with nested groups/devices; only
          // user objects carry access. Entries without a type hint are kept
          // when they look like users (have a UPN).
          if (odataType && !odataType.endsWith("user")) continue;
          if (!odataType && !member.userPrincipalName && !member.mail) {
            continue;
          }
          const email =
            member.accountEnabled === false
              ? null
              : ((member.mail ?? member.userPrincipalName)?.toLowerCase() ??
                null);
          byAccount.set(member.id, {
            accountId: member.id,
            displayName: member.displayName ?? null,
            email,
          });
        }
        url = result["@odata.nextLink"] ?? undefined;
      }
      members = [...byAccount.values()];
      this.graphGroupsTier = true;
    } catch (error) {
      if (isGraphForbidden(error)) {
        this.graphGroupsTier = false;
        this.log.warn(
          "Entra group expansion denied (GroupMember.Read.All missing); group memberships degrade fail-closed for this pass",
        );
      } else {
        this.log.warn(
          { error: extractErrorMessage(error) },
          "Could not expand Entra group; its memberships are dropped fail-closed",
        );
      }
      this.droppedPrincipals += 1;
    }
    this.entraGroupCache.set(groupId, members);
    return members;
  }

  /**
   * SharePoint site group → member roster via the site's REST API (Graph
   * cannot expand site groups). Tier: SharePoint Sites.FullControl.All —
   * the SAME app registration, a second token audience. Direct users roster
   * by email/claims; a nested Entra-group claim is flattened through the
   * Graph roster expansion (Salesforce nesting precedent); a whole-tenant
   * claim cannot be rostered and is kept as an email-less member so the
   * admin can see it rather than it vanishing.
   */
  private async expandSpGroup(
    title: string,
  ): Promise<GroupMemberYield[] | null> {
    const cached = this.spGroupCache.get(title);
    if (cached !== undefined) return cached;
    if (this.spRestTier === false) return null;
    let members: GroupMemberYield[] | null = null;
    const token = await this.getSpAccessToken();
    const siteUrl = this.permConfig?.siteUrl;
    if (token && siteUrl) {
      try {
        const path = `_api/web/sitegroups/getbyname('${encodeURIComponent(title).replace(/'/g, "''")}')/users?$select=Email,LoginName,Title&$top=5000`;
        const response = await this.fetchWithRetry(
          `${siteUrl.replace(/\/+$/, "")}/${path}`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json;odata=nometadata",
            },
          },
        );
        if (response.status === 401 || response.status === 403) {
          throw new SpRestForbiddenError();
        }
        if (!response.ok) {
          throw new Error(`SharePoint REST ${response.status}`);
        }
        const body = (await response.json()) as {
          value?: Array<{ Email?: string; LoginName?: string; Title?: string }>;
        };
        const byAccount = new Map<string, GroupMemberYield>();
        for (const member of body.value ?? []) {
          const loginName = member.LoginName ?? "";
          const lowered = loginName.toLowerCase();
          if (lowered.includes("|federateddirectoryclaimprovider|")) {
            const nestedId = loginName.split("|").pop();
            const nested = nestedId
              ? await this.expandEntraGroup(nestedId)
              : null;
            for (const m of nested ?? []) byAccount.set(m.accountId, m);
            continue;
          }
          const accountId = loginName || member.Email?.toLowerCase();
          if (!accountId) continue;
          const claimEmail = lowered.startsWith("i:0#.f|membership|")
            ? loginName.split("|").pop()?.toLowerCase()
            : undefined;
          const email =
            member.Email?.toLowerCase() ??
            (claimEmail?.includes("@") ? claimEmail : null);
          byAccount.set(accountId, {
            accountId,
            displayName: member.Title ?? null,
            email,
            accountType: "siteUser",
          });
        }
        members = [...byAccount.values()];
        this.spRestTier = true;
      } catch (error) {
        if (error instanceof SpRestForbiddenError) {
          this.spRestTier = false;
          this.log.warn(
            "SharePoint REST denied (SharePoint Sites.FullControl.All missing); site-group memberships degrade fail-closed for this pass",
          );
        } else {
          this.log.warn(
            { error: extractErrorMessage(error) },
            "Could not expand SharePoint site group; its memberships are dropped fail-closed",
          );
        }
        this.droppedPrincipals += 1;
      }
    }
    this.spGroupCache.set(title, members);
    return members;
  }

  /** All active tenant users (org-wide links). Tier: User.Read.All. */
  private async expandTenantUsers(): Promise<string[] | null> {
    if (this.tenantUsersCache !== undefined) return this.tenantUsersCache;
    let members: string[] | null = null;
    if (await this.hasGraphUsersTier()) {
      try {
        const client = this.getGraphClient(
          this.requirePermCredentials(),
          this.requirePermConfig(),
        );
        const emails = new Set<string>();
        let url: string | undefined =
          `${GRAPH_API_BASE}/users?$select=mail,userPrincipalName,accountEnabled&$top=999`;
        while (url) {
          await this.rateLimit();
          const result = (await client.api(url).get()) as GraphListResponse<{
            mail?: string | null;
            userPrincipalName?: string;
            accountEnabled?: boolean;
          }>;
          for (const user of result.value ?? []) {
            if (user.accountEnabled === false) continue;
            const email = (user.mail ?? user.userPrincipalName)?.toLowerCase();
            if (email) emails.add(email);
          }
          url = result["@odata.nextLink"] ?? undefined;
        }
        members = [...emails];
      } catch (error) {
        this.log.warn(
          { error: extractErrorMessage(error) },
          "Could not enumerate tenant users; organization-wide links degrade fail-closed for this pass",
        );
      }
    }
    if (!members) this.droppedPrincipals += 1;
    this.tenantUsersCache = members;
    return members;
  }

  /** User.Read.All probe, cached per pass. */
  private async hasGraphUsersTier(): Promise<boolean> {
    if (this.graphUsersTier === null) {
      try {
        const client = this.getGraphClient(
          this.requirePermCredentials(),
          this.requirePermConfig(),
        );
        await this.rateLimit();
        await client.api(`${GRAPH_API_BASE}/users?$select=id&$top=1`).get();
        this.graphUsersTier = true;
      } catch (error) {
        this.graphUsersTier = false;
        this.log.debug(
          { error: extractErrorMessage(error) },
          "Graph users tier unavailable (User.Read.All missing); Graph-id principals drop fail-closed",
        );
      }
    }
    return this.graphUsersTier;
  }

  /** SharePoint-resource access token for the SAME app registration. */
  private async getSpAccessToken(): Promise<string | null> {
    if (this.spAccessToken) return this.spAccessToken;
    const credentials = this.permCredentials;
    const config = this.permConfig;
    if (!credentials?.email || !config) return null;
    try {
      const hostname = new URL(config.siteUrl).hostname;
      const credential = new ClientSecretCredential(
        config.tenantId,
        credentials.email,
        credentials.apiToken,
      );
      const token = await credential.getToken(`https://${hostname}/.default`);
      this.spAccessToken = token?.token ?? null;
    } catch (error) {
      this.log.debug(
        { error: extractErrorMessage(error) },
        "Could not acquire a SharePoint-resource token",
      );
      this.spAccessToken = null;
    }
    return this.spAccessToken;
  }

  private requirePermCredentials(): ConnectorCredentials {
    if (!this.permCredentials) throw new Error("permission pass not armed");
    return this.permCredentials;
  }

  private requirePermConfig(): SharePointConfig {
    if (!this.permConfig) throw new Error("permission pass not armed");
    return this.permConfig;
  }

  /** Surface principals dropped this pass (fail-closed under-grant). */
  private reportDroppedPrincipals(): void {
    if (this.droppedPrincipals <= 0) return;
    const count = this.droppedPrincipals;
    this.droppedPrincipals = 0;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped SharePoint principals that could not be resolved (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }
}

// ===== Module-level helpers =====

type GraphListResponse<T> = {
  value: T[];
  "@odata.nextLink"?: string;
};

// ===== Permission-sync types =====

const PERMISSION_READBACK_PAGE_SIZE = 1000;
/** Scanning-guidance preference: mark permission-hierarchy roots. */
const DELTA_ENUM_PREFER = "deltashowremovedasdeleted, hierarchicalsharing";
/** Elevated probe preference: annotate items whose SHARING changed. */
const DELTA_SHARING_PREFER =
  "deltashowremovedasdeleted, deltatraversepermissiongaps, deltashowsharingchanges";
const DELTA_PLAIN_PREFER = "deltashowremovedasdeleted";

/** A top-level permission container: a document library, or the site's pages. */
type SpContainer = { key: string; kind: "drive" | "site" };

/** One buffered delta-walk item (ids + the unique-permissions marker only). */
type DeltaItemEntry = { parentId: string | null; scopeRoot: boolean };

type GraphDeltaPage = {
  value?: Array<{
    id: string;
    parentReference?: { id?: string };
    deleted?: object;
    shared?: object;
    "@microsoft.graph.sharedChanged"?: string | boolean;
  }>;
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

/** Narrowed Graph permission resource (the facets we read). */
type SpPermission = {
  link?: { scope?: string };
  grantedToV2?: SpIdentitySet;
  grantedToIdentitiesV2?: SpIdentitySet[];
};

type SpIdentitySet = {
  user?: { id?: string; displayName?: string };
  siteUser?: { loginName?: string; displayName?: string };
  siteGroup?: { displayName?: string };
  group?: { id?: string };
  application?: { id?: string };
};

/**
 * Roster group ids — byte-matched between the audience path's `groups` refs
 * and `syncGroups` yields (the `group:sharepoint_<id>` token contract).
 */
function entraGroupRef(groupId: string): string {
  return `entra:${groupId}`;
}
function spGroupRef(title: string): string {
  return `sitegroup:${title}`;
}
/** Synthetic roster group for direct (non-group) grantees. */
const DIRECT_GRANTS_GROUP_ID = "direct-grants";

class SpRestForbiddenError extends Error {
  constructor() {
    super("SharePoint REST forbidden");
  }
}

function emptyAudience(): DocumentPermissions {
  return { isPublic: false, users: [], groups: [] };
}

/** 401/403 from the Graph SDK (statusCode on the thrown object). */
function isGraphForbidden(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;
  return status === 401 || status === 403;
}

// Narrowed from @microsoft/microsoft-graph-types using Pick + Required + NonNullable.
// Our $select queries guarantee these fields are present and non-null.
type RequiredNonNull<T, K extends keyof T> = {
  [P in K]-?: NonNullable<T[P]>;
};

type DriveItem = RequiredNonNull<
  GraphDriveItem,
  | "id"
  | "name"
  | "webUrl"
  | "lastModifiedDateTime"
  | "createdDateTime"
  | "size"
  | "file"
  | "folder"
  | "parentReference"
>;

type SitePage = RequiredNonNull<
  GraphSitePage,
  | "id"
  | "name"
  | "title"
  | "webUrl"
  | "lastModifiedDateTime"
  | "createdDateTime"
  | "description"
>;

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function parseSharePointConfig(
  config: Record<string, unknown>,
): SharePointConfig | null {
  const result = SharePointConfigSchema.safeParse({
    type: "sharepoint",
    ...config,
  });
  return result.success ? result.data : null;
}

function buildResolveSiteErrorMessage(error?: string): string {
  if (!error) {
    return "Could not resolve SharePoint site. Verify the site URL and app permissions.";
  }

  return `Could not resolve SharePoint site. ${error}`;
}

function formatSharePointGraphError(params: {
  error: unknown;
  apiPath: string;
}): string {
  const { error, apiPath } = params;
  const parts = [`Graph path: ${apiPath}`];

  const statusCode = getGraphStatusCode(error);
  if (statusCode !== null) {
    parts.push(`status: ${statusCode}`);
  }

  const graphCode = getGraphCode(error);
  if (graphCode) {
    parts.push(`code: ${graphCode}`);
  }

  const requestId = getGraphRequestId(error);
  if (requestId) {
    parts.push(`request-id: ${requestId}`);
  }

  const clientRequestId = getGraphClientRequestId(error);
  if (clientRequestId) {
    parts.push(`client-request-id: ${clientRequestId}`);
  }

  const message = extractGraphErrorMessage(error);
  if (message) {
    parts.push(`message: ${message}`);
  }

  return parts.join("; ");
}

function extractGraphErrorMessage(error: unknown): string {
  const bodyMessage = getGraphBodyMessage(error);
  if (bodyMessage) {
    return bodyMessage;
  }

  return extractErrorMessage(error);
}

function getGraphStatusCode(error: unknown): number | null {
  const value = (error as { statusCode?: unknown })?.statusCode;
  return typeof value === "number" ? value : null;
}

function getGraphCode(error: unknown): string | null {
  const value = (error as { code?: unknown })?.code;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getGraphRequestId(error: unknown): string | null {
  const direct = (error as { requestId?: unknown })?.requestId;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }

  return getHeaderValue(error, "request-id");
}

function getGraphClientRequestId(error: unknown): string | null {
  return getHeaderValue(error, "client-request-id");
}

function getHeaderValue(error: unknown, headerName: string): string | null {
  const headers = (error as { headers?: unknown })?.headers;
  if (!headers || typeof headers !== "object" || !("get" in headers)) {
    return null;
  }

  const get = (headers as { get?: unknown }).get;
  if (typeof get !== "function") {
    return null;
  }

  const value = get.call(headers, headerName);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getGraphBodyMessage(error: unknown): string | null {
  const body = (error as { body?: unknown })?.body;
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(body) as {
      message?: unknown;
      error?: { message?: unknown; innerError?: { date?: unknown } };
    };

    if (typeof parsed.message === "string" && parsed.message.length > 0) {
      return parsed.message;
    }

    const nested = parsed.error?.message;
    if (typeof nested === "string" && nested.length > 0) {
      return nested;
    }
  } catch {
    return body;
  }

  return null;
}

function buildRootChildrenUrl(
  driveId: string,
  folderPath: string | undefined,
  batchSize: number,
): string {
  const basePath = folderPath
    ? `${GRAPH_API_BASE}/drives/${driveId}/root:/${encodeGraphPath(folderPath)}:/children`
    : `${GRAPH_API_BASE}/drives/${driveId}/root/children`;

  const params = new URLSearchParams({
    $select:
      "id,name,webUrl,lastModifiedDateTime,createdDateTime,size,file,folder,parentReference",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  return `${basePath}?${params.toString()}`;
}

function buildItemChildrenUrl(
  driveId: string,
  itemId: string,
  batchSize: number,
): string {
  const params = new URLSearchParams({
    $select:
      "id,name,webUrl,lastModifiedDateTime,createdDateTime,size,file,folder,parentReference",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  return `${GRAPH_API_BASE}/drives/${driveId}/items/${itemId}/children?${params.toString()}`;
}

function buildRootSubfoldersUrl(
  driveId: string,
  folderPath: string | undefined,
  batchSize: number,
): string {
  const basePath = folderPath
    ? `${GRAPH_API_BASE}/drives/${driveId}/root:/${encodeGraphPath(folderPath)}:/children`
    : `${GRAPH_API_BASE}/drives/${driveId}/root/children`;

  const params = new URLSearchParams({
    $select: "id,folder,file",
    $top: String(batchSize),
  });

  return `${basePath}?${params.toString()}`;
}

function buildItemSubfoldersUrl(
  driveId: string,
  itemId: string,
  batchSize: number,
): string {
  const params = new URLSearchParams({
    $select: "id,folder,file",
    $top: String(batchSize),
  });

  return `${GRAPH_API_BASE}/drives/${driveId}/items/${itemId}/children?${params.toString()}`;
}

function buildSitePagesUrl(siteId: string, batchSize: number): string {
  const params = new URLSearchParams({
    $select:
      "id,name,title,webUrl,lastModifiedDateTime,createdDateTime,description",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  return `${GRAPH_API_BASE}/sites/${siteId}/pages?${params.toString()}`;
}

function isSupportedFile(
  name: string,
  imageMimeTypes: ReadonlySet<string>,
): boolean {
  const ext = getFileExtension(name);
  return (
    SUPPORTED_TEXT_EXTENSIONS.has(ext) ||
    SUPPORTED_BINARY_EXTENSIONS.has(ext) ||
    imageMimeTypes.has(IMAGE_MIME_TYPES[ext] ?? "")
  );
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0) return "";
  return name.slice(lastDot).toLowerCase();
}

function encodeGraphPath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function isModifiedSince(
  itemTimestamp: string | undefined,
  syncFrom: string | undefined,
): boolean {
  if (!syncFrom || !itemTimestamp) {
    return true;
  }

  const itemTime = Date.parse(itemTimestamp);
  const syncTime = Date.parse(syncFrom);

  if (!Number.isNaN(itemTime) && !Number.isNaN(syncTime)) {
    return itemTime >= syncTime;
  }

  return itemTimestamp >= syncFrom;
}

async function extractTextFromBinary(params: {
  buffer: Buffer;
  ext: string;
  filename?: string;
  ocr?: OcrRunContext;
}): Promise<{ text: string; emptyReason?: string; warning?: string }> {
  const { buffer, ext, filename, ocr } = params;
  switch (ext) {
    case ".docx": {
      return { text: await extractTextFromDocx(buffer) };
    }
    case ".pdf": {
      const result = await extractPdfText({ buffer, filename, ocr });
      return {
        text: result.text,
        emptyReason: describePdfEmptyText(result),
        warning: describePdfExtractionWarning(result),
      };
    }
    case ".pptx": {
      return { text: await extractTextFromPptx(buffer) };
    }
    case ".xlsx": {
      return { text: await extractTextFromXlsx(buffer) };
    }
    default:
      return { text: "" };
  }
}

function driveItemToDocument(
  item: DriveItem,
  driveId: string,
  content: string,
  mediaContent?: { mimeType: string; data: string },
): ConnectorDocument {
  const title = item.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: item.id,
    title,
    // For media-only documents, store the title as the text content so
    // the document record is human-readable in the UI.
    content: mediaContent && !content.trim() ? `# ${title}` : fullContent,
    sourceUrl: item.webUrl,
    metadata: {
      driveId,
      driveItemId: item.id,
      fileName: item.name,
      mimeType: item.file?.mimeType,
      size: item.size,
      lastModifiedDateTime: item.lastModifiedDateTime,
      createdDateTime: item.createdDateTime,
      parentPath: item.parentReference?.path,
    },
    updatedAt: new Date(item.lastModifiedDateTime),
    mediaContent,
  };
}

function sitePageToDocument(
  page: SitePage,
  siteId: string,
  content: string,
): ConnectorDocument {
  const title = page.title || page.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: `page-${page.id}`,
    title,
    content: fullContent,
    sourceUrl: page.webUrl,
    metadata: {
      siteId,
      pageId: page.id,
      pageName: page.name,
      description: page.description,
      lastModifiedDateTime: page.lastModifiedDateTime,
      createdDateTime: page.createdDateTime,
    },
    updatedAt: new Date(page.lastModifiedDateTime),
  };
}
