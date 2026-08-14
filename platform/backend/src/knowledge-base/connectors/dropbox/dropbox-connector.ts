import type { ModelInputModality } from "@archestra/shared";
import type { files, sharing, users } from "dropbox";
import { Dropbox } from "dropbox";
import * as metrics from "@/observability/metrics";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DocumentPermissions,
  DropboxCheckpoint,
  DropboxConfig,
  GroupMembershipYield,
  GroupMemberYield,
  PermissionProbeResult,
  PermissionSnapshotYield,
  PermissionSyncParams,
  PermissionSyncState,
  ResolveMappedEmail,
} from "@/types";
import { DropboxConfigSchema } from "@/types";
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
  parsePdfBuffer,
} from "../pdf-utils";
import { extractTextFromPptx } from "../pptx-text-extractor";
import { extractTextFromXlsx } from "../xlsx-text-extractor";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_DEPTH = 50;

// Subtract 5 min from syncFrom to guard against clock skew between Dropbox
// servers and our system, so we never skip a file that was modified right
// around the checkpoint boundary.
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

const MAX_CONTENT_LENGTH = 500_000; // 500 KB text limit per document
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB image size limit

// File extensions read directly as UTF-8 text
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".ts",
  ".js",
  ".py",
  ".json",
  ".yaml",
  ".yml",
  ".html",
  ".css",
  ".csv",
  ".xml",
  ".sh",
  ".env",
  ".toml",
  ".ini",
  ".conf",
]);

// Binary document formats extracted through the shared extractors
type BinaryFormat = ".pdf" | ".docx" | ".pptx" | ".xlsx";
const BINARY_EXTENSIONS = new Set<string>([".pdf", ".docx", ".pptx", ".xlsx"]);

// Image extensions ingested as multimodal chunks when the embedding model
// accepts the format (see resolveIngestibleImageMimeTypes)
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

type DropboxFileMetadata = files.FileMetadataReference;
type DropboxEntry = files.ListFolderResult["entries"][number];

export class DropboxConnector extends BaseConnector {
  type = "dropbox" as const;

  supportsPermissionSync = true;

  // ----- Per-pass permission-sync state (armed by initPermissionPass) -----
  /** Shared folder id → resolved audience (failures are re-attempted, never cached). */
  private folderAudienceCache = new Map<string, ResolvedAudience>();
  /** Token account; null = resolution failed this pass, undefined = unresolved. */
  private ownerCache: DropboxOwner | null | undefined;
  private droppedPrincipals = 0;
  private mappedEmailResolver: ResolveMappedEmail | null = null;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parseDropboxConfig,
      label: "Dropbox",
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    return this.runConnectionTest({
      label: "Dropbox",
      // Resolves the acting identity, so both token flavors are validated:
      // a user token answers directly; a team token must resolve its
      // generating admin and act as them.
      probe: async () => {
        await this.resolveActingIdentity(params.credentials);
      },
    });
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
    const parsed = parseDropboxConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Dropbox configuration");
    }

    const checkpoint = (params.checkpoint as DropboxCheckpoint | null) ?? {
      type: "dropbox" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const rootPath = normalizeRootPath(parsed.rootPath);
    const fileTypes = parsed.fileTypes ?? [];
    const recursive = parsed.recursive ?? true;
    const maxDepth = parsed.maxDepth ?? DEFAULT_MAX_DEPTH;
    const imageMimeTypes = resolveIngestibleImageMimeTypes({
      connectorImageMimeTypes: Object.values(IMAGE_MIME_BY_EXTENSION),
      embeddingInputModalities: params.embeddingInputModalities,
      embeddingAcceptedImageMimeTypes: params.embeddingAcceptedImageMimeTypes,
    });

    const dbx = await this.getNamespacedClient(params.credentials);

    this.log.debug(
      { rootPath, fileTypes, cursor: checkpoint.cursor },
      "Starting Dropbox sync",
    );

    if (checkpoint.cursor) {
      yield* this.syncFromCursor(
        dbx,
        checkpoint.cursor,
        checkpoint,
        batchSize,
        fileTypes,
        imageMimeTypes,
      );
      return;
    }

    yield* this.syncFolderTree(
      dbx,
      rootPath,
      checkpoint,
      batchSize,
      fileTypes,
      recursive,
      maxDepth,
      imageMimeTypes,
    );
  }

  // ===== Permission sync =====

  /**
   * Container model: one top-level container, the constant key `account` —
   * the whole synced tree of the single Dropbox account the access token
   * belongs to (one connector = one token = one account, and the ACL token
   * `container:<connectorId>:account` already disambiguates across
   * connector instances). Files inside a shared folder become nested
   * `account/sf:<shared_folder_id>` containers: Dropbox stamps every
   * file's NEAREST containing shared folder on plain list metadata
   * (`sharing_info.parent_shared_folder_id`), so document→container
   * assignment costs one recursive metadata walk and zero per-item
   * requests. A rootPath that itself sits inside a shared folder needs no
   * special-casing — its files carry that outer folder's id and land in
   * its container; the top-level container keeps only files in no shared
   * folder at all, whose audience is the token account alone.
   *
   * The token account joins every audience: it demonstrably reads
   * everything content sync ingested (it IS the ingestion credential), so
   * that is definitionally correct, never an over-grant. Folder member
   * lists resolve inline emails (Dropbox returns member emails directly;
   * the admin member mapping rescues a missing one), include inherited
   * members (`is_inherited`), and grant `viewer_no_comment` and up —
   * `traverse` conveys no content read and is skipped, and invitees have
   * not accepted and have no access yet. Group grants emit the Dropbox
   * `group_id` as the group ref (globally unique across teams); a
   * user-scoped token CANNOT expand group rosters — that is a Business
   * team-credential API — so `syncGroups` rosters them empty for manual
   * admin assignment (the OneDrive site-group precedent). Files with
   * explicit per-file members (surfaced by the walk's
   * `include_has_explicit_shared_members`) resolve their non-inherited
   * user members as document `exceptionUsers`; a per-file GROUP grant is
   * not expressible on a document and is counted as a dropped principal.
   * Shared links are not reflected at all (documented limitation): a
   * link-shared file stays visible only to the audiences above —
   * under-grant, never over.
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const parsed = parseDropboxConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Dropbox configuration for permission sync");
    }
    this.initPermissionPass(params.resolveMappedEmail);

    const docIds = await readAllIngestedSourceIds(params.readIngestedDocuments);

    if (docIds.length === 0) {
      // Empty corpus: emit the fail-closed boundary container WITHOUT
      // resolving its audience (Jira precedent — not a resolution failure).
      yield {
        kind: "container",
        containerKey: TOP_CONTAINER_KEY,
        permissions: emptyAudience(),
        audienceResolutionFailed: false,
        cursor: TOP_CONTAINER_KEY,
      };
      return;
    }

    let dbx: Dropbox;
    let corpus: Map<string, CorpusSharingEntry>;
    try {
      dbx = await this.getPermissionClient(params.credentials);
      corpus = await this.walkCorpusSharing(dbx, parsed);
    } catch (error) {
      // The corpus walk failed: no assignment is possible, so the whole
      // corpus fail-closes under the top-level container.
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Could not enumerate the Dropbox tree for permission sync; the corpus is fail-closed for this pass",
      );
      yield {
        kind: "container",
        containerKey: TOP_CONTAINER_KEY,
        permissions: emptyAudience(),
        audienceResolutionFailed: true,
        cursor: TOP_CONTAINER_KEY,
      };
      for (const sourceId of docIds) {
        yield {
          kind: "document",
          sourceId,
          containerKey: TOP_CONTAINER_KEY,
          cursor: TOP_CONTAINER_KEY,
        };
      }
      this.reportDroppedPrincipals();
      return;
    }

    const root = await this.resolveRootAudience(dbx);
    yield {
      kind: "container",
      containerKey: TOP_CONTAINER_KEY,
      permissions: root.permissions,
      audienceResolutionFailed: root.resolutionFailed,
      cursor: TOP_CONTAINER_KEY,
    };

    const emittedNested = new Set<string>();
    for (const sourceId of docIds) {
      const entry = corpus.get(sourceId);
      const sharedFolderId = entry?.parentSharedFolderId ?? null;
      // A corpus document the walk did not see (deleted or moved upstream
      // since content sync) stays under the top-level container until the
      // next content sync retires it.
      let containerKey = TOP_CONTAINER_KEY;
      if (sharedFolderId) {
        containerKey = sharedFolderContainerKey(sharedFolderId);
        if (!emittedNested.has(containerKey)) {
          const audience = await this.resolveSharedFolderAudience(
            dbx,
            sharedFolderId,
          );
          yield {
            kind: "container",
            containerKey,
            permissions: audience.permissions,
            audienceResolutionFailed: audience.resolutionFailed,
            cursor: TOP_CONTAINER_KEY,
          };
          emittedNested.add(containerKey);
        }
      }
      const exceptionUsers = entry?.hasExplicitSharedMembers
        ? await this.resolveFileExceptionUsers(dbx, sourceId)
        : [];
      yield {
        kind: "document",
        sourceId,
        containerKey,
        ...(exceptionUsers.length > 0 ? { exceptionUsers } : {}),
        cursor: TOP_CONTAINER_KEY,
      };
    }

    this.reportDroppedPrincipals();
  }

  /**
   * Group roster sync (Users/Groups tabs + member overrides). Walks the
   * corpus tree for its shared folders and collects every granted Dropbox
   * group. Rosters live behind the Business TEAM API, which only answers
   * TEAM-linked tokens: with one (scopes `groups.read` + `members.read`)
   * each group expands to its ACTIVE members' emails on the bare client —
   * team RPCs take no select-user or path-root. A failed expansion — a
   * user-linked token (Dropbox refuses it with a 400 regardless of the
   * app's checked scopes), missing team scopes — is flagged fail-closed
   * and the service replaces the roster with an empty one; the group
   * stays visible in the Groups tab for manual member assignment, and
   * admin overrides apply. Direct grantees —
   * every folder's user members plus the token account — roster under the
   * synthetic `direct-grants` group with their inline emails. A folder
   * whose member list cannot be read is skipped here: the audience phase
   * owns fail-closing its container. The corpus walk itself failing
   * THROWS — a truncated roster must never masquerade as a completed one
   * (the pass retains the previous group snapshot on a thrown group
   * step).
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const parsed = parseDropboxConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Dropbox configuration for group sync");
    }
    this.initPermissionPass(params.resolveMappedEmail);
    const dbx = await this.getPermissionClient(params.credentials);

    const corpus = await this.walkCorpusSharing(dbx, parsed);
    const sharedFolderIds = [
      ...new Set(
        [...corpus.values()]
          .map((entry) => entry.parentSharedFolderId)
          .filter((id): id is string => id !== null),
      ),
    ].sort();

    const groups = new Map<string, string | null>();
    const direct = new Map<string, GroupMemberYield>();

    const owner = await this.resolveOwner(dbx);
    if (owner) {
      direct.set(owner.accountId, {
        accountId: owner.accountId,
        displayName: owner.displayName,
        email: owner.email,
        accountType: "user",
      });
    }

    for (const sharedFolderId of sharedFolderIds) {
      const members = await this.listFolderMembers(dbx, sharedFolderId);
      if (!members) continue; // audience phase owns fail-closing this container
      for (const groupMember of members.groups) {
        // Mirror the audience filter: a traverse-only group grants no read,
        // so it belongs in no roster either.
        if (!canReadAccessLevel(groupMember.access_type)) continue;
        groups.set(
          groupMember.group.group_id,
          groupMember.group.group_name ?? null,
        );
      }
      for (const userMember of members.users) {
        if (!canReadAccessLevel(userMember.access_type)) continue;
        // Roster the UPSTREAM identity: Dropbox exposes the email inline,
        // so unmatched accounts stay visible and override-assignable.
        direct.set(userMember.user.account_id, {
          accountId: userMember.user.account_id,
          displayName: userMember.user.display_name ?? null,
          email: userMember.user.email ?? null,
          accountType: "user",
        });
      }
    }

    // Team RPCs take no path-root header — use the bare client.
    const teamClient = getDropboxClient(params.credentials);
    for (const [groupId, name] of [...groups.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const members = await this.expandTeamGroup(teamClient, groupId);
      if (members) {
        yield { groupId, name, members };
      } else {
        // Expansion FAILED — an observed fail-closed empty group, not a
        // clean empty one.
        yield { groupId, name, members: [], membershipResolutionFailed: true };
      }
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
   * Delta probe over the same recursive change feed content sync uses,
   * held on an independent cursor in permission-sync state. File/folder
   * drift (create, move, delete, share/unshare mounts) surfaces as
   * entries and dirties the single top-level container — coarse, but
   * there is only one top-level container to dirty, and a quiet feed
   * skips the corpus walk entirely. Folder MEMBERSHIP drift produces no
   * file entries and is deliberately NOT probed here: the pass re-reads
   * every stored container's member list on every delta pass via
   * `refreshContainerAudiences`, so grants and revocations land next
   * pass unconditionally. Per-file explicit-member drift is likewise
   * invisible to the feed; those exceptions reconcile on the periodic
   * full pass (the documented bound for probe-invisible drift). A
   * rejected/reset cursor forfeits the drift window → full reconcile.
   */
  async probePermissionChanges(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    state: PermissionSyncState | null;
  }): Promise<PermissionProbeResult> {
    const parsed = parseDropboxConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Dropbox configuration for permission probe");
    }
    this.initPermissionPass(undefined);
    const dbx = await this.getPermissionClient(params.credentials);

    const stored =
      typeof params.state?.cursor === "string" && params.state.cursor
        ? params.state.cursor
        : null;
    if (!stored) {
      return {
        dirtyContainerKeys: [],
        fullRequired: true,
        nextState: { cursor: await this.latestChangeCursor(dbx, parsed) },
      };
    }

    try {
      let cursor = stored;
      let sawChange = false;
      let hasMore = true;
      while (hasMore) {
        await this.rateLimit();
        const result = await dbx.filesListFolderContinue({ cursor });
        cursor = result.result.cursor;
        hasMore = result.result.has_more;
        if (result.result.entries.length > 0) sawChange = true;
      }
      return {
        dirtyContainerKeys: sawChange ? [TOP_CONTAINER_KEY] : [],
        fullRequired: false,
        nextState: { cursor },
      };
    } catch (error) {
      // Rejected/expired cursor (path reset etc.) — the drift window is
      // lost, so only a full reconcile restores correctness.
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Dropbox change cursor rejected; promoting to a full reconcile",
      );
      return {
        dirtyContainerKeys: [],
        fullRequired: true,
        nextState: { cursor: await this.latestChangeCursor(dbx, parsed) },
      };
    }
  }

  /**
   * Audience verification, run on every delta pass: the top-level
   * `account` container re-reads the token account, and every nested
   * `account/sf:<id>` container re-reads its full member list —
   * O(stored containers), no item enumeration. Unlike OneDrive's
   * item-scoped nested containers, Dropbox nested keys are STABLE shared
   * folder identities resolvable without any assignment reconcile, so
   * membership revocations land on the next delta pass unconditionally.
   * A folder that is gone or unshared fail-closes with the
   * resolution-failure flag until the next full pass reassigns its
   * documents.
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
    const parsed = parseDropboxConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Dropbox configuration for audience refresh");
    }
    this.initPermissionPass(params.resolveMappedEmail);
    const dbx = await this.getPermissionClient(params.credentials);

    for (const containerKey of params.containerKeys) {
      if (containerKey === TOP_CONTAINER_KEY) {
        const root = await this.resolveRootAudience(dbx);
        yield {
          containerKey,
          permissions: root.permissions,
          audienceResolutionFailed: root.resolutionFailed,
        };
        continue;
      }
      const sharedFolderId = parseSharedFolderContainerKey(containerKey);
      if (!sharedFolderId) continue;
      const audience = await this.resolveSharedFolderAudience(
        dbx,
        sharedFolderId,
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
   * Local-adoption scoping for delta passes: the single top-level
   * container's enumeration covers the whole corpus, so every stored
   * document maps to it. Scoping only — the enumeration resolves the
   * authoritative (possibly nested) assignment, so this can never
   * over-grant.
   */
  scopeKeyForDocument(_metadata: Record<string, unknown>): string | null {
    return TOP_CONTAINER_KEY;
  }

  // ===== Private methods =====

  private async *syncFolderTree(
    dbx: Dropbox,
    rootPath: string,
    checkpoint: DropboxCheckpoint,
    batchSize: number,
    fileTypes: string[],
    recursive: boolean,
    maxDepth: number,
    imageMimeTypes: ReadonlySet<string>,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (parentPath: string) =>
        this.listSubfolderPaths(dbx, parentPath),
    };

    const folderPaths: string[] = [];
    for await (const folderPath of traverseFolders(
      adapter,
      { rootFolderId: rootPath, recursive, maxDepth },
      this.log,
    )) {
      folderPaths.push(folderPath);
    }

    // Get a root-scoped cursor before syncing so incremental sync
    // can track changes across the entire tree, not just the last folder walked.
    await this.rateLimit();
    const rootCursorResult = await dbx.filesListFolder({
      path: rootPath,
      recursive: true,
      include_deleted: false,
      include_has_explicit_shared_members: false,
    });
    const rootScopedCursor = rootCursorResult.result.cursor;

    for (let fi = 0; fi < folderPaths.length; fi++) {
      const folderPath = folderPaths[fi];
      const isLastFolder = fi === folderPaths.length - 1;

      let cursor: string | undefined;
      let hasMorePages = true;
      let batchIndex = 0;
      const pendingFiles: DropboxFileMetadata[] = [];

      while (hasMorePages) {
        await this.rateLimit();

        let entries: DropboxEntry[];
        let nextCursor: string;
        let hasMore: boolean;

        if (!cursor) {
          const result = await dbx.filesListFolder({
            path: folderPath,
            recursive: false,
            include_deleted: false,
            include_has_explicit_shared_members: false,
          });
          entries = result.result.entries;
          nextCursor = result.result.cursor;
          hasMore = result.result.has_more;
        } else {
          const result = await dbx.filesListFolderContinue({ cursor });
          entries = result.result.entries;
          nextCursor = result.result.cursor;
          hasMore = result.result.has_more;
        }

        cursor = nextCursor;
        hasMorePages = hasMore;
        pendingFiles.push(
          ...this.selectSupportedFiles(entries, fileTypes, imageMimeTypes),
        );

        while (pendingFiles.length >= batchSize) {
          const batch = pendingFiles.splice(0, batchSize);
          batchIndex++;

          const { documents, lastModified } = await this.downloadBatch(
            dbx,
            batch,
            imageMimeTypes,
            checkpoint.lastSyncedAt,
          );

          this.log.debug(
            { batchIndex, documentCount: documents.length, hasMore: true },
            "Dropbox full-sync batch done",
          );

          yield {
            documents,
            failures: this.flushFailures(),
            skipped: this.flushSkipped(),
            checkpoint: buildCheckpoint({
              type: "dropbox",
              itemUpdatedAt: lastModified,
              previousLastSyncedAt: checkpoint.lastSyncedAt,
              extra: { cursor: rootScopedCursor },
            }),
            hasMore: true,
          };
        }
      }

      const filesToProcess = pendingFiles.splice(0);
      const chunksToYield =
        filesToProcess.length > 0
          ? Math.ceil(filesToProcess.length / batchSize)
          : 1;

      for (let ci = 0; ci < chunksToYield; ci++) {
        const batch = filesToProcess.splice(0, batchSize);
        const isLastBatch = ci === chunksToYield - 1;
        batchIndex++;

        const { documents, lastModified } = await this.downloadBatch(
          dbx,
          batch,
          imageMimeTypes,
          checkpoint.lastSyncedAt,
        );

        this.log.debug(
          {
            batchIndex,
            documentCount: documents.length,
            hasMore: !isLastFolder || !isLastBatch,
          },
          "Dropbox full-sync batch done",
        );

        yield {
          documents,
          failures: this.flushFailures(),
          skipped: this.flushSkipped(),
          checkpoint: buildCheckpoint({
            type: "dropbox",
            itemUpdatedAt: lastModified,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { cursor: rootScopedCursor },
          }),
          hasMore: !isLastFolder || !isLastBatch,
        };
      }
    }
  }

  private async listSubfolderPaths(
    dbx: Dropbox,
    parentPath: string,
  ): Promise<string[]> {
    const subfolders: string[] = [];
    let cursor: string | undefined;

    do {
      await this.rateLimit();

      let entries: DropboxEntry[];
      let nextCursor: string;
      let hasMore: boolean;

      if (!cursor) {
        const result = await dbx.filesListFolder({
          path: parentPath,
          recursive: false,
          include_deleted: false,
        });
        entries = result.result.entries;
        nextCursor = result.result.cursor;
        hasMore = result.result.has_more;
      } else {
        const result = await dbx.filesListFolderContinue({ cursor });
        entries = result.result.entries;
        nextCursor = result.result.cursor;
        hasMore = result.result.has_more;
      }

      for (const entry of entries) {
        if (entry[".tag"] === "folder") {
          subfolders.push(
            (entry as files.FolderMetadataReference).path_display ?? "",
          );
        }
      }

      cursor = hasMore ? nextCursor : undefined;
    } while (cursor);

    return subfolders;
  }

  private async *syncFromCursor(
    dbx: Dropbox,
    savedCursor: string,
    checkpoint: DropboxCheckpoint,
    batchSize: number,
    fileTypes: string[],
    imageMimeTypes: ReadonlySet<string>,
  ): AsyncGenerator<ConnectorSyncBatch> {
    let cursor = savedCursor;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      this.log.debug({ batchIndex, cursor }, "Fetching Dropbox changes batch");

      const result = await dbx.filesListFolderContinue({ cursor });
      cursor = result.result.cursor;
      hasMore = result.result.has_more;

      const files = this.selectSupportedFiles(
        result.result.entries,
        fileTypes,
        imageMimeTypes,
      );

      for (let i = 0; i < files.length; i += batchSize) {
        const batchFiles = files.slice(i, i + batchSize);
        const batchHasMore = hasMore || i + batchSize < files.length;

        const { documents, lastModified } = await this.downloadBatch(
          dbx,
          batchFiles,
          imageMimeTypes,
        );

        batchIndex++;
        this.log.debug(
          { batchIndex, documentCount: documents.length, batchHasMore },
          "Dropbox incremental batch done",
        );

        yield {
          documents,
          failures: this.flushFailures(),
          skipped: this.flushSkipped(),
          checkpoint: buildCheckpoint({
            type: "dropbox",
            itemUpdatedAt: lastModified,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { cursor },
          }),
          hasMore: batchHasMore,
        };
      }

      if (files.length === 0) {
        batchIndex++;
        yield {
          documents: [],
          failures: [],
          skipped: this.flushSkipped(),
          checkpoint: buildCheckpoint({
            type: "dropbox",
            itemUpdatedAt: undefined,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { cursor },
          }),
          hasMore,
        };
      }
    }
  }

  /**
   * Listing-time selection: text and binary-document extensions always
   * qualify; image extensions qualify only when the embedding model accepts
   * the format. An explicit `fileTypes` config narrows the set (its
   * exclusions are deliberate and stay silent), and an extension it names
   * outside the known sets is read as UTF-8 text — the historical behavior
   * for custom text types. Files the CONNECTOR cannot ingest are recorded
   * as unsupported-type skips so an "empty" sync is explainable.
   */
  private selectSupportedFiles(
    entries: DropboxEntry[],
    fileTypes: string[],
    imageMimeTypes: ReadonlySet<string>,
  ): DropboxFileMetadata[] {
    const selected: DropboxFileMetadata[] = [];
    for (const entry of entries) {
      if (entry[".tag"] !== "file") continue;
      const file = entry as DropboxFileMetadata;
      const ext = getExtension(file.name);
      if (fileTypes.length > 0 && !fileTypes.includes(ext)) continue;

      const imageMime = IMAGE_MIME_BY_EXTENSION[ext];
      const supported = imageMime
        ? imageMimeTypes.has(imageMime)
        : fileTypes.length > 0 ||
          TEXT_EXTENSIONS.has(ext) ||
          BINARY_EXTENSIONS.has(ext);
      if (supported) {
        selected.push(file);
      } else {
        this.trackSkipped({
          itemId: file.id,
          name: file.name,
          reason: imageMime
            ? "The configured embedding model does not accept this image format"
            : "unsupported_file_type",
          category: "unsupported_type",
        });
      }
    }
    return selected;
  }

  private async downloadBatch(
    dbx: Dropbox,
    fileList: DropboxFileMetadata[],
    imageMimeTypes: ReadonlySet<string>,
    syncFrom?: string,
  ): Promise<{
    documents: ConnectorDocument[];
    lastModified: string | undefined;
  }> {
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;

    const documents: ConnectorDocument[] = [];
    let lastModified: string | undefined;

    for (const file of fileList) {
      if (
        safetyBufferedSyncFrom &&
        file.server_modified <= safetyBufferedSyncFrom
      ) {
        lastModified = lastModified
          ? laterOf(lastModified, file.server_modified)
          : file.server_modified;
        continue;
      }

      const doc = await this.safeItemFetch({
        fetch: async () => {
          const buffer = await this.downloadFile(dbx, file);
          const extracted = await this.extractFileContent(
            file,
            buffer,
            imageMimeTypes,
          );
          // A file with no extractable text or media is a definitive no-text
          // skip, not a document — indexing a title-only row has no search
          // value, and the skip keeps the run's emptiness explainable.
          if (!extracted.text.trim() && !extracted.mediaContent) {
            this.trackSkipped({
              itemId: file.id,
              name: file.name,
              reason:
                extracted.emptyReason ??
                "Empty content — no text or media could be extracted",
              category: "no_extractable_text",
            });
            return null;
          }
          return fileToDocument(file, extracted.text, extracted.mediaContent);
        },
        fallback: null,
        itemId: file.id,
        resource: "file",
        itemUnavailable: true,
      });

      // Skipped files advance the timestamp too — they were observed.
      lastModified = lastModified
        ? laterOf(lastModified, file.server_modified)
        : file.server_modified;
      if (doc) documents.push(doc);
    }

    return { documents, lastModified };
  }

  private async downloadFile(
    dbx: Dropbox,
    file: DropboxFileMetadata,
  ): Promise<Buffer> {
    await this.rateLimit();

    const result = await dbx.filesDownload({ path: file.id });
    // The SDK attaches the payload as `fileBinary` in Node and `fileBlob` in
    // browsers/workers — read whichever is present. (The historical
    // fileBlob-only read resolved to undefined in Node, so every download
    // silently ingested EMPTY content.)
    const payload = result.result as files.FileMetadata & {
      fileBinary?: Buffer | Uint8Array;
      fileBlob?: Blob;
    };
    if (payload.fileBinary) return Buffer.from(payload.fileBinary);
    if (payload.fileBlob) {
      return Buffer.from(await payload.fileBlob.arrayBuffer());
    }
    this.log.warn(
      { fileId: file.id, fileName: file.name },
      "Dropbox download returned no payload bytes",
    );
    return Buffer.alloc(0);
  }

  /**
   * Extension-dispatched content extraction: binary documents go through
   * the shared extractors, images become base64 media chunks (size-capped),
   * and everything else — the text set plus custom `fileTypes` extensions —
   * reads as UTF-8.
   */
  private async extractFileContent(
    file: DropboxFileMetadata,
    buffer: Buffer,
    imageMimeTypes: ReadonlySet<string>,
  ): Promise<{
    text: string;
    mediaContent?: { mimeType: string; data: string };
    emptyReason?: string;
  }> {
    const ext = getExtension(file.name);

    if (BINARY_EXTENSIONS.has(ext)) {
      const extracted = await extractTextFromBinary(
        buffer,
        ext as BinaryFormat,
      );
      if (extracted.warning) {
        this.log.warn(
          { fileId: file.id, fileName: file.name, reason: extracted.warning },
          "Dropbox: PDF page extraction warning",
        );
      }
      return {
        text: extracted.text.slice(0, MAX_CONTENT_LENGTH),
        emptyReason: extracted.emptyReason,
      };
    }

    const imageMime = IMAGE_MIME_BY_EXTENSION[ext];
    if (imageMime && imageMimeTypes.has(imageMime)) {
      if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
        return {
          text: "",
          emptyReason: "Image exceeds the maximum size supported for embedding",
        };
      }
      return {
        text: "",
        mediaContent: { mimeType: imageMime, data: buffer.toString("base64") },
      };
    }

    return { text: buffer.toString("utf-8").slice(0, MAX_CONTENT_LENGTH) };
  }

  /**
   * The identity the access token acts as. Dropbox mints two disjoint
   * token flavors: USER-linked (personal apps, apps without team scopes)
   * and TEAM-linked (any console token of an app with team scopes). User
   * endpoints (files/sharing/users) refuse team tokens and team RPCs
   * refuse user tokens, so the flavor is probed — `users/get_current_account`
   * answers only user tokens. A team token acts as the admin who generated
   * it (`team/token/get_authenticated_admin`) by stamping
   * `Dropbox-API-Select-User` on every user-endpoint call, which restores
   * exactly that admin's view — the corpus a user token of theirs would
   * have synced.
   */
  private async resolveActingIdentity(
    credentials: ConnectorCredentials,
  ): Promise<{ account: users.FullAccount; selectUser?: string }> {
    const probe = getDropboxClient(credentials);
    await this.rateLimit();
    try {
      return { account: (await probe.usersGetCurrentAccount()).result };
    } catch (userError) {
      let teamMemberId: string;
      try {
        await this.rateLimit();
        const admin = (await probe.teamTokenGetAuthenticatedAdmin()).result;
        teamMemberId = admin.admin_profile.team_member_id;
      } catch {
        // Not a team token either — the original refusal is the real error.
        throw userError;
      }
      this.log.debug(
        { teamMemberId },
        "Dropbox token is team-linked; acting as the admin who generated it",
      );
      const memberProbe = new Dropbox({
        accessToken: credentials.apiToken,
        selectUser: teamMemberId,
      });
      await this.rateLimit();
      const account = (await memberProbe.usersGetCurrentAccount()).result;
      return { account, selectUser: teamMemberId };
    }
  }

  /**
   * A Dropbox client rooted at the acting account's TRUE root. On a
   * Business team with a team space, member-context files/* calls default
   * to the member's private home namespace — the team space (where team
   * content lives) is invisible unless every call carries
   * `Dropbox-API-Path-Root` pointing at the shared root namespace.
   * Personal accounts (root == home) use a plain client. sharing/*
   * endpoints take ids and are namespace-agnostic either way.
   */
  private async getNamespacedClient(
    credentials: ConnectorCredentials,
  ): Promise<Dropbox> {
    const { account, selectUser } =
      await this.resolveActingIdentity(credentials);
    return clientForAccount(credentials, account, selectUser);
  }

  // ----- Permission-sync helpers -----

  /**
   * `getNamespacedClient` for the permission hooks: the account response
   * also primes the per-pass owner cache, so the audience path resolves
   * the owner without a second request.
   */
  private async getPermissionClient(
    credentials: ConnectorCredentials,
  ): Promise<Dropbox> {
    const { account, selectUser } =
      await this.resolveActingIdentity(credentials);
    this.ownerCache = {
      accountId: account.account_id,
      email: account.email ?? null,
      displayName: account.name?.display_name ?? null,
    };
    return clientForAccount(credentials, account, selectUser);
  }

  private initPermissionPass(
    resolveMappedEmail: ResolveMappedEmail | undefined,
  ): void {
    this.folderAudienceCache = new Map();
    this.ownerCache = undefined;
    this.droppedPrincipals = 0;
    this.mappedEmailResolver = resolveMappedEmail ?? null;
  }

  /**
   * One recursive metadata walk of the configured tree: file source id →
   * its nearest containing shared folder and whether it carries explicit
   * per-file members. Metadata pages only — nothing is downloaded. Walks
   * recursively regardless of the content sync's `recursive`/`maxDepth`
   * narrowing: the walk is a superset of any corpus those settings
   * produced, and assignment only ever touches stored source ids.
   */
  private async walkCorpusSharing(
    dbx: Dropbox,
    config: DropboxConfig,
  ): Promise<Map<string, CorpusSharingEntry>> {
    const entries = new Map<string, CorpusSharingEntry>();
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();
      const result = cursor
        ? await dbx.filesListFolderContinue({ cursor })
        : await dbx.filesListFolder({
            path: normalizeRootPath(config.rootPath),
            recursive: true,
            include_deleted: false,
            include_has_explicit_shared_members: true,
          });
      for (const entry of result.result.entries) {
        if (entry[".tag"] !== "file") continue;
        const file = entry as DropboxFileMetadata;
        entries.set(file.id, {
          parentSharedFolderId:
            file.sharing_info?.parent_shared_folder_id ?? null,
          hasExplicitSharedMembers: file.has_explicit_shared_members ?? false,
        });
      }
      cursor = result.result.cursor;
      hasMore = result.result.has_more;
    }

    return entries;
  }

  /** Token account, cached per pass; null = resolution failed. */
  private async resolveOwner(dbx: Dropbox): Promise<DropboxOwner | null> {
    if (this.ownerCache !== undefined) return this.ownerCache;
    try {
      await this.rateLimit();
      const account = (await dbx.usersGetCurrentAccount()).result;
      this.ownerCache = {
        accountId: account.account_id,
        email: account.email ?? null,
        displayName: account.name?.display_name ?? null,
      };
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Could not resolve the Dropbox token account",
      );
      this.ownerCache = null;
    }
    return this.ownerCache;
  }

  /**
   * The top-level container's audience: the token account alone (files
   * outside every shared folder are visible only to the account itself).
   * Fail-closed empty when the account cannot be resolved.
   */
  private async resolveRootAudience(dbx: Dropbox): Promise<ResolvedAudience> {
    const owner = await this.resolveOwner(dbx);
    if (!owner) {
      return { permissions: emptyAudience(), resolutionFailed: true };
    }
    const users = new Set<string>();
    this.addPrincipalEmail(users, owner.accountId, owner.email);
    return {
      permissions: { isPublic: false, users: [...users], groups: [] },
      resolutionFailed: false,
    };
  }

  /**
   * A shared folder's audience from its full member list (inherited
   * members included), plus the token account. Cached per pass — the
   * snapshot and refresh hooks resolve each folder once. Failures are
   * fail-closed empty with the resolution flag and are NOT cached, so a
   * later hook in the same pass may still succeed.
   */
  private async resolveSharedFolderAudience(
    dbx: Dropbox,
    sharedFolderId: string,
  ): Promise<ResolvedAudience> {
    const cached = this.folderAudienceCache.get(sharedFolderId);
    if (cached) return cached;

    const members = await this.listFolderMembers(dbx, sharedFolderId);
    if (!members) {
      return { permissions: emptyAudience(), resolutionFailed: true };
    }

    const users = new Set<string>();
    const groups = new Set<string>();
    for (const userMember of members.users) {
      if (!canReadAccessLevel(userMember.access_type)) continue;
      this.addPrincipalEmail(
        users,
        userMember.user.account_id,
        userMember.user.email ?? null,
      );
    }
    for (const groupMember of members.groups) {
      if (!canReadAccessLevel(groupMember.access_type)) continue;
      groups.add(groupMember.group.group_id);
    }
    // Invitees have not accepted and cannot read content yet — excluded.
    const owner = await this.resolveOwner(dbx);
    if (owner) this.addPrincipalEmail(users, owner.accountId, owner.email);

    const audience: ResolvedAudience = {
      permissions: { isPublic: false, users: [...users], groups: [...groups] },
      resolutionFailed: false,
    };
    this.folderAudienceCache.set(sharedFolderId, audience);
    return audience;
  }

  /**
   * A shared folder's complete member list, cursor-paginated. `null`
   * means the list could not be read — callers fail-close (audience) or
   * skip (roster).
   */
  private async listFolderMembers(
    dbx: Dropbox,
    sharedFolderId: string,
  ): Promise<FolderMemberLists | null> {
    try {
      const users: sharing.UserMembershipInfo[] = [];
      const groups: sharing.GroupMembershipInfo[] = [];
      await this.rateLimit();
      let page = (
        await dbx.sharingListFolderMembers({
          shared_folder_id: sharedFolderId,
          limit: MEMBER_PAGE_LIMIT,
        })
      ).result;
      for (;;) {
        users.push(...page.users);
        groups.push(...page.groups);
        if (!page.cursor) break;
        await this.rateLimit();
        page = (
          await dbx.sharingListFolderMembersContinue({ cursor: page.cursor })
        ).result;
      }
      return { users, groups };
    } catch (error) {
      this.log.warn(
        { sharedFolderId, error: extractErrorMessage(error) },
        "Could not read a Dropbox shared folder's members; its documents are fail-closed for this pass",
      );
      return null;
    }
  }

  /**
   * Explicit per-file grantees as exception users: non-inherited user
   * members with read access, resolved to emails. Per-file GROUP grants
   * cannot be expressed on a document and count as dropped principals. A
   * failed read yields no exceptions — the container audience still
   * stands (under-grant, never over).
   */
  private async resolveFileExceptionUsers(
    dbx: Dropbox,
    fileId: string,
  ): Promise<string[]> {
    try {
      const users = new Set<string>();
      await this.rateLimit();
      let page = (
        await dbx.sharingListFileMembers({
          file: fileId,
          include_inherited: false,
          limit: MEMBER_PAGE_LIMIT,
        })
      ).result;
      for (;;) {
        for (const userMember of page.users) {
          if (userMember.is_inherited) continue;
          if (!canReadAccessLevel(userMember.access_type)) continue;
          this.addPrincipalEmail(
            users,
            userMember.user.account_id,
            userMember.user.email ?? null,
          );
        }
        // Only read-granting group grants are real drops worth reporting.
        this.droppedPrincipals += page.groups.filter((groupMember) =>
          canReadAccessLevel(groupMember.access_type),
        ).length;
        if (!page.cursor) break;
        await this.rateLimit();
        page = (
          await dbx.sharingListFileMembersContinue({ cursor: page.cursor })
        ).result;
      }
      return [...users];
    } catch (error) {
      this.log.warn(
        { fileId, error: extractErrorMessage(error) },
        "Could not read a Dropbox file's explicit members; the file carries no exception grants this pass",
      );
      return [];
    }
  }

  /**
   * Upstream inline email first (Dropbox exposes verified member emails
   * directly), admin member mapping as the rescue for a hidden one — the
   * Jira/OneDrive fallback order. A principal with neither is counted
   * dropped (fail-closed, surfaced via metrics).
   */
  private addPrincipalEmail(
    users: Set<string>,
    accountId: string,
    email: string | null,
  ): void {
    const resolved = email ?? this.mappedEmailResolver?.(accountId) ?? null;
    if (resolved) {
      users.add(resolved.toLowerCase());
      return;
    }
    this.droppedPrincipals += 1;
  }

  /**
   * A Dropbox group expanded to its ACTIVE members through the team API
   * (invited members have not joined and suspended/removed members cannot
   * read content — excluded fail-closed). `null` means the expansion
   * failed — the caller yields the group flagged, never silently empty.
   */
  private async expandTeamGroup(
    teamClient: Dropbox,
    groupId: string,
  ): Promise<GroupMemberYield[] | null> {
    try {
      const members: GroupMemberYield[] = [];
      await this.rateLimit();
      let page = (
        await teamClient.teamGroupsMembersList({
          group: { ".tag": "group_id", group_id: groupId },
          limit: MEMBER_PAGE_LIMIT,
        })
      ).result;
      for (;;) {
        for (const member of page.members) {
          if (member.profile.status[".tag"] !== "active") continue;
          members.push({
            accountId:
              member.profile.account_id ?? member.profile.team_member_id,
            displayName: member.profile.name?.display_name ?? null,
            email: member.profile.email ?? null,
            accountType: "user",
          });
        }
        if (!page.has_more) break;
        await this.rateLimit();
        page = (
          await teamClient.teamGroupsMembersListContinue({
            cursor: page.cursor,
          })
        ).result;
      }
      return members.sort((a, b) => a.accountId.localeCompare(b.accountId));
    } catch (error) {
      this.log.warn(
        { groupId, error: extractErrorMessage(error) },
        "Could not expand a Dropbox group through the team API; its roster is fail-closed for this pass",
      );
      return null;
    }
  }

  /** A fresh recursive change cursor for the configured tree. */
  private async latestChangeCursor(
    dbx: Dropbox,
    config: DropboxConfig,
  ): Promise<string> {
    await this.rateLimit();
    const result = await dbx.filesListFolderGetLatestCursor({
      path: normalizeRootPath(config.rootPath),
      recursive: true,
      include_deleted: false,
      include_has_explicit_shared_members: true,
    });
    return result.result.cursor;
  }

  private reportDroppedPrincipals(): void {
    if (this.droppedPrincipals <= 0) return;
    const count = this.droppedPrincipals;
    this.droppedPrincipals = 0;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped Dropbox principals that could not be resolved (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }
}

// ===== Module-level helpers =====

function getDropboxClient(credentials: ConnectorCredentials): Dropbox {
  return new Dropbox({ accessToken: credentials.apiToken });
}

/**
 * Client for the resolved acting account: path-rooted at the shared team
 * root when one exists (see `getNamespacedClient`) and acting as
 * `selectUser` when the token is team-linked, plain otherwise.
 */
function clientForAccount(
  credentials: ConnectorCredentials,
  account: users.FullAccount,
  selectUser?: string,
): Dropbox {
  const rootInfo = account.root_info;
  const pathRoot =
    rootInfo?.root_namespace_id &&
    rootInfo.root_namespace_id !== rootInfo.home_namespace_id
      ? JSON.stringify({ ".tag": "root", root: rootInfo.root_namespace_id })
      : undefined;
  if (!pathRoot && !selectUser) return getDropboxClient(credentials);
  return new Dropbox({
    accessToken: credentials.apiToken,
    ...(selectUser ? { selectUser } : {}),
    ...(pathRoot ? { pathRoot } : {}),
  });
}

function normalizeRootPath(rootPath: string | undefined): string {
  if (!rootPath) return "";
  return rootPath.startsWith("/") ? rootPath : `/${rootPath}`;
}

// ----- Permission-sync helpers -----

/**
 * The single top-level container: the token account's synced tree. The
 * key is constant — config carries no account identity, and the ACL token
 * (`container:<connectorId>:account`) is already connector-scoped.
 */
const TOP_CONTAINER_KEY = "account";

const DIRECT_GRANTS_GROUP_ID = "direct-grants";

const PERMISSION_READBACK_PAGE_SIZE = 1000;
const MEMBER_PAGE_LIMIT = 300;

interface CorpusSharingEntry {
  parentSharedFolderId: string | null;
  hasExplicitSharedMembers: boolean;
}

interface ResolvedAudience {
  permissions: DocumentPermissions;
  resolutionFailed: boolean;
}

interface DropboxOwner {
  accountId: string;
  email: string | null;
  displayName: string | null;
}

interface FolderMemberLists {
  users: sharing.UserMembershipInfo[];
  groups: sharing.GroupMembershipInfo[];
}

function sharedFolderContainerKey(sharedFolderId: string): string {
  return `${TOP_CONTAINER_KEY}/sf:${sharedFolderId}`;
}

function parseSharedFolderContainerKey(containerKey: string): string | null {
  const prefix = `${TOP_CONTAINER_KEY}/sf:`;
  return containerKey.startsWith(prefix)
    ? containerKey.slice(prefix.length)
    : null;
}

function emptyAudience(): DocumentPermissions {
  return { isPublic: false, users: [], groups: [] };
}

/**
 * Access levels that convey a content read: everything except `traverse`
 * (folder-listing-only navigation rights) and unknown future levels —
 * fail-closed on anything unrecognized.
 */
function canReadAccessLevel(accessType: sharing.AccessLevel): boolean {
  const tag = accessType[".tag"];
  return (
    tag === "owner" ||
    tag === "editor" ||
    tag === "viewer" ||
    tag === "viewer_no_comment"
  );
}

/** Drain the keyset-paginated read-back into a sorted source-id list. */
async function readAllIngestedSourceIds(
  readIngestedDocuments: PermissionSyncParams["readIngestedDocuments"],
): Promise<string[]> {
  const sourceIds: string[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { documents, nextAfterId } = await readIngestedDocuments({
      afterId,
      limit: PERMISSION_READBACK_PAGE_SIZE,
    });
    for (const doc of documents) sourceIds.push(doc.sourceId);
    if (documents.length < PERMISSION_READBACK_PAGE_SIZE) break;
    afterId = nextAfterId;
  }
  return sourceIds.sort();
}

function parseDropboxConfig(
  config: Record<string, unknown>,
): DropboxConfig | null {
  const result = DropboxConfigSchema.safeParse({ type: "dropbox", ...config });
  return result.success ? result.data : null;
}

async function extractTextFromBinary(
  buffer: Buffer,
  format: BinaryFormat,
): Promise<{ text: string; emptyReason?: string; warning?: string }> {
  switch (format) {
    case ".docx": {
      return { text: await extractTextFromDocx(buffer) };
    }
    case ".pdf": {
      const result = await parsePdfBuffer(buffer);
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
  }
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot === -1 ? "" : filename.slice(lastDot).toLowerCase();
}

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function laterOf(a: string, b: string): string {
  return a >= b ? a : b;
}

function fileToDocument(
  file: DropboxFileMetadata,
  content: string,
  mediaContent?: { mimeType: string; data: string },
): ConnectorDocument {
  return {
    id: file.id,
    title: file.name,
    // An image-only document gets its title as the text so the chunk has an
    // embeddable label; text documents keep their raw content byte-for-byte
    // (existing corpora must not re-chunk).
    content: content || (mediaContent ? `# ${file.name}` : ""),
    sourceUrl: `https://www.dropbox.com/home${file.path_display ?? ""}`,
    metadata: {
      dropboxFileId: file.id,
      pathDisplay: file.path_display,
      serverModified: file.server_modified,
      clientModified: file.client_modified,
      size: file.size,
    },
    updatedAt: new Date(file.server_modified),
    ...(mediaContent ? { mediaContent } : {}),
  };
}
