import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { MemoryItemModel } from "@/models";
import {
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertMemoryItemSchema,
  SelectMemoryItemSchema,
  UpdateMemoryItemSchema,
} from "@/types";

const memoryItemRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/memory-items",
    {
      schema: {
        operationId: RouteId.GetMemoryItems,
        description: "List saved memory items for the current user",
        tags: ["Memory"],
        querystring: z.object({
          namespace: z.string().optional(),
        }),
        response: constructResponseSchema(
          z.array(SelectMemoryItemSchema),
        ),
      },
    },
    async ({ query: { namespace }, organizationId, user }, reply) => {
      const items = await MemoryItemModel.findByUser({
        organizationId,
        userId: user.id,
        namespace,
      });
      return reply.send(items);
    },
  );

  fastify.post(
    "/api/memory-items",
    {
      schema: {
        operationId: RouteId.CreateMemoryItem,
        description: "Create a new memory item",
        tags: ["Memory"],
        body: InsertMemoryItemSchema.omit({
          organizationId: true,
          userId: true,
        }),
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const item = await MemoryItemModel.create({
        ...body,
        organizationId,
        userId: user.id,
      });
      return reply.send(item);
    },
  );

  fastify.put(
    "/api/memory-items/:id",
    {
      schema: {
        operationId: RouteId.UpdateMemoryItem,
        description: "Update a memory item",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        body: UpdateMemoryItemSchema,
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      const existing = await MemoryItemModel.findById(id);
      if (
        !existing ||
        existing.organizationId !== organizationId ||
        existing.userId !== user.id
      ) {
        return reply.status(404).send({ error: "Memory not found" });
      }

      const updated = await MemoryItemModel.update(id, body);
      if (!updated) {
        return reply.status(404).send({ error: "Memory not found" });
      }
      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/memory-items/:id",
    {
      schema: {
        operationId: RouteId.DeleteMemoryItem,
        description: "Delete a memory item",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const existing = await MemoryItemModel.findById(id);
      if (
        !existing ||
        existing.organizationId !== organizationId ||
        existing.userId !== user.id
      ) {
        return reply.status(404).send({ error: "Memory not found" });
      }

      const deleted = await MemoryItemModel.delete(id);
      if (!deleted) {
        return reply.status(404).send({ error: "Memory not found" });
      }
      return reply.send({ success: true });
    },
  );
};

export default memoryItemRoutes;
