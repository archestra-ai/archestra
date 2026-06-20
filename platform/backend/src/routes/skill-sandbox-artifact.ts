import { createHash } from "node:crypto";
import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { projectService } from "@/services/project";
import { FileBytesMissingError } from "@/skills-sandbox/file-storage";
import { fileStore } from "@/skills-sandbox/file-store";
import { isInlineSafeImageMime } from "@/skills-sandbox/mime-sniff";
import {
  ApiError,
  constructResponseSchema,
  SandboxFileListItemSchema,
} from "@/types";

/**
 * An artifact handle: a row UUID, or a bounded `obj_` ref for an untracked
 * (hand-placed) object. Bounding the length/charset here keeps a malformed/huge
 * ref from reaching the decoder (the store still validates the decoded key).
 */
const ARTIFACT_REF = z
  .string()
  .regex(/^(?:[0-9a-fA-F-]{36}|obj_[A-Za-z0-9_-]{1,2048})$/);

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
        // a row UUID, or an `obj_` ref for an untracked (hand-placed) object.
        params: z.object({ artifactId: ARTIFACT_REF }),
        // no `response` schema: this endpoint streams raw bytes, not JSON,
        // so the zod type-provider would reject the Buffer payload. The
        // global error handler still formats 4xx/5xx as JSON.
      },
    },
    async (
      { params: { artifactId }, organizationId, user, headers },
      reply,
    ) => {
      // "wrong owner" and "missing" collapse into the same 404 inside the
      // store so cross-org probes can't tell them apart. Access: the file's
      // author, or anyone with access to the project owning the file. Byte
      // normalization and per-row provider dispatch happen in the store.
      let resolved: Awaited<ReturnType<typeof fileStore.get>>;
      try {
        resolved = await fileStore.get({
          ref: artifactId,
          organizationId,
          userId: user.id,
        });
      } catch (error) {
        if (error instanceof FileBytesMissingError) {
          // the row exists but its bytes are gone
          throw new ApiError(404, "Artifact data is no longer available");
        }
        throw error;
      }
      if (!resolved) {
        throw new ApiError(404, "Artifact not found");
      }
      const { data } = resolved;

      // The download handle (row id / obj_ key) is stable across in-place edits
      // (edit_file overwrites the same row/key), so a time-based cache would let
      // the preview keep serving pre-edit bytes while a fresh download shows the
      // new ones — the two visibly diverge. Revalidate every request against a
      // content ETag instead: an unchanged file 304s, an edited one re-sends, so
      // preview and download always reflect the current bytes.
      const etag = `"${createHash("sha1").update(data).digest("base64url")}"`;
      if (headers["if-none-match"] === etag) {
        return reply
          .code(304)
          .header("ETag", etag)
          .header("Cache-Control", "private, no-cache")
          .send();
      }

      const inlineSafe = isInlineSafeImageMime(resolved.mimeType);
      const filename = safeFilenameFromPath(resolved.filename);
      const disposition = inlineSafe
        ? `inline; filename="${filename}"`
        : `attachment; filename="${filename}"`;
      const contentType = inlineSafe
        ? resolved.mimeType
        : "application/octet-stream";

      reply
        .header("Content-Type", contentType)
        .header("Content-Length", String(data.byteLength))
        .header("Content-Disposition", disposition)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("ETag", etag)
        .header("Cache-Control", "private, no-cache");
      return reply.send(data);
    },
  );

  if (config.projects.enabled) {
    fastify.delete(
      "/api/skill-sandbox/artifacts/:artifactId",
      {
        schema: {
          operationId: RouteId.DeleteSkillSandboxArtifact,
          description:
            "Delete a persistent file. Allowed for the file's author, or " +
            "anyone with access to the project owning the file.",
          tags: ["Skills"],
          // a row UUID, or an `obj_` ref for an untracked (hand-placed) object.
          params: z.object({ artifactId: ARTIFACT_REF }),
          response: constructResponseSchema(z.object({ ok: z.literal(true) })),
        },
      },
      async ({ params: { artifactId }, organizationId, user }) => {
        const deleted = await fileStore.delete({
          ref: artifactId,
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
        fileStore.list({
          organizationId,
          conversationId,
          authorUserId: user.id,
        }),
    );

    fastify.get(
      "/api/skill-sandbox/files",
      {
        schema: {
          operationId: RouteId.GetSkillSandboxFiles,
          description:
            "List the calling user's persistent files (My Files): their own " +
            "artifact files across all conversations, plus the files of " +
            "projects shared with them.",
          tags: ["Skills"],
          response: constructResponseSchema(
            z.object({ files: z.array(SandboxFileListItemSchema) }),
          ),
        },
      },
      async ({ organizationId, user }) => {
        const [own, shared] = await Promise.all([
          fileStore.search({
            organizationId,
            userId: user.id,
            scope: { kind: "personal" },
          }),
          projectService.listSharedProjectFiles({
            organizationId,
            userId: user.id,
          }),
        ]);
        // newest-first across personal + every shared project (the per-project
        // fan-out in listSharedProjectFiles loses global ordering otherwise).
        const files = [...own, ...shared].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        );
        return { files };
      },
    );
  }
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
