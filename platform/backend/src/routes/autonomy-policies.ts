import { RouteId } from "@shared";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import type { SimulationEvaluation } from "@/models/tool-invocation-policy";
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
            "require_approval",
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

  const SIMULATE_MAX_CALLS = 1000;

  const CandidatePolicySchema = z.object({
    toolId: UuidIdSchema,
    conditions: z.array(
      z.object({
        key: z.string().min(1).max(200),
        operator: AutonomyPolicyOperator.SupportedOperatorSchema,
        value: z.string().max(1000),
      }),
    ),
    action: z.enum([
      "allow_when_context_is_untrusted",
      "block_when_context_is_untrusted",
      "block_always",
      "require_approval",
    ]),
    reason: z.string().max(500).nullable().optional(),
  });

  const SimulationDetailSchema = z.object({
    mcpToolCallId: z.string(),
    toolName: z.string(),
    agentId: z.string().nullable(),
    calledAt: z.string(),
    currentOutcome: z.enum(["allowed", "blocked", "require_approval"]),
    simulatedOutcome: z.enum(["allowed", "blocked", "require_approval"]),
    changed: z.boolean(),
    changedReason: z.string().optional(),
  });

  fastify.post(
    "/api/autonomy-policies/tool-invocation/simulate",
    {
      schema: {
        operationId: RouteId.SimulateToolInvocationPolicy,
        description:
          "Simulate the impact of candidate policies against recent historical tool calls without saving any changes",
        tags: ["Tool Invocation Policies"],
        body: z.object({
          candidatePolicies: z.array(CandidatePolicySchema).max(500),
          limit: z.number().int().min(1).max(SIMULATE_MAX_CALLS).optional(),
          agentId: UuidIdSchema.optional(),
          startDate: z.string().datetime().optional(),
          endDate: z.string().datetime().optional(),
          globalToolPolicy: z.enum(["permissive", "restrictive"]).optional(),
        }),
        response: constructResponseSchema(
          z.object({
            summary: z.object({
              totalCalls: z.number(),
              newlyBlocked: z.number(),
              newlyAllowed: z.number(),
              requireApprovalAdded: z.number(),
              requireApprovalRemoved: z.number(),
              noChange: z.number(),
            }),
            details: z.array(SimulationDetailSchema),
          }),
        ),
      },
    },
    async ({ body }, reply) => {
      const {
        candidatePolicies,
        limit = 200,
        agentId,
        startDate,
        endDate,
        globalToolPolicy = "restrictive",
      } = body;

      // Load recent mcp_tool_calls (tools/call method only — skips list/initialize)
      const whereConditions = [];
      if (agentId) {
        whereConditions.push(
          inArray(schema.mcpToolCallsTable.agentId, [agentId]),
        );
      }
      if (startDate) {
        whereConditions.push(
          gte(schema.mcpToolCallsTable.createdAt, new Date(startDate)),
        );
      }
      if (endDate) {
        whereConditions.push(
          lte(schema.mcpToolCallsTable.createdAt, new Date(endDate)),
        );
      }

      const baseCondition = eq(
        schema.mcpToolCallsTable.method,
        "tools/call",
      );
      const whereClause = whereConditions.length > 0
        ? and(baseCondition, ...whereConditions)
        : baseCondition;

      const historicalCalls = await db
        .select({
          id: schema.mcpToolCallsTable.id,
          agentId: schema.mcpToolCallsTable.agentId,
          toolCall: schema.mcpToolCallsTable.toolCall,
          createdAt: schema.mcpToolCallsTable.createdAt,
        })
        .from(schema.mcpToolCallsTable)
        .where(whereClause)
        .orderBy(desc(schema.mcpToolCallsTable.createdAt))
        .limit(limit);

      // Get unique tool names from historical calls
      const toolNames = [
        ...new Set(
          historicalCalls
            .map((c) => (c.toolCall as { name?: string } | null)?.name)
            .filter((n): n is string => typeof n === "string"),
        ),
      ];

      if (toolNames.length === 0) {
        return reply.send({
          summary: {
            totalCalls: 0,
            newlyBlocked: 0,
            newlyAllowed: 0,
            requireApprovalAdded: 0,
            requireApprovalRemoved: 0,
            noChange: 0,
          },
          details: [],
        });
      }

      // Batch-fetch tool IDs for all tool names
      const tools = await db
        .select({ id: schema.toolsTable.id, name: schema.toolsTable.name })
        .from(schema.toolsTable)
        .where(inArray(schema.toolsTable.name, toolNames));

      const toolIdsByName = new Map(tools.map((t) => [t.name, t.id]));
      const toolIds = tools.map((t) => t.id);

      // Fetch current DB policies for those tools
      const currentPoliciesRaw =
        toolIds.length > 0
          ? await db
              .select()
              .from(schema.toolInvocationPoliciesTable)
              .where(
                inArray(schema.toolInvocationPoliciesTable.toolId, toolIds),
              )
          : [];

      const currentPoliciesByToolId = new Map<
        string,
        ToolInvocation.ToolInvocationPolicy[]
      >();
      for (const policy of currentPoliciesRaw) {
        const existing = currentPoliciesByToolId.get(policy.toolId) ?? [];
        existing.push(policy);
        currentPoliciesByToolId.set(policy.toolId, existing);
      }

      // Build candidate policies map by toolId (cast to ToolInvocationPolicy shape)
      const candidatePoliciesByToolId = new Map<
        string,
        ToolInvocation.ToolInvocationPolicy[]
      >();
      for (const cp of candidatePolicies) {
        const existing = candidatePoliciesByToolId.get(cp.toolId) ?? [];
        existing.push({
          id: "",
          toolId: cp.toolId,
          conditions: cp.conditions,
          action: cp.action,
          reason: cp.reason ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        });
        candidatePoliciesByToolId.set(cp.toolId, existing);
      }

      // Evaluate each historical call against current and candidate policies
      const emptyContext = { teamIds: [] };
      const details: z.infer<typeof SimulationDetailSchema>[] = [];
      const summary = {
        totalCalls: 0,
        newlyBlocked: 0,
        newlyAllowed: 0,
        requireApprovalAdded: 0,
        requireApprovalRemoved: 0,
        noChange: 0,
      };

      for (const call of historicalCalls) {
        const tc = call.toolCall as { name?: string; arguments?: Record<string, unknown> } | null;
        if (!tc?.name) continue;

        summary.totalCalls++;

        const toolName = tc.name;
        const toolInput = tc.arguments ?? {};
        const toolId = toolIdsByName.get(toolName);
        const currentPolicies = toolId
          ? (currentPoliciesByToolId.get(toolId) ?? [])
          : [];
        const candidatePoliciesForTool = toolId
          ? (candidatePoliciesByToolId.get(toolId) ?? [])
          : [];

        const currentEval = globalToolPolicy === "permissive"
          ? ({ outcome: "allowed" } as SimulationEvaluation)
          : ToolInvocationPolicyModel.evaluateToolCallAgainstPolicies(
              toolName,
              toolInput,
              emptyContext,
              true,
              currentPolicies,
            );

        const simulatedEval = globalToolPolicy === "permissive"
          ? ({ outcome: "allowed" } as SimulationEvaluation)
          : ToolInvocationPolicyModel.evaluateToolCallAgainstPolicies(
              toolName,
              toolInput,
              emptyContext,
              true,
              candidatePoliciesForTool,
            );

        const changed = currentEval.outcome !== simulatedEval.outcome;

        if (changed) {
          if (
            currentEval.outcome !== "blocked" &&
            simulatedEval.outcome === "blocked"
          ) {
            summary.newlyBlocked++;
          } else if (
            currentEval.outcome === "blocked" &&
            simulatedEval.outcome !== "blocked"
          ) {
            summary.newlyAllowed++;
          } else if (
            currentEval.outcome !== "require_approval" &&
            simulatedEval.outcome === "require_approval"
          ) {
            summary.requireApprovalAdded++;
          } else if (
            currentEval.outcome === "require_approval" &&
            simulatedEval.outcome !== "require_approval"
          ) {
            summary.requireApprovalRemoved++;
          }
        } else {
          summary.noChange++;
        }

        details.push({
          mcpToolCallId: call.id,
          toolName,
          agentId: call.agentId,
          calledAt: call.createdAt.toISOString(),
          currentOutcome: currentEval.outcome,
          simulatedOutcome: simulatedEval.outcome,
          changed,
          ...(changed && simulatedEval.reason
            ? { changedReason: simulatedEval.reason }
            : {}),
        });
      }

      return reply.send({ summary, details });
    },
  );
};

export default autonomyPolicyRoutes;
