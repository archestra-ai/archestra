import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SkillSandboxArtifactModel, SkillSandboxModel } from "@/models";
import { isInlineSafeImageMime } from "@/skills-sandbox/mime-sniff";
import { ApiError } from "@/types";

/**
 * Serves bytes from `skill_sandbox_artifacts` back to the browser so the UI
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
      const artifact = await SkillSandboxArtifactModel.findById(artifactId);
      if (!artifact) {
        throw new ApiError(404, "Artifact not found");
      }
      // collapse "wrong sandbox owner" and "missing" into the same 404 so
      // cross-org probes can't distinguish "exists but inaccessible" from
      // "does not exist".
      const sandbox = await SkillSandboxModel.findById(artifact.sandboxId);
      if (
        !sandbox ||
        sandbox.organizationId !== organizationId ||
        sandbox.userId !== user.id
      ) {
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

      // bytea round-trips as Buffer in production (pg) but as something
      // string-like under PGlite; coerce so reply.send always streams bytes.
      const data = Buffer.isBuffer(artifact.data)
        ? artifact.data
        : Buffer.from(artifact.data);

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
