import { createHash } from "node:crypto";
import { EDITABLE_TEXT_FILE_MAX_BYTES, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { FileBytesMissingError } from "@/skills-sandbox/file-storage";
import { FileNotDeletableError, fileStore } from "@/skills-sandbox/file-store";
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
        // A project admin overseeing a foreign project may read its files
        // read-only, even without share access. Project-scoped files only —
        // personal files are never exposed by this fallback.
        if (
          !resolved &&
          (await userHasPermission(user.id, organizationId, "project", "admin"))
        ) {
          resolved = await fileStore.getProjectScopedForAdmin({
            ref: artifactId,
            organizationId,
          });
        }
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

  // A generated file exists independently of the Projects feature, so deleting
  // one is always available (parity with the unconditional GET above). The
  // authority still lives in `fileStore.delete` (author / project access, plus
  // the never-deletable instructions-file guard), so ungating registration
  // does not loosen who may delete what.
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
      let deleted: boolean;
      try {
        deleted = await fileStore.delete({
          ref: artifactId,
          organizationId,
          userId: user.id,
        });
        // A project admin may also delete a foreign project's files (oversight),
        // mirroring the read path — project-scoped files only, never personal.
        // Checked lazily so the normal path pays no extra permission lookup.
        // Inside the try so the instructions-file guard below still applies.
        if (
          !deleted &&
          (await userHasPermission(user.id, organizationId, "project", "admin"))
        ) {
          deleted = await fileStore.deleteProjectScopedForAdmin({
            ref: artifactId,
            organizationId,
          });
        }
      } catch (error) {
        // The project instructions file is never deletable; surface it as a
        // conflict rather than a generic 500.
        if (error instanceof FileNotDeletableError) {
          throw new ApiError(409, error.message);
        }
        throw error;
      }
      if (!deleted) {
        throw new ApiError(404, "Artifact not found");
      }
      return { ok: true as const };
    },
  );

  // Overwrite a text file's content from the browser editor — the REST analog of
  // the project-instructions write, for any row-backed `.md`/`.txt` file. Auth
  // and the editability/instructions guards live in the store (parity with the
  // GET/DELETE above, whose authority is also `fileStore`).
  fastify.put(
    "/api/skill-sandbox/artifacts/:artifactId/content",
    {
      schema: {
        operationId: RouteId.UpdateSkillSandboxArtifactContent,
        description:
          "Overwrite the full text content of a row-backed Markdown/plain-text " +
          "file. Allowed for the file's author, or anyone with access to the " +
          "project owning the file.",
        tags: ["Skills"],
        // Row-backed files only — a rowless (`obj_`) object has no row to
        // update, so a strict UUID (not the GET/DELETE `ARTIFACT_REF`).
        params: z.object({ artifactId: z.string().uuid() }),
        body: z.object({
          // Coarse payload guard; the store's UTF-8 `byteLength` check is the
          // precise authority (a multi-byte character is more than one byte).
          content: z.string().max(EDITABLE_TEXT_FILE_MAX_BYTES),
        }),
        response: constructResponseSchema(
          z.object({
            ok: z.literal(true),
            fileId: z.string(),
            filename: z.string(),
            mimeType: z.string(),
            sizeBytes: z.number(),
          }),
        ),
      },
    },
    async ({
      params: { artifactId },
      body: { content },
      organizationId,
      user,
    }) => {
      const result = await fileStore.updateTextFileContent({
        ref: artifactId,
        organizationId,
        userId: user.id,
        content,
      });
      if ("error" in result) {
        switch (result.error) {
          case "not_found":
            throw new ApiError(404, "Artifact not found");
          case "reserved":
            throw new ApiError(
              409,
              "The project instructions file is edited from the Instructions panel.",
            );
          case "not_editable":
            throw new ApiError(415, "Only .md and .txt files can be edited.");
          case "too_large":
            throw new ApiError(413, "File content is too large to edit.");
        }
      }
      return {
        ok: true as const,
        fileId: result.id,
        filename: result.filename,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
      };
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
