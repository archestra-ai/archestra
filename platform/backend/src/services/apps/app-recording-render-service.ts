import type { AppRecordingBundle } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "@/types";
import {
  cancelRenderJob,
  renderJobStatus,
  startRenderJob,
  takeRenderedVideo,
} from "./app-recording-render-jobs";
import {
  INTERNAL_RENDER_BASE,
  RENDER_BUNDLE_BODY_LIMIT_BYTES,
  RENDER_FILENAME_HEADER,
  RENDER_USER_ID_HEADER,
} from "./app-recording-render-protocol";

/**
 * The internal render endpoints served by the dedicated render service (the
 * `renderer` process type — see startRenderer). They are the same four
 * operations the public app-recording routes expose, minus the session: the
 * web tier has already authenticated the caller and gated the feature, and
 * reaches these over the in-cluster Service only. What they add over calling the
 * job module directly is that a SINGLE replica runs them, so every follow-up
 * request for a render lands on the one process that holds its (in-memory) job.
 *
 * Ownership is still enforced per render — a job id is a bearer token for
 * someone's video — from the user id the web tier forwards in a header, so one
 * caller cannot collect another's video by guessing a job id.
 */
const renderServiceRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    INTERNAL_RENDER_BASE,
    {
      // Matches the public render route's ceiling: the web tier proxies the same
      // bundle here, so this hop must accept what that one already did.
      bodyLimit: RENDER_BUNDLE_BODY_LIMIT_BYTES,
      schema: {
        hide: true,
        // @security The bundle is taken as z.unknown() and trusted unvalidated
        // (cast below): the web tier already validated it against the shared
        // contract, and these internal routes are reachable only from inside
        // the cluster network. That trust rests on that boundary — if these
        // routes ever become reachable by untrusted callers, the bundle must be
        // re-validated here (validateRecordingBundle) before it drives a
        // browser, since it flows straight into the renderer.
        body: z.object({ bundle: z.unknown(), title: z.string().min(1) }),
        response: {
          200: z.object({ jobId: z.string() }),
        },
      },
    },
    async ({ body, headers }, reply) => {
      const userId = requireUserId(headers);
      // The web tier validated the bundle against the shared contract before
      // proxying it here, and only the web tier can reach this route, so it is
      // taken as given rather than re-walked over what may be tens of megabytes.
      //
      // startRenderJob is synchronous by design: it registers the job and hands
      // back its id, then the render runs in the background. This handler must
      // NOT await it to completion — the client polls status and pulls the video
      // in separate requests.
      const jobId = startRenderJob({
        bundle: body.bundle as AppRecordingBundle,
        userId,
        title: body.title,
        bundleBytes: Number(headers["content-length"]) || undefined,
      });
      return reply.send({ jobId });
    },
  );

  fastify.get(
    `${INTERNAL_RENDER_BASE}/:jobId`,
    {
      schema: {
        hide: true,
        params: z.object({ jobId: z.string() }),
        response: {
          200: z.object({
            status: z.enum(["running", "done", "failed", "cancelled"]),
            error: z.string().optional(),
          }),
        },
      },
    },
    async ({ params, headers }, reply) => {
      const userId = requireUserId(headers);
      return reply.send(renderJobStatus({ jobId: params.jobId, userId }));
    },
  );

  fastify.get(
    `${INTERNAL_RENDER_BASE}/:jobId/video`,
    { schema: { hide: true, params: z.object({ jobId: z.string() }) } },
    async ({ params, headers }, reply) => {
      const userId = requireUserId(headers);
      const { video, fileName } = takeRenderedVideo({
        jobId: params.jobId,
        userId,
      });
      // The name rides back in a header, url-encoded, so the web tier can put it
      // on the content-disposition it sends the browser without the file's
      // punctuation having to survive two hops of quoting.
      return reply
        .header("content-type", "video/mp4")
        .header(RENDER_FILENAME_HEADER, encodeURIComponent(fileName))
        .send(video);
    },
  );

  fastify.delete(
    `${INTERNAL_RENDER_BASE}/:jobId`,
    {
      schema: {
        hide: true,
        params: z.object({ jobId: z.string() }),
        response: { 200: z.object({ cancelled: z.literal(true) }) },
      },
    },
    async ({ params, headers }, reply) => {
      const userId = requireUserId(headers);
      cancelRenderJob({ jobId: params.jobId, userId });
      return reply.send({ cancelled: true });
    },
  );
};

export default renderServiceRoutes;

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * The user id the web tier forwarded. Its absence is a 400: only the web tier
 * calls these routes and it always sends it, so a request without it is
 * malformed rather than merely unauthorized.
 */
function requireUserId(headers: FastifyRequest["headers"]): string {
  const userId = headers[RENDER_USER_ID_HEADER];
  if (typeof userId !== "string" || !userId) {
    throw new ApiError(400, "Missing render user.");
  }
  return userId;
}
