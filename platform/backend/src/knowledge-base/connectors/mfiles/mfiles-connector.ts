import { randomUUID, scryptSync } from "node:crypto";
import type { ModelInputModality } from "@archestra/shared";
import { z } from "zod";
import { extractPdfText } from "@/knowledge-base/pdf-ocr";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  GroupMembershipYield,
  MFilesCheckpoint,
  MFilesConfig,
  PermissionProbeResult,
  PermissionSnapshotYield,
  PermissionSyncParams,
  PermissionSyncState,
} from "@/types";
import { MFilesConfigSchema } from "@/types";
import { stripHtmlTags } from "@/utils/strip-html";
import {
  BaseConnector,
  extractErrorMessage,
  resolveIngestibleImageMimeTypes,
  truncateConnectorContent,
} from "../base-connector";
import { extractTextFromDocx } from "../docx-text-extractor";
import {
  describePdfEmptyText,
  describePdfExtractionWarning,
} from "../pdf-utils";
import { extractTextFromPptx } from "../pptx-text-extractor";
import { extractTextFromXlsx } from "../xlsx-text-extractor";

const DEFAULT_OBJECT_TYPE_IDS = [0];
const DEFAULT_BATCH_SIZE = 50;
// white-label-ok: stable VAF extension-method wire identifier
const DEFAULT_PERMISSION_EXTENSION_METHOD =
  "ArchestraKnowledgePermissionSnapshot";
const PERMISSION_PAGE_SIZE = 250;
const INGESTED_DOCUMENT_PAGE_SIZE = 500;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_CONTENT_LENGTH = 500_000;
const ADD_ON_SCHEMA_VERSION = 2;
const ADD_ON_CHANGE_PAGE_SIZE = 250;
const OAUTH_EXPIRY_SKEW_MS = 60_000;
const PASSWORD_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "csv",
  "json",
  "xml",
  "html",
  "htm",
  "log",
  "yaml",
  "yml",
]);
const SUPPORTED_BINARY_EXTENSIONS = new Set(["docx", "pdf", "pptx", "xlsx"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
]);
const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

const MFilesObjectFileSchema = z.object({
  ID: z.number().int().nonnegative(),
  Name: z.string(),
  Extension: z.string(),
  Version: z.number().int().nonnegative(),
  ChangeTimeUtc: z.string().optional(),
});

const MFilesObjectVersionSchema = z.object({
  ObjVer: z.object({
    Type: z.number().int().nonnegative(),
    ID: z.number().int().nonnegative(),
    Version: z.number().int().nonnegative(),
  }),
  Title: z.string(),
  LastModifiedUtc: z.string(),
  Deleted: z.boolean().optional(),
  Files: z.array(MFilesObjectFileSchema).optional(),
});

type MFilesObjectFile = z.infer<typeof MFilesObjectFileSchema>;
type MFilesObjectVersion = z.infer<typeof MFilesObjectVersionSchema>;

const PermissionCursorSchema = z.string().regex(/^object:[0-9]{10}:[0-9]{20}$/);
const GroupCursorSchema = z.string().regex(/^[0-9]+$/);

const CapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(ADD_ON_SCHEMA_VERSION),
    addOnVersion: z.string().min(1),
    addOnInstanceId: z.string().uuid(),
    vaultGuid: z.string().min(1),
    callerUserId: z.number().int().positive(),
    journal: z
      .object({
        headCursor: z.string().regex(/^\d+$/),
        floorCursor: z.string().regex(/^\d+$/),
      })
      .strict(),
    capabilities: z
      .object({
        contentDelta: z.literal(true),
        permissionDelta: z.literal(true),
        groupDelta: z.literal(true),
        managedObjectsOnly: z.literal(true),
      })
      .strict(),
    permissionPolicyFingerprint: z.string().min(1),
  })
  .strict();

const ChangePageSchema = z
  .object({
    schemaVersion: z.literal(ADD_ON_SCHEMA_VERSION),
    addOnInstanceId: z.string().uuid(),
    nextCursor: z.string().regex(/^\d+$/),
    pinnedHeadCursor: z.string().regex(/^\d+$/),
    hasMore: z.boolean(),
    fullRequired: z
      .object({
        content: z.boolean(),
        permissions: z.boolean(),
        groups: z.boolean(),
        reasons: z.array(z.string()),
      })
      .strict(),
    changes: z.array(
      z
        .object({
          sequence: z.string().regex(/^\d+$/),
          kind: z.enum([
            "object-upsert",
            "object-permission",
            "object-delete",
            "group-upsert",
            "group-delete",
            "security-full",
          ]),
          objectTypeId: z.number().int().nonnegative().nullable().optional(),
          objectId: z.number().int().nonnegative().nullable().optional(),
          groupId: z.number().int().nonnegative().nullable().optional(),
        })
        .strict(),
    ),
    permissionPolicyFingerprint: z.string().min(1),
  })
  .strict();

const ObjectPageSchema = z
  .object({
    schemaVersion: z.literal(ADD_ON_SCHEMA_VERSION),
    items: z.array(
      z
        .object({
          objectTypeId: z.number().int().nonnegative(),
          objectId: z.number().int().nonnegative(),
          latestVersion: z.number().int().positive(),
        })
        .strict(),
    ),
    nextCursor: PermissionCursorSchema.nullable(),
  })
  .strict();

const PermissionPageSchema = z
  .object({
    schemaVersion: z.literal(ADD_ON_SCHEMA_VERSION),
    items: z.array(
      z
        .object({
          objectTypeId: z.number().int().nonnegative(),
          objectId: z.number().int().nonnegative(),
          latestVersion: z.number().int().positive().nullable(),
          state: z.enum(["active", "missing", "unreadable"]),
          users: z.array(
            z
              .object({
                accountId: z.string().regex(/^[0-9]+$/),
                email: z.string().email().nullable(),
              })
              .strict(),
          ),
          groups: z.array(z.string().regex(/^[0-9]+$/)),
          isPublic: z.boolean(),
          fingerprint: z.string().min(1),
          audienceResolutionFailed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const GroupPageSchema = z
  .object({
    schemaVersion: z.literal(ADD_ON_SCHEMA_VERSION),
    groups: z.array(
      z
        .object({
          groupId: GroupCursorSchema,
          name: z.string().nullable(),
          members: z.array(
            z
              .object({
                accountId: z.string().regex(/^[0-9]+$/),
                displayName: z.string().nullable(),
                email: z.string().email().nullable(),
                accountType: z.string().nullable(),
              })
              .strict(),
          ),
          membershipResolutionFailed: z.boolean(),
        })
        .strict(),
    ),
    nextCursor: GroupCursorSchema.nullable(),
  })
  .strict();

type PermissionPage = z.infer<typeof PermissionPageSchema>;
type GroupPage = z.infer<typeof GroupPageSchema>;
type Capabilities = z.infer<typeof CapabilitiesSchema>;
type ChangePage = z.infer<typeof ChangePageSchema>;
type ObjectPage = z.infer<typeof ObjectPageSchema>;
type ObjectKey = {
  objectTypeId: number;
  objectId: number;
};
type IngestedPermissionDocument = {
  sourceId: string;
  metadata: Record<string, unknown> | null;
  objectVersion: number | null;
};
type ResolvedPermissionEntry = {
  key: ObjectKey;
  item: PermissionPage["items"][number];
  documents: IngestedPermissionDocument[];
  permissions: { users: string[]; groups: string[]; isPublic: boolean };
  audienceResolutionFailed: boolean;
};

/**
 * M-Files connector built on the cross-platform M-Files Web Service (MFWS).
 *
 * MFWS deliberately exposes user-level object/file operations but has no
 * documented ACL, vault-user, or vault-group resources. Permission sync uses
 * a small server-side VAF extension method for that missing administrative
 * surface. The add-on contract is versioned and strictly parsed here so a
 * deployment cannot silently over-grant when the add-on drifts.
 */
export class MFilesConnector extends BaseConnector {
  type = "mfiles" as const;
  supportsPermissionSync = true;
  requiresAtomicSecuritySync = true;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parseMFilesConfig,
      label: "M-Files",
      extraChecks: (parsed) => {
        if (!isHttpUrl(parsed.baseUrl)) {
          return "baseUrl must be a valid HTTP(S) URL";
        }
        const objectTypeIds = parsed.objectTypeIds ?? DEFAULT_OBJECT_TYPE_IDS;
        if (new Set(objectTypeIds).size !== objectTypeIds.length) {
          return "objectTypeIds must not contain duplicates";
        }
        const authMethod = parsed.authMethod ?? "mfiles_password_token";
        if (authMethod === "oauth_client_credentials") {
          if (
            !parsed.oauthTokenEndpoint ||
            !parsed.oauthAuthConfig ||
            !parsed.oauthAuthConfigScope ||
            !parsed.oauthAccountName
          ) {
            return "OAuth requires oauthTokenEndpoint, oauthAuthConfig, oauthAuthConfigScope, and oauthAccountName";
          }
          if (parsed.domain) {
            return "domain is only supported with password-derived MFWS tokens";
          }
          if (parsed.oauthScope && parsed.oauthResource) {
            return "Configure oauthScope or oauthResource, not both";
          }
        }
        return null;
      },
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const config = parseMFilesConfig(params.config);
    if (!config) return { success: false, error: "Invalid configuration" };

    return this.runConnectionTest({
      label: "M-Files",
      probe: async () => {
        const client = this.createClient(config, params.credentials);
        // The authentication-token endpoint returns a token-shaped response
        // even for some invalid credentials. Probe an authenticated resource
        // before declaring the connection healthy.
        await client.getJson("/session");
        const capabilities = await this.getCapabilities(client, config);
        if (!sameGuid(capabilities.vaultGuid, config.vaultGuid)) {
          throw new Error(
            `The VAF Add On belongs to vault ${capabilities.vaultGuid}, not ${config.vaultGuid}`,
          );
        }
      },
    });
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const config = parseMFilesConfig(params.config);
    if (!config) return null;
    try {
      // A complete count would be the same segmented vault walk as a baseline
      // and would double the load immediately before ingestion. Preflight the
      // add-on here and let the run expose live progress with an unknown total.
      const client = this.createClient(config, params.credentials);
      await this.getCapabilities(client, config);
      return null;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Failed to estimate M-Files item count",
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
    const config = parseMFilesConfig(params.config);
    if (!config) throw new Error("Invalid M-Files configuration");
    const checkpoint = (params.checkpoint as MFilesCheckpoint | null) ?? {
      type: "mfiles" as const,
    };
    const client = this.createClient(config, params.credentials);
    const capabilities = await this.getCapabilities(client, config);
    const configFingerprint = fingerprintConfig(config, params.credentials);
    const compatible =
      checkpoint.addOnInstanceId === capabilities.addOnInstanceId &&
      checkpoint.addOnVersion === capabilities.addOnVersion &&
      checkpoint.configFingerprint === configFingerprint;
    const baselineActive = Boolean(
      compatible &&
        checkpoint.baselineGeneration &&
        checkpoint.baselineHeadCursor,
    );
    // Image formats to ingest: only those the configured embedding model and
    // its client accept — the same gate the other connectors apply.
    const imageMimeTypes = resolveIngestibleImageMimeTypes({
      connectorImageMimeTypes: Object.values(IMAGE_MIME_TYPES),
      embeddingInputModalities: params.embeddingInputModalities,
      embeddingAcceptedImageMimeTypes: params.embeddingAcceptedImageMimeTypes,
    });

    if (!compatible || !checkpoint.changeCursor || baselineActive) {
      yield* this.syncBaseline({
        client,
        config,
        checkpoint: compatible ? checkpoint : { type: "mfiles" },
        capabilities,
        configFingerprint,
        imageMimeTypes,
      });
      return;
    }

    const firstChangePage = await this.readChangePage({
      client,
      config,
      cursor: checkpoint.changeCursor,
      pinnedHeadCursor: null,
    });
    if (
      firstChangePage.addOnInstanceId !== capabilities.addOnInstanceId ||
      firstChangePage.fullRequired.content
    ) {
      yield* this.syncBaseline({
        client,
        config,
        checkpoint: { type: "mfiles" },
        capabilities,
        configFingerprint,
        imageMimeTypes,
      });
      return;
    }
    yield* this.syncDelta({
      client,
      config,
      checkpoint,
      capabilities,
      configFingerprint,
      imageMimeTypes,
      firstPage: firstChangePage,
    });
  }

  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseMFilesConfig(params.config);
    if (!config) throw new Error("Invalid M-Files configuration");
    const client = this.createClient(config, params.credentials);
    let cursor = params.cursor;
    let scopedKeys: ObjectKey[] | undefined;
    if (params.scope?.containerKeys) {
      scopedKeys = params.scope.containerKeys.map((containerKey) => {
        const key = parseContainerKey(containerKey);
        if (!key) {
          throw new Error(`Invalid M-Files container key: ${containerKey}`);
        }
        return key;
      });
      scopedKeys.sort(compareObjectKeys);
    }

    while (true) {
      let keys: ObjectKey[];
      let nextCursor: string | null = null;
      if (scopedKeys) {
        keys = scopedKeys.slice(0, PERMISSION_PAGE_SIZE);
        scopedKeys = scopedKeys.slice(PERMISSION_PAGE_SIZE);
      } else {
        const page = await this.enumerateObjectPage({
          client,
          config,
          cursor,
          limit: PERMISSION_PAGE_SIZE,
        });
        keys = page.items;
        nextCursor = page.nextCursor;
      }

      const resolved = await this.readPermissionItems({
        client,
        config,
        keys,
        params,
      });
      for (const entry of resolved) {
        const containerKey = buildContainerKey(
          entry.key.objectTypeId,
          entry.key.objectId,
        );
        yield {
          kind: "container",
          containerKey,
          permissions: entry.audienceResolutionFailed
            ? { users: [], groups: [], isPublic: false }
            : entry.permissions,
          fingerprint: entry.item.fingerprint,
          audienceResolutionFailed: entry.audienceResolutionFailed,
          cursor: containerKey,
        };
        for (const document of entry.documents) {
          yield {
            kind: "document",
            sourceId: document.sourceId,
            containerKey,
            cursor: containerKey,
          };
        }
      }

      if (scopedKeys) {
        if (scopedKeys.length === 0) break;
      } else {
        if (nextCursor === null) break;
        if (cursor && nextCursor.localeCompare(cursor) <= 0) {
          throw new Error("M-Files object enumeration cursor did not advance");
        }
        cursor = nextCursor;
      }
    }
  }

  async probePermissionChanges(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    state: PermissionSyncState | null;
  }): Promise<PermissionProbeResult> {
    const config = parseMFilesConfig(params.config);
    if (!config) throw new Error("Invalid M-Files configuration");
    const client = this.createClient(config, params.credentials);
    const capabilities = await this.getCapabilities(client, config);
    const configFingerprint = fingerprintConfig(config, params.credentials);
    const previous = readPermissionState(params.state);
    const initialState = {
      addOnInstanceId: capabilities.addOnInstanceId,
      addOnVersion: capabilities.addOnVersion,
      configFingerprint,
      changeCursor: capabilities.journal.headCursor,
      permissionPolicyFingerprint: capabilities.permissionPolicyFingerprint,
    };
    if (
      !previous ||
      previous.addOnInstanceId !== capabilities.addOnInstanceId ||
      previous.addOnVersion !== capabilities.addOnVersion ||
      previous.configFingerprint !== configFingerprint
    ) {
      return {
        dirtyContainerKeys: [],
        dirtyGroupIds: [],
        deletedGroupIds: [],
        fullRequired: true,
        authoritativeAudienceScope: true,
        nextState: initialState,
      };
    }

    const dirtyObjects = new Map<string, ObjectKey>();
    const dirtyGroupIds = new Set<string>();
    const deletedGroupIds = new Set<string>();
    let cursor = previous.changeCursor;
    let pinnedHeadCursor: string | null = null;
    let fullRequired =
      previous.permissionPolicyFingerprint !==
      capabilities.permissionPolicyFingerprint;
    let nextPolicyFingerprint = capabilities.permissionPolicyFingerprint;
    for (;;) {
      const page = await this.readChangePage({
        client,
        config,
        cursor,
        pinnedHeadCursor,
      });
      cursor = page.nextCursor;
      pinnedHeadCursor = page.pinnedHeadCursor;
      nextPolicyFingerprint = page.permissionPolicyFingerprint;
      fullRequired ||=
        page.fullRequired.permissions ||
        page.fullRequired.groups ||
        page.permissionPolicyFingerprint !==
          previous.permissionPolicyFingerprint;
      for (const change of page.changes) {
        if (change.kind === "security-full") {
          fullRequired = true;
          continue;
        }
        if (
          change.kind === "group-upsert" &&
          change.groupId !== null &&
          change.groupId !== undefined
        ) {
          dirtyGroupIds.add(String(change.groupId));
          // Object ACLs are flattened to effective vault users. A group
          // membership change can therefore revoke access on every object that
          // references the group; without a reverse ACL index the only safe
          // response is a completion-gated full permission reconcile.
          fullRequired = true;
          continue;
        }
        if (
          change.kind === "group-delete" &&
          change.groupId !== null &&
          change.groupId !== undefined
        ) {
          deletedGroupIds.add(String(change.groupId));
          fullRequired = true;
          continue;
        }
        const key = objectKeyFromChange(change);
        if (key && isConfiguredObjectType(config, key.objectTypeId)) {
          dirtyObjects.set(buildObjectKey(key.objectTypeId, key.objectId), key);
        }
      }
      if (!page.hasMore) break;
    }

    return {
      dirtyContainerKeys: [...dirtyObjects.values()]
        .sort(compareObjectKeys)
        .map((key) => buildContainerKey(key.objectTypeId, key.objectId)),
      dirtyGroupIds: [...dirtyGroupIds],
      deletedGroupIds: [...deletedGroupIds],
      fullRequired,
      authoritativeAudienceScope: true,
      nextState: {
        addOnInstanceId: capabilities.addOnInstanceId,
        addOnVersion: capabilities.addOnVersion,
        configFingerprint,
        changeCursor: cursor,
        permissionPolicyFingerprint: nextPolicyFingerprint,
      },
    };
  }

  async *refreshContainerAudiences(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    containerKeys: string[];
    readIngestedDocuments: PermissionSyncParams["readIngestedDocuments"];
    resolveMappedEmail?: PermissionSyncParams["resolveMappedEmail"];
  }) {
    const config = parseMFilesConfig(params.config);
    if (!config) throw new Error("Invalid M-Files configuration");
    const client = this.createClient(config, params.credentials);
    const keys = params.containerKeys.map((containerKey) => {
      const key = parseContainerKey(containerKey);
      if (!key) {
        throw new Error(`Invalid M-Files container key: ${containerKey}`);
      }
      return key;
    });
    keys.sort(compareObjectKeys);
    for (let index = 0; index < keys.length; index += PERMISSION_PAGE_SIZE) {
      const resolved = await this.readPermissionItems({
        client,
        config,
        keys: keys.slice(index, index + PERMISSION_PAGE_SIZE),
        params: {
          readIngestedDocuments: params.readIngestedDocuments,
          resolveMappedEmail: params.resolveMappedEmail,
        },
      });
      for (const entry of resolved) {
        yield {
          containerKey: buildContainerKey(
            entry.key.objectTypeId,
            entry.key.objectId,
          ),
          permissions: entry.audienceResolutionFailed
            ? { users: [], groups: [], isPublic: false }
            : entry.permissions,
          fingerprint: entry.item.fingerprint,
          audienceResolutionFailed: entry.audienceResolutionFailed,
        };
      }
    }
  }

  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseMFilesConfig(params.config);
    if (!config) throw new Error("Invalid M-Files configuration");
    const client = this.createClient(config, params.credentials);
    const scopedGroupIds = params.scope?.groupIds?.map((groupId) => {
      if (!GroupCursorSchema.safeParse(groupId).success) {
        throw new Error(`Invalid M-Files group ID: ${groupId}`);
      }
      return Number(groupId);
    });
    let cursor: string | null = null;
    let previousGroupId: string | null = null;

    while (true) {
      const page: GroupPage = await this.callVafAddOn<GroupPage>({
        client,
        config,
        body: {
          schemaVersion: ADD_ON_SCHEMA_VERSION,
          operation: "listGroups",
          cursor,
          limit: PERMISSION_PAGE_SIZE,
          ...(scopedGroupIds ? { groupIds: scopedGroupIds } : {}),
        },
        parse: (value) => GroupPageSchema.parse(value),
      });
      for (const group of page.groups) {
        if (cursor && group.groupId.localeCompare(cursor) < 0) {
          throw new Error(
            `The VAF Add On returned group ${group.groupId} before requested cursor ${cursor}`,
          );
        }
        if (
          previousGroupId &&
          group.groupId.localeCompare(previousGroupId) <= 0
        ) {
          throw new Error(
            `The VAF Add On returned non-monotonic group ${group.groupId}`,
          );
        }
        previousGroupId = group.groupId;
        yield group;
      }
      if (scopedGroupIds) break;
      if (page.nextCursor === null) break;
      if (
        (cursor && page.nextCursor.localeCompare(cursor) <= 0) ||
        (previousGroupId && page.nextCursor.localeCompare(previousGroupId) <= 0)
      ) {
        throw new Error("The VAF Add On group cursor did not advance");
      }
      cursor = page.nextCursor;
    }
  }

  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const objectKey = metadata.mfilesObjectKey;
    if (typeof objectKey !== "string") return null;
    const match = /^(\d+):(\d+)$/.exec(objectKey);
    if (!match) return null;
    return buildContainerKey(Number(match[1]), Number(match[2]));
  }

  private createClient(
    config: MFilesConfig,
    credentials: ConnectorCredentials,
  ): MFilesClient {
    return new MFilesClient({
      config,
      credentials,
      request: (url, options) => this.fetchWithRetry(url, options),
    });
  }

  private async *syncBaseline(params: {
    client: MFilesClient;
    config: MFilesConfig;
    checkpoint: MFilesCheckpoint;
    capabilities: Capabilities;
    configFingerprint: string;
    imageMimeTypes: ReadonlySet<string>;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const generation = params.checkpoint.baselineGeneration ?? randomUUID();
    const baselineHeadCursor =
      params.checkpoint.baselineHeadCursor ??
      params.capabilities.journal.headCursor;
    let cursor = params.checkpoint.baselineCursor ?? null;
    const batchSize = params.config.batchSize ?? DEFAULT_BATCH_SIZE;
    let latestModifiedAt = params.checkpoint.lastSyncedAt;

    while (true) {
      const page = await this.enumerateObjectPage({
        client: params.client,
        config: params.config,
        cursor,
        limit: Math.min(batchSize, PERMISSION_PAGE_SIZE),
      });
      const documents: ConnectorDocument[] = [];
      for (const key of page.items) {
        const object = await this.getObjectWithFiles(params.client, key);
        if (!object) continue;
        const objectDocuments = await this.extractObjectDocuments({
          client: params.client,
          config: params.config,
          object,
          imageMimeTypes: params.imageMimeTypes,
          baselineGeneration: generation,
        });
        documents.push(...objectDocuments);
        latestModifiedAt = maxIso([
          latestModifiedAt,
          ...objectDocuments.map((document) =>
            document.updatedAt?.toISOString(),
          ),
        ]);
      }

      const finalPage = page.nextCursor === null;
      const chunks = chunkDocuments(documents, batchSize);
      if (chunks.length === 0) chunks.push([]);
      for (let index = 0; index < chunks.length; index++) {
        const finalChunk = index === chunks.length - 1;
        const complete = finalPage && finalChunk;
        const checkpoint: MFilesCheckpoint = complete
          ? {
              type: "mfiles",
              lastSyncedAt: latestModifiedAt,
              changeCursor: baselineHeadCursor,
              addOnInstanceId: params.capabilities.addOnInstanceId,
              addOnVersion: params.capabilities.addOnVersion,
              configFingerprint: params.configFingerprint,
            }
          : {
              type: "mfiles",
              lastSyncedAt: latestModifiedAt,
              baselineCursor: finalChunk ? page.nextCursor : cursor,
              baselineHeadCursor,
              baselineGeneration: generation,
              addOnInstanceId: params.capabilities.addOnInstanceId,
              addOnVersion: params.capabilities.addOnVersion,
              configFingerprint: params.configFingerprint,
            };
        yield {
          documents: chunks[index],
          failures: this.flushFailures(),
          skipped: this.flushSkipped(),
          checkpoint,
          hasMore: !complete,
          ...(complete
            ? {
                completionSweep: {
                  metadataKey: "mfilesBaselineGeneration",
                  generation,
                },
              }
            : {}),
        };
      }
      const nextCursor = page.nextCursor;
      if (nextCursor === null) break;
      if (cursor && nextCursor.localeCompare(cursor) <= 0) {
        throw new Error("M-Files object enumeration cursor did not advance");
      }
      cursor = nextCursor;
    }
  }

  private async *syncDelta(params: {
    client: MFilesClient;
    config: MFilesConfig;
    checkpoint: MFilesCheckpoint;
    capabilities: Capabilities;
    configFingerprint: string;
    imageMimeTypes: ReadonlySet<string>;
    firstPage: ChangePage;
  }): AsyncGenerator<ConnectorSyncBatch> {
    let page = params.firstPage;
    let committedCursor = params.checkpoint.changeCursor ?? "0";
    let latestModifiedAt = params.checkpoint.lastSyncedAt;
    const batchSize = params.config.batchSize ?? DEFAULT_BATCH_SIZE;

    while (true) {
      const changedObjects = new Map<string, ObjectKey>();
      for (const change of page.changes) {
        if (change.kind !== "object-upsert" && change.kind !== "object-delete")
          continue;
        const key = objectKeyFromChange(change);
        if (key && isConfiguredObjectType(params.config, key.objectTypeId)) {
          changedObjects.set(
            buildObjectKey(key.objectTypeId, key.objectId),
            key,
          );
        }
      }
      const entries: Array<{
        documents: ConnectorDocument[];
        reconcileScopes: ConnectorSyncBatch["reconcileScopes"];
      }> = [];
      for (const key of [...changedObjects.values()].sort(compareObjectKeys)) {
        const object = await this.getObjectWithFiles(params.client, key);
        const documents = object
          ? await this.extractObjectDocuments({
              client: params.client,
              config: params.config,
              object,
              imageMimeTypes: params.imageMimeTypes,
            })
          : [];
        latestModifiedAt = maxIso([
          latestModifiedAt,
          ...documents.map((document) => document.updatedAt?.toISOString()),
        ]);
        const chunks = chunkDocuments(documents, batchSize);
        if (chunks.length === 0) chunks.push([]);
        for (let index = 0; index < chunks.length; index++) {
          entries.push({
            documents: chunks[index],
            reconcileScopes:
              index === chunks.length - 1
                ? [
                    {
                      metadataFilter: {
                        mfilesObjectKey: buildObjectKey(
                          key.objectTypeId,
                          key.objectId,
                        ),
                      },
                      seenSourceIds: documents.map((document) => document.id),
                    },
                  ]
                : undefined,
          });
        }
      }
      if (entries.length === 0) {
        entries.push({ documents: [], reconcileScopes: undefined });
      }
      for (let index = 0; index < entries.length; index++) {
        const finalEntry = index === entries.length - 1;
        yield {
          documents: entries[index].documents,
          failures: this.flushFailures(),
          skipped: this.flushSkipped(),
          checkpoint: {
            type: "mfiles",
            lastSyncedAt: latestModifiedAt,
            changeCursor: finalEntry ? page.nextCursor : committedCursor,
            addOnInstanceId: params.capabilities.addOnInstanceId,
            addOnVersion: params.capabilities.addOnVersion,
            configFingerprint: params.configFingerprint,
          },
          hasMore: page.hasMore || !finalEntry,
          ...(entries[index].reconcileScopes
            ? { reconcileScopes: entries[index].reconcileScopes }
            : {}),
        };
      }
      if (!page.hasMore) break;
      committedCursor = page.nextCursor;
      page = await this.readChangePage({
        client: params.client,
        config: params.config,
        cursor: page.nextCursor,
        pinnedHeadCursor: page.pinnedHeadCursor,
      });
      if (page.fullRequired.content) {
        throw new Error(
          `M-Files journal became incomplete during a pinned delta read: ${page.fullRequired.reasons.join(", ")}`,
        );
      }
    }
  }

  private async getCapabilities(
    client: MFilesClient,
    config: MFilesConfig,
  ): Promise<Capabilities> {
    return await this.callVafAddOn({
      client,
      config,
      body: {
        schemaVersion: ADD_ON_SCHEMA_VERSION,
        operation: "getCapabilities",
      },
      parse: (value) => CapabilitiesSchema.parse(value),
    });
  }

  private async readChangePage(params: {
    client: MFilesClient;
    config: MFilesConfig;
    cursor: string;
    pinnedHeadCursor: string | null;
  }): Promise<ChangePage> {
    return await this.callVafAddOn({
      client: params.client,
      config: params.config,
      body: {
        schemaVersion: ADD_ON_SCHEMA_VERSION,
        operation: "readChanges",
        cursor: params.cursor,
        pinnedHeadCursor: params.pinnedHeadCursor,
        limit: ADD_ON_CHANGE_PAGE_SIZE,
      },
      parse: (value) => ChangePageSchema.parse(value),
    });
  }

  private async enumerateObjectPage(params: {
    client: MFilesClient;
    config: MFilesConfig;
    cursor: string | null;
    limit: number;
  }): Promise<ObjectPage> {
    return await this.callVafAddOn({
      client: params.client,
      config: params.config,
      body: {
        schemaVersion: ADD_ON_SCHEMA_VERSION,
        operation: "enumerateObjects",
        cursor: params.cursor,
        limit: params.limit,
        objectTypeIds: params.config.objectTypeIds ?? DEFAULT_OBJECT_TYPE_IDS,
      },
      parse: (value) => ObjectPageSchema.parse(value),
    });
  }

  private async getObjectWithFiles(
    client: MFilesClient,
    key: ObjectKey,
  ): Promise<MFilesObjectVersion | null> {
    await this.rateLimit();
    const raw = await client.getJsonOrNull(
      `/objects/${key.objectTypeId}/${key.objectId}/latest`,
    );
    if (raw === null) return null;
    const parsed = MFilesObjectVersionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `M-Files returned invalid object metadata for ${key.objectTypeId}:${key.objectId}`,
      );
    }
    const object = parsed.data;
    if (!object.Files) {
      const files = await client.getJson(
        `/objects/${key.objectTypeId}/${key.objectId}/${object.ObjVer.Version}/files`,
      );
      object.Files = z.array(MFilesObjectFileSchema).parse(files);
    }
    return object.Deleted ? null : object;
  }

  private async extractObjectDocuments(params: {
    client: MFilesClient;
    config: MFilesConfig;
    object: MFilesObjectVersion;
    imageMimeTypes: ReadonlySet<string>;
    baselineGeneration?: string;
  }): Promise<ConnectorDocument[]> {
    const documents: ConnectorDocument[] = [];
    for (const file of params.object.Files ?? []) {
      const extension = normalizeExtension(file.Extension);
      if (!isSupportedExtension(extension, params.imageMimeTypes)) {
        this.trackSkipped({
          itemId: buildSourceId(params.object, file),
          name: buildFileName(file),
          reason: `Unsupported M-Files extension: .${extension || "(none)"}`,
        });
        continue;
      }
      // This fetch is authoritative for reconciliation. A transport/parser
      // failure must abort the page; turning it into a skipped item would let
      // the completion-gated seen-set delete a healthy stored document.
      const extracted = await this.downloadAndExtract({
        client: params.client,
        object: params.object,
        file,
        extension,
        imageMimeTypes: params.imageMimeTypes,
      });
      if (!extracted) continue;
      const modifiedAt = file.ChangeTimeUtc ?? params.object.LastModifiedUtc;
      const limited = truncateConnectorContent({
        content: extracted.text,
        maxLength: MAX_CONTENT_LENGTH,
      });
      documents.push({
        id: buildSourceId(params.object, file),
        title: buildDocumentTitle(params.object, file),
        content: limited.content,
        contentTruncation: limited.truncation,
        sourceUrl: params.client.objectUrl(params.object),
        metadata: {
          source: "mfiles",
          vaultGuid: params.config.vaultGuid,
          mfilesObjectKey: buildObjectKey(
            params.object.ObjVer.Type,
            params.object.ObjVer.ID,
          ),
          objectTypeId: params.object.ObjVer.Type,
          objectId: params.object.ObjVer.ID,
          objectVersion: params.object.ObjVer.Version,
          fileId: file.ID,
          fileVersion: file.Version,
          extension,
          ...(params.baselineGeneration
            ? { mfilesBaselineGeneration: params.baselineGeneration }
            : {}),
        },
        ...(params.baselineGeneration
          ? { operationalMetadataKeys: ["mfilesBaselineGeneration"] }
          : {}),
        updatedAt: new Date(modifiedAt),
        ...(extracted.mediaContent
          ? { mediaContent: extracted.mediaContent }
          : {}),
      });
    }
    return documents;
  }

  private async readPermissionItems(params: {
    client: MFilesClient;
    config: MFilesConfig;
    keys: ObjectKey[];
    params: Pick<
      PermissionSyncParams,
      "readIngestedDocuments" | "resolveMappedEmail"
    >;
  }): Promise<ResolvedPermissionEntry[]> {
    if (params.keys.length === 0) return [];
    const documentsByKey = new Map<string, IngestedPermissionDocument[]>();
    const requests: Array<ObjectKey & { cachedVersions: number[] }> = [];
    for (const key of params.keys) {
      const documents = await readAllIngestedObjectDocuments(
        params.params.readIngestedDocuments,
        key,
      );
      documentsByKey.set(
        buildObjectKey(key.objectTypeId, key.objectId),
        documents,
      );
      requests.push({
        objectTypeId: key.objectTypeId,
        objectId: key.objectId,
        cachedVersions: [
          ...new Set(
            documents
              .map((document) => document.objectVersion)
              .filter((version): version is number => version !== null),
          ),
        ],
      });
    }
    const page = await this.callVafAddOn<PermissionPage>({
      client: params.client,
      config: params.config,
      body: {
        schemaVersion: ADD_ON_SCHEMA_VERSION,
        operation: "getObjectPermissionsByKeys",
        objects: requests,
      },
      parse: (value) => PermissionPageSchema.parse(value),
    });
    const byKey = new Map(
      page.items.map((item) => [
        buildObjectKey(item.objectTypeId, item.objectId),
        item,
      ]),
    );
    return params.keys.map((key) => {
      const objectKey = buildObjectKey(key.objectTypeId, key.objectId);
      const item = byKey.get(objectKey);
      if (!item) {
        throw new Error(`The VAF Add On omitted requested object ${objectKey}`);
      }
      // Under-grant: an M-Files principal we cannot map to a verified email
      // (or a manual Archestra mapping) is dropped from the audience, never
      // granted. Dropping a reader can only narrow access, so it can never
      // over-grant — and it keeps the resolvable readers (e.g. a mapped user)
      // instead of denying the whole object because one co-grantee lacks an
      // email. The object is fail-closed only when the add-on itself could not
      // read the ACL (`audienceResolutionFailed`); a dropped principal instead
      // surfaces as an unassigned user in the connector's Users view.
      const users: string[] = [];
      for (const principal of item.users) {
        const email =
          params.params.resolveMappedEmail?.(principal.accountId) ??
          principal.email;
        if (email) users.push(email.toLowerCase());
      }
      return {
        key,
        item,
        documents: documentsByKey.get(objectKey) ?? [],
        permissions: {
          users: [...new Set(users)].sort(),
          groups: item.groups,
          isPublic: item.isPublic,
        },
        audienceResolutionFailed: item.audienceResolutionFailed,
      };
    });
  }

  private async downloadAndExtract(params: {
    client: MFilesClient;
    object: MFilesObjectVersion;
    file: MFilesObjectFile;
    extension: string;
    imageMimeTypes: ReadonlySet<string>;
  }): Promise<{
    text: string;
    mediaContent?: { mimeType: string; data: string };
  } | null> {
    await this.rateLimit();
    const buffer = await params.client.getBuffer(
      `/objects/${params.object.ObjVer.Type}/${params.object.ObjVer.ID}/${params.object.ObjVer.Version}/files/${params.file.ID}/content`,
    );
    if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
      this.trackSkipped({
        itemId: buildSourceId(params.object, params.file),
        name: buildFileName(params.file),
        reason: `File exceeds ${MAX_FILE_SIZE_BYTES} byte extraction limit`,
      });
      return null;
    }

    if (isIngestibleImageExtension(params.extension, params.imageMimeTypes)) {
      return {
        text: "",
        mediaContent: {
          mimeType: IMAGE_MIME_TYPES[params.extension],
          data: buffer.toString("base64"),
        },
      };
    }

    let text: string;
    switch (params.extension) {
      case "docx":
        text = await extractTextFromDocx(buffer);
        break;
      case "pdf": {
        const result = await extractPdfText({
          buffer,
          filename: buildFileName(params.file),
          ocr: this.ocrContext,
        });
        const emptyReason = describePdfEmptyText(result);
        if (emptyReason) {
          this.trackSkipped({
            itemId: buildSourceId(params.object, params.file),
            name: buildFileName(params.file),
            reason: emptyReason,
            category: "no_extractable_text",
          });
          return null;
        }
        const warning = describePdfExtractionWarning(result);
        if (warning) {
          this.log.warn(
            {
              itemId: buildSourceId(params.object, params.file),
              fileName: buildFileName(params.file),
              reason: warning,
            },
            "M-Files: PDF page extraction warning",
          );
        }
        text = result.text;
        break;
      }
      case "pptx":
        text = await extractTextFromPptx(buffer);
        break;
      case "xlsx":
        text = await extractTextFromXlsx(buffer);
        break;
      case "html":
      case "htm":
        text = stripHtmlTags(buffer.toString("utf8"));
        break;
      default:
        text = buffer.toString("utf8");
    }
    if (!text.trim()) {
      this.trackSkipped({
        itemId: buildSourceId(params.object, params.file),
        name: buildFileName(params.file),
        reason: "Empty content — no text could be extracted",
        category: "no_extractable_text",
      });
      return null;
    }
    return { text };
  }

  private async callVafAddOn<T>(params: {
    client: MFilesClient;
    config: MFilesConfig;
    body: Record<string, unknown>;
    parse: (value: unknown) => T;
  }): Promise<T> {
    const method =
      params.config.permissionExtensionMethod ??
      DEFAULT_PERMISSION_EXTENSION_METHOD;
    await this.rateLimit();
    const value = await params.client.callExtension(method, params.body);
    try {
      return params.parse(value);
    } catch (error) {
      throw new Error(
        `Invalid response from M-Files permission extension ${method}: ${extractErrorMessage(error)}`,
      );
    }
  }
}

type RequestFn = (url: string, options: RequestInit) => Promise<Response>;

class MFilesClient {
  private readonly config: MFilesConfig;
  private readonly credentials: ConnectorCredentials;
  private readonly request: RequestFn;
  private readonly restBaseUrl: string;
  private authenticationToken: string | null = null;
  private authenticationExpiresAt = 0;
  private cookieHeader: string | null = null;

  constructor(params: {
    config: MFilesConfig;
    credentials: ConnectorCredentials;
    request: RequestFn;
  }) {
    this.config = params.config;
    this.credentials = params.credentials;
    this.request = params.request;
    this.restBaseUrl = toRestBaseUrl(params.config.baseUrl);
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const response = await this.authenticatedRequest(path);
    return (await response.json()) as T;
  }

  async getJsonOrNull<T = unknown>(path: string): Promise<T | null> {
    const response = await this.authenticatedRequest(path, {}, true, true);
    if (response.status === 404) return null;
    return (await response.json()) as T;
  }

  async getBuffer(path: string): Promise<Buffer> {
    const response = await this.authenticatedRequest(path);
    return Buffer.from(await response.arrayBuffer());
  }

  async callExtension(
    method: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.authenticatedRequest(
      `/vault/extensionmethod/${encodeURIComponent(method)}`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: JSON.stringify(body),
      },
    );
    const output = await response.text();
    const parsed = JSON.parse(output) as unknown;
    // Some MFWS/IIS configurations JSON-encode the extension's string output,
    // while others return that output as the response body directly.
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  }

  objectUrl(object: MFilesObjectVersion): string {
    return `${this.restBaseUrl}/objects/${object.ObjVer.Type}/${object.ObjVer.ID}/${object.ObjVer.Version}`;
  }

  private async authenticate(): Promise<void> {
    if (
      (this.config.authMethod ?? "mfiles_password_token") ===
      "oauth_client_credentials"
    ) {
      await this.authenticateWithOAuth();
      return;
    }
    await this.authenticateWithPasswordToken();
  }

  private async authenticateWithPasswordToken(): Promise<void> {
    const username = this.credentials.email;
    if (!username) throw new Error("M-Files username is required");

    const expiresAt = Date.now() + PASSWORD_TOKEN_LIFETIME_MS;
    const body = {
      Username: username,
      Password: this.credentials.apiToken,
      VaultGuid: this.config.vaultGuid,
      SessionID: randomUUID(),
      Expiration: new Date(expiresAt).toISOString(),
      ...(this.config.domain ? { Domain: this.config.domain } : {}),
    };
    const response = await this.request(
      `${this.restBaseUrl}/server/authenticationtokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw await responseError(response, "authentication");
    const tokenResponse = (await response.json()) as unknown;
    const token = readAuthenticationToken(tokenResponse);
    if (!token) {
      throw new Error("M-Files authentication returned an invalid token");
    }
    this.authenticationToken = token;
    this.authenticationExpiresAt = expiresAt;
    this.cookieHeader = mergeCookieHeader(
      this.cookieHeader,
      readCookieHeader(response.headers),
    );
  }

  private async authenticateWithOAuth(): Promise<void> {
    const clientId = this.credentials.email;
    const clientSecret = this.credentials.apiToken;
    if (!clientId) throw new Error("M-Files OAuth client ID is required");
    if (!this.config.oauthTokenEndpoint || !this.config.oauthAuthConfig) {
      throw new Error(
        "M-Files OAuth token endpoint and authentication configuration are required",
      );
    }
    const tokenEndpoint = this.config.oauthTokenEndpoint;
    // The connector negotiates the two provider-specific wire details so
    // admins are not asked for them. Client authentication: most providers
    // take the secret in the request body; strict ones demand HTTP Basic
    // and reject the body form with a 400/401. Audience parameter: Entra ID
    // and most providers take it as `scope`; AD FS-style providers reject
    // that with a 400 and expect the same value as `resource`. Explicit
    // config values (API-set) pin either choice and disable its fallback.
    const configuredMethod = this.config.oauthClientAuthMethod;
    const methods: Array<"client_secret_post" | "client_secret_basic"> =
      configuredMethod
        ? [configuredMethod]
        : ["client_secret_post", "client_secret_basic"];
    const audiences: Array<{ scope?: string; resource?: string }> = this.config
      .oauthResource
      ? [{ scope: this.config.oauthScope, resource: this.config.oauthResource }]
      : this.config.oauthScope
        ? [
            { scope: this.config.oauthScope },
            { resource: this.config.oauthScope },
          ]
        : [{}];
    let response: Response | undefined;
    let firstFailure: Response | undefined;
    attempts: for (const audience of audiences) {
      for (const method of methods) {
        const attempt = await this.requestOAuthToken({
          endpoint: tokenEndpoint,
          method,
          clientId,
          clientSecret,
          ...audience,
        });
        if (attempt.ok) {
          response = attempt;
          break attempts;
        }
        firstFailure ??= attempt;
        // Anything but 400/401 is not a parameter-shape rejection — stop
        // negotiating and report it.
        if (attempt.status !== 400 && attempt.status !== 401) break attempts;
      }
    }
    // Both loops run at least once, so one of the two is always set.
    const finalResponse = (response ?? firstFailure) as Response;
    if (!finalResponse.ok)
      throw await responseError(finalResponse, "OAuth authentication");
    response = finalResponse;
    const tokenResponse = OAuthTokenResponseSchema.parse(await response.json());
    const token = this.config.oauthUseIdToken
      ? tokenResponse.id_token
      : tokenResponse.access_token;
    if (!token) {
      throw new Error(
        `M-Files OAuth provider did not return the configured ${
          this.config.oauthUseIdToken ? "ID" : "access"
        } token`,
      );
    }
    this.authenticationToken = token;
    this.authenticationExpiresAt = Date.now() + tokenResponse.expires_in * 1000;
  }

  private async requestOAuthToken(params: {
    endpoint: string;
    method: "client_secret_post" | "client_secret_basic";
    clientId: string;
    clientSecret: string;
    scope?: string;
    resource?: string;
  }): Promise<Response> {
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (params.scope) form.set("scope", params.scope);
    if (params.resource) form.set("resource", params.resource);
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    });
    if (params.method === "client_secret_basic") {
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64")}`,
      );
    } else {
      form.set("client_id", params.clientId);
      form.set("client_secret", params.clientSecret);
    }
    return await this.request(params.endpoint, {
      method: "POST",
      headers,
      body: form.toString(),
    });
  }

  private async authenticatedRequest(
    path: string,
    options: RequestInit = {},
    mayReauthenticate = true,
    allowNotFound = false,
  ): Promise<Response> {
    if (
      !this.authenticationToken ||
      Date.now() >= this.authenticationExpiresAt - OAUTH_EXPIRY_SKEW_MS
    ) {
      await this.authenticate();
    }
    const headers = new Headers(options.headers);
    headers.set("Accept", headers.get("Accept") ?? "application/json");
    if (
      (this.config.authMethod ?? "mfiles_password_token") ===
      "oauth_client_credentials"
    ) {
      headers.set("Authorization", `Bearer ${this.authenticationToken ?? ""}`);
      headers.set("X-Vault", this.config.vaultGuid);
      headers.set("X-AuthConfig", this.config.oauthAuthConfig ?? "");
      headers.set(
        "X-AuthConfigScope",
        normalizeAuthConfigScope(this.config.oauthAuthConfigScope ?? ""),
      );
      headers.set(
        "X-ExtraAuthData",
        `AuthType=Client;UpdateMetadata=true;AccountName=${encodeExtraAuthValue(this.config.oauthAccountName ?? "")}`,
      );
    } else {
      headers.set("X-Authentication", this.authenticationToken ?? "");
    }
    if (this.cookieHeader) headers.set("Cookie", this.cookieHeader);

    const response = await this.request(`${this.restBaseUrl}${path}`, {
      ...options,
      headers,
    });
    this.cookieHeader = mergeCookieHeader(
      this.cookieHeader,
      readCookieHeader(response.headers),
    );
    if (
      (response.status === 401 || response.status === 403) &&
      mayReauthenticate
    ) {
      this.authenticationToken = null;
      this.authenticationExpiresAt = 0;
      await this.authenticate();
      return this.authenticatedRequest(path, options, false, allowNotFound);
    }
    if (allowNotFound && response.status === 404) return response;
    if (!response.ok) throw await responseError(response, path);
    return response;
  }
}

const OAuthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1).optional(),
    id_token: z.string().min(1).optional(),
    expires_in: z.coerce.number().int().positive(),
  })
  .passthrough();

function readAuthenticationToken(response: unknown): string | null {
  if (typeof response === "string") return response || null;
  if (
    response !== null &&
    typeof response === "object" &&
    "Value" in response &&
    typeof response.Value === "string"
  ) {
    return response.Value || null;
  }
  return null;
}

function parseMFilesConfig(
  config: Record<string, unknown>,
): MFilesConfig | null {
  const parsed = MFilesConfigSchema.safeParse({ type: "mfiles", ...config });
  return parsed.success ? parsed.data : null;
}

function toRestBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/REST$/i.test(normalized) ? normalized : `${normalized}/REST`;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function sameGuid(left: string, right: string): boolean {
  return (
    left.replace(/[{}]/g, "").toLowerCase() ===
    right.replace(/[{}]/g, "").toLowerCase()
  );
}

function fingerprintConfig(
  config: MFilesConfig,
  credentials: ConnectorCredentials,
): string {
  const canonical = JSON.stringify({
    baseUrl: toRestBaseUrl(config.baseUrl).toLowerCase(),
    vaultGuid: config.vaultGuid.replace(/[{}]/g, "").toLowerCase(),
    objectTypeIds: [...(config.objectTypeIds ?? DEFAULT_OBJECT_TYPE_IDS)].sort(
      (left, right) => left - right,
    ),
    permissionExtensionMethod:
      config.permissionExtensionMethod ?? DEFAULT_PERMISSION_EXTENSION_METHOD,
    authMethod: config.authMethod ?? "mfiles_password_token",
    credentialIdentity: credentials.email?.trim().toLowerCase() ?? null,
    domain: config.domain?.trim().toLowerCase() ?? null,
    oauthTokenEndpoint: config.oauthTokenEndpoint?.replace(/\/+$/, "") ?? null,
    oauthScope: config.oauthScope?.trim().split(/\s+/).sort().join(" ") ?? null,
    oauthResource: config.oauthResource?.trim() ?? null,
    oauthAuthConfig: config.oauthAuthConfig ?? null,
    oauthAuthConfigScope:
      normalizeAuthConfigScope(config.oauthAuthConfigScope ?? "") || null,
    oauthAccountName: config.oauthAccountName?.trim().toLowerCase() ?? null,
    oauthUseIdToken: config.oauthUseIdToken ?? false,
    oauthClientAuthMethod: config.oauthClientAuthMethod ?? "client_secret_post",
  });
  // The M-Files authentication configuration, scope, and account name are
  // public routing data; `credentialIdentity` is a login/client ID.
  // ConnectorCredentials.apiToken
  // (the password/client secret) is deliberately excluded so secret rotation
  // stays delta-only. Use the repository's memory-hard deterministic
  // fingerprint pattern because CodeQL conservatively treats OAuth config
  // fields as password material.
  const fingerprint = scryptSync(
    canonical,
    "archestra-mfiles-sync-boundary-v2",
    32,
  ).toString("hex");
  return `scrypt:v2:${fingerprint}`;
}

function normalizeAuthConfigScope(value: string): string {
  const trimmed = value.trim();
  return trimmed && !trimmed.endsWith(":") ? `${trimmed}:` : trimmed;
}

function encodeExtraAuthValue(value: string): string {
  return value
    .trim()
    .replaceAll("%", "%25")
    .replaceAll(";", "%3B")
    .replaceAll("=", "%3D");
}

function parseContainerKey(value: string): ObjectKey | null {
  const match = /^object:(\d{10}):(\d{20})$/.exec(value);
  if (!match) return null;
  const objectTypeId = Number(match[1]);
  const objectId = Number(match[2]);
  return Number.isSafeInteger(objectTypeId) && Number.isSafeInteger(objectId)
    ? { objectTypeId, objectId }
    : null;
}

function compareObjectKeys(left: ObjectKey, right: ObjectKey): number {
  return (
    left.objectTypeId - right.objectTypeId || left.objectId - right.objectId
  );
}

function objectKeyFromChange(
  change: ChangePage["changes"][number],
): ObjectKey | null {
  return change.objectTypeId !== null &&
    change.objectTypeId !== undefined &&
    change.objectId !== null &&
    change.objectId !== undefined
    ? { objectTypeId: change.objectTypeId, objectId: change.objectId }
    : null;
}

function isConfiguredObjectType(
  config: MFilesConfig,
  objectTypeId: number,
): boolean {
  return (config.objectTypeIds ?? DEFAULT_OBJECT_TYPE_IDS).includes(
    objectTypeId,
  );
}

function readPermissionState(state: PermissionSyncState | null): {
  addOnInstanceId: string;
  addOnVersion: string;
  configFingerprint: string;
  changeCursor: string;
  permissionPolicyFingerprint: string;
} | null {
  if (!state) return null;
  const {
    addOnInstanceId,
    addOnVersion,
    configFingerprint,
    changeCursor,
    permissionPolicyFingerprint,
  } = state;
  return typeof addOnInstanceId === "string" &&
    typeof addOnVersion === "string" &&
    typeof configFingerprint === "string" &&
    typeof changeCursor === "string" &&
    /^\d+$/.test(changeCursor) &&
    typeof permissionPolicyFingerprint === "string"
    ? {
        addOnInstanceId,
        addOnVersion,
        configFingerprint,
        changeCursor,
        permissionPolicyFingerprint,
      }
    : null;
}

async function readAllIngestedObjectDocuments(
  read: PermissionSyncParams["readIngestedDocuments"],
  key: ObjectKey,
): Promise<IngestedPermissionDocument[]> {
  const documents: IngestedPermissionDocument[] = [];
  let afterId: string | null = null;
  do {
    const page = await read({
      metadataFilter: {
        mfilesObjectKey: buildObjectKey(key.objectTypeId, key.objectId),
      },
      afterId,
      limit: INGESTED_DOCUMENT_PAGE_SIZE,
    });
    for (const document of page.documents) {
      const version = document.metadata?.objectVersion;
      documents.push({
        ...document,
        objectVersion:
          typeof version === "number" &&
          Number.isInteger(version) &&
          version > 0
            ? version
            : null,
      });
    }
    afterId = page.nextAfterId;
  } while (afterId);
  return documents;
}

function chunkDocuments(
  documents: ConnectorDocument[],
  size: number,
): ConnectorDocument[][] {
  if (documents.length === 0) return [[]];
  const chunks: ConnectorDocument[][] = [];
  for (let index = 0; index < documents.length; index += size) {
    chunks.push(documents.slice(index, index + size));
  }
  return chunks;
}

function normalizeExtension(extension: string): string {
  return extension.replace(/^\./, "").trim().toLowerCase();
}

function isSupportedExtension(
  extension: string,
  imageMimeTypes: ReadonlySet<string>,
): boolean {
  return (
    SUPPORTED_TEXT_EXTENSIONS.has(extension) ||
    SUPPORTED_BINARY_EXTENSIONS.has(extension) ||
    isIngestibleImageExtension(extension, imageMimeTypes)
  );
}

function isIngestibleImageExtension(
  extension: string,
  imageMimeTypes: ReadonlySet<string>,
): boolean {
  return (
    SUPPORTED_IMAGE_EXTENSIONS.has(extension) &&
    imageMimeTypes.has(IMAGE_MIME_TYPES[extension])
  );
}

function buildObjectKey(objectTypeId: number, objectId: number): string {
  return `${objectTypeId}:${objectId}`;
}

/** Lexically sortable because permission-sync cursors compare as strings. */
function buildContainerKey(objectTypeId: number, objectId: number): string {
  return `object:${String(objectTypeId).padStart(10, "0")}:${String(objectId).padStart(20, "0")}`;
}

function buildSourceId(
  object: MFilesObjectVersion,
  file: MFilesObjectFile,
): string {
  return `mfiles:${object.ObjVer.Type}:${object.ObjVer.ID}:file:${file.ID}`;
}

function buildFileName(file: MFilesObjectFile): string {
  const extension = normalizeExtension(file.Extension);
  return extension && !file.Name.toLowerCase().endsWith(`.${extension}`)
    ? `${file.Name}.${extension}`
    : file.Name;
}

function buildDocumentTitle(
  object: MFilesObjectVersion,
  file: MFilesObjectFile,
): string {
  const fileName = buildFileName(file);
  return (object.Files?.length ?? 0) > 1
    ? `${object.Title} — ${fileName}`
    : object.Title || fileName;
}

function maxIso(values: Array<string | undefined>): string | undefined {
  return values.reduce<string | undefined>(
    (latest, value) => (value && (!latest || value > latest) ? value : latest),
    undefined,
  );
}

function readCookieHeader(headers: Headers): string | null {
  const getSetCookie = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.bind(headers);
  const raw =
    getSetCookie?.() ?? splitCombinedSetCookie(headers.get("set-cookie"));
  const cookies = raw
    .map((cookie) => cookie.split(";", 1)[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie));
  return cookies.length > 0 ? cookies.join("; ") : null;
}

function splitCombinedSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=[^;,]+=)/);
}

function mergeCookieHeader(
  current: string | null,
  incoming: string | null,
): string | null {
  const cookies = new Map<string, string>();
  for (const header of [current, incoming]) {
    for (const cookie of header?.split(/;\s*/) ?? []) {
      const separator = cookie.indexOf("=");
      if (separator <= 0) continue;
      cookies.set(cookie.slice(0, separator), cookie);
    }
  }
  return cookies.size > 0 ? [...cookies.values()].join("; ") : null;
}

async function responseError(
  response: Response,
  operation: string,
): Promise<Error> {
  const body = (await response.text()).slice(0, 1_000);
  return new Error(
    `M-Files ${operation} failed (${response.status}${body ? `: ${body}` : ""})`,
  );
}
