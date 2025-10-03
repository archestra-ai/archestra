import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel } from "../models";
import {
  ErrorResponseSchema,
  InsertAgentSchema,
  SelectAgentSchema,
  UuidIdSchema,
} from "../types";

const agentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agents",
    {
      schema: {
        operationId: "getAgents",
        description: "Get all agents",
        tags: ["Agents"],
        response: {
          200: z.array(SelectAgentSchema),
          500: ErrorResponseSchema,
        },
      },
    },
    async (_, reply) => {
      try {
        const agents = await AgentModel.findAll();
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

  fastify.post(
    "/api/agents",
    {
      schema: {
        operationId: "createAgent",
        description: "Create a new agent",
        tags: ["Agents"],
        body: InsertAgentSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: SelectAgentSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const agent = await AgentModel.create(request.body);
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
        operationId: "getAgent",
        description: "Get agent by ID",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: SelectAgentSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id } }, reply) => {
      try {
        const agent = await AgentModel.findById(id);

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
        operationId: "updateAgent",
        description: "Update an agent",
        tags: ["Agents"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: InsertAgentSchema.omit({
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
        operationId: "deleteAgent",
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
};

export default agentRoutes;
