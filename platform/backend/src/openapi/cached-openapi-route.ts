import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

type CachedOpenApiRouteOptions = {
  buildDocument: () => unknown;
  getCacheKey: () => string;
};

type CachedResponse = {
  body: Buffer;
  etag: string;
  key: string;
};

const matchesEtag = (
  header: string | string[] | undefined,
  etag: string,
): boolean => {
  if (!header) return false;

  const values = Array.isArray(header) ? header : [header];
  return values.some((value) =>
    value.split(",").some((candidate) => {
      const normalized = candidate.trim();
      return normalized === "*" || normalized.replace(/^W\//i, "") === etag;
    }),
  );
};

export const createCachedOpenApiRouteHandler = ({
  buildDocument,
  getCacheKey,
}: CachedOpenApiRouteOptions) => {
  let cached: CachedResponse | undefined;

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const key = getCacheKey();
    if (!cached || cached.key !== key) {
      const serialized = JSON.stringify(buildDocument());
      if (serialized === undefined) {
        throw new Error("OpenAPI document cannot be serialized as JSON");
      }
      const body = Buffer.from(serialized);

      cached = {
        body,
        etag: `"${createHash("sha256").update(body).digest("hex")}"`,
        key,
      };
    }

    reply.header("Cache-Control", CACHE_CONTROL).header("ETag", cached.etag);

    if (matchesEtag(request.headers["if-none-match"], cached.etag)) {
      return reply.code(304).send();
    }

    return reply.type("application/json; charset=utf-8").send(cached.body);
  };
};
