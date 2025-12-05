import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { ConversationModel } from "@/models";
import { BrowserStreamService } from "@/services/browser-stream";
import { constructResponseSchema } from "@/types";

const ConversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

const NavigateBodySchema = z.object({
  url: z.string().url(),
});

const browserStreamRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const browserStreamService = new BrowserStreamService();

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
            error: z.string().optional(),
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
        return reply.send({
          available: false,
          error: "Conversation not found",
        });
      }

      try {
        const result = await browserStreamService.checkAvailability(agentId);
        return reply.send(result);
      } catch (error) {
        logger.error(
          { error, conversationId },
          "Failed to check browser availability",
        );
        return reply.send({
          available: false,
          error:
            error instanceof Error
              ? error.message
              : "Availability check failed",
        });
      }
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
            error: z.string().optional(),
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
        return reply.send({
          success: false,
          error: "Conversation not found",
        });
      }

      try {
        const result = await browserStreamService.navigate(
          agentId,
          conversationId,
          url,
        );
        return reply.send(result);
      } catch (error) {
        logger.error(
          { error, conversationId, url },
          "Failed to navigate browser",
        );
        return reply.send({
          success: false,
          error: error instanceof Error ? error.message : "Navigation failed",
        });
      }
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
            error: z.string().optional(),
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
        return reply.send({
          error: "Conversation not found",
        });
      }

      try {
        const result = await browserStreamService.takeScreenshot(
          agentId,
          conversationId,
        );
        return reply.send(result);
      } catch (error) {
        logger.error({ error, conversationId }, "Failed to take screenshot");
        return reply.send({
          error: error instanceof Error ? error.message : "Screenshot failed",
        });
      }
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
            error: z.string().optional(),
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
        return reply.send({
          success: false,
          error: "Conversation not found",
        });
      }

      try {
        const result = await browserStreamService.activateTab(
          agentId,
          conversationId,
        );
        return reply.send(result);
      } catch (error) {
        logger.error(
          { error, conversationId },
          "Failed to activate browser tab",
        );
        return reply.send({
          success: false,
          error:
            error instanceof Error ? error.message : "Tab activation failed",
        });
      }
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
            error: z.string().optional(),
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
        // No conversation means no tab to close
        return reply.send({ success: true });
      }

      try {
        const result = await browserStreamService.closeTab(
          agentId,
          conversationId,
        );
        return reply.send(result);
      } catch (error) {
        logger.error({ error, conversationId }, "Failed to close browser tab");
        return reply.send({
          success: false,
          error: error instanceof Error ? error.message : "Tab close failed",
        });
      }
    },
  );
};

export default browserStreamRoutes;
