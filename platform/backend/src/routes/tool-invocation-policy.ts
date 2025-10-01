import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ToolInvocationPolicyModel } from "../models";
import {
  ErrorResponseSchema,
  InsertToolInvocationPolicySchema,
  SelectToolInvocationPolicySchema,
} from "../types";

const toolInvocationPolicyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/tool-invocation-policies",
    {
      schema: {
        operationId: "getToolInvocationPolicies",
        description: "Get all tool invocation policies",
        tags: ["Tool Invocation Policies"],
        response: {
          200: z.array(SelectToolInvocationPolicySchema),
          500: ErrorResponseSchema,
        },
      },
    },
    async (_, reply) => {
      try {
        const policies = await ToolInvocationPolicyModel.findAll();
        return reply.send(policies);
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
    "/api/tool-invocation-policies",
    {
      schema: {
        operationId: "createToolInvocationPolicy",
        description: "Create a new tool invocation policy",
        tags: ["Tool Invocation Policies"],
        body: InsertToolInvocationPolicySchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: SelectToolInvocationPolicySchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const policy = await ToolInvocationPolicyModel.create(request.body);
        return reply.send(policy);
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
    "/api/tool-invocation-policies/:id",
    {
      schema: {
        operationId: "getToolInvocationPolicy",
        description: "Get tool invocation policy by ID",
        tags: ["Tool Invocation Policies"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: {
          200: SelectToolInvocationPolicySchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id } }, reply) => {
      try {
        const policy = await ToolInvocationPolicyModel.findById(id);

        if (!policy) {
          return reply.status(404).send({
            error: {
              message: "Tool invocation policy not found",
              type: "not_found",
            },
          });
        }

        return reply.send(policy);
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
    "/api/tool-invocation-policies/:id",
    {
      schema: {
        operationId: "updateToolInvocationPolicy",
        description: "Update a tool invocation policy",
        tags: ["Tool Invocation Policies"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: InsertToolInvocationPolicySchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }).partial(),
        response: {
          200: SelectToolInvocationPolicySchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id }, body }, reply) => {
      try {
        const policy = await ToolInvocationPolicyModel.update(id, body);

        if (!policy) {
          return reply.status(404).send({
            error: {
              message: "Tool invocation policy not found",
              type: "not_found",
            },
          });
        }

        return reply.send(policy);
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
    "/api/tool-invocation-policies/:id",
    {
      schema: {
        operationId: "deleteToolInvocationPolicy",
        description: "Delete a tool invocation policy",
        tags: ["Tool Invocation Policies"],
        params: z.object({
          id: z.string().uuid(),
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
        const success = await ToolInvocationPolicyModel.delete(id);

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Tool invocation policy not found",
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

export default toolInvocationPolicyRoutes;
