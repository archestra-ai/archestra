import { createHash } from "node:crypto";
import { RouteId } from "@archestra/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { publicFileSharing } from "@/public-files/public-file-sharing";
import { ApiError } from "@/types";
import { PUBLIC_FILES_PREFIX } from "../route-paths";

/**
 * The internet-facing side of public file links: `GET|HEAD
 * /public-files/<token>[/<filename>]`. No session — the token in the path is
 * the whole credential (allowlisted in the auth middleware, kept out of request
 * logs). The trailing filename is cosmetic and ignored.
 *
 * Unknown, revoked, switched-off, deleted, and no-longer-allowed all answer the
 * same 404, so a probe learns nothing about which links ever existed.
 *
 * Headers: the Content-Type comes from sniffing the bytes, never from the
 * stored mime or the filename; `nosniff` stops the browser second-guessing it;
 * a `sandbox` CSP leaves even a polyglot file no script surface. PDFs get a
 * no-framing CSP instead, because `sandbox` blanks Chrome's PDF viewer. Never
 * sets a cookie. Single byte ranges are honoured so video players can seek.
 */
const publicFilesRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const handler = async (
    request: FastifyRequest<{ Params: { token: string } }>,
    reply: FastifyReply,
  ) => {
    const file = await publicFileSharing.resolve(request.params.token);
    if (!file) {
      throw new ApiError(404, "Not found");
    }
    const { data, mimeType } = file;

    const etag = `"${createHash("sha1").update(data).digest("base64url")}"`;
    reply
      .header("Content-Type", mimeType)
      .header(
        "Content-Disposition",
        `inline; filename="${safeFilename(file.filename)}"`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Security-Policy",
        mimeType === "application/pdf"
          ? "default-src 'none'; frame-ancestors 'none'"
          : "default-src 'none'; sandbox",
      )
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", `public, max-age=${CACHE_MAX_AGE_SECONDS}`)
      .header("Accept-Ranges", "bytes")
      .header("ETag", etag);

    if (request.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }

    const range = parseRange(request.headers.range, data.byteLength);
    if (range === "unsatisfiable") {
      return reply
        .code(416)
        .header("Content-Range", `bytes */${data.byteLength}`)
        .send();
    }
    if (range) {
      const slice = data.subarray(range.start, range.end + 1);
      return reply
        .code(206)
        .header(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${data.byteLength}`,
        )
        .header("Content-Length", String(slice.byteLength))
        .send(slice);
    }
    return reply.header("Content-Length", String(data.byteLength)).send(data);
  };

  const schema = {
    operationId: RouteId.GetPublicFile,
    description:
      "Serve a publicly shared file. Unauthenticated: the token in the path " +
      "authorizes the request. The trailing filename is optional and ignored.",
    tags: ["Public File Links"],
    // no `response` schema: this endpoint streams raw bytes, not JSON.
  };

  fastify.get(
    `${PUBLIC_FILES_PREFIX}/:token`,
    { schema: { ...schema, params: TokenParamsSchema } },
    handler,
  );
  fastify.get(
    `${PUBLIC_FILES_PREFIX}/:token/:filename`,
    {
      schema: {
        ...schema,
        operationId: RouteId.GetPublicFileWithName,
        params: TokenParamsSchema.extend({ filename: z.string() }),
      },
    },
    handler,
  );
};

export default publicFilesRoutes;

// === internal helpers ===

/**
 * How long shared caches may keep a file. Long enough for a CDN to absorb
 * repeat fetches, short enough that a revoke takes effect everywhere soon.
 */
const CACHE_MAX_AGE_SECONDS = 600;

const TokenParamsSchema = z.object({ token: z.string().max(64) });

/**
 * One `bytes=` range (`a-b`, `a-`, or `-n`); multiple ranges and anything
 * unparseable are ignored and the whole file is sent, as RFC 9110 allows.
 */
function parseRange(
  header: string | string[] | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Keep Content-Disposition parseable: basename, safe characters only. */
function safeFilename(name: string): string {
  const basename = name.split("/").pop() ?? "";
  return basename.replace(/[^A-Za-z0-9._\- ]/g, "_") || "file";
}
