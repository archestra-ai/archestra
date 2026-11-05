import type {
  ResourcePermissionGrant,
  ScopedResource,
} from "@archestra/shared";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  type SQLWrapper,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type { AclEntry } from "@/types";
import type { KnowledgeFileVisibility } from "@/types/knowledge-file";
import CreatedByModel from "./created-by";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import ResourcePermissionSubjectModel, {
  type GrantPrincipal,
  type ResourceAccessFilter,
} from "./resource-permission-subject";

/**
 * Who a caller is, for repository-listing purposes.
 *
 * Retrieval ACLs are enforced at chunk-query time, which does nothing for a
 * direct read of the repository — so listing and download authorize on these
 * fields per row instead.
 */
export interface KbFileViewer {
  userId: string;
  teamIds: string[];
  /** Knowledge admins see the whole repository, including private files. */
  canManageAll: boolean;
}

class KbFileModel {
  static async findPaginated(params: {
    organizationId: string;
    viewer: KbFileViewer;
    directoryId?: string | null;
    search?: string;
    /** File ids matching a `?labels=` filter; omit when not filtering. */
    labelFilteredIds?: string[];
    /** The list's `access`, `sharedWith`, and `owner` filters. */
    access?: ResourceAccessFilter;
    limit: number;
    offset: number;
  }) {
    const where = and(
      eq(schema.kbFilesTable.organizationId, params.organizationId),
      await KbFileModel.visibleTo(params),
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      params.access
        ? ResourcePermissionPolicyModel.accessRelationCondition({
            ...params.access,
            organizationId: params.organizationId,
            resource: "knowledgeFile",
            scopeColumn: schema.kbFilesTable.id,
            ownerColumn: schema.kbFilesTable.uploadedBy,
          })
        : undefined,
      // SPDX-SnippetEnd
      ...(params.labelFilteredIds !== undefined
        ? [inArray(schema.kbFilesTable.id, params.labelFilteredIds)]
        : []),
      ...(params.directoryId === undefined
        ? []
        : [
            params.directoryId === null
              ? isNull(schema.kbFilesTable.directoryId)
              : eq(schema.kbFilesTable.directoryId, params.directoryId),
          ]),
      ...(params.search
        ? [ilike(schema.kbFilesTable.filename, `%${params.search}%`)]
        : []),
    );

    const [rows, [totals]] = await Promise.all([
      db
        .select()
        .from(schema.kbFilesTable)
        .where(where)
        .orderBy(desc(schema.kbFilesTable.createdAt))
        .limit(params.limit)
        .offset(params.offset),
      db.select({ total: count() }).from(schema.kbFilesTable).where(where),
    ]);

    return { items: rows, total: totals?.total ?? 0 };
  }

  static async findById(params: {
    id: string;
    organizationId: string;
    viewer: KbFileViewer;
  }) {
    const [row] = await db
      .select()
      .from(schema.kbFilesTable)
      .where(
        and(
          eq(schema.kbFilesTable.id, params.id),
          eq(schema.kbFilesTable.organizationId, params.organizationId),
          await KbFileModel.visibleTo(params),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async findManyByIds(params: {
    ids: string[];
    organizationId: string;
    viewer: KbFileViewer;
  }) {
    if (params.ids.length === 0) return [];
    return db
      .select()
      .from(schema.kbFilesTable)
      .where(
        and(
          inArray(schema.kbFilesTable.id, params.ids),
          eq(schema.kbFilesTable.organizationId, params.organizationId),
          await KbFileModel.visibleTo(params),
        ),
      );
  }

  static async create(params: {
    organizationId: string;
    directoryId: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
    data: Buffer;
    uploadedBy: string;
    /**
     * Who else can read the file. The uploader always gets full access;
     * omitted or empty means nobody else.
     */
    initialPermissionGrants?: ResourcePermissionGrant[];
  }) {
    return db.transaction(async (tx) => {
      const [file] = await tx
        .insert(schema.kbFilesTable)
        .values(
          await CreatedByModel.forInsert({
            data: {
              organizationId: params.organizationId,
              directoryId: params.directoryId,
              filename: params.filename,
              mimeType: params.mimeType,
              sizeBytes: params.sizeBytes,
              contentHash: params.contentHash,
              storageProvider: "db",
              data: params.data,
              uploadedBy: params.uploadedBy,
            },
            userIdField: "uploadedBy",
            transaction: tx,
          }),
        )
        .returning();
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId: file.organizationId,
        resource: "knowledgeFile",
        scope: file.id,
        grants: params.initialPermissionGrants,
        authorId: file.uploadedBy,
      });
      // SPDX-SnippetEnd

      return file;
    });
  }

  /** Client-chosen UUID makes external uploads retryable without filename matching. */
  static async upsertContent(params: {
    id: string;
    organizationId: string;
    uploadedBy: string;
    filename: string;
    mimeType: string;
    data: Buffer;
    contentHash: string;
  }) {
    const content = {
      filename: params.filename,
      mimeType: params.mimeType,
      data: params.data,
      sizeBytes: params.data.byteLength,
      contentHash: params.contentHash,
      storageProvider: "db" as const,
      objectKey: null,
    };
    return db.transaction(async (tx) => {
      const [file] = await tx
        .insert(schema.kbFilesTable)
        .values(
          await CreatedByModel.forInsert({
            data: {
              ...content,
              id: params.id,
              organizationId: params.organizationId,
              uploadedBy: params.uploadedBy,
            },
            userIdField: "uploadedBy",
            transaction: tx,
          }),
        )
        .onConflictDoUpdate({
          target: schema.kbFilesTable.id,
          set: content,
          setWhere: and(
            eq(schema.kbFilesTable.organizationId, params.organizationId),
            eq(schema.kbFilesTable.uploadedBy, params.uploadedBy),
            eq(schema.kbFilesTable.storageProvider, "db"),
          ),
        })
        .returning();
      if (!file) return null;
      const policies = schema.resourcePermissionPoliciesTable;
      const [existing] = await tx
        .select({ scope: policies.scope })
        .from(policies)
        .where(
          and(
            eq(policies.organizationId, params.organizationId),
            eq(policies.resource, "knowledgeFile"),
            eq(policies.scope, file.id),
          ),
        )
        .limit(1);
      if (!existing)
        await ResourcePermissionPolicyModel.createInitial({
          tx,
          organizationId: params.organizationId,
          resource: "knowledgeFile",
          scope: file.id,
          authorId: params.uploadedBy,
          grants: [],
        });
      return file;
    });
  }

  /**
   * Rename or move a file. Who can read it is its grants, so the retired
   * `visibility` column and `kb_file_team` rows are not written here.
   */
  static async update(params: {
    id: string;
    organizationId: string;
    filename?: string;
    directoryId?: string | null;
  }) {
    const [file] = await db
      .update(schema.kbFilesTable)
      .set({
        ...(params.filename === undefined ? {} : { filename: params.filename }),
        ...(params.directoryId === undefined
          ? {}
          : { directoryId: params.directoryId }),
      })
      .where(
        and(
          eq(schema.kbFilesTable.id, params.id),
          eq(schema.kbFilesTable.organizationId, params.organizationId),
        ),
      )
      .returning();
    return file ?? null;
  }

  /**
   * Each file's audience in the vocabulary of its retired `visibility` field,
   * and the teams it reaches, derived from its grants: `org-wide` when they
   * reach the organization or a role, `team-scoped` when they reach a team,
   * `private` otherwise. API responses read this so the old fields describe
   * who can actually read the file.
   */
  static async findGrantedAudiences(params: {
    organizationId: string;
    fileIds: string[];
  }): Promise<
    Map<string, { visibility: KnowledgeFileVisibility; teamIds: string[] }>
  > {
    const audiences = await ResourcePermissionPolicyModel.findAudiences({
      organizationId: params.organizationId,
      resource: "knowledgeFile",
      scopes: params.fileIds,
    });
    return new Map(
      [...audiences].map(([fileId, { audience, teamIds }]) => [
        fileId,
        {
          visibility:
            audience === "org"
              ? "org-wide"
              : audience === "team"
                ? "team-scoped"
                : "private",
          teamIds,
        },
      ]),
    );
  }

  static async findTeamIds(kbFileId: string): Promise<string[]> {
    const rows = await db
      .select({ teamId: schema.kbFileTeamsTable.teamId })
      .from(schema.kbFileTeamsTable)
      .where(eq(schema.kbFileTeamsTable.kbFileId, kbFileId));
    return rows.map((row) => row.teamId);
  }

  /** Team ids per file, batched so a listing does not query per row. */
  static async findTeamIdsForFiles(
    kbFileIds: string[],
  ): Promise<Map<string, string[]>> {
    if (kbFileIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(schema.kbFileTeamsTable)
      .where(inArray(schema.kbFileTeamsTable.kbFileId, kbFileIds));

    const byFile = new Map<string, string[]>();
    for (const row of rows) {
      const existing = byFile.get(row.kbFileId) ?? [];
      existing.push(row.teamId);
      byFile.set(row.kbFileId, existing);
    }
    return byFile;
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /** Upload sources with an indexed usable file in the supplied knowledge bases. */
  static async findPublishedUploadConnectorIds(params: {
    organizationId: string;
    knowledgeBaseIds: string[];
    principal?: GrantPrincipal;
  }): Promise<string[]> {
    if (params.knowledgeBaseIds.length === 0) return [];
    const hasUse = (resource: ScopedResource, scopeColumn: SQLWrapper) =>
      params.principal
        ? or(
            ResourcePermissionPolicyModel.grantCondition({
              ...params.principal,
              resource,
              scopeColumn,
              action: "use",
            }),
            ResourcePermissionPolicyModel.organizationAccessCondition({
              organizationId: params.organizationId,
              resource,
              scopeColumn,
              action: "use",
            }),
          )
        : ResourcePermissionPolicyModel.organizationAccessCondition({
            organizationId: params.organizationId,
            resource,
            scopeColumn,
            action: "use",
          });
    const rows = await db
      .selectDistinct({
        connectorId: schema.kbUploadConnectorsTable.connectorId,
      })
      .from(schema.kbUploadConnectorsTable)
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.knowledgeBasesTable.id,
          schema.kbUploadConnectorsTable.knowledgeBaseId,
        ),
      )
      .innerJoin(
        schema.kbDocumentsTable,
        eq(
          schema.kbDocumentsTable.connectorId,
          schema.kbUploadConnectorsTable.connectorId,
        ),
      )
      .innerJoin(
        schema.kbFileDocumentsTable,
        eq(
          schema.kbFileDocumentsTable.kbDocumentId,
          schema.kbDocumentsTable.id,
        ),
      )
      .innerJoin(
        schema.kbFilesTable,
        eq(schema.kbFilesTable.id, schema.kbFileDocumentsTable.kbFileId),
      )
      .where(
        and(
          inArray(
            schema.kbUploadConnectorsTable.knowledgeBaseId,
            params.knowledgeBaseIds,
          ),
          eq(schema.knowledgeBasesTable.organizationId, params.organizationId),
          isNull(schema.knowledgeBasesTable.deletedAt),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(schema.kbFilesTable.organizationId, params.organizationId),
          or(
            hasUse("knowledgeFile", schema.kbFilesTable.id),
            hasUse("knowledgeBase", schema.knowledgeBasesTable.id),
          ),
        ),
      );
    return rows.map((row) => row.connectorId);
  }
  // SPDX-SnippetEnd

  /** Knowledge bases a file is currently indexed into, batched for a listing. */
  static async findKnowledgeBasesForFiles(
    kbFileIds: string[],
    viewer?: KbFileViewer,
  ) {
    if (kbFileIds.length === 0)
      return new Map<string, { id: string; name: string }[]>();

    const rows = await db
      .select({
        kbFileId: schema.kbFileDocumentsTable.kbFileId,
        knowledgeBaseId: schema.knowledgeBasesTable.id,
        knowledgeBaseName: schema.knowledgeBasesTable.name,
      })
      .from(schema.kbFileDocumentsTable)
      .innerJoin(
        schema.kbDocumentsTable,
        eq(
          schema.kbDocumentsTable.id,
          schema.kbFileDocumentsTable.kbDocumentId,
        ),
      )
      .innerJoin(
        schema.kbUploadConnectorsTable,
        eq(
          schema.kbUploadConnectorsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.knowledgeBasesTable.id,
          schema.kbUploadConnectorsTable.knowledgeBaseId,
        ),
      )
      .where(
        and(
          inArray(schema.kbFileDocumentsTable.kbFileId, kbFileIds),
          isNull(schema.knowledgeBasesTable.deletedAt),
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          viewer
            ? ResourcePermissionPolicyModel.grantConditionForAny({
                principals:
                  await ResourcePermissionSubjectModel.resolvePrincipals({
                    userId: viewer.userId,
                  }),
                organizationColumn: schema.knowledgeBasesTable.organizationId,
                resource: "knowledgeBase",
                scopeColumn: schema.knowledgeBasesTable.id,
                action: "read",
              })
            : undefined,
          // SPDX-SnippetEnd
        ),
      );

    const byFile = new Map<string, { id: string; name: string }[]>();
    for (const row of rows) {
      const existing = byFile.get(row.kbFileId) ?? [];
      existing.push({ id: row.knowledgeBaseId, name: row.knowledgeBaseName });
      byFile.set(row.kbFileId, existing);
    }
    return byFile;
  }

  /**
   * The audience tokens a document indexed from this file carries, from the
   * file's grants and the grants of the knowledge base it is indexed into.
   * Retrieving content takes the `use` action ("Can use"), so only grants
   * holding it count: the organization (a grant to everyone, or the upgrade's
   * organization-wide role grants) gives `org:*`, a team gives `team:<id>`, a
   * person gives `user_email:<address>`, and a managed OAuth client gives
   * `oauth_client:<id>`. A role or service account grant has no token of its
   * own, so it adds nothing and those holders do not retrieve the file (fails
   * closed). A file nobody may use has an empty ACL.
   */
  static async findDocumentAcl(params: {
    fileId: string;
    organizationId: string;
    knowledgeBaseId?: string;
  }): Promise<AclEntry[]> {
    const knowledgeBaseIds = params.knowledgeBaseId
      ? [params.knowledgeBaseId]
      : (
          await db
            .selectDistinct({
              knowledgeBaseId: schema.kbUploadConnectorsTable.knowledgeBaseId,
            })
            .from(schema.kbFileDocumentsTable)
            .innerJoin(
              schema.kbDocumentsTable,
              eq(
                schema.kbDocumentsTable.id,
                schema.kbFileDocumentsTable.kbDocumentId,
              ),
            )
            .innerJoin(
              schema.kbUploadConnectorsTable,
              eq(
                schema.kbUploadConnectorsTable.connectorId,
                schema.kbDocumentsTable.connectorId,
              ),
            )
            .innerJoin(
              schema.knowledgeBasesTable,
              eq(
                schema.knowledgeBasesTable.id,
                schema.kbUploadConnectorsTable.knowledgeBaseId,
              ),
            )
            .where(
              and(
                eq(schema.kbFileDocumentsTable.kbFileId, params.fileId),
                eq(
                  schema.kbDocumentsTable.organizationId,
                  params.organizationId,
                ),
                eq(
                  schema.knowledgeBasesTable.organizationId,
                  params.organizationId,
                ),
                isNull(schema.knowledgeBasesTable.deletedAt),
              ),
            )
        ).map((row) => row.knowledgeBaseId);

    const [filePolicies, kbPolicies] = await Promise.all([
      ResourcePermissionPolicyModel.findApplicable({
        organizationId: params.organizationId,
        resource: "knowledgeFile",
        scope: params.fileId,
      }),
      knowledgeBaseIds.length === 0
        ? Promise.resolve([])
        : ResourcePermissionPolicyModel.findApplicableBatch({
            organizationId: params.organizationId,
            resource: "knowledgeBase",
            scopes: knowledgeBaseIds,
          }),
    ]);

    const fileIsOrgWide = filePolicies.some((policy) =>
      ResourcePermissionPolicyModel.isOrganizationWide({
        policy,
        scope: params.fileId,
        action: "use",
      }),
    );
    if (fileIsOrgWide) return ["org:*"];

    const kbIsOrgWide = kbPolicies.some((policy) =>
      knowledgeBaseIds.some((kbId) =>
        ResourcePermissionPolicyModel.isOrganizationWide({
          policy,
          scope: kbId,
          action: "use",
        }),
      ),
    );

    const policies = [...filePolicies, ...kbPolicies];
    const readers = policies.flatMap((policy) =>
      policy.grants.filter((grant) => grant.actions.includes("use")),
    );
    const teamIds = [
      ...new Set(
        readers
          .filter((grant) => grant.subject.type === "team")
          .map((grant) => grant.subject.id),
      ),
    ];
    const userIds = [
      ...new Set(
        readers
          .filter((grant) => grant.subject.type === "user")
          .map((grant) => grant.subject.id),
      ),
    ];
    const oauthClientSubjects = readers
      .filter(
        (
          grant,
        ): grant is ResourcePermissionGrant & {
          subject: { type: "oauthClient"; id: string };
        } => grant.subject.type === "oauthClient",
      )
      .map((grant) => grant.subject);

    const [users, existingOauthClients] = await Promise.all([
      userIds.length === 0
        ? Promise.resolve([])
        : db
            .select({ email: schema.usersTable.email })
            .from(schema.usersTable)
            .where(inArray(schema.usersTable.id, userIds)),
      oauthClientSubjects.length === 0
        ? Promise.resolve([])
        : ResourcePermissionSubjectModel.findExisting({
            organizationId: params.organizationId,
            subjects: oauthClientSubjects,
          }),
    ]);
    return [
      ...new Set<AclEntry>([
        ...(kbIsOrgWide ? (["org:*"] as const) : []),
        ...teamIds.map((id): AclEntry => `team:${id}`),
        ...users.map((user): AclEntry => `user_email:${user.email}`),
        ...existingOauthClients.map(
          (client): AclEntry => `oauth_client:${client.id}`,
        ),
      ]),
    ];
  }

  /**
   * Rewrite the ACL of every document indexed from this file, and of their
   * chunks, to {@link findDocumentAcl}. Run after the file's or knowledge
   * base's grants change so retrieval follows the edit, a revocation included.
   */
  static async refreshDocumentAcl(params: {
    fileId: string;
    organizationId: string;
  }): Promise<void> {
    const documents = await db
      .select({
        id: schema.kbFileDocumentsTable.kbDocumentId,
        knowledgeBaseId: schema.kbUploadConnectorsTable.knowledgeBaseId,
      })
      .from(schema.kbFileDocumentsTable)
      .innerJoin(
        schema.kbDocumentsTable,
        eq(
          schema.kbDocumentsTable.id,
          schema.kbFileDocumentsTable.kbDocumentId,
        ),
      )
      .leftJoin(
        schema.kbUploadConnectorsTable,
        eq(
          schema.kbUploadConnectorsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(schema.kbFileDocumentsTable.kbFileId, params.fileId),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
        ),
      );
    if (documents.length === 0) return;

    const byKnowledgeBase = new Map<string | null, string[]>();
    for (const doc of documents) {
      const key = doc.knowledgeBaseId ?? null;
      const list = byKnowledgeBase.get(key) ?? [];
      list.push(doc.id);
      byKnowledgeBase.set(key, list);
    }

    const updates = await Promise.all(
      [...byKnowledgeBase.entries()].map(
        async ([knowledgeBaseId, documentIds]) => ({
          documentIds,
          acl: await KbFileModel.findDocumentAcl({
            fileId: params.fileId,
            organizationId: params.organizationId,
            knowledgeBaseId: knowledgeBaseId ?? undefined,
          }),
        }),
      ),
    );

    await db.transaction(async (tx) => {
      for (const { documentIds, acl } of updates) {
        await tx
          .update(schema.kbDocumentsTable)
          .set({ acl })
          .where(
            and(
              inArray(schema.kbDocumentsTable.id, documentIds),
              eq(schema.kbDocumentsTable.organizationId, params.organizationId),
            ),
          );
        await tx
          .update(schema.kbChunksTable)
          .set({ acl })
          .where(inArray(schema.kbChunksTable.documentId, documentIds));
      }
    });
  }

  /**
   * Rewrite the ACL of every uploaded document indexed into a knowledge base
   * after the knowledge base's grants change.
   */
  static async refreshDocumentAclForKnowledgeBase(params: {
    knowledgeBaseId: string;
    organizationId: string;
  }): Promise<void> {
    const rows = await db
      .selectDistinct({ kbFileId: schema.kbFileDocumentsTable.kbFileId })
      .from(schema.kbUploadConnectorsTable)
      .innerJoin(
        schema.kbDocumentsTable,
        eq(
          schema.kbDocumentsTable.connectorId,
          schema.kbUploadConnectorsTable.connectorId,
        ),
      )
      .innerJoin(
        schema.kbFileDocumentsTable,
        eq(
          schema.kbFileDocumentsTable.kbDocumentId,
          schema.kbDocumentsTable.id,
        ),
      )
      .where(
        and(
          eq(
            schema.kbUploadConnectorsTable.knowledgeBaseId,
            params.knowledgeBaseId,
          ),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
        ),
      );
    await KbFileModel.refreshDocumentAclBatch({
      fileIds: rows.map((row) => row.kbFileId),
      organizationId: params.organizationId,
    });
  }

  /**
   * Rewrite the ACL of every uploaded document in an organization after a
   * wildcard `knowledgeFile` or `knowledgeBase` policy changes.
   */
  static async refreshDocumentAclForOrganization(params: {
    organizationId: string;
  }): Promise<void> {
    const rows = await db
      .selectDistinct({ kbFileId: schema.kbFileDocumentsTable.kbFileId })
      .from(schema.kbFileDocumentsTable)
      .innerJoin(
        schema.kbDocumentsTable,
        eq(
          schema.kbDocumentsTable.id,
          schema.kbFileDocumentsTable.kbDocumentId,
        ),
      )
      .where(eq(schema.kbDocumentsTable.organizationId, params.organizationId));
    await KbFileModel.refreshDocumentAclBatch({
      fileIds: rows.map((row) => row.kbFileId),
      organizationId: params.organizationId,
    });
  }

  private static async refreshDocumentAclBatch(params: {
    fileIds: string[];
    organizationId: string;
  }): Promise<void> {
    const batchSize = 25;
    for (let i = 0; i < params.fileIds.length; i += batchSize) {
      const batch = params.fileIds.slice(i, i + batchSize);
      await Promise.all(
        batch.map((fileId) =>
          KbFileModel.refreshDocumentAcl({
            fileId,
            organizationId: params.organizationId,
          }),
        ),
      );
    }
  }

  static async linkDocument(params: {
    kbFileId: string;
    kbDocumentId: string;
  }): Promise<void> {
    await db
      .insert(schema.kbFileDocumentsTable)
      .values(params)
      .onConflictDoNothing();
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    return db.transaction(async (tx) => {
      const documentIds = (
        await tx
          .select({ id: schema.kbFileDocumentsTable.kbDocumentId })
          .from(schema.kbFileDocumentsTable)
          .where(eq(schema.kbFileDocumentsTable.kbFileId, params.id))
      ).map((row) => row.id);
      const [deleted] = await tx
        .delete(schema.kbFilesTable)
        .where(
          and(
            eq(schema.kbFilesTable.id, params.id),
            eq(schema.kbFilesTable.organizationId, params.organizationId),
          ),
        )
        .returning({ id: schema.kbFilesTable.id });
      if (!deleted) return false;
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.deleteForTarget({
        tx,
        resources: ["knowledgeFile"],
        scope: params.id,
      });
      // SPDX-SnippetEnd
      if (documentIds.length > 0) {
        await tx
          .delete(schema.kbDocumentsTable)
          .where(inArray(schema.kbDocumentsTable.id, documentIds));
      }
      return true;
    });
  }

  /**
   * Ids, names and visibility for a bulk route's audit record, on both sides
   * of the write.
   *
   * Deliberately NOT viewer-filtered, unlike {@link findManyByIds}. Narrowing a
   * document's audience can put it out of the caller's own view, and a snapshot
   * that dropped it there would make a visibility change read as a deletion.
   * Organization ownership is the fence; the route has already decided what the
   * caller may touch.
   */
  static async findVisibilityForBulkAudit(params: {
    ids: string[];
    organizationId: string;
  }): Promise<
    Array<{
      id: string;
      filename: string;
      visibility: string;
      teamIds: string[];
    }>
  > {
    const { ids, organizationId } = params;
    if (ids.length === 0) return [];

    const rows = await db
      .select({
        id: schema.kbFilesTable.id,
        filename: schema.kbFilesTable.filename,
        visibility: schema.kbFilesTable.visibility,
      })
      .from(schema.kbFilesTable)
      .where(
        and(
          inArray(schema.kbFilesTable.id, ids),
          eq(schema.kbFilesTable.organizationId, organizationId),
        ),
      )
      // Sorted so an unchanged batch snapshots identically on both sides and
      // the audit diff stays empty; row order is unspecified.
      .orderBy(schema.kbFilesTable.id);

    const teamsByFile = await KbFileModel.findTeamIdsForFiles(
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      ...row,
      teamIds: [...(teamsByFile.get(row.id) ?? [])].sort(),
    }));
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select({
        id: schema.kbFilesTable.id,
        organizationId: schema.kbFilesTable.organizationId,
        directoryId: schema.kbFilesTable.directoryId,
        filename: schema.kbFilesTable.filename,
        mimeType: schema.kbFilesTable.mimeType,
        sizeBytes: schema.kbFilesTable.sizeBytes,
        contentHash: schema.kbFilesTable.contentHash,
        visibility: schema.kbFilesTable.visibility,
        uploadedBy: schema.kbFilesTable.uploadedBy,
        createdByServiceAccountId:
          schema.kbFilesTable.createdByServiceAccountId,
        createdAt: schema.kbFilesTable.createdAt,
      })
      .from(schema.kbFilesTable)
      .where(
        and(
          eq(schema.kbFilesTable.id, id),
          eq(schema.kbFilesTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return { ...row, teamIds: await KbFileModel.findTeamIds(id) };
  }

  // ===== Internal =====

  /**
   * Row-level visibility filter: a read grant on the file, or at `*`. Written
   * as a WHERE fragment rather than a post-filter so pagination counts stay
   * truthful.
   */
  private static async visibleTo(params: {
    organizationId: string;
    viewer: KbFileViewer;
  }) {
    return ResourcePermissionPolicyModel.grantCondition({
      ...(await ResourcePermissionSubjectModel.resolvePrincipal({
        organizationId: params.organizationId,
        userId: params.viewer.userId,
      })),
      resource: "knowledgeFile",
      scopeColumn: schema.kbFilesTable.id,
      action: "read",
    });
  }
}

export default KbFileModel;
