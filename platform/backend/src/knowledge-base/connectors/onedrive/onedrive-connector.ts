import type { ModelInputModality } from "@archestra/shared";
import { ClientSecretCredential } from "@azure/identity";
import { Client, ResponseType } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import type { DriveItem as GraphDriveItem } from "@microsoft/microsoft-graph-types";
import { extractPdfText, type OcrRunContext } from "@/knowledge-base/pdf-ocr";
import * as metrics from "@/observability/metrics";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DocumentPermissions,
  GroupMembershipYield,
  GroupMemberYield,
  OneDriveCheckpoint,
  OneDriveConfig,
  PermissionProbeResult,
  PermissionSnapshotYield,
  PermissionSyncParams,
  PermissionSyncState,
  ResolveMappedEmail,
} from "@/types";
import { OneDriveConfigSchema } from "@/types";
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

const SUPPORTED_BINARY_EXTENSIONS = new Set([
  ".docx",
  ".pdf",
  ".pptx",
  ".xlsx",
]);

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export class OneDriveConnector extends BaseConnector {
  type = "onedrive" as const;
  supportsPermissionSync = true;

  // ----- Per-pass permission-sync state (armed by initPermissionPass) -----
  private permCredentials: ConnectorCredentials | null = null;
  private permConfig: OneDriveConfig | null = null;
  /** Graph user id → email (null = unresolvable this pass). */
  private userEmailCache = new Map<string, string | null>();
  /** Entra group id → transitive member roster (null = expansion failed). */
  private entraGroupCache = new Map<string, GroupMemberYield[] | null>();
  /** Configured user id → resolved drive (null = resolution failed). */
  private driveInfoCache = new Map<string, OdDriveInfo | null>();
  /** Tenant active-user emails (null = enumeration failed/denied). */
  private tenantUsersCache: string[] | null | undefined;
  private graphUsersTier: boolean | null = null;
  private graphGroupsTier: boolean | null = null;
  private deltaSharingTier: boolean | null = null;
  private droppedPrincipals = 0;
  private mappedEmailResolver: ResolveMappedEmail | null = null;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseOneDriveConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid OneDrive configuration" };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing OneDrive connection");

    try {
      const config = parseOneDriveConfig(params.config);
      if (!config) {
        return { success: false, error: "Invalid configuration" };
      }

      const client = this.getGraphClient(params.credentials, config);
      const userId = config.userIds[0];

      // Lightweight call: fetch the user's drive metadata
      await client
        .api(`${GRAPH_API_BASE}/users/${userId}/drive`)
        .select("id,name")
        .get();

      this.log.debug("OneDrive connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "OneDrive connection test failed");
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
    const parsed = parseOneDriveConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as OneDriveCheckpoint | null) ?? {
        type: "onedrive" as const,
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
      let total = 0;

      for (const userId of parsed.userIds) {
        total += await this.countUserDriveItems({
          client,
          userId,
          config: parsed,
          syncFrom: safetyBufferedSyncFrom,
          imageMimeTypes,
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
    const parsed = parseOneDriveConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid OneDrive configuration");
    }

    const checkpoint = (params.checkpoint as OneDriveCheckpoint | null) ?? {
      type: "onedrive" as const,
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
    const recursive = parsed.recursive ?? true;
    const maxDepth = parsed.maxDepth;

    const client = this.getGraphClient(params.credentials, parsed);

    const progress = {
      maxLastModified: checkpoint.lastSyncedAt as string | undefined,
      safeLastSyncedAt: checkpoint.lastSyncedAt as string | undefined,
    };

    this.log.debug(
      {
        userIds: parsed.userIds,
        folderId: parsed.folderId,
        recursive,
        syncFrom,
        imageMimeTypes: [...imageMimeTypes],
      },
      "Starting OneDrive sync",
    );

    for (let i = 0; i < parsed.userIds.length; i++) {
      const userId = parsed.userIds[i];
      const isLastUser = i === parsed.userIds.length - 1;

      yield* this.syncUserDrive({
        client,
        userId,
        config: parsed,
        progress,
        syncFrom: safetyBufferedSyncFrom,
        batchSize,
        imageMimeTypes,
        recursive,
        maxDepth,
        fileTypes: parsed.fileTypes,
        hasMoreUsers: !isLastUser,
      });
    }
  }

  // ===== Permission sync =====

  /**
   * Container model: `user:<userId>` per configured user — the key is the
   * CONFIGURED id (UPN or object id), byte-matching the `metadata.userId`
   * every ingested document already carries, so existing corpora need no
   * re-ingestion and `scopeKeyForDocument` stays a pure metadata read. The
   * user's drive id is resolved once per pass for the Graph calls. Items
   * that BREAK permission inheritance (permission-hierarchy roots surfaced
   * by the delta feed's `hierarchicalsharing` preference — the SharePoint
   * mechanism verbatim; OneDrive for Business drives are Graph drives)
   * become nested `user:<id>/item:<itemId>` containers; a document's
   * container is its nearest uniquely-permissioned ancestor.
   *
   * A personal drive's root permission list does NOT include its owner, so
   * the resolved drive OWNER is added to every audience in that drive (root
   * and nested) — definitionally correct for single-owner drives, never an
   * over-grant. When the root permission read fails the container still
   * fail-closes to the empty audience (no owner shortcut): an audience we
   * could not verify is not partially granted.
   *
   * Group grants emit GROUP TOKENS (`entra:<guid>`, byte-matched into
   * `group:onedrive_…` ACL tokens) resolved at query time through the
   * roster `syncGroups` maintains. SharePoint site-group grants (rare on
   * personal drives — OneDrive is SharePoint underneath) emit
   * `sitegroup:<title>` tokens but are NOT expanded: personal sites expose
   * no practical roster API surface here, so those groups stay visible in
   * the Groups tab with an empty roster — bounded fail-closed, admin member
   * overrides still apply. Direct grantees resolve inline to emails (with
   * the `resolveMappedEmail` override fallback) and roster under the
   * synthetic `direct-grants` group. Tiers are progressive, probed lazily,
   * cached per pass, always degrading fail-closed:
   *  - base (Files.Read.All / Sites.Read.All): drive + permission lists,
   *    group-token emission (identity only — no membership)
   *  - + User.Read.All: Graph user-id → email, tenant-wide link expansion
   *  - + GroupMember.Read.All: Entra/M365 roster expansion (syncGroups)
   *  - + Sites.FullControl.All: sharing-aware delta probing
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseOneDriveConfig(params.config);
    if (!config) {
      throw new Error("Invalid OneDrive configuration for permission sync");
    }
    this.initPermissionPass(params.credentials, config);
    this.mappedEmailResolver = params.resolveMappedEmail ?? null;
    const client = this.getGraphClient(params.credentials, config);

    const containers = topContainers(config);
    const scope = params.scope ? new Set(params.scope.containerKeys) : null;

    for (const container of containers) {
      if (scope && !scope.has(container.key)) continue;
      // Resume: containers strictly before the cursor are done; the cursor
      // container is re-processed (idempotent — same audiences).
      if (params.cursor && container.key < params.cursor) continue;
      yield* this.syncUserContainerSnapshot(client, container, params);
    }

    this.reportDroppedPrincipals();
  }

  /**
   * Group roster sync (Users/Groups tabs + member overrides). Walks each
   * configured user's drive-root permission surface, collects every granted
   * Entra group and direct grantee, and expands Entra groups to members.
   * Yielded groupIds byte-match the refs the audience path emits
   * (`entra:<guid>` / `sitegroup:<title>`). Site groups yield an empty
   * roster (not expandable here — see the container-model note). Direct
   * grantees — including each drive's OWNER — roster under the synthetic
   * `direct-grants` group so unmatched accounts are visible and
   * override-assignable. A surface whose permission read fails is skipped
   * here: the audience phase owns fail-closing its containers.
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseOneDriveConfig(params.config);
    if (!config) {
      throw new Error("Invalid OneDrive configuration for group sync");
    }
    this.initPermissionPass(params.credentials, config);
    const client = this.getGraphClient(params.credentials, config);

    const entraIds = new Set<string>();
    const siteGroupTitles = new Set<string>();
    const direct = new Map<string, GroupMemberYield>();

    for (const container of topContainers(config)) {
      const info = await this.resolveUserDrive(client, container.userId);
      if (!info) continue; // audience phase owns fail-closing this container
      if (info.ownerId) {
        const email = await this.resolveGraphUserEmail(info.ownerId);
        direct.set(info.ownerId, {
          accountId: info.ownerId,
          displayName: info.ownerDisplayName ?? null,
          email: email ?? info.ownerEmail ?? null,
          accountType: "user",
        });
      }
      let permissions: OdPermission[];
      try {
        permissions = await this.listItemPermissions(
          client,
          `/drives/${info.driveId}/root/permissions`,
        );
      } catch (error) {
        this.log.warn(
          { userId: container.userId, error: extractErrorMessage(error) },
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
            siteGroupTitles,
            direct,
          );
        }
      }
    }

    for (const groupId of [...entraIds].sort()) {
      const members = await this.expandEntraGroup(groupId);
      yield { groupId: entraGroupRef(groupId), members: members ?? [] };
    }
    for (const title of [...siteGroupTitles].sort()) {
      // Not expandable on personal sites — empty roster, fail-closed.
      yield { groupId: siteGroupRef(title), members: [] };
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

  /**
   * Delta-pass probe over each configured user's drive delta feed. With the
   * elevated `deltashowsharingchanges` preference (Sites.FullControl.All),
   * items whose SHARING changed carry an annotation and only those dirty
   * the container; without the elevation any item drift dirties it (the
   * safe coarse fallback). 410 Gone / rejected token ⇒ fullRequired.
   */
  async probePermissionChanges(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    state: PermissionSyncState | null;
  }): Promise<PermissionProbeResult> {
    const config = parseOneDriveConfig(params.config);
    if (!config) {
      throw new Error("Invalid OneDrive configuration for permission probe");
    }
    this.initPermissionPass(params.credentials, config);
    const client = this.getGraphClient(params.credentials, config);
    const containers = topContainers(config);

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
      const token = stored[container.key];
      if (typeof token !== "string" || !token) {
        nextTokens[container.key] = await this.getLatestDeltaToken(
          client,
          container,
        );
        dirty.push(container.key);
        continue;
      }
      try {
        const outcome = await this.walkDriveDelta(client, container, {
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
          "OneDrive delta token rejected; promoting to a full reconcile",
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
   * `.../item:<id>` containers are deliberately NOT yielded — their
   * audiences follow assignment drift, which the enumerating passes own.
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
    const config = parseOneDriveConfig(params.config);
    if (!config) {
      throw new Error("Invalid OneDrive configuration for audience refresh");
    }
    this.initPermissionPass(params.credentials, config);
    this.mappedEmailResolver = params.resolveMappedEmail ?? null;
    const client = this.getGraphClient(params.credentials, config);

    for (const containerKey of params.containerKeys) {
      const userMatch = containerKey.match(/^user:([^/]+)$/);
      if (!userMatch) continue; // nested item containers: assignment-tier
      const audience = await this.resolveDriveRootAudience(
        client,
        userMatch[1],
      );
      yield {
        containerKey,
        permissions: audience.permissions,
        audienceResolutionFailed: audience.resolutionFailed,
      };
    }

    this.reportDroppedPrincipals();
  }

  /**
   * Local-adoption scoping for delta passes: content-sync stamps
   * `metadata.userId` on every drive item. Scoping only — the container
   * enumeration resolves the authoritative assignment, so this can never
   * over-grant.
   */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const userId = metadata.userId;
    if (typeof userId === "string" && userId.length > 0) {
      return `user:${userId}`;
    }
    return null;
  }

  // ===== Private methods =====

  private getGraphClient(
    credentials: ConnectorCredentials,
    config: OneDriveConfig,
  ): Client {
    // Reuses the same credential pattern as SharePoint:
    // credentials.email = Azure AD Application (client) ID
    // credentials.apiToken = Azure AD client secret
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

  private async *syncUserDrive(params: {
    client: Client;
    userId: string;
    config: OneDriveConfig;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    imageMimeTypes: ReadonlySet<string>;
    recursive: boolean;
    maxDepth: number | undefined;
    fileTypes: string[] | undefined;
    hasMoreUsers: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      userId,
      config,
      progress,
      syncFrom,
      batchSize,
      imageMimeTypes,
      recursive,
      maxDepth,
      fileTypes,
      hasMoreUsers,
    } = params;

    this.log.debug({ userId }, "Syncing OneDrive for user");

    const rootItemId = config.folderId ?? "root";

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (folderId) =>
        this.listDirectSubfolders({ client, userId, folderId }),
    };

    const folderGen = traverseFolders(
      adapter,
      { rootFolderId: rootItemId, recursive, maxDepth },
      this.log,
    );

    let next = await folderGen.next();
    while (!next.done) {
      const folderId = next.value;
      next = await folderGen.next();
      const hasMoreFolders = !next.done;

      yield* this.syncFilesInFolder({
        client,
        userId,
        folderId,
        progress,
        syncFrom,
        batchSize,
        imageMimeTypes,
        fileTypes,
        hasMoreFolders: hasMoreFolders || hasMoreUsers,
      });
    }
  }

  private async *syncFilesInFolder(params: {
    client: Client;
    userId: string;
    folderId: string;
    progress: {
      maxLastModified: string | undefined;
      safeLastSyncedAt: string | undefined;
    };
    syncFrom: string | undefined;
    batchSize: number;
    imageMimeTypes: ReadonlySet<string>;
    fileTypes: string[] | undefined;
    hasMoreFolders: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      userId,
      folderId,
      progress,
      syncFrom,
      batchSize,
      imageMimeTypes,
      fileTypes,
      hasMoreFolders,
    } = params;

    let url = buildFolderChildrenUrl(userId, folderId, batchSize);
    let hasMorePages = true;
    let batchIndex = 0;

    while (hasMorePages) {
      await this.rateLimit();

      let result: GraphListResponse<DriveItem>;
      try {
        result = await client.api(url).get();
      } catch (error) {
        throw new Error(
          `OneDrive items query failed for user ${userId}: ${extractErrorMessage(error)}`,
        );
      }

      const files = result.value.filter(
        (item) =>
          item.file &&
          !item.folder &&
          isSupportedFile(item.name, imageMimeTypes, fileTypes) &&
          isModifiedSince(item.lastModifiedDateTime, syncFrom),
      );

      const documents: ConnectorDocument[] = [];

      for (const item of files) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const result = await this.downloadFileData(
              client,
              userId,
              item.id,
              item.name,
            );
            if (result.unsupportedType) {
              this.trackSkipped({
                itemId: item.id,
                name: item.name,
                reason: "unsupported_file_type",
                category: "unsupported_type",
              });
              return null;
            }
            if (!result.text.trim() && !result.mediaContent) {
              this.trackSkipped({
                itemId: item.id,
                name: item.name,
                reason:
                  result.emptyReason ??
                  "Empty content — no text or media could be extracted",
                category: "no_extractable_text",
                sourceScope: { metadataField: "userId", value: userId },
              });
              return null;
            }
            return driveItemToDocument(
              item,
              userId,
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

      const lastResult = result.value[result.value.length - 1];
      const lastModified = lastResult?.lastModifiedDateTime;

      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      const hasMore = hasMorePages || hasMoreFolders;

      batchIndex++;
      this.log.debug(
        {
          userId,
          folderId,
          batchIndex,
          itemCount: files.length,
          documentCount: documents.length,
          hasMore,
        },
        "OneDrive batch done",
      );

      const checkpointAt = hasMore
        ? progress.safeLastSyncedAt
        : progress.maxLastModified;

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: buildCheckpoint({
          type: "onedrive",
          itemUpdatedAt: checkpointAt ? new Date(checkpointAt) : undefined,
          previousLastSyncedAt: checkpointAt,
        }),
        hasMore,
      };
    }
  }

  private async listDirectSubfolders(params: {
    client: Client;
    userId: string;
    folderId: string;
  }): Promise<string[]> {
    const { client, userId, folderId } = params;
    let url: string = buildFolderSubfoldersUrl(userId, folderId);
    const subfolderIds: string[] = [];

    while (url) {
      const result = (await client
        .api(url)
        .get()) as GraphListResponse<GraphDriveItem>;
      for (const item of result.value ?? []) {
        if (item.folder && !item.file && item.id) {
          subfolderIds.push(item.id);
        }
      }
      url = result["@odata.nextLink"] ?? "";
    }

    return subfolderIds;
  }

  private async downloadFileData(
    client: Client,
    userId: string,
    itemId: string,
    fileName: string,
  ): Promise<{
    text: string;
    mediaContent?: { mimeType: string; data: string };
    /** Why the text came back empty, for skip reporting on the run. */
    emptyReason?: string;
    /**
     * The extension has no extractor at all (a fileTypes entry outside the
     * supported sets) — an unsupported-type skip, not a document without text.
     */
    unsupportedType?: true;
  }> {
    const ext = getFileExtension(fileName);
    const contentPath = `/users/${userId}/drive/items/${itemId}/content`;

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
          "OneDrive: PDF page extraction warning",
        );
      }
      return {
        text: extracted.text.slice(0, MAX_CONTENT_LENGTH),
        emptyReason: extracted.emptyReason,
      };
    }

    if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      const arrayBuffer = (await client
        .api(contentPath)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()) as ArrayBuffer;
      if (arrayBuffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
        this.log.debug(
          { fileName, sizeBytes: arrayBuffer.byteLength },
          "OneDrive: skipping oversized image",
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
      "OneDrive: skipping unsupported file type",
    );
    return { text: "", unsupportedType: true };
  }

  private async countUserDriveItems(params: {
    client: Client;
    userId: string;
    config: OneDriveConfig;
    syncFrom: string | undefined;
    imageMimeTypes: ReadonlySet<string>;
  }): Promise<number> {
    const { client, userId, config, syncFrom, imageMimeTypes } = params;
    const rootItemId = config.folderId ?? "root";
    const recursive = config.recursive ?? true;
    const maxDepth = config.maxDepth;

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (folderId) =>
        this.listDirectSubfolders({ client, userId, folderId }),
    };

    let count = 0;
    for await (const folderId of traverseFolders(adapter, {
      rootFolderId: rootItemId,
      recursive,
      maxDepth,
    })) {
      count += await this.countFilesInFolder({
        client,
        userId,
        folderId,
        syncFrom,
        fileTypes: config.fileTypes,
        imageMimeTypes,
      });
    }

    return count;
  }

  private async countFilesInFolder(params: {
    client: Client;
    userId: string;
    folderId: string;
    syncFrom: string | undefined;
    fileTypes: string[] | undefined;
    imageMimeTypes: ReadonlySet<string>;
  }): Promise<number> {
    const { client, userId, folderId, syncFrom, fileTypes, imageMimeTypes } =
      params;
    let url = buildFolderChildrenUrl(userId, folderId, 500);
    let count = 0;

    while (url) {
      const result = (await client
        .api(url)
        .get()) as GraphListResponse<DriveItem>;
      count += result.value.filter(
        (item) =>
          item.file &&
          !item.folder &&
          isSupportedFile(item.name, imageMimeTypes, fileTypes) &&
          isModifiedSince(item.lastModifiedDateTime, syncFrom),
      ).length;
      url = result["@odata.nextLink"] ?? "";
    }

    return count;
  }

  // ===== Permission-sync internals =====

  /** Arm (or re-arm) the per-pass state every permission hook shares. */
  private initPermissionPass(
    credentials: ConnectorCredentials,
    config: OneDriveConfig,
  ): void {
    this.permCredentials = credentials;
    this.permConfig = config;
    this.userEmailCache = new Map();
    this.entraGroupCache = new Map();
    this.driveInfoCache = new Map();
    this.tenantUsersCache = undefined;
    this.graphUsersTier = null;
    this.graphGroupsTier = null;
    this.deltaSharingTier = null;
    this.droppedPrincipals = 0;
    this.mappedEmailResolver = null;
  }

  private async *syncUserContainerSnapshot(
    client: Client,
    container: OdContainer,
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const containerKey = container.key;

    const docIds: string[] = [];
    let afterId: string | null = null;
    for (;;) {
      const { documents, nextAfterId } = await params.readIngestedDocuments({
        metadataFilter: { userId: container.userId },
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
        permissions: emptyAudience(),
        audienceResolutionFailed: false,
        cursor: containerKey,
      };
      return;
    }

    const info = await this.resolveUserDrive(client, container.userId);
    if (!info) {
      // The drive itself could not be resolved: no enumeration is possible,
      // so the whole corpus fail-closes under the top-level container.
      yield {
        kind: "container",
        containerKey,
        permissions: emptyAudience(),
        audienceResolutionFailed: true,
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
      return;
    }

    // The corpus enumeration: one delta walk with hierarchicalsharing, which
    // marks permission-hierarchy roots (items whose permissions no longer
    // inherit) so unique-permission detection costs no per-item requests.
    const walk = await this.walkDriveDelta(client, container, {
      forProbe: false,
    });
    const items = walk.items ?? new Map();

    const root = await this.resolveDriveRootAudience(client, container.userId);
    yield {
      kind: "container",
      containerKey,
      permissions: root.permissions,
      audienceResolutionFailed: root.resolutionFailed,
      cursor: containerKey,
    };

    const emittedNested = new Set<string>();
    for (const sourceId of docIds) {
      const governingItemId = findGoverningScopeRoot(items, sourceId);
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
          info,
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

  /**
   * Resolve a configured user's drive (id + owner), cached per pass.
   * `null` means the drive could not be resolved — callers fail-close.
   */
  private async resolveUserDrive(
    client: Client,
    userId: string,
  ): Promise<OdDriveInfo | null> {
    const cached = this.driveInfoCache.get(userId);
    if (cached !== undefined) return cached;
    let info: OdDriveInfo | null = null;
    try {
      await this.rateLimit();
      const drive = (await client
        .api(`${GRAPH_API_BASE}/users/${userId}/drive?$select=id,owner`)
        .get()) as {
        id?: string;
        owner?: {
          user?: { id?: string; displayName?: string; email?: string };
        };
      };
      if (drive.id) {
        info = {
          driveId: drive.id,
          ownerId: drive.owner?.user?.id ?? null,
          ownerDisplayName: drive.owner?.user?.displayName ?? null,
          ownerEmail: drive.owner?.user?.email?.toLowerCase() ?? null,
        };
      }
    } catch (error) {
      this.log.error(
        { userId, error: extractErrorMessage(error) },
        "Could not resolve the user's drive; every document in it is fail-closed for this pass",
      );
    }
    this.driveInfoCache.set(userId, info);
    return info;
  }

  /**
   * One drive's delta feed. Enumeration mode (`forProbe: false`) buffers
   * every item's id/parent/scope-root flag and asks for
   * `hierarchicalsharing` so scope roots carry a `shared` facet. Probe mode
   * walks a stored delta link and reports whether anything drifted —
   * sharing-only drift when the elevated `deltashowsharingchanges`
   * preference is honored, any drift when the tenant denies it (403 ⇒
   * cache the denial, retry coarse).
   */
  private async walkDriveDelta(
    client: Client,
    container: OdContainer,
    opts: { token?: string; forProbe: boolean },
  ): Promise<{
    items: Map<string, DeltaItemEntry> | null;
    deltaLink: string;
    sawChange: boolean;
  }> {
    const info = await this.resolveUserDrive(client, container.userId);
    if (!info) {
      throw new Error(
        `OneDrive drive resolution failed for user ${container.userId}`,
      );
    }
    const startUrl =
      opts.token ?? `${GRAPH_API_BASE}/drives/${info.driveId}/root/delta`;

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
          // the sharing-aware preference is rejected, so probe coarsely
          // (any drift dirties the container) for the rest of this pass.
          sharingPreference = false;
          this.deltaSharingTier = false;
          this.log.warn(
            "OneDrive delta sharing-change preference rejected (Sites.FullControl.All missing); probing coarsely",
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
    throw new Error("OneDrive delta walk ended without a delta link");
  }

  private async getLatestDeltaToken(
    client: Client,
    container: OdContainer,
  ): Promise<string> {
    const info = await this.resolveUserDrive(client, container.userId);
    if (!info) {
      throw new Error(
        `OneDrive drive resolution failed for user ${container.userId}`,
      );
    }
    await this.rateLimit();
    const result = (await client
      .api(`${GRAPH_API_BASE}/drives/${info.driveId}/root/delta?token=latest`)
      .get()) as GraphDeltaPage;
    return result["@odata.deltaLink"] ?? "";
  }

  private async captureDeltaTokens(
    client: Client,
    containers: OdContainer[],
  ): Promise<Record<string, string>> {
    const tokens: Record<string, string> = {};
    for (const container of containers) {
      tokens[container.key] = await this.getLatestDeltaToken(client, container);
    }
    return tokens;
  }

  /**
   * A drive root's effective audience: the root permission list PLUS the
   * drive owner (personal drives do not list their owner). Failure
   * fail-closes the corpus — including the owner (an unverified audience
   * is not partially granted).
   */
  private async resolveDriveRootAudience(
    client: Client,
    userId: string,
  ): Promise<{ permissions: DocumentPermissions; resolutionFailed: boolean }> {
    const info = await this.resolveUserDrive(client, userId);
    if (!info) {
      return { permissions: emptyAudience(), resolutionFailed: true };
    }
    try {
      const permissions = await this.listItemPermissions(
        client,
        `/drives/${info.driveId}/root/permissions`,
      );
      return {
        permissions: await this.permissionsToAudience(permissions, info),
        resolutionFailed: false,
      };
    } catch (error) {
      this.log.error(
        { userId, error: extractErrorMessage(error) },
        "Could not read the drive root's permissions; every document in it is fail-closed for this pass",
      );
      return { permissions: emptyAudience(), resolutionFailed: true };
    }
  }

  /**
   * One item's effective audience (the permission list folds inherited
   * entries in — no inheritance math here), plus the drive owner. A read
   * failure fail-closes THIS item's subtree only — never fall back to the
   * parent audience on error (a transient 429/5xx must not become an
   * over-grant).
   */
  private async resolveItemAudience(
    client: Client,
    info: OdDriveInfo,
    itemId: string,
  ): Promise<{ permissions: DocumentPermissions; resolutionFailed: boolean }> {
    try {
      const permissions = await this.listItemPermissions(
        client,
        `/drives/${info.driveId}/items/${itemId}/permissions`,
      );
      return {
        permissions: await this.permissionsToAudience(permissions, info),
        resolutionFailed: false,
      };
    } catch (error) {
      this.log.warn(
        { driveId: info.driveId, itemId, error: extractErrorMessage(error) },
        "Could not read the item's permissions; its documents are fail-closed for this pass",
      );
      return { permissions: emptyAudience(), resolutionFailed: true };
    }
  }

  /** Paginate a Graph permission collection. */
  private async listItemPermissions(
    client: Client,
    path: string,
  ): Promise<OdPermission[]> {
    const out: OdPermission[] = [];
    let url: string | undefined = `${GRAPH_API_BASE}${path}`;
    while (url) {
      await this.rateLimit();
      const result = (await client
        .api(url)
        .get()) as GraphListResponse<OdPermission>;
      out.push(...(result.value ?? []));
      url = result["@odata.nextLink"] ?? undefined;
    }
    return out;
  }

  /**
   * Map Graph permission principals to a document audience, always
   * including the drive owner. Group grants emit group REFERENCES
   * (`entra:<guid>` / `sitegroup:<title>`) — resolved to users at query
   * time through the roster `syncGroups` maintains — and direct users
   * resolve inline to emails (with the admin member-override fallback for
   * accounts whose upstream email is hidden). Anonymous links are genuinely
   * public (isPublic — the Jira "anyone" precedent); organization links
   * expand to the tenant's active users, NOT org-wide (a revocable set —
   * the Jira applicationRole precedent). Application grants carry no user
   * access and are ignored.
   */
  private async permissionsToAudience(
    permissions: OdPermission[],
    info: OdDriveInfo,
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
    await this.applyDriveOwner(info, users);
    return { isPublic, users: [...users], groups: [...groups] };
  }

  /** The owner belongs to every audience in a single-owner drive. */
  private async applyDriveOwner(
    info: OdDriveInfo,
    users: Set<string>,
  ): Promise<void> {
    if (info.ownerId) {
      const email =
        (await this.resolveGraphUserEmail(info.ownerId)) ??
        info.ownerEmail ??
        this.mappedEmailResolver?.(info.ownerId);
      if (email) {
        users.add(email.toLowerCase());
        return;
      }
      this.droppedPrincipals += 1;
      return;
    }
    if (info.ownerEmail) users.add(info.ownerEmail);
  }

  private async applyIdentitySet(
    identitySet: OdIdentitySet | undefined,
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
      groups.add(siteGroupRef(identitySet.siteGroup.displayName));
    }
    if (identitySet.group?.id) {
      groups.add(entraGroupRef(identitySet.group.id));
    }
  }

  /**
   * A SharePoint claims login name → whoever it denotes: a user email
   * (`i:0#.f|membership|user@domain`), an Entra group
   * (`…|federateddirectoryclaimprovider|<guid>`), or the whole-tenant claim
   * (`spo-grid-all-users` / `rolemanager|…|true`). OneDrive for Business is
   * SharePoint underneath, so these facets appear on its permissions too.
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

  /** Roster-side principal collection (audience-side is applyIdentitySet). */
  private async collectRosterIdentity(
    identitySet: OdIdentitySet | undefined,
    entraIds: Set<string>,
    siteGroupTitles: Set<string>,
    direct: Map<string, GroupMemberYield>,
  ): Promise<void> {
    if (!identitySet) return;
    if (identitySet.group?.id) entraIds.add(identitySet.group.id);
    if (identitySet.siteGroup?.displayName) {
      siteGroupTitles.add(identitySet.siteGroup.displayName);
    }
    if (identitySet.user?.id) {
      // Roster the UPSTREAM identity: email stays null when hidden — that
      // is exactly the row an admin assigns manually.
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
   * Entra/M365 group → transitive member roster. Tier:
   * GroupMember.Read.All. Nested groups arrive pre-flattened
   * (transitiveMembers); non-user directory objects are skipped. A member
   * whose email is hidden is still rostered (email: null — admin-visible,
   * override-assignable).
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

  private requirePermCredentials(): ConnectorCredentials {
    if (!this.permCredentials) throw new Error("permission pass not armed");
    return this.permCredentials;
  }

  private requirePermConfig(): OneDriveConfig {
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
      "Dropped OneDrive principals that could not be resolved (fail-closed)",
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

// ===== Permission-sync types & helpers =====

const PERMISSION_READBACK_PAGE_SIZE = 1000;
/** Scanning-guidance preference: mark permission-hierarchy roots. */
const DELTA_ENUM_PREFER = "deltashowremovedasdeleted, hierarchicalsharing";
/** Elevated probe preference: annotate items whose SHARING changed. */
const DELTA_SHARING_PREFER =
  "deltashowremovedasdeleted, deltatraversepermissiongaps, deltashowsharingchanges";
const DELTA_PLAIN_PREFER = "deltashowremovedasdeleted";

/** A top-level permission container: one configured user's drive. */
type OdContainer = { key: string; userId: string };

/** A configured user's resolved drive (id + owner), cached per pass. */
type OdDriveInfo = {
  driveId: string;
  ownerId: string | null;
  ownerDisplayName: string | null;
  ownerEmail: string | null;
};

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
type OdPermission = {
  link?: { scope?: string };
  grantedToV2?: OdIdentitySet;
  grantedToIdentitiesV2?: OdIdentitySet[];
};

type OdIdentitySet = {
  user?: { id?: string; displayName?: string };
  siteUser?: { loginName?: string; displayName?: string };
  siteGroup?: { displayName?: string };
  group?: { id?: string };
  application?: { id?: string };
};

/**
 * The connector's top-level containers, sorted for a monotonic cursor. The
 * key embeds the CONFIGURED user id so it byte-matches `metadata.userId`.
 */
function topContainers(config: OneDriveConfig): OdContainer[] {
  return config.userIds
    .map((userId) => ({ key: `user:${userId}`, userId }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The nearest ancestor (or self) whose permissions no longer inherit — the
 * item whose audience governs this document. `null` means the drive root's
 * audience governs. The delta walk covers the whole drive, so a chain that
 * leaves the buffer exited at the root.
 */
function findGoverningScopeRoot(
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
 * Roster group ids — byte-matched between the audience path's `groups` refs
 * and `syncGroups` yields (the `group:onedrive_<id>` token contract).
 */
function entraGroupRef(groupId: string): string {
  return `entra:${groupId}`;
}
function siteGroupRef(title: string): string {
  return `sitegroup:${title}`;
}
/** Synthetic roster group for direct (non-group) grantees. */
const DIRECT_GRANTS_GROUP_ID = "direct-grants";

function emptyAudience(): DocumentPermissions {
  return { isPublic: false, users: [], groups: [] };
}

/** 401/403 from the Graph SDK (statusCode on the thrown object). */
function isGraphForbidden(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;
  return status === 401 || status === 403;
}

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

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function parseOneDriveConfig(
  config: Record<string, unknown>,
): OneDriveConfig | null {
  const result = OneDriveConfigSchema.safeParse({
    type: "onedrive",
    ...config,
  });
  return result.success ? result.data : null;
}

function buildFolderChildrenUrl(
  userId: string,
  itemId: string,
  batchSize: number,
): string {
  const basePath =
    itemId === "root"
      ? `${GRAPH_API_BASE}/users/${userId}/drive/root/children`
      : `${GRAPH_API_BASE}/users/${userId}/drive/items/${itemId}/children`;

  const params = new URLSearchParams({
    $select:
      "id,name,webUrl,lastModifiedDateTime,createdDateTime,size,file,folder,parentReference",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  return `${basePath}?${params.toString()}`;
}

function buildFolderSubfoldersUrl(userId: string, itemId: string): string {
  const basePath =
    itemId === "root"
      ? `${GRAPH_API_BASE}/users/${userId}/drive/root/children`
      : `${GRAPH_API_BASE}/users/${userId}/drive/items/${itemId}/children`;

  const params = new URLSearchParams({
    $select: "id,folder,file",
    $top: "500",
  });

  return `${basePath}?${params.toString()}`;
}

function isSupportedFile(
  name: string,
  imageMimeTypes: ReadonlySet<string>,
  fileTypes?: string[],
): boolean {
  const ext = getFileExtension(name);
  const explicitlyAllowed = fileTypes?.includes(ext) ?? false;

  if (fileTypes?.length && !explicitlyAllowed) return false;

  if (
    SUPPORTED_TEXT_EXTENSIONS.has(ext) ||
    SUPPORTED_BINARY_EXTENSIONS.has(ext)
  ) {
    return true;
  }

  // fileTypes is an additional user filter, not an image-capability override.
  // Known images must still be accepted by the embedding model, while an
  // explicitly configured unknown extension must reach downloadFileData so it
  // can be reported as an unsupported-type skip instead of disappearing.
  if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    return imageMimeTypes.has(IMAGE_MIME_TYPES[ext] ?? "");
  }

  return explicitlyAllowed;
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0) return "";
  return name.slice(lastDot).toLowerCase();
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
  userId: string,
  content: string,
  mediaContent?: { mimeType: string; data: string },
): ConnectorDocument {
  const title = item.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: item.id,
    title,
    content: mediaContent && !content.trim() ? `# ${title}` : fullContent,
    sourceUrl: item.webUrl,
    metadata: {
      userId,
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
