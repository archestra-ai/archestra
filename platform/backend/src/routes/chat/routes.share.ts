import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ConversationModel,
  ConversationShareModel,
  MessageModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  SelectConversationSchema,
  SelectConversationShareSchema,
  UuidIdSchema,
} from "@/types";

const shareRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get share status for a conversation
  fastify.get(
    "/api/chat/conversations/:id/share",
    {
      schema: {
        operationId: RouteId.GetConversationShare,
        description: "Get share status for a conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(
          SelectConversationShareSchema.nullable(),
        ),
      },
    },
    async (request) => {
      const { id } = request.params;
      const { user, organizationId } = request;

      // Verify ownership
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      const share = await ConversationShareModel.findByConversationId({
        conversationId: id,
        organizationId,
      });

      return share;
    },
  );

  // Share a conversation
  fastify.post(
    "/api/chat/conversations/:id/share",
    {
      schema: {
        operationId: RouteId.ShareConversation,
        description: "Share a conversation with your organization",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: z.object({
          visibility: z.enum(["organization"]),
        }),
        response: constructResponseSchema(SelectConversationShareSchema),
      },
    },
    async (request) => {
      const { id } = request.params;
      const { visibility } = request.body;
      const { user, organizationId } = request;

      // Verify ownership
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      // Check if already shared
      const existing = await ConversationShareModel.findByConversationId({
        conversationId: id,
        organizationId,
      });
      if (existing) {
        return existing;
      }

      const share = await ConversationShareModel.create({
        conversationId: id,
        organizationId,
        createdByUserId: user.id,
        visibility,
      });

      return share;
    },
  );

  // Unshare a conversation
  fastify.delete(
    "/api/chat/conversations/:id/share",
    {
      schema: {
        operationId: RouteId.UnshareConversation,
        description: "Revoke sharing of a conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request) => {
      const { id } = request.params;
      const { user, organizationId } = request;

      const deleted = await ConversationShareModel.delete({
        conversationId: id,
        organizationId,
        userId: user.id,
      });

      if (!deleted) {
        throw new ApiError(404, "Share not found");
      }

      return { success: true };
    },
  );

  // Get a shared conversation (org-level access)
  fastify.get(
    "/api/chat/shared/:shareId",
    {
      schema: {
        operationId: RouteId.GetSharedConversation,
        description: "Get a shared conversation by share ID",
        tags: ["Chat"],
        params: z.object({ shareId: UuidIdSchema }),
        response: constructResponseSchema(
          SelectConversationSchema.extend({
            sharedByUserId: z.string(),
          }),
        ),
      },
    },
    async (request) => {
      const { shareId } = request.params;
      const { organizationId } = request;

      const conversation = await ConversationShareModel.getSharedConversation({
        shareId,
        organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Shared conversation not found");
      }

      return conversation;
    },
  );

  // Fork a shared conversation into a new one
  fastify.post(
    "/api/chat/shared/:shareId/fork",
    {
      schema: {
        operationId: RouteId.ForkSharedConversation,
        description:
          "Create a new conversation from a shared conversation's messages",
        tags: ["Chat"],
        params: z.object({ shareId: UuidIdSchema }),
        body: z.object({
          agentId: z.string().uuid(),
        }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async (request) => {
      const { shareId } = request.params;
      const { agentId } = request.body;
      const { user, organizationId } = request;

      // Verify the share exists and is accessible
      const sharedConversation =
        await ConversationShareModel.getSharedConversation({
          shareId,
          organizationId,
        });

      if (!sharedConversation) {
        throw new ApiError(404, "Shared conversation not found");
      }

      // Create a new conversation for the current user
      const newConversation = await ConversationModel.create({
        userId: user.id,
        organizationId,
        agentId,
        selectedModel: sharedConversation.selectedModel,
      });

      // Copy messages from shared conversation
      if (sharedConversation.messages.length > 0) {
        const messagesToCopy = sharedConversation.messages.map(
          (msg: { role: string; content: unknown }) => ({
            conversationId: newConversation.id,
            role: msg.role,
            content: msg,
          }),
        );
        await MessageModel.bulkCreate(messagesToCopy);
      }

      // Refetch to get the conversation with messages
      const result = await ConversationModel.findById({
        id: newConversation.id,
        userId: user.id,
        organizationId,
      });

      if (!result) {
        throw new ApiError(500, "Failed to create forked conversation");
      }

      return result;
    },
  );
};

export default shareRoutes;
