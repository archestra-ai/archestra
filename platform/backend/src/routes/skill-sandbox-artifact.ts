import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getSandboxFileStorage } from "@/skills-sandbox/file-storage";
import { SandboxFileMissingError } from "@/skills-sandbox/file-storage-filesystem";
import { isInlineSafeImageMime } from "@/skills-sandbox/mime-sniff";
import { skillSandboxArtifactService } from "@/skills-sandbox/skill-sandbox-artifact-service";
import {
  ApiError,
  constructResponseSchema,
  SandboxFileListItemSchema,
  SandboxFolderListItemSchema,
} from "@/types";

/**
 * Serves bytes from `skill_sandbox_files` (kind `artifact`) back to the browser so the UI
 * can render previews or trigger downloads. The MCP tool only ever returns
 * metadata (`ArtifactRef`); this is the only path that exposes the actual
 * bytes outside the sandbox runtime.
 *
 * Security:
 *   - Auth via the standard /api/ middleware (org + user must match the
 *     artifact's sandbox).
 *   - `Content-Type` comes from the sniffed/persisted mime, never from a
 *     query param.
 *   - `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`
 *     so even a polyglot file has no script execution surface.
 *   - Only PNG/JPEG/WebP/GIF are served inline. SVG and everything else
 *     download as `application/octet-stream` so the browser never parses
 *     them as HTML.
 */
const skillSandboxArtifactRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/skill-sandbox/artifacts/:artifactId",
    {
      schema: {
        operationId: RouteId.GetSkillSandboxArtifact,
        description:
          "Stream the raw bytes of a skill sandbox artifact. Inline for " +
          "known-safe raster images; download for everything else.",
        tags: ["Skills"],
        params: z.object({ artifactId: z.string().uuid() }),
        // no `response` schema: this endpoint streams raw bytes, not JSON,
        // so the zod type-provider would reject the Buffer payload. The
        // global error handler still formats 4xx/5xx as JSON.
      },
    },
    async ({ params: { artifactId }, organizationId, user }, reply) => {
      // "wrong owner" and "missing" collapse into the same 404 inside the
      // service so cross-org probes can't tell them apart. Access: the
      // producing sandbox's owner or the owner of the artifact's folder.
      const artifact = await skillSandboxArtifactService.getArtifactForUser({
        artifactId,
        organizationId,
        userId: user.id,
      });
      if (!artifact) {
        throw new ApiError(404, "Artifact not found");
      }

      const inlineSafe = isInlineSafeImageMime(artifact.mimeType);
      const filename = safeFilenameFromPath(artifact.path);
      const disposition = inlineSafe
        ? `inline; filename="${filename}"`
        : `attachment; filename="${filename}"`;
      const contentType = inlineSafe
        ? artifact.mimeType
        : "application/octet-stream";

      // byte normalization (pg Buffer vs PGlite Uint8Array) lives in the
      // storage adapter, which also resolves rows whose bytes live outside
      // the data column (storage_provider = 'filesystem').
      let data: Buffer;
      try {
        data = await getSandboxFileStorage().get(artifact);
      } catch (error) {
        if (error instanceof SandboxFileMissingError) {
          // metadata exists but the backing file was removed from the folder
          throw new ApiError(404, "Artifact data is no longer available");
        }
        throw error;
      }

      reply
        .header("Content-Type", contentType)
        .header("Content-Length", String(data.byteLength))
        .header("Content-Disposition", disposition)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "private, max-age=300");
      return reply.send(data);
    },
  );

  fastify.delete(
    "/api/skill-sandbox/artifacts/:artifactId",
    {
      schema: {
        operationId: RouteId.DeleteSkillSandboxArtifact,
        description:
          "Delete a persistent file (artifact). Removes the record and, in " +
          "filesystem storage mode, the file on disk. Allowed for the chat " +
          "that produced it or the owner of the folder it sits in.",
        tags: ["Skills"],
        params: z.object({ artifactId: z.string().uuid() }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { artifactId }, organizationId, user }) => {
      const deleted = await skillSandboxArtifactService.deleteArtifactForUser({
        artifactId,
        organizationId,
        userId: user.id,
      });
      if (!deleted) {
        throw new ApiError(404, "Artifact not found");
      }
      return { ok: true as const };
    },
  );

  fastify.get(
    "/api/skill-sandbox/conversations/:conversationId/artifacts",
    {
      schema: {
        operationId: RouteId.GetSkillSandboxConversationArtifacts,
        description:
          "List the artifact files produced in a conversation's sandbox.",
        tags: ["Skills"],
        params: z.object({ conversationId: z.string().uuid() }),
        response: constructResponseSchema(z.array(SandboxFileListItemSchema)),
      },
    },
    async ({ params: { conversationId }, organizationId, user }) =>
      skillSandboxArtifactService.listForConversation({
        organizationId,
        userId: user.id,
        conversationId,
      }),
  );

  fastify.get(
    "/api/skill-sandbox/files",
    {
      schema: {
        operationId: RouteId.GetSkillSandboxFiles,
        description:
          "List the calling user's persistent files (X-Files): folders and " +
          "artifact files across all conversations.",
        tags: ["Skills"],
        response: constructResponseSchema(
          z.object({
            folders: z.array(SandboxFolderListItemSchema),
            files: z.array(SandboxFileListItemSchema),
          }),
        ),
      },
    },
    async ({ organizationId, user }) =>
      skillSandboxArtifactService.listAllForUser({
        organizationId,
        userId: user.id,
      }),
  );

  fastify.get(
    "/api/skill-sandbox/uploads/:uploadId",
    {
      schema: {
        operationId: RouteId.GetSkillSandboxUpload,
        description:
          "Stream the raw bytes of a sandbox upload (e.g. a persistent file " +
          "the agent pulled into the sandbox). Inline for known-safe raster " +
          "images; download for everything else.",
        tags: ["Skills"],
        params: z.object({ uploadId: z.string().uuid() }),
        // no `response` schema: raw bytes, same contract as the artifact route.
      },
    },
    async ({ params: { uploadId }, organizationId, user }, reply) => {
      // "not yours" and "missing" collapse into the same 404, mirroring the
      // artifact byte route, so probes can't distinguish the two.
      const upload = await skillSandboxArtifactService.getUploadForUser({
        uploadId,
        organizationId,
        userId: user.id,
      });
      if (!upload) {
        throw new ApiError(404, "Upload not found");
      }

      const inlineSafe = isInlineSafeImageMime(upload.mimeType);
      const filename = safeFilenameFromPath(upload.originalName ?? upload.path);
      const disposition = inlineSafe
        ? `inline; filename="${filename}"`
        : `attachment; filename="${filename}"`;
      const contentType = inlineSafe
        ? upload.mimeType
        : "application/octet-stream";

      // uploads always live in Postgres, but read through the storage router
      // anyway so this route stays correct if upload routing ever changes.
      let data: Buffer;
      try {
        data = await getSandboxFileStorage().get(upload);
      } catch (error) {
        if (error instanceof SandboxFileMissingError) {
          throw new ApiError(404, "Upload data is no longer available");
        }
        throw error;
      }

      reply
        .header("Content-Type", contentType)
        .header("Content-Length", String(data.byteLength))
        .header("Content-Disposition", disposition)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "private, max-age=300");
      return reply.send(data);
    },
  );
};

export default skillSandboxArtifactRoutes;

// === internal helpers ===

/**
 * Strip everything to the basename and drop characters that would break the
 * Content-Disposition header. Paths under SKILL_SANDBOX_HOME / ROOT are
 * sandbox-internal, so the user-visible filename is what was generated
 * inside.
 */
function safeFilenameFromPath(path: string): string {
  const basename = path.split("/").pop() ?? "artifact";
  // allowlist: alphanumerics, dot, dash, underscore, space. anything else
  // (quotes, backslashes, control chars, unicode) collapses to `_` so the
  // Content-Disposition header stays parseable.
  const cleaned = basename.replace(/[^A-Za-z0-9._\- ]/g, "_");
  return cleaned || "artifact";
}
