import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { devFeedbackService } from "@/services/dev-feedback";
import { ApiError, constructResponseSchema } from "@/types";
import {
  CreateDevFeedbackCommentBodySchema,
  DevFeedbackBotSchema,
  DevFeedbackChannelSchema,
  DevFeedbackCommentSchema,
  DevFeedbackReplySchema,
  DevFeedbackSetupStatusSchema,
  SaveDevFeedbackSetupBodySchema,
} from "@/types/dev-feedback";

const devFeedbackRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Every handler 404s unless the deployment turns the overlay on, so the
  // routes are inert in the shipped product. onRequest, so a disabled
  // deployment never parses an upload body.
  fastify.addHook("onRequest", async () => {
    if (!devFeedbackService.isAvailable) {
      throw new ApiError(404, "Dev feedback is not enabled");
    }
  });

  fastify.get(
    "/api/dev-feedback/setup",
    {
      schema: {
        operationId: RouteId.GetDevFeedbackSetup,
        description: "Whether a Slack bot and channel are picked for feedback",
        tags: ["Dev Feedback"],
        response: constructResponseSchema(DevFeedbackSetupStatusSchema),
      },
    },
    async ({ user, organizationId }, reply) =>
      reply.send(
        await devFeedbackService.getSetupStatus({
          userId: user.id,
          organizationId,
        }),
      ),
  );

  fastify.get(
    "/api/dev-feedback/setup/bots",
    {
      schema: {
        operationId: RouteId.ListDevFeedbackBots,
        description: "List the chatops Slack bots feedback can post as",
        tags: ["Dev Feedback"],
        response: constructResponseSchema(z.array(DevFeedbackBotSchema)),
      },
    },
    async (_request, reply) => reply.send(await devFeedbackService.listBots()),
  );

  fastify.get(
    "/api/dev-feedback/setup/bots/:botId/channels",
    {
      schema: {
        operationId: RouteId.ListDevFeedbackChannels,
        description: "List the Slack channels a bot can post feedback to",
        tags: ["Dev Feedback"],
        params: z.object({ botId: z.string().min(1).max(64) }),
        response: constructResponseSchema(z.array(DevFeedbackChannelSchema)),
      },
    },
    async ({ params }, reply) =>
      reply.send(await devFeedbackService.listChannels(params.botId)),
  );

  fastify.put(
    "/api/dev-feedback/setup",
    {
      schema: {
        operationId: RouteId.SaveDevFeedbackSetup,
        description:
          "Pick the Slack bot and channel feedback posts to (joins a public channel)",
        tags: ["Dev Feedback"],
        body: SaveDevFeedbackSetupBodySchema,
        response: constructResponseSchema(DevFeedbackSetupStatusSchema),
      },
    },
    async ({ body, user, organizationId }, reply) =>
      reply.send(
        await devFeedbackService.saveSetup({
          ...body,
          actor: { userId: user.id, organizationId },
        }),
      ),
  );

  fastify.get(
    "/api/dev-feedback/comments",
    {
      schema: {
        operationId: RouteId.GetDevFeedbackComments,
        description: "List open UI feedback comments pinned on a route",
        tags: ["Dev Feedback"],
        querystring: z.object({ route: z.string().min(1) }),
        response: constructResponseSchema(z.array(DevFeedbackCommentSchema)),
      },
    },
    async ({ query }, reply) =>
      reply.send(await devFeedbackService.listComments(query.route)),
  );

  fastify.post(
    "/api/dev-feedback/comments",
    {
      // A screenshot plus a ~25s screen clip, base64-encoded.
      bodyLimit: 40 * 1024 * 1024,
      schema: {
        operationId: RouteId.CreateDevFeedbackComment,
        description:
          "Post a UI feedback comment, with a screenshot and optional clip, to the feedback Slack channel",
        tags: ["Dev Feedback"],
        body: CreateDevFeedbackCommentBodySchema,
        response: constructResponseSchema(DevFeedbackCommentSchema),
      },
    },
    async ({ body, user, organizationId }, reply) =>
      reply.send(
        await devFeedbackService.createComment({
          body,
          authorName: user.name || user.email,
          actor: { userId: user.id, organizationId },
        }),
      ),
  );

  fastify.get(
    "/api/dev-feedback/comments/:commentId/replies",
    {
      schema: {
        operationId: RouteId.GetDevFeedbackReplies,
        description: "List the Slack thread replies of a UI feedback comment",
        tags: ["Dev Feedback"],
        params: CommentParamsSchema,
        response: constructResponseSchema(z.array(DevFeedbackReplySchema)),
      },
    },
    async ({ params }, reply) =>
      reply.send(await devFeedbackService.listReplies(params.commentId)),
  );

  fastify.post(
    "/api/dev-feedback/comments/:commentId/replies",
    {
      schema: {
        operationId: RouteId.CreateDevFeedbackReply,
        description: "Reply in the Slack thread of a UI feedback comment",
        tags: ["Dev Feedback"],
        params: CommentParamsSchema,
        body: z.object({ text: z.string().trim().min(1).max(4000) }),
        response: constructResponseSchema(DevFeedbackReplySchema),
      },
    },
    async ({ params, body, user }, reply) =>
      reply.send(
        await devFeedbackService.createReply({
          commentId: params.commentId,
          text: body.text,
          authorName: user.name || user.email,
        }),
      ),
  );

  fastify.post(
    "/api/dev-feedback/comments/:commentId/resolve",
    {
      schema: {
        operationId: RouteId.ResolveDevFeedbackComment,
        description:
          "Resolve a UI feedback comment (marks its Slack message resolved)",
        tags: ["Dev Feedback"],
        params: CommentParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, user }, reply) => {
      await devFeedbackService.resolveComment({
        commentId: params.commentId,
        resolvedBy: user.name || user.email,
      });
      return reply.send({ success: true });
    },
  );
};

export default devFeedbackRoutes;

// ===

/** Slack message ts, e.g. `1729426800.123456`. */
const CommentParamsSchema = z.object({
  commentId: z.string().regex(/^\d+\.\d+$/),
});
