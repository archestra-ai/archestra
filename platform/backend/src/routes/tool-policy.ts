import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { AgentToolModel, ToolModel, ToolPolicyModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertToolPolicySchema,
  SelectToolPolicySchema,
  ToolInvocation,
  TrustedData,
  UpdateToolPolicySchema,
  UuidIdSchema,
} from "@/types";

const ToolPolicyWithRulesSchema = SelectToolPolicySchema.omit({
  organizationId: true,
}).extend({
  toolInvocationPolicies: z.array(
    ToolInvocation.SelectToolInvocationPolicySchema,
  ),
  trustedDataPolicies: z.array(TrustedData.SelectTrustedDataPolicySchema),
});

const toolPolicyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/tools/:toolId/policies",
    {
      schema: {
        operationId: RouteId.GetToolPoliciesForTool,
        description: "List tool policies for a given tool",
        tags: ["Tool Policies"],
        params: z.object({
          toolId: UuidIdSchema,
        }),
        response: constructResponseSchema(z.array(ToolPolicyWithRulesSchema)),
      },
    },
    async ({ params: { toolId }, headers, user, organizationId }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const tool = await ToolModel.findById(toolId, user.id, isAgentAdmin);
      if (!tool) {
        throw new ApiError(404, "Tool not found");
      }

      const policies = await ToolPolicyModel.findAllByToolId(
        toolId,
        organizationId,
      );
      return reply.send(
        policies.map(({ organizationId: _org, ...rest }) => rest),
      );
    },
  );

  fastify.post(
    "/api/tools/:toolId/policies",
    {
      schema: {
        operationId: RouteId.CreateToolPolicy,
        description: "Create a new tool policy for a tool",
        tags: ["Tool Policies"],
        params: z.object({
          toolId: UuidIdSchema,
        }),
        body: InsertToolPolicySchema.pick({
          name: true,
          allowUsageWhenUntrustedDataIsPresent: true,
          toolResultTreatment: true,
          responseModifierTemplate: true,
        }),
        response: constructResponseSchema(ToolPolicyWithRulesSchema),
      },
    },
    async (
      { params: { toolId }, body, headers, organizationId, user },
      reply,
    ) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const tool = await ToolModel.findById(toolId, user.id, isAgentAdmin);
      if (!tool) {
        throw new ApiError(404, "Tool not found");
      }

      if (!organizationId) {
        throw new ApiError(400, "Organization context is required");
      }

      const policy = await ToolPolicyModel.create({
        ...body,
        toolId,
        organizationId,
      });

      // Ensure the newly created policy is associated with the tool's agent-tool record
      // so tool invocation policies take effect immediately.
      if (tool.agentId) {
        await AgentToolModel.createOrUpdateCredentials(
          tool.agentId,
          toolId,
          undefined,
          undefined,
          policy.id,
        );
      }

      const { organizationId: _org, ...rest } = policy;
      return reply.send({
        ...rest,
        toolInvocationPolicies: [],
        trustedDataPolicies: [],
      });
    },
  );

  fastify.put(
    "/api/tool-policies/:policyId",
    {
      schema: {
        operationId: RouteId.UpdateToolPolicy,
        description: "Update an existing tool policy",
        tags: ["Tool Policies"],
        params: z.object({
          policyId: UuidIdSchema,
        }),
        body: UpdateToolPolicySchema.pick({
          name: true,
          allowUsageWhenUntrustedDataIsPresent: true,
          toolResultTreatment: true,
          responseModifierTemplate: true,
        }).partial(),
        response: constructResponseSchema(ToolPolicyWithRulesSchema),
      },
    },
    async (
      { params: { policyId }, body, headers, organizationId, user },
      reply,
    ) => {
      const existing = await ToolPolicyModel.findById(policyId);
      if (!existing || existing.organizationId !== organizationId) {
        throw new ApiError(404, "Tool policy not found");
      }

      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const tool = await ToolModel.findById(
        existing.toolId,
        user.id,
        isAgentAdmin,
      );
      if (!tool) {
        throw new ApiError(404, "Tool not found");
      }

      const updated = await ToolPolicyModel.update(policyId, body);
      if (!updated) {
        throw new ApiError(500, "Failed to update tool policy");
      }

      const { organizationId: _org, ...rest } = updated;

      const policiesWithRules = await ToolPolicyModel.findAllByToolId(
        existing.toolId,
        organizationId,
      );
      const withRules = policiesWithRules.find((p) => p.id === policyId);

      return reply.send({
        ...rest,
        toolInvocationPolicies: withRules?.toolInvocationPolicies ?? [],
        trustedDataPolicies: withRules?.trustedDataPolicies ?? [],
      });
    },
  );

  fastify.delete(
    "/api/tool-policies/:policyId",
    {
      schema: {
        operationId: RouteId.DeleteToolPolicy,
        description: "Delete a tool policy",
        tags: ["Tool Policies"],
        params: z.object({
          policyId: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { policyId }, headers, organizationId }, reply) => {
      const existing = await ToolPolicyModel.findById(policyId);
      if (!existing || existing.organizationId !== organizationId) {
        throw new ApiError(404, "Tool policy not found");
      }

      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      if (!isAgentAdmin) {
        throw new ApiError(403, "Insufficient permissions");
      }

      const deleted = await ToolPolicyModel.delete(policyId);
      if (!deleted) {
        throw new ApiError(500, "Failed to delete tool policy");
      }

      return reply.send({ success: true });
    },
  );
};

export default toolPolicyRoutes;
