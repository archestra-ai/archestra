import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getAppVersion } from "@/app-version";
import config from "@/config";
import logger from "@/logging";
import { PROXY_BODY_LIMIT } from "@/routes/proxy/common";
import { SITE_CHANNEL_PREFIX } from "@/routes/route-paths";
import { SITE_TOKEN_HEADER, verifySiteToken } from "@/sites/channel-auth";

/**
 * The internal channel other sites call (see `sites/README.md`). Every
 * request carries a site token over its exact body; user auth is skipped for
 * this prefix in the auth middleware. Hidden from the public OpenAPI spec.
 *
 * To add a channel endpoint, register it inside this plugin with
 * `readSignedJson`, which checks the token and parses the body.
 */
const siteChannelRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // The token signs the raw bytes, so this scope keeps JSON bodies as text.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: PROXY_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  fastify.post(
    `${SITE_CHANNEL_PREFIX}/health`,
    { schema: { hide: true }, bodyLimit: PROXY_BODY_LIMIT },
    async (request, reply) => {
      const signed = readSignedJson(request, reply);
      if (!signed) return reply;
      return reply.send({
        name: config.site.name,
        role: config.site.role,
        version: getAppVersion(),
        caller: signed.from,
      });
    },
  );
};

export default siteChannelRoutes;

/**
 * Verify the site token over the raw body and parse it. Sends 401 and
 * returns null when the token is refused.
 */
function readSignedJson<T = unknown>(
  request: FastifyRequest,
  reply: FastifyReply,
): { from: string; body: T } | null {
  const raw = typeof request.body === "string" ? request.body : "";
  const header = request.headers[SITE_TOKEN_HEADER];
  const verdict = verifySiteToken({
    token: Array.isArray(header) ? header[0] : header,
    body: raw,
  });
  if (!verdict.ok) {
    logger.warn(
      { reason: verdict.reason, url: request.url },
      "Refused a site channel request",
    );
    void reply
      .code(401)
      .send({ origin: "site", error: { message: verdict.reason } });
    return null;
  }
  return { from: verdict.from, body: (raw ? JSON.parse(raw) : {}) as T };
}
