import {
  APP_RECORDING_MAX_BUNDLE_BYTES,
  RouteId,
  validateRecordingBundle,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { AgentModel, ConversationModel } from "@/models";
import { draftRecordingEnhancement } from "@/services/apps/app-recording-enhancement";
import { renderJobClient } from "@/services/apps/app-recording-render-client";
import { RENDER_BUNDLE_BODY_LIMIT_BYTES } from "@/services/apps/app-recording-render-protocol";
import { assertAppsHackathonAvailable } from "@/services/apps/apps-hackathon-gate";
import { ApiError, constructResponseSchema, UuidIdSchema } from "@/types";

/**
 * The one host a review recording may be fetched from. Submissions live as
 * `apps/<slug>/recording.json` in the public gallery repository, served raw by
 * GitHub — so the only legitimate source is a raw.githubusercontent.com URL.
 * Restricting to it is what keeps this endpoint from being an SSRF hop to
 * arbitrary internal or external hosts.
 */
const REVIEW_BUNDLE_HOST = "raw.githubusercontent.com";
/** Give up on a slow GitHub fetch rather than holding the request open. */
const REVIEW_FETCH_TIMEOUT_MS = 15_000;
/**
 * Cap the fetched body well below the recorder's own bundle ceiling: a review
 * recording is already trimmed for submission, and a reviewer's request must
 * not buffer an unbounded response an attacker points `src` at.
 */
const REVIEW_BUNDLE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * App session recordings are captured, stored (IndexedDB, one per
 * conversation, overwrite-on-new), replayed, edited, and downloaded entirely
 * in the browser — the server keeps no recording state and has no table. The
 * single endpoint here drafts the AI presentation layer for a recording over
 * the chat's connected agent.
 */

const appRecordingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Every route in this plugin is gated on the same flag, so the gate is
  // registered once here rather than repeated in each handler — a per-handler
  // check is one forgotten line away from an endpoint that answers on a
  // deployment where the feature is switched off.
  fastify.addHook("preHandler", async (request) => {
    // Reviewing a submitted recording is not recording a session: a reviewer
    // may open a submission independent of the hackathon recording window (it
    // is public GitHub data, only authenticated org members reach it). Every
    // OTHER route here is a recorder/render action and stays behind the gate.
    // Match by operationId (the route's stable identity), not the URL string, so
    // a later path rename can't silently drop the exemption and start gating the
    // review route behind the recorder feature flag.
    if (request.routeOptions.schema?.operationId === RouteId.ReviewAppRecording)
      return;
    await assertAppsHackathonAvailable(request.organizationId);
  });

  fastify.post(
    "/api/app-recordings/enhance",
    {
      schema: {
        operationId: RouteId.EnhanceAppRecording,
        description:
          "Draft the AI enhancement for a recorded app-building session: a one-sentence app description, one consolidated build prompt, one closing agent response, and a gallery category, all generated from the full chat. All are drafts the builder edits before applying; nulls mean generation was unavailable and the client falls back.",
        tags: ["App Recordings"],
        body: z.object({
          conversationId: UuidIdSchema,
          appName: z.string().min(1).max(200),
        }),
        response: constructResponseSchema(
          z.object({
            description: z.string().nullable(),
            prompt: z.string().nullable(),
            response: z.string().nullable(),
            category: z.string().nullable(),
          }),
        ),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      // Ownership-scoped load — the enhancement reads the caller's own chat.
      const conversation = await ConversationModel.findById({
        id: body.conversationId,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      // Generate with the agent connected to this chat session: its configured
      // LLM drives the drafts (falling back to the org default when the agent
      // has none). Ownership of the conversation was checked above, so the
      // agent lookup skips the redundant per-user access gate.
      const agentLlm = conversation.agentId
        ? await AgentModel.findLlmSelectionFieldsById(conversation.agentId)
        : null;

      const draft = await draftRecordingEnhancement({
        appName: body.appName,
        conversationId: conversation.id,
        // The model this chat is actually on — tried first so the draft follows
        // whatever provider the builder picked in chat, with the agent / org
        // default as the fallback.
        chatModel: {
          modelId: conversation.modelId ?? null,
          chatApiKeyId: conversation.chatApiKeyId ?? null,
        },
        agent:
          conversation.agentId && agentLlm
            ? { id: conversation.agentId, ...agentLlm }
            : null,
        messages: conversation.messages ?? [],
        organizationId,
        userId: user.id,
      });
      return reply.send(draft);
    },
  );

  fastify.post(
    "/api/app-recordings/render",
    {
      // A recording bundle carries the whole session (frames as data URIs), so
      // it runs well past the general API body limit; this route accepts it.
      bodyLimit: RENDER_BUNDLE_BODY_LIMIT_BYTES,
      // Refused from the headers, before megabytes are buffered and parsed:
      // an oversized bundle gets the real number and the real remedy, not the
      // parser's blunt 413 — and not the renderer's mid-job collapse.
      onRequest: async (request) => {
        const declared = Number(request.headers["content-length"]);
        if (
          Number.isFinite(declared) &&
          declared > APP_RECORDING_MAX_BUNDLE_BYTES
        ) {
          throw new ApiError(
            413,
            `This recording is ${Math.round(declared / (1024 * 1024))}MB — over the ${Math.round(APP_RECORDING_MAX_BUNDLE_BYTES / (1024 * 1024))}MB limit for video export. Re-record the session and try again.`,
          );
        }
      },
      schema: {
        operationId: RouteId.RenderAppRecordingVideo,
        description:
          "Start rendering a recorded app session to an MP4 and return the job's id. Rendering runs in the background — poll the status endpoint and collect the file when it reports done. The recording is rendered from the bundle sent with the request; nothing is read from or written to server storage.",
        tags: ["App Recordings"],
        body: z.object({
          bundle: z.unknown(),
          title: z.string().min(1).max(200),
        }),
        response: constructResponseSchema(z.object({ jobId: z.string() })),
      },
    },
    async ({ body, user, headers }, reply) => {
      // Hold the posted bundle to the same contract the player enforces before
      // driving a browser with it.
      const validation = validateRecordingBundle(body.bundle);
      if (!validation.ok) {
        throw new ApiError(
          400,
          `This recording can't be rendered. ${validation.reason}`,
        );
      }
      // The export limit is on the FINAL CUT — what the video would run for —
      // and only the replay can work that out, because cuts and the editor's
      // gap compression both move it. It is checked in the renderer, against
      // the length the replay itself reports. Measuring the raw recording here
      // instead would refuse a trimmed-to-14s session for being 35s long.
      const jobId = await renderJobClient.start({
        bundle: validation.bundle,
        userId: user.id,
        title: body.title,
        bundleBytes: Number(headers["content-length"]) || undefined,
      });
      return reply.send({ jobId });
    },
  );

  fastify.get(
    "/api/app-recordings/render/:jobId",
    {
      schema: {
        operationId: RouteId.GetAppRecordingRenderStatus,
        description:
          "How a video render is going. `done` means the file is ready to collect from the download endpoint.",
        tags: ["App Recordings"],
        params: z.object({ jobId: z.string() }),
        response: constructResponseSchema(
          z.object({
            status: z.enum(["running", "done", "failed", "cancelled"]),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ params, user }, reply) => {
      return reply.send(
        await renderJobClient.status({ jobId: params.jobId, userId: user.id }),
      );
    },
  );

  fastify.get(
    "/api/app-recordings/render/:jobId/video",
    {
      schema: {
        operationId: RouteId.DownloadAppRecordingVideo,
        description:
          "Collect a finished render. The job ends here — the file is handed over once and the server keeps no copy.",
        tags: ["App Recordings"],
        params: z.object({ jobId: z.string() }),
      },
    },
    async ({ params, user }, reply) => {
      const { video, fileName } = await renderJobClient.takeVideo({
        jobId: params.jobId,
        userId: user.id,
      });
      return (
        reply
          .header("content-type", "video/mp4")
          // Both spellings: the plain one for old clients, the RFC 6266 one so a
          // name is never at the mercy of the slug staying quote-free.
          .header(
            "content-disposition",
            `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          )
          .send(video)
      );
    },
  );

  fastify.delete(
    "/api/app-recordings/render/:jobId",
    {
      schema: {
        operationId: RouteId.CancelAppRecordingRender,
        description:
          "Stop a running render and discard it, freeing the browser it was driving.",
        tags: ["App Recordings"],
        params: z.object({ jobId: z.string() }),
        response: constructResponseSchema(
          z.object({ cancelled: z.literal(true) }),
        ),
      },
    },
    async ({ params, user }, reply) => {
      await renderJobClient.cancel({ jobId: params.jobId, userId: user.id });
      return reply.send({ cancelled: true });
    },
  );

  fastify.get(
    "/api/app-recording/review",
    {
      schema: {
        operationId: RouteId.ReviewAppRecording,
        description:
          "Fetch a hackathon submission's recording bundle from GitHub (raw.githubusercontent.com only), validate it against the recording contract, and return it for the on-platform, read-only review player. The fetch runs server-side so the frontend's CSP never has to reach GitHub; the bundle is public data and nothing is stored.",
        tags: ["App Recordings"],
        querystring: z.object({
          src: z
            .string()
            .min(1)
            .describe(
              "Absolute https://raw.githubusercontent.com/... URL of the submission's recording.json.",
            ),
        }),
        // Passed through verbatim — the bundle was just validated, and
        // re-describing the whole recording schema here would only invite drift.
        response: constructResponseSchema(z.unknown()),
      },
    },
    async ({ query }, reply) => {
      const bundle = await fetchReviewBundleFromGithub(query.src);
      return reply.send(bundle);
    },
  );
};

export default appRecordingRoutes;

// ===== Internal helpers =====

/**
 * Fetch and validate a submission's recording bundle from GitHub for the review
 * player.
 *
 * Hardened against being used as a general-purpose fetch proxy: the source must
 * be an absolute https URL on {@link REVIEW_BUNDLE_HOST}, the request times out,
 * the body is capped, and redirects are only honored while they stay on that
 * host. The parsed bundle is held to the same contract the player enforces, so a
 * malformed submission fails here with a reason rather than in the browser.
 */
async function fetchReviewBundleFromGithub(src: string): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new ApiError(400, "The recording source must be an absolute URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== REVIEW_BUNDLE_HOST) {
    throw new ApiError(
      400,
      `The recording source must be a https://${REVIEW_BUNDLE_HOST}/... URL.`,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REVIEW_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { accept: "application/json, text/plain, */*" },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(
          504,
          "Timed out fetching the submission recording from GitHub.",
        );
      }
      logger.error(
        { err: error, host: url.hostname },
        "[AppRecordingReview] fetch failed",
      );
      throw new ApiError(
        502,
        "Could not fetch the submission recording from GitHub.",
      );
    }

    // A redirect that left the allowed host would defeat the host check above.
    try {
      if (new URL(response.url).hostname !== REVIEW_BUNDLE_HOST) {
        throw new ApiError(
          400,
          `The recording source redirected off ${REVIEW_BUNDLE_HOST}.`,
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // An unparseable response URL is as untrustworthy as an off-host one.
      throw new ApiError(502, "GitHub returned an unexpected response.");
    }

    if (response.status === 404) {
      throw new ApiError(
        404,
        "The submission recording could not be found on GitHub.",
      );
    }
    if (!response.ok) {
      throw new ApiError(
        502,
        `GitHub returned ${response.status} for the submission recording.`,
      );
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > REVIEW_BUNDLE_MAX_BYTES) {
      throw new ApiError(
        413,
        `The submission recording is larger than the ${Math.round(
          REVIEW_BUNDLE_MAX_BYTES / (1024 * 1024),
        )}MB review limit.`,
      );
    }

    const text = await readCappedBody(response, controller);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(422, "The submission recording is not valid JSON.");
    }

    const validation = validateRecordingBundle(parsed);
    if (!validation.ok) {
      throw new ApiError(
        422,
        `This submission can't be reviewed. ${validation.reason}`,
      );
    }
    return validation.bundle;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read a fetch response body as text, aborting the moment it exceeds the cap —
 * so a `content-length`-less response can't stream past the limit before it is
 * noticed.
 */
async function readCappedBody(
  response: Response,
  controller: AbortController,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, "GitHub returned an empty response.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > REVIEW_BUNDLE_MAX_BYTES) {
      controller.abort();
      throw new ApiError(
        413,
        `The submission recording is larger than the ${Math.round(
          REVIEW_BUNDLE_MAX_BYTES / (1024 * 1024),
        )}MB review limit.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
