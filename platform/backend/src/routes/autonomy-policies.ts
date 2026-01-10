import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ToolInvocationPolicyModel, TrustedDataPolicyModel } from "@/models";
import {
  ApiError,
  AutonomyPolicyOperator,
  constructResponseSchema,
  DeleteObjectResponseSchema,
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
        response: constructResponseSchema(
          z.array(
            z.object({
              value: AutonomyPolicyOperator.SupportedOperatorSchema,
              label: z.string(),
            }),
          ),
        ),
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
        response: constructResponseSchema(
          z.array(ToolInvocation.SelectToolInvocationPolicySchema),
        ),
      },
    },
    async (_, reply) => {
      return reply.send(await ToolInvocationPolicyModel.findAll());
    },
  );

  fastify.post(
    "/api/autonomy-policies/tool-invocation",
    {
      schema: {
        operationId: RouteId.CreateToolInvocationPolicy,
        description: "Create a new tool invocation policy",
        tags: ["Tool Invocation Policies"],
        body: ToolInvocation.InsertToolInvocationPolicySchema,
        response: constructResponseSchema(
          ToolInvocation.SelectToolInvocationPolicySchema,
        ),
      },
    },
    async ({ body }, reply) => {
      return reply.send(await ToolInvocationPolicyModel.create(body));
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
        response: constructResponseSchema(
          ToolInvocation.SelectToolInvocationPolicySchema,
        ),
      },
    },
    async ({ params: { id } }, reply) => {
      const policy = await ToolInvocationPolicyModel.findById(id);

      if (!policy) {
        throw new ApiError(404, "Tool invocation policy not found");
      }

      return reply.send(policy);
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
        body: ToolInvocation.InsertToolInvocationPolicySchema.partial(),
        response: constructResponseSchema(
          ToolInvocation.SelectToolInvocationPolicySchema,
        ),
      },
    },
    async ({ params: { id }, body }, reply) => {
      const policy = await ToolInvocationPolicyModel.update(id, body);

      if (!policy) {
        throw new ApiError(404, "Tool invocation policy not found");
      }

      return reply.send(policy);
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
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      const success = await ToolInvocationPolicyModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Tool invocation policy not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/trusted-data-policies",
    {
      schema: {
        operationId: RouteId.GetTrustedDataPolicies,
        description: "Get all trusted data policies",
        tags: ["Trusted Data Policies"],
        response: constructResponseSchema(
          z.array(TrustedData.SelectTrustedDataPolicySchema),
        ),
      },
    },
    async (_, reply) => {
      return reply.send(await TrustedDataPolicyModel.findAll());
    },
  );

  fastify.post(
    "/api/trusted-data-policies",
    {
      schema: {
        operationId: RouteId.CreateTrustedDataPolicy,
        description: "Create a new trusted data policy",
        tags: ["Trusted Data Policies"],
        body: TrustedData.InsertTrustedDataPolicySchema,
        response: constructResponseSchema(
          TrustedData.SelectTrustedDataPolicySchema,
        ),
      },
    },
    async ({ body }, reply) => {
      return reply.send(await TrustedDataPolicyModel.create(body));
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
        response: constructResponseSchema(
          TrustedData.SelectTrustedDataPolicySchema,
        ),
      },
    },
    async ({ params: { id } }, reply) => {
      const policy = await TrustedDataPolicyModel.findById(id);

      if (!policy) {
        throw new ApiError(404, "Trusted data policy not found");
      }

      return reply.send(policy);
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
        body: TrustedData.InsertTrustedDataPolicySchema.partial(),
        response: constructResponseSchema(
          TrustedData.SelectTrustedDataPolicySchema,
        ),
      },
    },
    async ({ params: { id }, body }, reply) => {
      const policy = await TrustedDataPolicyModel.update(id, body);

      if (!policy) {
        throw new ApiError(404, "Trusted data policy not found");
      }

      return reply.send(policy);
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
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      const success = await TrustedDataPolicyModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Trusted data policy not found");
      }

      return reply.send({ success: true });
    },
  );

  // Bulk operations for default policies
  fastify.post(
    "/api/tool-invocation/bulk-default",
    {
      schema: {
        operationId: RouteId.BulkUpsertDefaultCallPolicy,
        description:
          "Bulk upsert default tool invocation policies (empty conditions) for multiple tools",
        tags: ["Tool Invocation Policies"],
        body: z.object({
          toolIds: z.array(UuidIdSchema),
          action: z.enum([
            "allow_when_context_is_untrusted",
            "block_when_context_is_untrusted",
            "block_always",
          ]),
        }),
        response: constructResponseSchema(
          z.object({
            updated: z.number(),
            created: z.number(),
          }),
        ),
      },
    },
    async ({ body }, reply) => {
      const result = await ToolInvocationPolicyModel.bulkUpsertDefaultPolicy(
        body.toolIds,
        body.action,
      );
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/trusted-data-policies/bulk-default",
    {
      schema: {
        operationId: RouteId.BulkUpsertDefaultResultPolicy,
        description:
          "Bulk upsert default trusted data policies (empty conditions) for multiple tools",
        tags: ["Trusted Data Policies"],
        body: z.object({
          toolIds: z.array(UuidIdSchema),
          action: z.enum([
            "mark_as_trusted",
            "mark_as_untrusted",
            "block_always",
            "sanitize_with_dual_llm",
          ]),
        }),
        response: constructResponseSchema(
          z.object({
            updated: z.number(),
            created: z.number(),
          }),
        ),
      },
    },
    async ({ body }, reply) => {
      const result = await TrustedDataPolicyModel.bulkUpsertDefaultPolicy(
        body.toolIds,
        body.action,
      );
      return reply.send(result);
    },
  );
};

export default autonomyPolicyRoutes;
