import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatOpsExternalIdMappingModel, MemberModel } from "@/models";
import {
  ApiError,
  BundledChatOpsAdapterIdSchema,
  constructResponseSchema,
} from "@/types";
import { SelectChatOpsExternalIdMappingSchema } from "@/types/chatops-external-id-mapping";

const ListResponseSchema = z.object({
  data: z.array(SelectChatOpsExternalIdMappingSchema),
});

const CreateBodySchema = z.object({
  userId: z.string().min(1),
  adapterId: BundledChatOpsAdapterIdSchema,
  externalId: z.string().min(1).max(256),
});

const DeleteParamsSchema = z.object({
  id: z.string().uuid(),
});

const chatopsExternalIdMappingsRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  fastify.get(
    "/api/chatops/external-id-mappings",
    {
      schema: {
        operationId: RouteId.ListChatOpsExternalIdMappings,
        description: "List external ID mappings",
        tags: ["ChatOps"],
        querystring: z.object({
          userId: z.string().optional(),
        }),
        response: constructResponseSchema(ListResponseSchema),
      },
    },
    async (request, reply) => {
      const { userId } = request.query;

      if (userId) {
        const data = await ChatOpsExternalIdMappingModel.findByUserId(userId);
        return reply.send({ data });
      }

      throw new ApiError(400, "userId query parameter is required");
    },
  );

  fastify.post(
    "/api/chatops/external-id-mappings",
    {
      schema: {
        operationId: RouteId.CreateChatOpsExternalIdMapping,
        description: "Create or update an external ID mapping",
        tags: ["ChatOps"],
        body: CreateBodySchema,
        response: constructResponseSchema(SelectChatOpsExternalIdMappingSchema),
      },
    },
    async (request, reply) => {
      const { userId, adapterId, externalId } = request.body;

      const member = await MemberModel.getByUserId(
        userId,
        request.organizationId,
      );
      if (!member) {
        throw new ApiError(404, "User is not a member of this organization");
      }

      const mapping = await ChatOpsExternalIdMappingModel.upsert({
        adapterId,
        externalId,
        userId,
      });

      return reply.send(mapping);
    },
  );

  fastify.delete(
    "/api/chatops/external-id-mappings/:id",
    {
      schema: {
        operationId: RouteId.DeleteChatOpsExternalIdMapping,
        description: "Delete an external ID mapping",
        tags: ["ChatOps"],
        params: DeleteParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const deleted = await ChatOpsExternalIdMappingModel.deleteById(id);

      if (!deleted) {
        throw new ApiError(404, "Mapping not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default chatopsExternalIdMappingsRoutes;
