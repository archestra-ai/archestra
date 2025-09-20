import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import MemoryModel, { CreateMemorySchema } from '@backend/models/memory';
import websocketService from '@backend/websocket';

// Schema for API responses
const MemoryEntrySchema = z.object({
  id: z.number(),
  name: z.string(),
  value: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const MemoryListResponseSchema = z.object({
  memories: z.array(MemoryEntrySchema),
});

const MemoryResponseSchema = z.object({
  memory: MemoryEntrySchema.nullable(),
});

const LegacyMemoryResponseSchema = z.object({
  content: z.string(),
});

const DeleteResponseSchema = z.object({
  success: z.boolean(),
  deleted: z.boolean().optional(),
  count: z.number().optional(),
});

// Register schemas in global registry for OpenAPI spec
z.globalRegistry.add(MemoryEntrySchema, { id: 'MemoryEntry' });
z.globalRegistry.add(MemoryListResponseSchema, { id: 'MemoryListResponse' });
z.globalRegistry.add(MemoryResponseSchema, { id: 'MemoryResponse' });
z.globalRegistry.add(LegacyMemoryResponseSchema, { id: 'LegacyMemoryResponse' });
z.globalRegistry.add(CreateMemorySchema, { id: 'CreateMemory' });
z.globalRegistry.add(DeleteResponseSchema, { id: 'DeleteResponse' });

const memoryRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get all memories (new endpoint)
  fastify.get(
    '/api/memories',
    {
      schema: {
        operationId: 'getAllMemories',
        description: 'Get all memory entries for the current user',
        tags: ['Memory'],
        response: {
          200: MemoryListResponseSchema,
        },
      },
    },
    async (_request, _reply) => {
      const memories = await MemoryModel.getAllMemories();
      return { memories };
    }
  );

  // Get specific memory by name (new endpoint)
  fastify.get(
    '/api/memories/:name',
    {
      schema: {
        operationId: 'getMemoryByName',
        description: 'Get a specific memory entry by name',
        tags: ['Memory'],
        params: z.object({
          name: z.string(),
        }),
        response: {
          200: MemoryResponseSchema,
        },
      },
    },
    async ({ params }, _reply) => {
      const memory = await MemoryModel.getMemory(params.name);
      return { memory };
    }
  );

  // Create or update memory (new endpoint)
  fastify.put(
    '/api/memories/:name',
    {
      schema: {
        operationId: 'setMemory',
        description: 'Create or update a memory entry',
        tags: ['Memory'],
        params: z.object({
          name: z.string(),
        }),
        body: z.object({
          value: z.string(),
        }),
        response: {
          200: MemoryEntrySchema,
          400: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async ({ params, body }, reply) => {
      // Validate that name and value are not empty
      if (!params.name || params.name.trim() === '') {
        return reply.code(400).send({
          error: 'Invalid memory name',
          message: 'Memory name cannot be empty',
        });
      }

      if (!body.value || body.value.trim() === '') {
        return reply.code(400).send({
          error: 'Invalid memory value',
          message: 'Memory value cannot be empty',
        });
      }

      const memory = await MemoryModel.setMemory(params.name.trim(), body.value.trim());

      // Emit WebSocket event for memory update
      websocketService.broadcast({
        type: 'memory-updated',
        payload: { memories: await MemoryModel.getAllMemories() },
      });

      return memory;
    }
  );

  // Delete specific memory (new endpoint)
  fastify.delete(
    '/api/memories/:name',
    {
      schema: {
        operationId: 'deleteMemory',
        description: 'Delete a specific memory entry by name',
        tags: ['Memory'],
        params: z.object({
          name: z.string(),
        }),
        response: {
          200: DeleteResponseSchema,
        },
      },
    },
    async ({ params }, _reply) => {
      const deleted = await MemoryModel.deleteMemory(params.name);

      // Emit WebSocket event for memory update
      websocketService.broadcast({
        type: 'memory-updated',
        payload: { memories: await MemoryModel.getAllMemories() },
      });

      return { success: true, deleted };
    }
  );

  // Delete all memories (new endpoint)
  fastify.delete(
    '/api/memories',
    {
      schema: {
        operationId: 'deleteAllMemories',
        description: 'Delete all memory entries for the current user',
        tags: ['Memory'],
        response: {
          200: DeleteResponseSchema,
        },
      },
    },
    async (_request, _reply) => {
      const count = await MemoryModel.deleteAllMemories();

      // Emit WebSocket event for memory update
      websocketService.broadcast({
        type: 'memory-updated',
        payload: { memories: [] },
      });

      return { success: true, count };
    }
  );
};

export default memoryRoutes;
