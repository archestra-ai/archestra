import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { initializeMetrics } from "@/llm-metrics";
import { AgentLabelModel, AgentModel } from "@/models";
import {
  constructResponseSchema,
  createPaginatedResponseSchema,
  createSortingQuerySchema,
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
      try {
        const { success: isAgentAdmin } = await hasPermission(
          { agent: ["admin"] },
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
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  fastify.get(
    "/api/agents/all",
    {
      schema: {
        operationId: RouteId.GetAllAgents,
        description: "Get all agents without pagination",
        tags: ["Agents"],
        response: constructResponseSchema(z.array(SelectAgentSchema)),
      },
    },
    async (request, reply) => {
      try {
        const { success: isAgentAdmin } = await hasPermission(
          { agent: ["admin"] },
          request.headers,
        );
        return reply.send(
          await AgentModel.findAll(request.user.id, isAgentAdmin),
        );
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        const agent = await AgentModel.getAgentOrCreateDefault();
        return reply.send(agent);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  fastify.post(
    "/api/agents",
    {
      schema: {
        operationId: RouteId.CreateAgent,
        description: "Create a new agent",
        tags: ["Agents"],
        body: InsertAgentSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async (request, reply) => {
      try {
        const agent = await AgentModel.create(request.body);
        const labelKeys = await AgentLabelModel.getAllKeys();
        // We need to re-init metrics with the new label keys in case label keys changed.
        // Otherwise the newly added labels will not make it to metrics. The labels with new keys, that is.
        initializeMetrics(labelKeys);

        return reply.send(agent);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
    async (request, reply) => {
      try {
        const { success: isAgentAdmin } = await hasPermission(
          { agent: ["admin"] },
          request.headers,
        );

        const agent = await AgentModel.findById(
          request.params.id,
          request.user.id,
          isAgentAdmin,
        );

        if (!agent) {
          return reply.status(404).send({
            error: {
              message: "Agent not found",
              type: "not_found",
            },
          });
        }

        return reply.send(agent);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        body: UpdateAgentSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }).partial(),
        response: constructResponseSchema(SelectAgentSchema),
      },
    },
    async ({ params: { id }, body }, reply) => {
      try {
        const agent = await AgentModel.update(id, body);

        if (!agent) {
          return reply.status(404).send({
            error: {
              message: "Agent not found",
              type: "not_found",
            },
          });
        }

        const labelKeys = await AgentLabelModel.getAllKeys();
        // We need to re-init metrics with the new label keys in case label keys changed.
        // Otherwise the newly added labels will not make it to metrics. The labels with new keys, that is.
        initializeMetrics(labelKeys);

        return reply.send(agent);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id } }, reply) => {
      try {
        const success = await AgentModel.delete(id);

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Agent not found",
              type: "not_found",
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        const keys = await AgentLabelModel.getAllKeys();
        return reply.send(keys);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        return reply.send(
          key
            ? await AgentLabelModel.getValuesByKey(key)
            : await AgentLabelModel.getAllValues(),
        );
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default agentRoutes;
