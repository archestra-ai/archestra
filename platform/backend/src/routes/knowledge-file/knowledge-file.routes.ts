import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { extractText } from "@/knowledge-base/file-upload/extract";
import {
  hashFileContent,
  indexFilesIntoKnowledgeBase,
} from "@/knowledge-base/file-upload/index-file";
import {
  ConversationAttachmentModel,
  ConversationModel,
  KbDirectoryModel,
  KbFileModel,
  KnowledgeBaseModel,
  OrganizationModel,
  TeamModel,
} from "@/models";
import type { KbFileViewer } from "@/models/kb-file";
import { readRowBytes } from "@/skills-sandbox/file-storage";
import {
  ApiError,
  constructResponseSchema,
  KbDirectoryWithTeamsSchema,
  KbFileSchema,
  KnowledgeFileVisibilitySchema,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";
import {
  isSafeInlineMimeType,
  sanitizeAttachmentContentType,
} from "../chat/attachment-content-type";

const FileParamsSchema = z.object({ fileId: z.string().uuid() });
const DirectoryParamsSchema = z.object({ directoryId: z.string().uuid() });

const VisibilityBodySchema = z.object({
  visibility: KnowledgeFileVisibilitySchema.default("org-wide"),
  teamIds: z.array(z.string()).default([]),
});

const knowledgeFileRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // ===== Files =====

  fastify.get(
    "/api/knowledge-files",
    {
      schema: {
        operationId: RouteId.GetKnowledgeFiles,
        description: "List documents in the knowledge file repository",
        tags: ["Knowledge Files"],
        querystring: PaginationQuerySchema.extend({
          directoryId: z.string().optional(),
          search: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(KbFileSchema),
        ),
      },
    },
    async (request) => {
      const { limit, offset, directoryId, search } = request.query;
      const viewer = await resolveViewer(request);

      const { items, total } = await KbFileModel.findPaginated({
        organizationId: request.organizationId,
        viewer,
        // "root" is a distinct filter from "no filter", so it needs its own
        // sentinel rather than an absent parameter.
        directoryId:
          directoryId === undefined
            ? undefined
            : directoryId === "root"
              ? null
              : directoryId,
        search,
        limit,
        offset,
      });

      const fileIds = items.map((file) => file.id);
      const [knowledgeBases, teamIds] = await Promise.all([
        KbFileModel.findKnowledgeBasesForFiles(fileIds),
        KbFileModel.findTeamIdsForFiles(fileIds),
      ]);

      return {
        data: items.map(
          ({
            data: _data,
            objectKey: _objectKey,
            storageProvider: _provider,
            ...file
          }) => ({
            ...file,
            knowledgeBases: knowledgeBases.get(file.id) ?? [],
            teamIds: teamIds.get(file.id) ?? [],
          }),
        ),
        pagination: calculatePaginationMeta(total, { limit, offset }),
      };
    },
  );

  fastify.post(
    "/api/knowledge-files",
    {
      schema: {
        operationId: RouteId.UploadKnowledgeFile,
        description: "Upload a document into the knowledge file repository",
        tags: ["Knowledge Files"],
        body: VisibilityBodySchema.extend({
          filename: z.string().trim().min(1).max(512),
          mimeType: z.string().trim().min(1).max(255),
          /** Base64, matching how chat attachments already arrive. */
          content: z.string().min(1),
          directoryId: z.string().uuid().nullable().default(null),
        }),
        response: constructResponseSchema(KbFileSchema),
      },
    },
    async ({ body, organizationId, user }) => {
      // Checked on the encoded string BEFORE decoding: base64 inflates by ~4/3,
      // so validating only the decoded size still lets an oversized payload be
      // materialized in memory first.
      const maxBytes = config.knowledgeFiles.maxUploadBytes;
      if (
        Buffer.byteLength(body.content, "utf-8") > Math.ceil(maxBytes * 1.4)
      ) {
        throw new ApiError(
          413,
          `"${body.filename}" is larger than the ${Math.floor(maxBytes / 1_000_000)}MB upload limit.`,
        );
      }

      const buffer = Buffer.from(body.content, "base64");
      if (buffer.byteLength > maxBytes) {
        throw new ApiError(
          413,
          `"${body.filename}" is larger than the ${Math.floor(maxBytes / 1_000_000)}MB upload limit.`,
        );
      }

      // Parse before storing: a file we cannot read must never reach the
      // repository, where it would look uploaded but retrieve nothing. A
      // scanned PDF is the exception when the organization has OCR
      // configured — indexing transcribes it, so storing it is honest.
      await extractText({
        buffer,
        filename: body.filename,
        acceptTextlessPdf: await organizationHasOcr(organizationId),
      });

      await assertDirectoryInOrg({
        directoryId: body.directoryId,
        organizationId,
      });
      await assertTeamsInOrg({ teamIds: body.teamIds, organizationId });

      let file: Awaited<ReturnType<typeof KbFileModel.create>>;
      try {
        file = await KbFileModel.create({
          organizationId,
          directoryId: body.directoryId,
          filename: body.filename,
          mimeType: body.mimeType,
          sizeBytes: buffer.byteLength,
          contentHash: hashFileContent(buffer),
          data: buffer,
          visibility: body.visibility,
          teamIds: body.teamIds,
          uploadedBy: user.id,
        });
      } catch (error) {
        // A repeated filename in one place is an ordinary mistake with an
        // obvious fix; letting the raw constraint violation surface as a 500
        // tells the user nothing about what to do.
        if (isUniqueConstraintError(error)) {
          throw new ApiError(
            409,
            `"${body.filename}" already exists ${
              body.directoryId ? "in that directory" : "at the top level"
            }.`,
          );
        }
        throw error;
      }

      const {
        data: _data,
        objectKey: _objectKey,
        storageProvider: _provider,
        ...rest
      } = file;
      return { ...rest, knowledgeBases: [], teamIds: body.teamIds };
    },
  );

  fastify.post(
    "/api/knowledge-files/from-attachment",
    {
      schema: {
        operationId: RouteId.PromoteAttachmentToKnowledgeFile,
        description:
          "Copy a file attached to a chat into the knowledge file repository",
        tags: ["Knowledge Files"],
        body: VisibilityBodySchema.extend({
          attachmentId: z.string().uuid(),
          /** Defaults to the attachment's own name. */
          filename: z.string().trim().min(1).max(512).optional(),
          directoryId: z.string().uuid().nullable().default(null),
          /** Index into this knowledge base straight away, if given. */
          knowledgeBaseId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(KbFileSchema),
      },
    },
    async ({ body, organizationId, user }) => {
      // Metadata first, bytes second: an unauthorized request must not trigger
      // a large bytea read before its 403 (same order as the byte endpoint).
      const meta = await ConversationAttachmentModel.findById(
        body.attachmentId,
      );
      if (!meta || meta.organizationId !== organizationId) {
        throw new ApiError(404, "Attachment not found");
      }

      // A chat attachment is only as readable as the conversation holding it.
      // Without this, anyone with knowledgeSource:create could copy any
      // attachment in the organization into a repository document — and an
      // org-wide one at that, which would publish it to everyone.
      const conversation = await ConversationModel.findAccessibleById({
        id: meta.conversationId,
        userId: user.id,
        organizationId,
        canReadOthersViaProject: () =>
          userHasPermission(user.id, organizationId, "project", "read-all"),
      });
      if (!conversation) {
        throw new ApiError(403, "No access to the owning conversation");
      }

      const attachment = await ConversationAttachmentModel.findByIdWithData(
        body.attachmentId,
      );
      if (!attachment) {
        // Soft-deleted between the metadata check and the blob fetch.
        throw new ApiError(404, "Attachment not found");
      }

      const maxBytes = config.knowledgeFiles.maxUploadBytes;
      if (attachment.fileData.byteLength > maxBytes) {
        throw new ApiError(
          413,
          `"${attachment.originalName}" is larger than the ${Math.floor(maxBytes / 1_000_000)}MB upload limit.`,
        );
      }

      const filename = body.filename ?? attachment.originalName;

      // Parsed before storing, exactly as on upload: chat accepts files the
      // repository cannot index (an image), and one of those stored here
      // would look indexed and retrieve nothing. A scanned PDF is storable
      // when the organization has OCR configured — indexing transcribes it.
      await extractText({
        buffer: attachment.fileData,
        filename,
        acceptTextlessPdf: await organizationHasOcr(organizationId),
      });

      await assertDirectoryInOrg({
        directoryId: body.directoryId,
        organizationId,
      });
      await assertTeamsInOrg({ teamIds: body.teamIds, organizationId });

      let file: Awaited<ReturnType<typeof KbFileModel.create>>;
      try {
        file = await KbFileModel.create({
          organizationId,
          directoryId: body.directoryId,
          filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.fileData.byteLength,
          contentHash: attachment.contentHash,
          data: attachment.fileData,
          visibility: body.visibility,
          teamIds: body.teamIds,
          // The promoter owns the repository copy, not the original uploader:
          // they chose its audience, and for a private one they are the only
          // person its ACL will name.
          uploadedBy: user.id,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ApiError(
            409,
            `"${filename}" already exists ${
              body.directoryId ? "in that directory" : "at the top level"
            }.`,
          );
        }
        throw error;
      }

      const knowledgeBases: { id: string; name: string }[] = [];
      if (body.knowledgeBaseId) {
        const knowledgeBaseId = await assertKnowledgeBaseInOrg({
          knowledgeBaseId: body.knowledgeBaseId,
          organizationId,
        });
        await indexFilesIntoKnowledgeBase({
          fileIds: [file.id],
          knowledgeBaseId,
          organizationId,
          uploaderEmailById: await KbFileModel.findUploaderEmails([file.id]),
        });
        knowledgeBases.push(
          ...((await KbFileModel.findKnowledgeBasesForFiles([file.id])).get(
            file.id,
          ) ?? []),
        );
      }

      const {
        data: _data,
        objectKey: _objectKey,
        storageProvider: _provider,
        ...rest
      } = file;
      return { ...rest, knowledgeBases, teamIds: body.teamIds };
    },
  );

  fastify.get(
    "/api/knowledge-files/:fileId/content",
    {
      schema: {
        operationId: RouteId.GetKnowledgeFileContent,
        description:
          "Stream the bytes of a repository document. Safe types render inline (PDF, images, plain text); everything else downloads.",
        tags: ["Knowledge Files"],
        params: FileParamsSchema,
      },
    },
    async (request, reply) => {
      const viewer = await resolveViewer(request);
      const file = await KbFileModel.findById({
        id: request.params.fileId,
        organizationId: request.organizationId,
        viewer,
      });
      // Retrieval ACLs are enforced at chunk-query time and do nothing here, so
      // this read is authorized per row by `findById`'s visibility filter.
      if (!file) throw new ApiError(404, "File not found");

      const bytes = await readRowBytes(file);

      // Same doctrine as the chat attachment route: the stored mime came from
      // the uploader, so script carriers are coerced to octet-stream and only
      // an allow-list renders inline. Inline is what makes the preview dialog
      // work — an attachment disposition inside an iframe downloads instead of
      // rendering.
      const safeMime = sanitizeAttachmentContentType(file.mimeType);
      const disposition = isSafeInlineMimeType(safeMime)
        ? "inline"
        : "attachment";
      reply
        .header("Content-Type", safeMime)
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Disposition",
          // RFC 6266: an ASCII fallback plus the UTF-8 form modern clients
          // prefer, so non-ASCII filenames survive the download intact.
          `${disposition}; filename="${file.filename.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        );
      // `sandbox` would block Chrome's PDF viewer outright, so PDFs get a
      // narrower policy; everything else keeps the strict one. PDF script runs
      // inside the viewer plugin, isolated from the page and our origin.
      if (safeMime === "application/pdf") {
        reply.header("Content-Security-Policy", "frame-ancestors 'self'");
      } else {
        reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      }
      return reply.send(bytes);
    },
  );

  fastify.patch(
    "/api/knowledge-files/:fileId",
    {
      schema: {
        operationId: RouteId.UpdateKnowledgeFile,
        description: "Rename a document, move it, or change who can see it",
        tags: ["Knowledge Files"],
        params: FileParamsSchema,
        body: z.object({
          filename: z.string().trim().min(1).max(512).optional(),
          directoryId: z.string().uuid().nullable().optional(),
          visibility: KnowledgeFileVisibilitySchema.optional(),
          teamIds: z.array(z.string()).optional(),
        }),
        response: constructResponseSchema(KbFileSchema),
      },
    },
    async ({ params, body, organizationId }) => {
      if (body.directoryId !== undefined) {
        await assertDirectoryInOrg({
          directoryId: body.directoryId,
          organizationId,
        });
      }
      if (body.teamIds) {
        await assertTeamsInOrg({ teamIds: body.teamIds, organizationId });
      }

      let file: Awaited<ReturnType<typeof KbFileModel.update>>;
      try {
        file = await KbFileModel.update({
          id: params.fileId,
          organizationId,
          ...body,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ApiError(
            409,
            `"${body.filename}" already exists in that location.`,
          );
        }
        throw error;
      }
      if (!file) throw new ApiError(404, "File not found");

      const knowledgeBases = await KbFileModel.findKnowledgeBasesForFiles([
        file.id,
      ]);
      const {
        data: _data,
        objectKey: _objectKey,
        storageProvider: _provider,
        ...rest
      } = file;
      return {
        ...rest,
        knowledgeBases: knowledgeBases.get(file.id) ?? [],
        teamIds: await KbFileModel.findTeamIds(file.id),
      };
    },
  );

  fastify.delete(
    "/api/knowledge-files/:fileId",
    {
      schema: {
        operationId: RouteId.DeleteKnowledgeFile,
        description:
          "Delete a repository document and every document indexed from it",
        tags: ["Knowledge Files"],
        params: FileParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId }) => {
      const deleted = await KbFileModel.delete({
        id: params.fileId,
        organizationId,
      });
      if (!deleted) throw new ApiError(404, "File not found");
      return { success: true };
    },
  );

  fastify.post(
    "/api/knowledge-files/index",
    {
      schema: {
        operationId: RouteId.IndexKnowledgeFiles,
        description:
          "Index repository documents into a knowledge base, creating it when a name is given",
        tags: ["Knowledge Files"],
        body: z
          .object({
            fileIds: z.array(z.string().uuid()).default([]),
            directoryIds: z.array(z.string().uuid()).default([]),
            knowledgeBaseId: z.string().uuid().optional(),
            newKnowledgeBaseName: z.string().trim().min(1).max(256).optional(),
          })
          .refine(
            (body) =>
              Boolean(body.knowledgeBaseId) !==
              Boolean(body.newKnowledgeBaseName),
            "Provide either knowledgeBaseId or newKnowledgeBaseName, not both",
          ),
        response: constructResponseSchema(
          z.object({
            knowledgeBaseId: z.string(),
            indexed: z.number(),
            failures: z.array(
              z.object({ fileId: z.string(), error: z.string() }),
            ),
          }),
        ),
      },
    },
    async (request) => {
      const { body, organizationId } = request;
      const viewer = await resolveViewer(request);

      const knowledgeBaseId = body.newKnowledgeBaseName
        ? (
            await KnowledgeBaseModel.create({
              organizationId,
              name: body.newKnowledgeBaseName,
            })
          ).id
        : await assertKnowledgeBaseInOrg({
            knowledgeBaseId: body.knowledgeBaseId as string,
            organizationId,
          });

      // Resolve directories to their files here rather than in the model: the
      // caller's visibility filter has to apply to expanded files too, or
      // selecting a directory would index documents the caller cannot see.
      const directoryFileIds: string[] = [];
      for (const directoryId of body.directoryIds) {
        const { items } = await KbFileModel.findPaginated({
          organizationId,
          viewer,
          directoryId,
          limit: config.knowledgeFiles.maxFilesPerIndexRequest,
          offset: 0,
        });
        directoryFileIds.push(...items.map((file) => file.id));
      }

      const explicit = await KbFileModel.findManyByIds({
        ids: body.fileIds,
        organizationId,
        viewer,
      });
      const fileIds = [
        ...new Set([...explicit.map((file) => file.id), ...directoryFileIds]),
      ];
      if (fileIds.length === 0) {
        throw new ApiError(400, "No readable files were selected");
      }

      const uploaderEmailById = await KbFileModel.findUploaderEmails(fileIds);
      const result = await indexFilesIntoKnowledgeBase({
        fileIds,
        knowledgeBaseId,
        organizationId,
        uploaderEmailById,
      });

      return { knowledgeBaseId, ...result };
    },
  );

  // ===== Directories =====

  fastify.get(
    "/api/knowledge-directories",
    {
      schema: {
        operationId: RouteId.GetKnowledgeDirectories,
        description: "List knowledge file directories",
        tags: ["Knowledge Files"],
        response: constructResponseSchema(z.array(KbDirectoryWithTeamsSchema)),
      },
    },
    async ({ organizationId }) => KbDirectoryModel.findAll(organizationId),
  );

  fastify.post(
    "/api/knowledge-directories",
    {
      schema: {
        operationId: RouteId.CreateKnowledgeDirectory,
        description: "Create a knowledge file directory",
        tags: ["Knowledge Files"],
        body: VisibilityBodySchema.extend({
          name: z.string().trim().min(1).max(256),
        }),
        response: constructResponseSchema(KbDirectoryWithTeamsSchema),
      },
    },
    async ({ body, organizationId, user }) => {
      await assertTeamsInOrg({ teamIds: body.teamIds, organizationId });
      const directory = await KbDirectoryModel.create({
        organizationId,
        name: body.name,
        visibility: body.visibility,
        teamIds: body.teamIds,
        createdBy: user.id,
      });
      return { ...directory, teamIds: body.teamIds, fileCount: 0 };
    },
  );

  fastify.patch(
    "/api/knowledge-directories/:directoryId",
    {
      schema: {
        operationId: RouteId.UpdateKnowledgeDirectory,
        description: "Rename a directory or change who can see it",
        tags: ["Knowledge Files"],
        params: DirectoryParamsSchema,
        body: z.object({
          name: z.string().trim().min(1).max(256).optional(),
          visibility: KnowledgeFileVisibilitySchema.optional(),
          teamIds: z.array(z.string()).optional(),
        }),
        response: constructResponseSchema(KbDirectoryWithTeamsSchema),
      },
    },
    async ({ params, body, organizationId }) => {
      if (body.teamIds) {
        await assertTeamsInOrg({ teamIds: body.teamIds, organizationId });
      }
      const directory = await KbDirectoryModel.update({
        id: params.directoryId,
        organizationId,
        ...body,
      });
      if (!directory) throw new ApiError(404, "Directory not found");

      const [teamIds, fileCount] = await Promise.all([
        KbDirectoryModel.findTeamIds(directory.id),
        KbDirectoryModel.countFiles(directory.id),
      ]);
      return { ...directory, teamIds, fileCount };
    },
  );

  fastify.delete(
    "/api/knowledge-directories/:directoryId",
    {
      schema: {
        operationId: RouteId.DeleteKnowledgeDirectory,
        description:
          "Delete a directory; its files move to the repository root",
        tags: ["Knowledge Files"],
        params: DirectoryParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId }) => {
      const deleted = await KbDirectoryModel.delete({
        id: params.directoryId,
        organizationId,
      });
      if (!deleted) throw new ApiError(404, "Directory not found");
      return { success: true };
    },
  );
};

// ===== Internal =====

async function resolveViewer(request: {
  user: { id: string };
  organizationId: string;
}): Promise<KbFileViewer> {
  const teams = await TeamModel.getUserTeamsForOrganization({
    userId: request.user.id,
    organizationId: request.organizationId,
  });
  return {
    userId: request.user.id,
    teamIds: teams.map((team) => team.id),
    // Deliberately false: repository listing is scoped by the file's own
    // audience for everyone, so an admin browsing does not silently widen what
    // a shared screen shows. Deletion is gated by the route permission instead.
    canManageAll: false,
  };
}

/**
 * Foreign keys cannot express organization ownership for these references, so
 * every one is checked explicitly before it is stored.
 */
/**
 * Whether the organization has a Document OCR pair configured. Presence is
 * the feature's enable switch; resolvability is checked where the spend
 * happens (indexing), not at the upload gate.
 */
async function organizationHasOcr(organizationId: string): Promise<boolean> {
  const org = await OrganizationModel.getById(organizationId);
  return !!org?.ocrChatApiKeyId && !!org.ocrModel;
}

async function assertDirectoryInOrg(params: {
  directoryId: string | null;
  organizationId: string;
}): Promise<void> {
  if (!params.directoryId) return;
  const directory = await KbDirectoryModel.findById({
    id: params.directoryId,
    organizationId: params.organizationId,
  });
  if (!directory) throw new ApiError(404, "Directory not found");
}

async function assertTeamsInOrg(params: {
  teamIds: string[];
  organizationId: string;
}): Promise<void> {
  if (params.teamIds.length === 0) return;
  const teams = await TeamModel.findByOrganization(params.organizationId);
  const known = new Set(teams.map((team) => team.id));
  const foreign = params.teamIds.filter((teamId) => !known.has(teamId));
  if (foreign.length > 0) {
    throw new ApiError(400, "One or more teams are not in this organization");
  }
}

async function assertKnowledgeBaseInOrg(params: {
  knowledgeBaseId: string;
  organizationId: string;
}): Promise<string> {
  const knowledgeBase = await KnowledgeBaseModel.findById(
    params.knowledgeBaseId,
  );
  // `findById` is org-agnostic, so the tenancy check is this function's job.
  // Same 404 either way: a caller must not be able to tell a knowledge base in
  // another organization apart from one that does not exist.
  if (
    !knowledgeBase ||
    knowledgeBase.organizationId !== params.organizationId
  ) {
    throw new ApiError(404, "Knowledge base not found");
  }
  return knowledgeBase.id;
}

export default knowledgeFileRoutes;
