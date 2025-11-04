import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { initializeMetrics } from "@/llm-metrics";
import { AgentModel } from "@/models";
import AgentLabelModel from "@/models/agent-label";
import {
  createPaginatedResponseSchema,
  createSortingQuerySchema,
  ErrorResponseSchema,
  InsertAgentSchema,
  PaginationQuerySchema,
  RouteId,
  SelectAgentSchema,
  UpdateAgentSchema,
  UuidIdSchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

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
        response: {
          200: createPaginatedResponseSchema(SelectAgentSchema),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const { name, limit, offset, sortBy, sortDirection } = request.query;
        const pagination = { limit, offset };
        const sorting = { sortBy, sortDirection };
        const filters = { name };

        const result = await AgentModel.findAllPaginated(
          pagination,
          sorting,
          filters,
          user.id,
          user.isAdmin,
        );
        return reply.send(result);
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
        response: {
          200: z.array(SelectAgentSchema),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const agents = await AgentModel.findAll(user.id, user.isAdmin);
        return reply.send(agents);
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
        response: {
          200: SelectAgentSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

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
        response: {
          200: SelectAgentSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }
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
        response: {
          200: SelectAgentSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const agent = await AgentModel.findById(
          request.params.id,
          user.id,
          user.isAdmin,
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
        response: {
          200: SelectAgentSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
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
        response: {
          200: z.object({ success: z.boolean() }),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
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
        response: {
          200: z.array(z.string()),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

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
        response: {
          200: z.array(z.string()),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const { key } = request.query;
        const values = key
          ? await AgentLabelModel.getValuesByKey(key)
          : await AgentLabelModel.getAllValues();
        return reply.send(values);
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
