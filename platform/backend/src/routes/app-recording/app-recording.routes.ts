import { RouteId, validateRecordingBundle } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { AgentModel, ConversationModel } from "@/models";
import { draftRecordingEnhancement } from "@/services/apps/app-recording-enhancement";
import {
  cancelRenderJob,
  renderJobStatus,
  startRenderJob,
  takeRenderedVideo,
} from "@/services/apps/app-recording-render-jobs";
import { ApiError, constructResponseSchema, UuidIdSchema } from "@/types";

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
  fastify.addHook("preHandler", async () => {
    assertSessionRecordingEnabled();
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
    async ({ body, user }, reply) => {
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
      const jobId = startRenderJob({
        bundle: validation.bundle,
        userId: user.id,
        title: body.title,
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
        renderJobStatus({ jobId: params.jobId, userId: user.id }),
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
      const { video, fileName } = takeRenderedVideo({
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
      cancelRenderJob({ jobId: params.jobId, userId: user.id });
      return reply.send({ cancelled: true });
    },
  );
};

export default appRecordingRoutes;

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * 403 unless app session recording is enabled on this deployment.
 *
 * Not 400: the request is well formed and there is nothing the caller can
 * change about it — the feature is switched off for everyone here.
 */
function assertSessionRecordingEnabled(): void {
  if (!config.hackathonRecorder.enabled) {
    throw new ApiError(
      403,
      "The hackathon recorder is disabled on this deployment (ARCHESTRA_HACKATHON_RECORDER).",
    );
  }
}
