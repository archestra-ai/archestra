import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getAppVersion } from "@/app-version";
import config from "@/config";
import logger from "@/logging";
import { PROXY_BODY_LIMIT } from "@/routes/proxy/common";
import {
  LLM_RELAY_PATH,
  type RelayedLlmCall,
  RelayRefusedError,
  relayStreamFrame,
  serializeRelayError,
  serveRelayedCall,
} from "@/routes/proxy/remote-site-transport";
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

  fastify.post(
    `${SITE_CHANNEL_PREFIX}${LLM_RELAY_PATH}`,
    { schema: { hide: true }, bodyLimit: PROXY_BODY_LIMIT },
    async (request, reply) => {
      const signed = readSignedJson<RelayedLlmCall>(request, reply);
      if (!signed) return reply;
      const call = signed.body;
      // The receiving site's client went away: stop the provider call too.
      const abort = new AbortController();
      request.raw.on("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      let served: Awaited<ReturnType<typeof serveRelayedCall>>;
      try {
        served = await serveRelayedCall(call, abort.signal);
      } catch (error) {
        if (error instanceof RelayRefusedError)
          return reply
            .code(error.status)
            .send({ origin: "site", error: { message: error.message } });
        const serialized = serializeRelayError(error);
        logger.info(
          {
            from: signed.from,
            status: serialized.status,
            provider: call.provider,
          },
          "Relayed upstream call failed",
        );
        return reply.code(502).send({ origin: "upstream", error: serialized });
      }
      if (!served.stream)
        return reply.send({ response: served.response, usage: served.usage });

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      try {
        for await (const chunk of served.chunks) {
          if (abort.signal.aborted) break;
          reply.raw.write(relayStreamFrame({ chunk }));
        }
        reply.raw.write(relayStreamFrame({ usage: served.usage() }));
      } catch (error) {
        reply.raw.write(
          relayStreamFrame({ error: serializeRelayError(error) }),
        );
      }
      reply.raw.end();
      return reply;
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
