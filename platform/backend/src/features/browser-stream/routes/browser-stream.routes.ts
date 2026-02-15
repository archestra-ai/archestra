import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { browserStreamFeature } from "@/features/browser-stream/services/browser-stream.feature";
import type { BrowserUserContext } from "@/features/browser-stream/services/browser-stream.service";
import { ConversationModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";

const ConversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

const NavigateBodySchema = z.object({
  url: z.string().url(),
});

const browserStreamRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // When feature is disabled, register stub routes that return 404
  if (!browserStreamFeature.isEnabled()) {
    const disabledHandler = async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.status(404).send({
        error: { message: "Browser streaming feature is disabled" },
      });

    fastify.get(
      "/api/browser-stream/:conversationId/available",
      disabledHandler,
    );
    fastify.post(
      "/api/browser-stream/:conversationId/navigate",
      disabledHandler,
    );
    fastify.get(
      "/api/browser-stream/:conversationId/screenshot",
      disabledHandler,
    );
    fastify.post(
      "/api/browser-stream/:conversationId/activate",
      disabledHandler,
    );
    fastify.delete("/api/browser-stream/:conversationId/tab", disabledHandler);
    return;
  }

  /**
   * Helper to get agentId from conversationId
   */
  async function getAgentIdFromConversation(
    conversationId: string,
    userId: string,
    organizationId: string,
  ): Promise<string | null> {
    return ConversationModel.getAgentIdForUser(
      conversationId,
      userId,
      organizationId,
    );
  }

  /**
   * Helper to get user context for MCP client authentication
   */
  async function getUserContext(
    request: FastifyRequest,
  ): Promise<BrowserUserContext> {
    const { success: userIsProfileAdmin } = await hasPermission(
      { profile: ["admin"] },
      request.headers,
    );
    return {
      userId: request.user.id,
      organizationId: request.organizationId,
      userIsProfileAdmin,
    };
  }

  // Check if Playwright MCP is available for a conversation's agent
  fastify.get(
    "/api/browser-stream/:conversationId/available",
    {
      schema: {
        params: ConversationParamsSchema,
        response: constructResponseSchema(
          z.object({
            available: z.boolean(),
            tools: z.array(z.string()).optional(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);

      const agentId = await getAgentIdFromConversation(
        conversationId,
        request.user.id,
        request.organizationId,
      );
      if (!agentId) {
        throw new ApiError(404, "Conversation not found");
      }

      const result = await browserStreamFeature.checkAvailability(agentId);
      return reply.send(result);
    },
  );

  // Navigate to URL in conversation's browser tab
  fastify.post(
    "/api/browser-stream/:conversationId/navigate",
    {
      schema: {
        params: ConversationParamsSchema,
        body: NavigateBodySchema,
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            url: z.string().optional(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);
      const { url } = NavigateBodySchema.parse(request.body);

      const agentId = await getAgentIdFromConversation(
        conversationId,
        request.user.id,
        request.organizationId,
      );
      if (!agentId) {
        throw new ApiError(404, "Conversation not found");
      }

      const userContext = await getUserContext(request);
      const result = await browserStreamFeature.navigate(
        agentId,
        conversationId,
        url,
        userContext,
      );
      return reply.send(result);
    },
  );

  // Take screenshot of conversation's browser tab
  fastify.get(
    "/api/browser-stream/:conversationId/screenshot",
    {
      schema: {
        params: ConversationParamsSchema,
        response: constructResponseSchema(
          z.object({
            screenshot: z.string().optional(),
            url: z.string().optional(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);

      const agentId = await getAgentIdFromConversation(
        conversationId,
        request.user.id,
        request.organizationId,
      );
      if (!agentId) {
        throw new ApiError(404, "Conversation not found");
      }

      const userContext = await getUserContext(request);
      const result = await browserStreamFeature.takeScreenshot(
        agentId,
        conversationId,
        userContext,
      );
      return reply.send(result);
    },
  );

  // Activate/select tab for a conversation
  fastify.post(
    "/api/browser-stream/:conversationId/activate",
    {
      schema: {
        params: ConversationParamsSchema,
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            tabIndex: z.number().optional(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);

      const agentId = await getAgentIdFromConversation(
        conversationId,
        request.user.id,
        request.organizationId,
      );
      if (!agentId) {
        throw new ApiError(404, "Conversation not found");
      }

      const userContext = await getUserContext(request);
      const result = await browserStreamFeature.activateTab(
        agentId,
        conversationId,
        userContext,
      );
      return reply.send(result);
    },
  );

  // Close tab for a conversation
  fastify.delete(
    "/api/browser-stream/:conversationId/tab",
    {
      schema: {
        params: ConversationParamsSchema,
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);

      const agentId = await getAgentIdFromConversation(
        conversationId,
        request.user.id,
        request.organizationId,
      );
      if (!agentId) {
        // No conversation means no tab to close - this is idempotent
        return reply.send({ success: true });
      }

      const userContext = await getUserContext(request);
      const result = await browserStreamFeature.closeTab(
        agentId,
        conversationId,
        userContext,
      );
      return reply.send(result);
    },
  );
};

export default browserStreamRoutes;
