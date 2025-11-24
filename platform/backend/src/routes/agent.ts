import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { initializeMetrics } from "@/llm-metrics";
import { AgentLabelModel, AgentModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createPaginatedResponseSchema,
  createSortingQuerySchema,
  DeleteObjectResponseSchema,
  InsertAgentSchema,
  PaginationQuerySchema,
  SelectAgentSchema,
  UpdateAgentSchema,
  UuidIdSchema,
} from "@/types";

const agentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agents",
    {
      schema: {
        operationId: RouteId.GetAgents,
        description: "Get all agents with pagination, sorting, and filtering",
        tags: ["Agents"],
        querystring: z
          .object({
            name: z.string().optional().describe("Filter by agent name"),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema([
              "name",
              "createdAt",
              "toolsCount",
              "team",
            ] as const),
          ),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectAgentSchema),
        ),
      },
    },
    async (
      { query: { name, limit, offset, sortBy, sortDirection }, user, headers },
      reply,
    ) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );
      return reply.send(
        await AgentModel.findAllPaginated(
          { limit, offset },
          { sortBy, sortDirection },
          { name },
          user.id,
          isAgentAdmin,
        ),
      );
    },
  );

  fastify.get(
    "/api/agents/all",
    {
      schema: {
        operationId: RouteId.GetAllAgents,
        description: "Get all agents without pagination",
        tags: ["Agents"],
        querystring: z.object({
          useInChat: z.coerce.boolean().optional(),
        }),
        response: constructResponseSchema(z.array(SelectAgentSchema)),
      },
    },
    async ({ headers, user, query: filterParams }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );
      return reply.send(
        await AgentModel.findAll(user.id, isAgentAdmin, filterParams),
      );
    },
  );

  fastify.get(
    "/api/agents/default",
    {
      schema: {
        operationId: RouteId.GetDefaultAgent,
        description: "Get or create default agent",
        tags: ["Agents"],
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async (_request, reply) => {
      return reply.send(await AgentModel.getAgentOrCreateDefault());
    },
  );

  fastify.post(
    "/api/agents",
    {
      schema: {
        operationId: RouteId.CreateAgent,
        description: "Create a new agent",
        tags: ["Agents"],
        body: InsertAgentSchema,
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ body }, reply) => {
      const agent = await AgentModel.create(body);
      const labelKeys = await AgentLabelModel.getAllKeys();

      // We need to re-init metrics with the new label keys in case label keys changed.
      // Otherwise the newly added labels will not make it to metrics. The labels with new keys, that is.
      initializeMetrics(labelKeys);

      return reply.send(agent);
    },
  );

  fastify.get(
    "/api/agents/:id",
    {
      schema: {
        operationId: RouteId.GetAgent,
        description: "Get agent by ID",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id }, headers, user }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const agent = await AgentModel.findById(id, user.id, isAgentAdmin);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      return reply.send(agent);
    },
  );

  fastify.put(
    "/api/agents/:id",
    {
      schema: {
        operationId: RouteId.UpdateAgent,
        description: "Update an agent",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateAgentSchema.partial(),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id }, body }, reply) => {
      const agent = await AgentModel.update(id, body);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      const labelKeys = await AgentLabelModel.getAllKeys();
      // We need to re-init metrics with the new label keys in case label keys changed.
      // Otherwise the newly added labels will not make it to metrics. The labels with new keys, that is.
      initializeMetrics(labelKeys);

      return reply.send(agent);
    },
  );

  fastify.delete(
    "/api/agents/:id",
    {
      schema: {
        operationId: RouteId.DeleteAgent,
        description: "Delete an agent",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      const success = await AgentModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Agent not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/agents/labels/keys",
    {
      schema: {
        operationId: RouteId.GetLabelKeys,
        description: "Get all available label keys",
        tags: ["Agents"],
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async (_request, reply) => {
      return reply.send(await AgentLabelModel.getAllKeys());
    },
  );

  fastify.get(
    "/api/agents/labels/values",
    {
      schema: {
        operationId: RouteId.GetLabelValues,
        description: "Get all available label values",
        tags: ["Agents"],
        querystring: z.object({
          key: z.string().optional().describe("Filter values by label key"),
        }),
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ query: { key } }, reply) => {
      return reply.send(
        key
          ? await AgentLabelModel.getValuesByKey(key)
          : await AgentLabelModel.getAllValues(),
      );
    },
  );
};

export default agentRoutes;
