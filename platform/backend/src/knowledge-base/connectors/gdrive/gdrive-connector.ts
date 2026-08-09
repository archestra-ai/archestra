import type { ModelInputModality } from "@archestra/shared";
import type { admin_directory_v1, drive_v3 } from "googleapis";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  GoogleDriveCheckpoint,
  GoogleDriveConfig,
} from "@/types";
import { GoogleDriveConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";
import { extractTextFromDocx } from "../docx-text-extractor";
import {
  type FolderTraversalAdapter,
  traverseFolders,
} from "../folder-traversal";
import { parsePdfBuffer } from "../pdf-utils";
import { extractTextFromPptx } from "../pptx-text-extractor";
import { extractTextFromXlsx } from "../xlsx-text-extractor";
import {
  asDelegatedAuth,
  buildAdminDirectoryClient,
  buildDriveClient,
  type DelegatedServiceAccountAuth,
  describeGoogleAuthFailure,
  type GoogleDriveAuth,
  GoogleDriveAuthConfigError,
  resolveGoogleDriveAuth,
} from "./gdrive-auth";

const DEFAULT_BATCH_SIZE = 50;
const MAX_CONTENT_LENGTH = 500_000; // 500 KB text limit per document
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB image size limit
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_MAX_DEPTH = 50; // Safety limit for recursive folder traversal

/**
 * A domain pass can cross thousands of identities that hold nothing new, and
 * progress is only durable when a batch is yielded. Emitting a document-free
 * checkpoint every this many finished targets keeps an interrupted run from
 * re-walking a stretch of empty accounts, without yielding once per user.
 */
const DOMAIN_PROGRESS_CHECKPOINT_TARGETS = 50;

/**
 * Ceiling on the cross-identity dedupe set. One shared file is visible to
 * everyone it was shared with, so without this the same document would be
 * downloaded and embedded once per viewer. Past the cap the run stops
 * deduplicating rather than growing the set without bound — re-ingesting a
 * document is wasteful but harmless, since ingestion upserts by file id.
 */
const MAX_TRACKED_FILE_IDS = 2_000_000;

// File extensions whose text content we can extract via direct download
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

// Binary formats we can extract text from with libraries. Keyed by the
// canonical mimeType Drive reports so a file is recognized by what it IS, even
// when its name has no extension; the extension is only a fallback.
type BinaryFormat = ".pdf" | ".docx" | ".pptx" | ".xlsx";
const BINARY_MIME_TYPES: Record<string, BinaryFormat> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

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

// Image mimeTypes we support (mirror of IMAGE_MIME_TYPES values) — lets us
// recognize images by mimeType, not just by filename extension.
const SUPPORTED_IMAGE_MIME_TYPES = new Set(Object.values(IMAGE_MIME_TYPES));

// Google Workspace native files exported as plain text (one logical document).
const GOOGLE_DOC_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
};

// Google Workspace native files exported as a binary Office format instead of
// text, then run through the same extractor as an uploaded file. A Google Sheet
// exported as CSV is only its FIRST sheet, so export .xlsx and read every sheet.
const GOOGLE_BINARY_EXPORTS: Record<
  string,
  { exportMimeType: string; format: BinaryFormat }
> = {
  "application/vnd.google-apps.spreadsheet": {
    exportMimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    format: ".xlsx",
  },
};

/** Narrowed Drive file type – the fields listed in our $select queries. */
interface DriveFile {
  id: string | null | undefined;
  name: string | null | undefined;
  mimeType: string | null | undefined;
  modifiedTime: string | null | undefined;
  createdTime: string | null | undefined;
  owners?: Array<{ emailAddress?: string | null }>;
  webViewLink: string | null | undefined;
  parents: string[] | null | undefined;
  size: string | null | undefined;
}

/** Response shape from `drive.files.list`. */
interface FileListResponse {
  data: {
    files?: DriveFile[];
    nextPageToken?: string | null;
  };
}

export class GoogleDriveConnector extends BaseConnector {
  type = "gdrive" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseGDriveConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid Google Drive configuration" };
    }
    return { valid: true };
  }

  /**
   * Check that the connector can actually do what it is configured to do, not
   * merely that its credential authenticates.
   *
   * Authenticating proves nothing useful on its own here: a service account
   * with a valid key that nobody shared anything with passes an `about.get`
   * and then syncs zero files forever. So each stage of the configured setup
   * is probed separately — sign in (impersonating, when that is the mode),
   * read the directory when the pass will enumerate one, and open the folder
   * or shared drives that were named — and a failure says which stage it was.
   */
  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing Google Drive connection");

    const config = parseGDriveConfig(params.config);
    if (!config) {
      return { success: false, error: "Invalid configuration" };
    }

    let auth: GoogleDriveAuth;
    try {
      auth = resolveGoogleDriveAuth({
        config,
        credentials: params.credentials,
      });
    } catch (error) {
      if (error instanceof GoogleDriveAuthConfigError) {
        return { success: false, error: error.message };
      }
      throw error;
    }

    const subject = auth.kind === "service_account" ? auth.subject : undefined;
    const drive = buildDriveClient(auth);

    // Stage 1 — can we act as the identity at all?
    let identity: string | undefined;
    try {
      const about = await drive.about.get({ fields: "user(emailAddress)" });
      identity = about.data.user?.emailAddress ?? subject;
    } catch (error) {
      return this.failedTest({
        error,
        subject,
        fallback: subject
          ? `Could not sign in as ${subject}`
          : "Could not sign in to Google Drive",
      });
    }

    const asWho = identity ? ` as ${identity}` : "";

    // Stage 2 — a domain-wide pass is only possible if the directory reads.
    if (willEnumerateDomain(config)) {
      try {
        const directory = buildAdminDirectoryClient(auth);
        await directory.users.list({ customer: "my_customer", maxResults: 1 });
      } catch (error) {
        return this.failedTest({
          error,
          subject,
          fallback: `Signed in${asWho}, but the Workspace directory could not be read, so users cannot be enumerated for a domain-wide sync. Confirm the Admin SDK API is enabled and that the service account is authorized for the directory scope.`,
        });
      }
    }

    // Stage 3 — is the scope that was actually configured reachable? This is
    // the check that catches the folder nobody shared with the identity.
    if (config.folderId) {
      try {
        await drive.files.get({
          fileId: config.folderId,
          fields: "id,name",
          supportsAllDrives: true,
        });
      } catch (error) {
        return this.failedTest({
          error,
          subject,
          fallback: `Signed in${asWho}, but folder ${config.folderId} is not visible to that identity. Share the folder with it, or choose a folder it can already see.`,
        });
      }
    }

    for (const driveId of configuredSharedDriveIds(config)) {
      try {
        await drive.drives.get({ driveId, fields: "id,name" });
      } catch (error) {
        return this.failedTest({
          error,
          subject,
          fallback: `Signed in${asWho}, but shared drive ${driveId} is not visible to that identity. Add it as a member of the shared drive, or remove that drive ID.`,
        });
      }
    }

    this.log.debug({ identity }, "Google Drive connection test successful");
    return { success: true };
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseGDriveConfig(params.config);
    if (!parsed) return null;

    // A domain-wide pass would have to enumerate every user and page their
    // whole Drive just to produce a number — the same work as the sync itself.
    // Progress is reported from what the run actually finds instead.
    if (willEnumerateDomain(parsed)) return null;

    try {
      const checkpoint =
        (params.checkpoint as GoogleDriveCheckpoint | null) ?? {
          type: "gdrive" as const,
        };
      const syncFrom = checkpoint.lastSyncedAt;
      const safetyBufferedSyncFrom = syncFrom
        ? subtractSafetyBuffer(syncFrom)
        : undefined;

      const drive = this.getDriveClient({
        config: parsed,
        credentials: params.credentials,
      });
      let total = 0;

      const targetDriveIds =
        parsed.driveIds && parsed.driveIds.length > 0
          ? parsed.driveIds
          : parsed.driveId
            ? [parsed.driveId]
            : [undefined];

      for (const currentDriveId of targetDriveIds) {
        const query = buildFileQuery(parsed, safetyBufferedSyncFrom);
        let pageToken: string | undefined;
        const useSharedDriveApi = hasSharedDriveTarget({
          ...parsed,
          driveId: currentDriveId,
        });

        do {
          await this.rateLimit();
          const res = (await drive.files.list({
            q: query,
            pageSize: 1000,
            pageToken,
            fields: "nextPageToken,files(id)",
            includeItemsFromAllDrives: useSharedDriveApi,
            supportsAllDrives: useSharedDriveApi,
            ...(currentDriveId
              ? { driveId: currentDriveId, corpora: "drive" as const }
              : {}),
          })) as FileListResponse;

          total += res.data.files?.length ?? 0;
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
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
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseGDriveConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Google Drive configuration");
    }

    const checkpoint = (params.checkpoint as GoogleDriveCheckpoint | null) ?? {
      type: "gdrive" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const supportsImages =
      params.embeddingInputModalities?.includes("image") ?? false;

    // Domain-wide delegation with nothing narrowing it down: coverage follows
    // the organization, so the pass walks every shared drive and impersonates
    // every user rather than acting as one identity.
    if (willEnumerateDomain(parsed)) {
      yield* this.syncDomain({
        config: parsed,
        credentials: params.credentials,
        checkpoint,
        batchSize,
        supportsImages,
      });
      return;
    }

    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;

    const drive = this.getDriveClient({
      config: parsed,
      credentials: params.credentials,
    });

    // Track the highest modifiedTime seen across all yielded batches
    // so the checkpoint only advances monotonically.
    const progress = {
      maxLastModified: checkpoint.lastSyncedAt as string | undefined,
    };

    this.log.debug(
      {
        authMode: parsed.authMode ?? "legacy",
        driveId: parsed.driveId,
        driveIds: parsed.driveIds,
        folderId: parsed.folderId,
        impersonating: parsed.delegatedAdminEmail,
        useSharedDriveApi: hasSharedDriveTarget(parsed),
        recursive: parsed.recursive,
        syncFrom,
        supportsImages,
      },
      "Starting Google Drive sync",
    );

    yield* this.syncAsIdentity({
      drive,
      config: parsed,
      progress,
      syncFrom: safetyBufferedSyncFrom,
      batchSize,
      supportsImages,
    });
  }

  // ===== Private methods =====

  /**
   * Everything one identity contributes: a folder walk when the connector is
   * folder-scoped, otherwise a listing per configured drive.
   */
  private async *syncAsIdentity(params: {
    drive: drive_v3.Drive;
    config: GoogleDriveConfig;
    progress: { maxLastModified: string | undefined };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
    dedupe?: Set<string>;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { config } = params;

    if (config.folderId) {
      // Folder-scoped mode — recursive defaults to true
      yield* this.syncFolder({
        ...params,
        folderId: config.folderId,
        recursive: config.recursive ?? true,
        maxDepth: config.maxDepth ?? DEFAULT_MAX_DEPTH,
      });
      return;
    }

    // Drive listing mode
    const targetDriveIds =
      config.driveIds && config.driveIds.length > 0
        ? config.driveIds
        : config.driveId
          ? [config.driveId]
          : [undefined];

    for (const currentDriveId of targetDriveIds) {
      yield* this.syncDriveFiles({
        ...params,
        config: { ...config, driveId: currentDriveId },
      });
    }
  }

  /**
   * Walk the whole Workspace domain: every shared drive, then every user's My
   * Drive under impersonation. This is what makes coverage follow the
   * organization instead of a manual share list — a drive created tomorrow is
   * picked up by the next pass with nobody having to remember anything.
   *
   * The two halves do not overlap: a per-user listing uses the default `user`
   * corpus, which excludes shared drives. Files shared between users' own
   * Drives do overlap, so a file id seen once is not fetched again.
   *
   * `lastSyncedAt` only advances when a pass finishes, and it advances to when
   * that pass *started* rather than to the newest file it saw. A pass spans
   * many identities over a long time; anything modified while it was running
   * has to stay in scope for the next one.
   */
  private async *syncDomain(params: {
    config: GoogleDriveConfig;
    credentials: ConnectorCredentials;
    checkpoint: GoogleDriveCheckpoint;
    batchSize: number;
    supportsImages: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { config, credentials, checkpoint, batchSize, supportsImages } =
      params;

    const adminAuth = asDelegatedAuth(
      resolveGoogleDriveAuth({ config, credentials }),
    );
    const directory = buildAdminDirectoryClient(adminAuth);

    // A resumed pass keeps the timestamp it began with: the cursor may only
    // move past work that actually finished.
    const passStartedAt =
      checkpoint.domainSyncStartedAt ?? new Date().toISOString();
    const done = new Set(checkpoint.domainTargetsDone ?? []);
    const syncFrom = checkpoint.lastSyncedAt
      ? subtractSafetyBuffer(checkpoint.lastSyncedAt)
      : undefined;
    const seenFileIds = new Set<string>();

    const sharedDriveIds = await this.listDomainSharedDrives(adminAuth);
    const userEmails = await this.listDomainUsers(directory);

    const targets: Array<{ key: string; driveId?: string; user?: string }> = [
      ...sharedDriveIds.map((driveId) => ({
        key: `drive:${driveId}`,
        driveId,
      })),
      ...userEmails.map((user) => ({ key: `user:${user}`, user })),
    ];

    this.log.info(
      {
        sharedDrives: sharedDriveIds.length,
        users: userEmails.length,
        alreadyDone: done.size,
        passStartedAt,
        syncFrom,
      },
      "Starting domain-wide Google Drive sync",
    );

    const domainCheckpoint = (): GoogleDriveCheckpoint => ({
      type: "gdrive",
      lastSyncedAt: checkpoint.lastSyncedAt,
      domainTargetsDone: [...done],
      domainSyncStartedAt: passStartedAt,
    });

    let targetsSinceYield = 0;

    for (const target of targets) {
      if (done.has(target.key)) continue;

      const identityDrive = await this.openDomainTarget({
        adminAuth,
        target,
      });

      if (!identityDrive) {
        // Recorded rather than dropped: a shared drive the delegated admin
        // cannot open is exactly the gap this connector exists to close, and
        // it has to be visible in the run rather than inferred from a
        // suspiciously low document count.
        done.add(target.key);
        targetsSinceYield++;
        continue;
      }

      const identityConfig: GoogleDriveConfig = target.driveId
        ? { ...config, driveId: target.driveId, driveIds: undefined }
        : { ...config, driveId: undefined, driveIds: undefined };

      const inner = this.syncAsIdentity({
        drive: identityDrive,
        config: identityConfig,
        progress: { maxLastModified: undefined },
        syncFrom,
        batchSize,
        supportsImages,
        dedupe: seenFileIds,
      });

      // Peek one batch ahead so the LAST batch of a target is the one that
      // records the target as finished. Marking it earlier would let an
      // interruption skip work that never happened.
      let next = await inner.next();
      while (!next.done) {
        const batch = next.value;
        next = await inner.next();
        if (next.done) {
          done.add(target.key);
          targetsSinceYield = 0;
        }
        yield {
          ...batch,
          checkpoint: domainCheckpoint(),
          // Always true: a closing batch follows even after the last target,
          // and a batch claiming to be the end would let the run's time budget
          // finish the pass early — recording targets it never walked as done.
          hasMore: true,
        };
      }

      if (!done.has(target.key)) {
        done.add(target.key);
        targetsSinceYield++;
      }

      // Long stretches of empty accounts yield nothing, so progress would
      // never reach the database. Checkpoint periodically on its own.
      if (targetsSinceYield >= DOMAIN_PROGRESS_CHECKPOINT_TARGETS) {
        targetsSinceYield = 0;
        yield {
          documents: [],
          failures: this.flushFailures(),
          skipped: this.flushSkipped(),
          checkpoint: domainCheckpoint(),
          hasMore: true,
        };
      }
    }

    this.log.info(
      { targets: targets.length, uniqueFiles: seenFileIds.size },
      "Domain-wide Google Drive sync complete",
    );

    // Close the pass: clear the per-target progress and move the cursor to
    // when this pass began.
    yield {
      documents: [],
      failures: this.flushFailures(),
      skipped: this.flushSkipped(),
      checkpoint: { type: "gdrive", lastSyncedAt: passStartedAt },
      hasMore: false,
    };
  }

  /**
   * A Drive client that can actually read the target, or null.
   *
   * A shared drive is normally opened as the delegated admin, but being a
   * domain admin does not by itself grant membership of a shared drive. When
   * the admin cannot open one, its membership is read with domain-admin access
   * and a member is impersonated instead — otherwise a drive nobody thought to
   * add the admin to would silently contribute nothing.
   */
  private async openDomainTarget(params: {
    adminAuth: DelegatedServiceAccountAuth;
    target: { key: string; driveId?: string; user?: string };
  }): Promise<drive_v3.Drive | null> {
    const { adminAuth, target } = params;

    if (target.user) {
      return buildDriveClient({ ...adminAuth, subject: target.user });
    }

    const driveId = target.driveId;
    if (!driveId) return null;

    const adminDrive = buildDriveClient(adminAuth);
    try {
      await this.rateLimit();
      await adminDrive.drives.get({ driveId, fields: "id" });
      return adminDrive;
    } catch {
      // Falls through to impersonating a member.
    }

    const member = await this.findSharedDriveMember(adminDrive, driveId);
    if (!member) {
      this.trackSkipped({
        itemId: driveId,
        name: `Shared drive ${driveId}`,
        reason: "no_reachable_member",
      });
      this.log.warn(
        { driveId },
        "Shared drive has no impersonable member; skipping",
      );
      return null;
    }

    const memberDrive = buildDriveClient({ ...adminAuth, subject: member });
    try {
      await this.rateLimit();
      await memberDrive.drives.get({ driveId, fields: "id" });
      this.log.debug(
        { driveId, member },
        "Opened shared drive by impersonating a member",
      );
      return memberDrive;
    } catch (error) {
      this.trackSkipped({
        itemId: driveId,
        name: `Shared drive ${driveId}`,
        reason: "unreachable",
      });
      this.log.warn(
        { driveId, member, error: extractErrorMessage(error) },
        "Shared drive unreachable even as a member; skipping",
      );
      return null;
    }
  }

  private async findSharedDriveMember(
    adminDrive: drive_v3.Drive,
    driveId: string,
  ): Promise<string | null> {
    try {
      await this.rateLimit();
      const res = await adminDrive.permissions.list({
        fileId: driveId,
        supportsAllDrives: true,
        useDomainAdminAccess: true,
        fields: "permissions(type,role,emailAddress)",
        pageSize: 100,
      });
      const members = res.data.permissions ?? [];
      // Organizers first: the role most likely to see everything in the drive.
      const ranked = [...members].sort(
        (a, b) =>
          (a.role === "organizer" ? 0 : 1) - (b.role === "organizer" ? 0 : 1),
      );
      for (const permission of ranked) {
        if (permission.type === "user" && permission.emailAddress) {
          return permission.emailAddress;
        }
      }
      return null;
    } catch (error) {
      this.log.debug(
        { driveId, error: extractErrorMessage(error) },
        "Could not read shared drive membership",
      );
      return null;
    }
  }

  /** Every shared drive in the domain, seen through domain-admin access. */
  private async listDomainSharedDrives(
    adminAuth: DelegatedServiceAccountAuth,
  ): Promise<string[]> {
    const drive = buildDriveClient(adminAuth);
    const ids: string[] = [];
    let pageToken: string | undefined;

    do {
      await this.rateLimit();
      const res = await drive.drives.list({
        pageSize: 100,
        pageToken,
        useDomainAdminAccess: true,
        fields: "nextPageToken,drives(id,name)",
      });
      for (const sharedDrive of res.data.drives ?? []) {
        if (sharedDrive.id) ids.push(sharedDrive.id);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return ids;
  }

  /**
   * Every user whose Drive can be impersonated. Suspended and archived
   * accounts are left out: Google refuses to mint a token for them, so
   * including them would turn a normal domain into a run full of failures.
   */
  private async listDomainUsers(
    directory: admin_directory_v1.Admin,
  ): Promise<string[]> {
    const emails: string[] = [];
    let pageToken: string | undefined;

    do {
      await this.rateLimit();
      const res = await directory.users.list({
        customer: "my_customer",
        maxResults: 500,
        pageToken,
        orderBy: "email",
        fields: "nextPageToken,users(primaryEmail,suspended,archived)",
      });
      for (const user of res.data.users ?? []) {
        if (user.suspended || user.archived) continue;
        if (user.primaryEmail) emails.push(user.primaryEmail);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return emails;
  }

  /**
   * Turn a probe failure into a connection-test result, preferring an
   * explanation of the Google auth code over its raw text.
   */
  private failedTest(params: {
    error: unknown;
    subject: string | undefined;
    fallback: string;
  }): { success: boolean; error: string } {
    const described = describeGoogleAuthFailure({
      error: params.error,
      subject: params.subject,
    });
    const detail = extractErrorMessage(params.error);
    const message = described ?? `${params.fallback}: ${detail}`;
    this.log.error({ error: detail }, "Google Drive connection test failed");
    return { success: false, error: message };
  }

  /**
   * Build a Drive client for the identity the connector is configured to act
   * as. `impersonate` overrides the delegated admin, which is how the
   * domain-wide pass walks one user at a time through this same path.
   */
  private getDriveClient(params: {
    config: GoogleDriveConfig;
    credentials: ConnectorCredentials;
    impersonate?: string;
  }): drive_v3.Drive {
    return buildDriveClient(resolveGoogleDriveAuth(params));
  }

  private async *syncDriveFiles(params: {
    drive: drive_v3.Drive;
    config: GoogleDriveConfig;
    progress: { maxLastModified: string | undefined };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
    dedupe?: Set<string>;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      drive,
      config,
      progress,
      syncFrom,
      batchSize,
      supportsImages,
      dedupe,
    } = params;
    const useSharedDriveApi = hasSharedDriveTarget(config);

    const query = buildFileQuery(config, syncFrom);
    let pageToken: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      let res: FileListResponse;
      try {
        res = (await drive.files.list({
          q: query,
          pageSize: batchSize,
          pageToken,
          fields:
            "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,owners,webViewLink,parents,size)",
          orderBy: "modifiedTime asc",
          includeItemsFromAllDrives: useSharedDriveApi,
          supportsAllDrives: useSharedDriveApi,
          ...(config.driveId
            ? { driveId: config.driveId, corpora: "drive" as const }
            : {}),
        })) as FileListResponse;
      } catch (error) {
        throw new Error(
          `Google Drive files query failed: ${extractErrorMessage(error)}`,
        );
      }

      const allFiles = res.data.files ?? [];
      const files = this.selectIngestableFiles({
        files: allFiles,
        supportsImages,
        dedupe,
      });

      const documents: ConnectorDocument[] = [];

      for (const file of files) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const result = await this.downloadFileContent(
              drive,
              file,
              supportsImages,
            );
            // Skip files with no extractable content or media to avoid indexing
            // title-only documents that provide no search value.
            if (!result.text.trim() && !result.mediaContent) return null;
            return fileToDocument(file, result.text, result.mediaContent);
          },
          fallback: null,
          itemId: file.id ?? "unknown",
          resource: "driveFile",
        });
        if (doc) documents.push(doc);
      }

      // Advance the monotonic high-water mark using all results (not just
      // filtered ones) so the checkpoint moves past unsupported files.
      const lastFile = allFiles[allFiles.length - 1];
      const lastModified = lastFile?.modifiedTime;

      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      pageToken = res.data.nextPageToken ?? undefined;
      hasMore = !!pageToken;

      batchIndex++;
      this.log.debug(
        {
          batchIndex,
          fileCount: files.length,
          documentCount: documents.length,
          hasMore,
        },
        "Google Drive files batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: buildCheckpoint({
          type: "gdrive",
          itemUpdatedAt: progress.maxLastModified
            ? new Date(progress.maxLastModified)
            : undefined,
          previousLastSyncedAt: progress.maxLastModified,
        }),
        hasMore,
      };
    }
  }

  /**
   * Folder-scoped sync using lazy breadth-first traversal.
   *
   * Instead of eagerly collecting all subfolder IDs up front (which can OOM
   * or stall on deeply nested drives), we use a BFS queue: discover direct
   * children of the current folder, enqueue them, and yield file batches
   * from each folder as we go.
   */
  private async *syncFolder(params: {
    drive: drive_v3.Drive;
    folderId: string;
    config: GoogleDriveConfig;
    progress: { maxLastModified: string | undefined };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
    recursive: boolean;
    maxDepth: number;
    dedupe?: Set<string>;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      drive,
      folderId,
      config,
      progress,
      syncFrom,
      batchSize,
      supportsImages,
      recursive,
      maxDepth,
      dedupe,
    } = params;

    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: (parentId: string) =>
        this.listDirectSubfolders(drive, parentId, config),
    };

    const folderGen = traverseFolders(
      adapter,
      { rootFolderId: folderId, recursive, maxDepth },
      this.log,
    );

    let next = await folderGen.next();

    while (!next.done) {
      const currentFolderId = next.value;
      next = await folderGen.next();
      const hasMoreFolders = !next.done;

      yield* this.syncFilesInFolder({
        drive,
        folderId: currentFolderId,
        config,
        progress,
        syncFrom,
        batchSize,
        supportsImages,
        dedupe,
        hasMoreFolders,
      });
    }
  }

  /**
   * Sync files within a single folder, yielding paginated batches.
   */
  private async *syncFilesInFolder(params: {
    drive: drive_v3.Drive;
    folderId: string;
    config: GoogleDriveConfig;
    progress: { maxLastModified: string | undefined };
    syncFrom: string | undefined;
    batchSize: number;
    supportsImages: boolean;
    dedupe?: Set<string>;
    hasMoreFolders: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      drive,
      folderId,
      config,
      progress,
      syncFrom,
      batchSize,
      supportsImages,
      dedupe,
      hasMoreFolders,
    } = params;
    const useSharedDriveApi = hasSharedDriveTarget(config);

    // The query is identical for every page of this folder — build it once.
    let query = `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
    if (syncFrom) {
      query += ` and modifiedTime >= '${escapeDriveQueryValue(syncFrom)}'`;
    }
    if (config.fileTypes && config.fileTypes.length > 0) {
      const mimeFilters = config.fileTypes
        .map((ext) => `name contains '${escapeDriveQueryValue(ext)}'`)
        .join(" or ");
      query += ` and (${mimeFilters})`;
    }

    let pageToken: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      let res: FileListResponse;
      try {
        res = (await drive.files.list({
          q: query,
          pageSize: batchSize,
          pageToken,
          fields:
            "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,owners,webViewLink,parents,size)",
          orderBy: "modifiedTime asc",
          includeItemsFromAllDrives: useSharedDriveApi,
          supportsAllDrives: useSharedDriveApi,
        })) as FileListResponse;
      } catch (error) {
        throw new Error(
          `Google Drive folder query failed: ${extractErrorMessage(error)}`,
        );
      }

      const allFiles = res.data.files ?? [];
      const files = this.selectIngestableFiles({
        files: allFiles,
        supportsImages,
        dedupe,
      });

      const documents: ConnectorDocument[] = [];

      for (const file of files) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const result = await this.downloadFileContent(
              drive,
              file,
              supportsImages,
            );
            if (!result.text.trim() && !result.mediaContent) return null;
            return fileToDocument(file, result.text, result.mediaContent);
          },
          fallback: null,
          itemId: file.id ?? "unknown",
          resource: "driveFile",
        });
        if (doc) documents.push(doc);
      }

      const lastFile = allFiles[allFiles.length - 1];
      const lastModified = lastFile?.modifiedTime;

      if (
        lastModified &&
        (!progress.maxLastModified || lastModified > progress.maxLastModified)
      ) {
        progress.maxLastModified = lastModified;
      }

      pageToken = res.data.nextPageToken ?? undefined;
      hasMore = !!pageToken;

      batchIndex++;
      this.log.debug(
        {
          folderId,
          batchIndex,
          fileCount: files.length,
          documentCount: documents.length,
          hasMore: hasMore || hasMoreFolders,
        },
        "Google Drive folder batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: buildCheckpoint({
          type: "gdrive",
          itemUpdatedAt: progress.maxLastModified
            ? new Date(progress.maxLastModified)
            : undefined,
          previousLastSyncedAt: progress.maxLastModified,
        }),
        hasMore: hasMore || hasMoreFolders,
      };
    }
  }

  private async listDirectSubfolders(
    drive: drive_v3.Drive,
    parentId: string,
    config: GoogleDriveConfig,
  ): Promise<string[]> {
    const subfolders: string[] = [];
    let pageToken: string | undefined;
    const useSharedDriveApi = hasSharedDriveTarget(config);

    do {
      await this.rateLimit();
      const res = (await drive.files.list({
        q: `'${escapeDriveQueryValue(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        pageSize: 1000,
        pageToken,
        fields: "nextPageToken,files(id,name)",
        includeItemsFromAllDrives: useSharedDriveApi,
        supportsAllDrives: useSharedDriveApi,
      })) as FileListResponse;

      for (const folder of res.data.files ?? []) {
        if (folder.id) {
          subfolders.push(folder.id);
        }
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return subfolders;
  }

  /**
   * Narrow a page of Drive results to the files worth fetching.
   *
   * Files whose type cannot be read are recorded as skipped rather than
   * silently dropped, so a run reports "N found, M imported, K unsupported"
   * instead of a total that counts every file against an import count that
   * only covers some. Files another identity already contributed during this
   * run are dropped outright — the same document reached through a second
   * viewer is not a new document, and not a skip worth reporting either.
   */
  private selectIngestableFiles(params: {
    files: DriveFile[];
    supportsImages: boolean;
    dedupe?: Set<string>;
  }): DriveFile[] {
    const { files, supportsImages, dedupe } = params;
    const selected: DriveFile[] = [];

    for (const file of files) {
      if (dedupe && file.id) {
        if (dedupe.has(file.id)) continue;
        if (dedupe.size < MAX_TRACKED_FILE_IDS) dedupe.add(file.id);
      }

      if (isSupportedFile(file, supportsImages)) {
        selected.push(file);
      } else {
        this.trackSkipped({
          itemId: file.id ?? "unknown",
          name: file.name ?? "unknown",
          reason: "unsupported_file_type",
        });
      }
    }

    return selected;
  }

  private async downloadFileContent(
    drive: drive_v3.Drive,
    file: DriveFile,
    supportsImages: boolean,
  ): Promise<{
    text: string;
    mediaContent?: { mimeType: string; data: string };
  }> {
    const fileName = file.name ?? "";
    const fileId = file.id;
    if (!fileId) return { text: "" };

    const resolved = resolveDriveFile(file, supportsImages);

    // Google Workspace documents: export as text
    if (resolved?.kind === "google") {
      try {
        const res = await drive.files.export(
          { fileId, mimeType: resolved.exportMimeType },
          { responseType: "text" },
        );
        const text =
          typeof res.data === "string"
            ? res.data.slice(0, MAX_CONTENT_LENGTH)
            : "";
        return { text };
      } catch (error) {
        this.log.debug(
          { fileId, fileName, error: extractErrorMessage(error) },
          "Google Drive: failed to export Google Workspace file",
        );
        return { text: "" };
      }
    }

    // Google Sheets (and any other Workspace type worth exporting as Office
    // bytes): export the binary format and extract every sheet — a CSV export
    // would be the first sheet only.
    if (resolved?.kind === "google-binary") {
      try {
        const res = await drive.files.export(
          { fileId, mimeType: resolved.exportMimeType },
          { responseType: "arraybuffer" },
        );
        const buffer = Buffer.from(res.data as ArrayBuffer);
        const text = await extractTextFromBinary(buffer, resolved.format);
        return { text: text.slice(0, MAX_CONTENT_LENGTH) };
      } catch (error) {
        this.log.debug(
          { fileId, fileName, error: extractErrorMessage(error) },
          "Google Drive: failed to export Google Workspace file as Office bytes",
        );
        return { text: "" };
      }
    }

    // Plain text files: download and read as text
    if (resolved?.kind === "text") {
      const buffer = await this.downloadFileBuffer(drive, fileId);
      return {
        text: buffer.toString("utf-8").slice(0, MAX_CONTENT_LENGTH),
      };
    }

    // Binary files (.docx, .pdf, .pptx, .xlsx): download and extract text
    if (resolved?.kind === "binary") {
      const buffer = await this.downloadFileBuffer(drive, fileId);
      const text = await extractTextFromBinary(buffer, resolved.format);
      return { text: text.slice(0, MAX_CONTENT_LENGTH) };
    }

    // Image files: download as base64 for multimodal embedding
    if (resolved?.kind === "image") {
      const buffer = await this.downloadFileBuffer(drive, fileId);
      if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
        this.log.debug(
          { fileName, sizeBytes: buffer.length },
          "Google Drive: skipping oversized image",
        );
        return { text: "" };
      }
      const data = buffer.toString("base64");
      return { text: "", mediaContent: { mimeType: resolved.mimeType, data } };
    }

    this.log.debug(
      { fileName, mimeType: file.mimeType },
      "Google Drive: skipping unsupported file type",
    );
    return { text: "" };
  }

  private async downloadFileBuffer(
    drive: drive_v3.Drive,
    fileId: string,
  ): Promise<Buffer> {
    const res = await drive.files.get(
      // acknowledgeAbuse lets us download files Google has flagged as potentially
      // abusive (often false positives on a user's own drive); without it those
      // return 403 cannotDownloadAbusiveFile and the file is never indexed.
      { fileId, alt: "media", acknowledgeAbuse: true },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }
}

// ===== Module-level helpers =====

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function parseGDriveConfig(
  config: Record<string, unknown>,
): GoogleDriveConfig | null {
  const result = GoogleDriveConfigSchema.safeParse({
    type: "gdrive",
    ...config,
  });
  return result.success ? result.data : null;
}

/**
 * Build the files.list query string based on config and optional sync-from date.
 */
function buildFileQuery(
  config: GoogleDriveConfig,
  syncFrom: string | undefined,
): string {
  const parts: string[] = ["trashed = false"];

  // Exclude folders — we only want files
  parts.push("mimeType != 'application/vnd.google-apps.folder'");

  // If a folderId is set, scope to direct children of that folder
  if (config.folderId) {
    parts.push(`'${escapeDriveQueryValue(config.folderId)}' in parents`);
  }

  // Incremental sync filter
  if (syncFrom) {
    parts.push(`modifiedTime >= '${escapeDriveQueryValue(syncFrom)}'`);
  }

  // File type filter
  if (config.fileTypes && config.fileTypes.length > 0) {
    const fileTypeFilters = config.fileTypes
      .map((ext) => `name contains '${escapeDriveQueryValue(ext)}'`)
      .join(" or ");
    parts.push(`(${fileTypeFilters})`);
  }

  return parts.join(" and ");
}

/**
 * Escape a value for interpolation into a Google Drive query string literal
 * (the single-quoted operand of `'<id>' in parents`, `name contains '<ext>'`,
 * etc.). Drive's grammar uses `\` as the in-string escape char, so backslashes
 * and single quotes must be escaped to keep a value from breaking out of its
 * quotes and altering the query. Folder IDs and connector config are
 * admin-authored (not end-user input), so this is defense-in-depth rather than
 * a known injection vector.
 */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

type ResolvedDriveFile =
  | { kind: "google"; exportMimeType: string }
  | { kind: "google-binary"; exportMimeType: string; format: BinaryFormat }
  | { kind: "binary"; format: BinaryFormat }
  | { kind: "image"; mimeType: string }
  | { kind: "text" }
  | null;

/**
 * Decide how to ingest a Drive file, keyed on its mimeType first and falling
 * back to the filename extension. Drive reliably reports mimeType, so this
 * recognizes supported files (PDFs, Office docs, images, text) even when the
 * name has no extension — which the old extension-only check silently skipped.
 * Returns null for types we cannot extract text/media from.
 */
function resolveDriveFile(
  file: DriveFile,
  supportsImages: boolean,
): ResolvedDriveFile {
  const mimeType = file.mimeType ?? "";
  const ext = getFileExtension(file.name ?? "");

  // Google Sheets export as .xlsx (a CSV export is the first sheet only), then
  // go through the same extractor as an uploaded spreadsheet.
  const binaryExport = GOOGLE_BINARY_EXPORTS[mimeType];
  if (binaryExport) return { kind: "google-binary", ...binaryExport };

  // Other Google Workspace native files are exported as text.
  const exportMimeType = GOOGLE_DOC_MIME_TYPES[mimeType];
  if (exportMimeType) return { kind: "google", exportMimeType };

  // Any remaining Google-native type (forms, drawings, shortcuts, ...) has no
  // raw media — alt=media always 403s with fileNotDownloadable — so a
  // text-like file NAME must not route it to the download paths below.
  if (mimeType.startsWith("application/vnd.google-apps.")) return null;

  // Binary formats we extract with libraries (PDF/DOCX/PPTX/XLSX).
  const format = binaryFormatFor(mimeType, ext);
  if (format) return { kind: "binary", format };

  // Images for multimodal embedding, only when the model accepts them.
  if (supportsImages) {
    const imageMimeType = SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
      ? mimeType
      : SUPPORTED_IMAGE_EXTENSIONS.has(ext)
        ? IMAGE_MIME_TYPES[ext]
        : undefined;
    if (imageMimeType) return { kind: "image", mimeType: imageMimeType };
  }

  // Plain-text files: any text/* mimeType, or a known text extension.
  if (mimeType.startsWith("text/") || SUPPORTED_TEXT_EXTENSIONS.has(ext)) {
    return { kind: "text" };
  }

  return null;
}

function isSupportedFile(file: DriveFile, supportsImages: boolean): boolean {
  return resolveDriveFile(file, supportsImages) !== null;
}

function binaryFormatFor(mimeType: string, ext: string): BinaryFormat | null {
  const byMime = BINARY_MIME_TYPES[mimeType];
  if (byMime) return byMime;
  if (ext === ".pdf" || ext === ".docx" || ext === ".pptx" || ext === ".xlsx") {
    return ext;
  }
  return null;
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0) return "";
  return name.slice(lastDot).toLowerCase();
}

function hasSharedDriveTarget(config: GoogleDriveConfig): boolean {
  return Boolean(config.driveId) || Boolean(config.driveIds?.length);
}

/** The shared drives named in the config, however they were named. */
function configuredSharedDriveIds(config: GoogleDriveConfig): string[] {
  if (config.driveIds && config.driveIds.length > 0) return config.driveIds;
  return config.driveId ? [config.driveId] : [];
}

/**
 * Whether a run will walk the whole domain rather than act as one identity.
 *
 * Delegation is what makes it possible, and the absence of a narrower target
 * is what makes it wanted: naming a folder or specific shared drives is an
 * explicit statement of scope, and enumerating the domain anyway would ignore
 * it. So the connector infers the intent from the scope that was set instead
 * of asking for the same thing twice.
 */
function willEnumerateDomain(config: GoogleDriveConfig): boolean {
  return (
    config.authMode === "service_account_delegated" &&
    !config.folderId &&
    !hasSharedDriveTarget(config)
  );
}

function fileToDocument(
  file: DriveFile,
  content: string,
  mediaContent?: { mimeType: string; data: string },
): ConnectorDocument {
  const title = file.name ?? "Untitled";
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: file.id ?? "",
    title,
    content: mediaContent && !content.trim() ? `# ${title}` : fullContent,
    sourceUrl: file.webViewLink ?? undefined,
    metadata: {
      fileId: file.id,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      createdTime: file.createdTime,
      owners: file.owners?.map((o) => o.emailAddress).filter(Boolean),
      webViewLink: file.webViewLink,
      parents: file.parents,
      size: file.size ? Number(file.size) : undefined,
    },
    updatedAt: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
    mediaContent,
  };
}

async function extractTextFromBinary(
  buffer: Buffer,
  format: BinaryFormat,
): Promise<string> {
  switch (format) {
    case ".docx": {
      return extractTextFromDocx(buffer);
    }
    case ".pdf": {
      return parsePdfBuffer(buffer);
    }
    case ".pptx": {
      return extractTextFromPptx(buffer);
    }
    case ".xlsx": {
      return extractTextFromXlsx(buffer);
    }
  }
}
