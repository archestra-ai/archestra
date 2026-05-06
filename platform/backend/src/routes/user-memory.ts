import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { UserMemoryModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ErrorResponsesSchema,
  SelectUserMemorySchema,
  UpdateUserMemorySchema,
  UuidIdSchema,
  UserMemoryInputSchema,
} from "@/types";
import { z } from "zod";

const userMemoryRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/user-memories",
    {
      schema: {
        operationId: RouteId.GetUserMemories,
        description: "Get all memory entries for the current user",
        tags: ["User Memory"],
        response: constructResponseSchema(
          z.array(SelectUserMemorySchema),
        ),
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;
      const memories = await UserMemoryModel.findAllForUser(
        user.id,
        organizationId,
      );
      return reply.send(memories);
    },
  );

  fastify.post(
    "/api/user-memories",
    {
      schema: {
        operationId: RouteId.CreateUserMemory,
        description: "Create a new memory entry for the current user",
        tags: ["User Memory"],
        body: UserMemoryInputSchema,
        response: constructResponseSchema(SelectUserMemorySchema),
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;
      const { title, content } = request.body;

      const memory = await UserMemoryModel.create({
        userId: user.id,
        organizationId,
        title,
        content,
      });

      return reply.status(201).send(memory);
    },
  );

  fastify.patch(
    "/api/user-memories/:id",
    {
      schema: {
        operationId: RouteId.UpdateUserMemory,
        description: "Update a memory entry",
        tags: ["User Memory"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateUserMemorySchema,
        response: constructResponseSchema(SelectUserMemorySchema),
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      const data = request.body;

      const memory = await UserMemoryModel.update(id, user.id, data);
      if (!memory) {
        throw new ApiError(404, "Memory entry not found");
      }

      return reply.send(memory);
    },
  );

  fastify.delete(
    "/api/user-memories/:id",
    {
      schema: {
        operationId: RouteId.DeleteUserMemory,
        description: "Delete a memory entry",
        tags: ["User Memory"],
        params: z.object({ id: UuidIdSchema }),
        response: {
          ...ErrorResponsesSchema,
          200: DeleteObjectResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const deleted = await UserMemoryModel.delete(id, user.id);
      if (!deleted) {
        throw new ApiError(404, "Memory entry not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default userMemoryRoutes;
