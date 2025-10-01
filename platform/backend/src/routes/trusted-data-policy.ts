import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { TrustedDataPolicyModel } from "../models";
import {
  ErrorResponseSchema,
  InsertTrustedDataPolicySchema,
  SelectTrustedDataPolicySchema,
} from "../types";

const trustedDataPolicyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/trusted-data-policies",
    {
      schema: {
        operationId: "getTrustedDataPolicies",
        description: "Get all trusted data policies",
        tags: ["Trusted Data Policies"],
        response: {
          200: z.array(SelectTrustedDataPolicySchema),
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
        operationId: "createTrustedDataPolicy",
        description: "Create a new trusted data policy",
        tags: ["Trusted Data Policies"],
        body: InsertTrustedDataPolicySchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: SelectTrustedDataPolicySchema,
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
        operationId: "getTrustedDataPolicy",
        description: "Get trusted data policy by ID",
        tags: ["Trusted Data Policies"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: {
          200: SelectTrustedDataPolicySchema,
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
        operationId: "updateTrustedDataPolicy",
        description: "Update a trusted data policy",
        tags: ["Trusted Data Policies"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: InsertTrustedDataPolicySchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }).partial(),
        response: {
          200: SelectTrustedDataPolicySchema,
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
        operationId: "deleteTrustedDataPolicy",
        description: "Delete a trusted data policy",
        tags: ["Trusted Data Policies"],
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

export default trustedDataPolicyRoutes;
