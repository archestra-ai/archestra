import Fastify, { type FastifyRequest } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import logger from "@/logging";
import {
  getBrowserApiFaviconHref,
  isApiRequestUrl,
  isJsonContentType,
  renderBrowserApiDocument,
  shouldRenderBrowserApiDocument,
} from "@/middleware/browser-api-document";
import OrganizationModel from "@/models/organization";
import type { ApiError } from "@/types";
import { handleServerError } from "./server/error-handler";

const BROWSER_API_FAVICON_HREF = Symbol("browserApiFaviconHref");

type BrowserApiRequest = FastifyRequest & {
  [BROWSER_API_FAVICON_HREF]?: string;
};

/** Sets up logging, Zod validation, response serialization, and shared hooks. */
export const createFastifyInstance = () =>
  Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
    trustProxy: config.api.trustProxy,
    bodyLimit: config.api.bodyLimit,
    // Held above the keep-alive timeout of any proxy or load balancer in front
    // of us, so the proxy never reuses a socket we are closing at that instant
    // (which reaches the client as an intermittent dropped request). See
    // parseKeepAliveTimeoutMs in config.ts.
    keepAliveTimeout: config.api.keepAliveTimeoutMs,
    // Some path params are opaque, base64url-encoded handles longer than
    // Fastify's 100-char default (e.g. skill-sandbox artifact `obj_` refs that
    // encode a scope + object key). Without this, such a request fails to match
    // its route and falls through to the auth hook, surfacing as a 403.
    routerOptions: {
      maxParamLength: 4096,
    },
  })
    .withTypeProvider<ZodTypeProvider>()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler)
    // Resolve white-label branding before a top-level API navigation reaches
    // onSend. Keeping onSend synchronous is required for routes (Better Auth)
    // that write directly to the raw response.
    .addHook("preHandler", (request, _reply, done) => {
      if (!shouldRenderBrowserApiDocument(request)) {
        done();
        return;
      }

      void OrganizationModel.getAppearanceSettings().then(
        ({ favicon }) => {
          (request as BrowserApiRequest)[BROWSER_API_FAVICON_HREF] =
            getBrowserApiFaviconHref(favicon);
          done();
        },
        () => done(),
      );
    })
    // REST API responses are per-user and must never be cached by
    // intermediaries. Reverse proxies/CDNs in front of a deployment default to
    // caching responses that carry no Cache-Control header, which replays one
    // user's stale GET body after their own writes (e.g. an /api/apps list
    // that keeps showing pre-pin state until a hard refresh). Routes that
    // intentionally cache set their own header, which wins.
    .addHook("onSend", (request, reply, _payload, done) => {
      if (isApiRequestUrl(request.url) && !reply.hasHeader("cache-control")) {
        void reply.header("Cache-Control", "no-store");
      }
      done();
    })
    // Raw JSON documents have no <head>, so user agents can fall back to an
    // origin-wide favicon cache. Render only top-level navigations as HTML with
    // an explicit versioned icon; fetch/XHR/API clients keep the original JSON.
    .addHook("onSend", (request, reply, payload, done) => {
      const browserRequest = request as BrowserApiRequest;
      const faviconHref = browserRequest[BROWSER_API_FAVICON_HREF];
      delete browserRequest[BROWSER_API_FAVICON_HREF];
      if (
        reply.raw.headersSent ||
        typeof payload !== "string" ||
        !faviconHref ||
        !isJsonContentType(reply.getHeader("content-type"))
      ) {
        done();
        return;
      }

      try {
        const document = renderBrowserApiDocument(payload, faviconHref);
        void reply.type("text/html; charset=utf-8");
        void reply.removeHeader("content-length");
        done(null, document);
      } catch {
        // Branding must never turn a successful API response into an error.
        done();
      }
    })
    .setErrorHandler<ApiError | Error>(handleServerError);

/** Type for the Fastify instance with Zod type provider. */
export type FastifyInstanceWithZod = ReturnType<typeof createFastifyInstance>;
