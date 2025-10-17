import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ToolInvocationPolicyModel, TrustedDataPolicyModel } from "@/models";
import {
  AutonomyPolicyOperator,
  ErrorResponseSchema,
  RouteId,
  ToolInvocation,
  TrustedData,
  UuidIdSchema,
} from "@/types";

const autonomyPolicyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/autonomy-policies/operators",
    {
      schema: {
        operationId: RouteId.GetOperators,
        description: "Get all supported policy operators",
        tags: ["Autonomy Policies"],
        response: {
          200: z.array(
            z.object({
              value: AutonomyPolicyOperator.SupportedOperatorSchema,
              label: z.string(),
            }),
          ),
        },
      },
    },
    async (_, reply) => {
      const supportedOperators = Object.values(
        AutonomyPolicyOperator.SupportedOperatorSchema.enum,
      ).map((value) => {
        /**
         * Convert the camel cased supported operator values to title case
         * https://stackoverflow.com/a/7225450/3902555
         */
        const titleCaseConversion = value.replace(/([A-Z])/g, " $1");
        const label =
          titleCaseConversion.charAt(0).toUpperCase() +
          titleCaseConversion.slice(1);

        return { value, label };
      });

      return reply.send(supportedOperators);
    },
  );

  fastify.get(
    "/api/autonomy-policies/tool-invocation",
    {
      schema: {
        operationId: RouteId.GetToolInvocationPolicies,
        description: "Get all tool invocation policies",
        tags: ["Tool Invocation Policies"],
        response: {
          200: z.array(ToolInvocation.SelectToolInvocationPolicySchema),
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
    "/api/autonomy-policies/tool-invocation",
    {
      schema: {
        operationId: RouteId.CreateToolInvocationPolicy,
        description: "Create a new tool invocation policy",
        tags: ["Tool Invocation Policies"],
        body: ToolInvocation.InsertToolInvocationPolicySchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: ToolInvocation.SelectToolInvocationPolicySchema,
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
    "/api/autonomy-policies/tool-invocation/:id",
    {
      schema: {
        operationId: RouteId.GetToolInvocationPolicy,
        description: "Get tool invocation policy by ID",
        tags: ["Tool Invocation Policies"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: ToolInvocation.SelectToolInvocationPolicySchema,
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
    "/api/autonomy-policies/tool-invocation/:id",
    {
      schema: {
        operationId: RouteId.UpdateToolInvocationPolicy,
        description: "Update a tool invocation policy",
        tags: ["Tool Invocation Policies"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: ToolInvocation.InsertToolInvocationPolicySchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }).partial(),
        response: {
          200: ToolInvocation.SelectToolInvocationPolicySchema,
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
    "/api/autonomy-policies/tool-invocation/:id",
    {
      schema: {
        operationId: RouteId.DeleteToolInvocationPolicy,
        description: "Delete a tool invocation policy",
        tags: ["Tool Invocation Policies"],
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

  fastify.get(
    "/api/trusted-data-policies",
    {
      schema: {
        operationId: RouteId.GetTrustedDataPolicies,
        description: "Get all trusted data policies",
        tags: ["Trusted Data Policies"],
        response: {
          200: z.array(TrustedData.SelectTrustedDataPolicySchema),
          500: ErrorResponseSchema,
        },
      },
    },
    async (_, reply) => {
      try {
        const policies = await TrustedDataPolicyModel.findAll();
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
    "/api/trusted-data-policies",
    {
      schema: {
        operationId: RouteId.CreateTrustedDataPolicy,
        description: "Create a new trusted data policy",
        tags: ["Trusted Data Policies"],
        body: TrustedData.InsertTrustedDataPolicySchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: TrustedData.SelectTrustedDataPolicySchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const policy = await TrustedDataPolicyModel.create(request.body);
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
    "/api/trusted-data-policies/:id",
    {
      schema: {
        operationId: RouteId.GetTrustedDataPolicy,
        description: "Get trusted data policy by ID",
        tags: ["Trusted Data Policies"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: TrustedData.SelectTrustedDataPolicySchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id } }, reply) => {
      try {
        const policy = await TrustedDataPolicyModel.findById(id);

        if (!policy) {
          return reply.status(404).send({
            error: {
              message: "Trusted data policy not found",
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
    "/api/trusted-data-policies/:id",
    {
      schema: {
        operationId: RouteId.UpdateTrustedDataPolicy,
        description: "Update a trusted data policy",
        tags: ["Trusted Data Policies"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: TrustedData.InsertTrustedDataPolicySchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }).partial(),
        response: {
          200: TrustedData.SelectTrustedDataPolicySchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id }, body }, reply) => {
      try {
        const policy = await TrustedDataPolicyModel.update(id, body);

        if (!policy) {
          return reply.status(404).send({
            error: {
              message: "Trusted data policy not found",
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
    "/api/trusted-data-policies/:id",
    {
      schema: {
        operationId: RouteId.DeleteTrustedDataPolicy,
        description: "Delete a trusted data policy",
        tags: ["Trusted Data Policies"],
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
        const success = await TrustedDataPolicyModel.delete(id);

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Trusted data policy not found",
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

export default autonomyPolicyRoutes;
