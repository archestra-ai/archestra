import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, AgentToolModel, ToolModel } from "@/models";
import {
  ErrorResponseSchema,
  RouteId,
  SelectAgentToolSchema,
  SelectToolSchema,
  UpdateAgentToolSchema,
  UuidIdSchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

const agentToolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agent-tools",
    {
      schema: {
        operationId: RouteId.GetAllAgentTools,
        description: "Get all agent-tool relationships with details",
        tags: ["Agent Tools"],
        response: {
          200: z.array(SelectAgentToolSchema),
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

        const agentTools = await AgentToolModel.findAll(user.id, user.isAdmin);
        return reply.send(agentTools);
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
    "/api/agents/:agentId/tools/:toolId",
    {
      schema: {
        operationId: RouteId.AssignToolToAgent,
        description: "Assign a tool to an agent",
        tags: ["Agent Tools"],
        params: z.object({
          agentId: UuidIdSchema,
          toolId: UuidIdSchema,
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { agentId, toolId } = request.params;

        // Validate that agent exists
        const agent = await AgentModel.findById(agentId);
        if (!agent) {
          return reply.status(404).send({
            error: {
              message: `Agent with ID ${agentId} not found`,
              type: "not_found",
            },
          });
        }

        // Validate that tool exists
        const tool = await ToolModel.findById(toolId);
        if (!tool) {
          return reply.status(404).send({
            error: {
              message: `Tool with ID ${toolId} not found`,
              type: "not_found",
            },
          });
        }

        // Create the assignment (no-op if already exists)
        await AgentToolModel.createIfNotExists(agentId, toolId);

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

  fastify.delete(
    "/api/agents/:agentId/tools/:toolId",
    {
      schema: {
        operationId: RouteId.UnassignToolFromAgent,
        description: "Unassign a tool from an agent",
        tags: ["Agent Tools"],
        params: z.object({
          agentId: UuidIdSchema,
          toolId: UuidIdSchema,
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { agentId, toolId } = request.params;

        const success = await AgentToolModel.delete(agentId, toolId);

        return reply.send({ success });
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
    "/api/agents/:agentId/tools",
    {
      schema: {
        operationId: RouteId.GetAgentTools,
        description:
          "Get all tools for an agent (both proxy-sniffed and MCP tools)",
        tags: ["Agent Tools"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: {
          200: z.array(SelectToolSchema),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { agentId } = request.params;

        // Validate that agent exists
        const agent = await AgentModel.findById(agentId);
        if (!agent) {
          return reply.status(404).send({
            error: {
              message: `Agent with ID ${agentId} not found`,
              type: "not_found",
            },
          });
        }

        const tools = await ToolModel.getToolsByAgent(agentId);

        return reply.send(tools);
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

  fastify.patch(
    "/api/agent-tools/:id",
    {
      schema: {
        operationId: RouteId.UpdateAgentTool,
        description: "Update an agent-tool relationship",
        tags: ["Agent Tools"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateAgentToolSchema.pick({
          allowUsageWhenUntrustedDataIsPresent: true,
          toolResultTreatment: true,
          responseModifierTemplate: true,
        }).partial(),
        response: {
          200: UpdateAgentToolSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;

        const agentTool = await AgentToolModel.update(id, request.body);

        if (!agentTool) {
          return reply.status(404).send({
            error: {
              message: `Agent-tool relationship with ID ${id} not found`,
              type: "not_found",
            },
          });
        }

        return reply.send(agentTool);
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

export default agentToolRoutes;
