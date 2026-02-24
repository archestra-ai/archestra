import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { ChatApiKeyModel, VirtualApiKeyModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  SelectVirtualApiKeySchema,
  VirtualApiKeyWithParentInfoSchema,
  VirtualApiKeyWithValueSchema,
} from "@/types";

const virtualApiKeysRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // List all virtual keys for the organization (paginated)
  fastify.get(
    "/api/virtual-api-keys",
    {
      schema: {
        operationId: RouteId.GetAllVirtualApiKeys,
        description:
          "Get all virtual API keys for the organization, with parent API key info",
        tags: ["Virtual API Keys"],
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(VirtualApiKeyWithParentInfoSchema),
        ),
      },
    },
    async ({ query: { limit, offset }, organizationId }, reply) => {
      const result = await VirtualApiKeyModel.findAllByOrganization({
        organizationId,
        pagination: { limit, offset },
      });
      return reply.send(result);
    },
  );

  // List virtual keys for a chat API key
  fastify.get(
    "/api/chat-api-keys/:chatApiKeyId/virtual-keys",
    {
      schema: {
        operationId: RouteId.GetVirtualApiKeys,
        description: "Get all virtual API keys for a chat API key",
        tags: ["Virtual API Keys"],
        params: z.object({
          chatApiKeyId: z.string().uuid(),
        }),
        response: constructResponseSchema(z.array(SelectVirtualApiKeySchema)),
      },
    },
    async ({ params, organizationId }, reply) => {
      const chatApiKey = await ChatApiKeyModel.findById(params.chatApiKeyId);
      if (!chatApiKey || chatApiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      const virtualKeys = await VirtualApiKeyModel.findByChatApiKeyId(
        params.chatApiKeyId,
      );
      return reply.send(virtualKeys);
    },
  );

  // Create a virtual key
  fastify.post(
    "/api/chat-api-keys/:chatApiKeyId/virtual-keys",
    {
      schema: {
        operationId: RouteId.CreateVirtualApiKey,
        description:
          "Create a new virtual API key. Returns the full token value once.",
        tags: ["Virtual API Keys"],
        params: z.object({
          chatApiKeyId: z.string().uuid(),
        }),
        body: z.object({
          name: z.string().min(1, "Name is required").max(256),
          expiresAt: z.coerce.date().nullable().optional(),
        }),
        response: constructResponseSchema(VirtualApiKeyWithValueSchema),
      },
    },
    async ({ params, body, organizationId }, reply) => {
      const chatApiKey = await ChatApiKeyModel.findById(params.chatApiKeyId);
      if (!chatApiKey || chatApiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      // Validate expiration is in the future
      if (body.expiresAt && body.expiresAt <= new Date()) {
        throw new ApiError(400, "Expiration date must be in the future");
      }

      // Enforce max limit
      const count = await VirtualApiKeyModel.countByChatApiKeyId(
        params.chatApiKeyId,
      );
      const maxVirtualKeys = config.llmProxy.maxVirtualKeysPerApiKey;
      if (count >= maxVirtualKeys) {
        throw new ApiError(
          400,
          `Maximum of ${maxVirtualKeys} virtual keys per API key reached`,
        );
      }

      const { virtualKey, value } = await VirtualApiKeyModel.create({
        chatApiKeyId: params.chatApiKeyId,
        name: body.name,
        expiresAt: body.expiresAt ?? null,
      });

      return reply.send({ ...virtualKey, value });
    },
  );

  // Delete a virtual key
  fastify.delete(
    "/api/chat-api-keys/:chatApiKeyId/virtual-keys/:id",
    {
      schema: {
        operationId: RouteId.DeleteVirtualApiKey,
        description: "Delete a virtual API key",
        tags: ["Virtual API Keys"],
        params: z.object({
          chatApiKeyId: z.string().uuid(),
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId }, reply) => {
      const chatApiKey = await ChatApiKeyModel.findById(params.chatApiKeyId);
      if (!chatApiKey || chatApiKey.organizationId !== organizationId) {
        throw new ApiError(404, "Chat API key not found");
      }

      // Verify the virtual key belongs to this chat API key
      const virtualKey = await VirtualApiKeyModel.findById(params.id);
      if (!virtualKey || virtualKey.chatApiKeyId !== params.chatApiKeyId) {
        throw new ApiError(404, "Virtual API key not found");
      }

      await VirtualApiKeyModel.delete(params.id);
      return reply.send({ success: true });
    },
  );
};

export default virtualApiKeysRoutes;
