import { isArchestraMcpServerTool } from "@shared";
import { and, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { get } from "lodash-es";
import db, { schema } from "@/database";
import type { ToolInvocation } from "@/types";
import AgentToolModel from "./agent-tool";

type EvaluationResult = {
  isAllowed: boolean;
  reason: string;
};

class ToolInvocationPolicyModel {
  static async create(
    policy: ToolInvocation.InsertToolInvocationPolicy,
  ): Promise<ToolInvocation.ToolInvocationPolicy> {
    const [createdPolicy] = await db
      .insert(schema.toolInvocationPoliciesTable)
      .values(policy)
      .returning();

    // Clear auto-configured timestamp and reasoning when adding a policy
    await db
      .update(schema.agentToolsTable)
      .set({
        policiesAutoConfiguredAt: null,
        policiesAutoConfiguredReasoning: null,
      })
      .where(eq(schema.agentToolsTable.id, policy.agentToolId));

    return createdPolicy;
  }

  static async findAll(): Promise<ToolInvocation.ToolInvocationPolicy[]> {
    return db
      .select()
      .from(schema.toolInvocationPoliciesTable)
      .orderBy(desc(schema.toolInvocationPoliciesTable.createdAt));
  }

  static async findById(
    id: string,
  ): Promise<ToolInvocation.ToolInvocationPolicy | null> {
    const [policy] = await db
      .select()
      .from(schema.toolInvocationPoliciesTable)
      .where(eq(schema.toolInvocationPoliciesTable.id, id));
    return policy || null;
  }

  static async update(
    id: string,
    policy: Partial<ToolInvocation.InsertToolInvocationPolicy>,
  ): Promise<ToolInvocation.ToolInvocationPolicy | null> {
    const [updatedPolicy] = await db
      .update(schema.toolInvocationPoliciesTable)
      .set(policy)
      .where(eq(schema.toolInvocationPoliciesTable.id, id))
      .returning();

    // Clear auto-configured timestamp and reasoning when updating a policy
    if (updatedPolicy) {
      await db
        .update(schema.agentToolsTable)
        .set({
          policiesAutoConfiguredAt: null,
          policiesAutoConfiguredReasoning: null,
        })
        .where(eq(schema.agentToolsTable.id, updatedPolicy.agentToolId));
    }

    return updatedPolicy || null;
  }

  static async delete(id: string): Promise<boolean> {
    // Get the policy first to access agentToolId
    const policy = await ToolInvocationPolicyModel.findById(id);
    if (!policy) {
      return false;
    }

    const result = await db
      .delete(schema.toolInvocationPoliciesTable)
      .where(eq(schema.toolInvocationPoliciesTable.id, id));

    const deleted = result.rowCount !== null && result.rowCount > 0;

    // Clear auto-configured timestamp and reasoning when deleting a policy
    if (deleted) {
      await db
        .update(schema.agentToolsTable)
        .set({
          policiesAutoConfiguredAt: null,
          policiesAutoConfiguredReasoning: null,
        })
        .where(eq(schema.agentToolsTable.id, policy.agentToolId));
    }

    return deleted;
  }

  /**
   * Batch evaluate tool invocation policies for multiple tool calls at once.
   * This avoids N+1 queries by fetching all policies and security configs,
   *
   * Returns the first blocked tool call (refusal message) or null if all are allowed.
   */
  static async evaluateBatch(
    agentId: string,
    toolCalls: Array<{
      toolCallName: string;
      // biome-ignore lint/suspicious/noExplicitAny: tool inputs can be any shape
      toolInput: Record<string, any>;
    }>,
    isContextTrusted: boolean,
  ): Promise<EvaluationResult & { toolCallName?: string }> {
    // Filter out Archestra tools (always allowed)
    const nonArchestraToolCalls = toolCalls.filter(
      (tc) => !isArchestraMcpServerTool(tc.toolCallName),
    );

    if (nonArchestraToolCalls.length === 0) {
      return { isAllowed: true, reason: "" };
    }

    const toolNames = nonArchestraToolCalls.map((tc) => tc.toolCallName);

    // Fetch all policies for all tools.
    const allPolicies = await db
      .select({
        ...getTableColumns(schema.toolInvocationPoliciesTable),
        toolName: schema.toolsTable.name,
        allowUsageWhenUntrustedDataIsPresent:
          schema.agentToolsTable.allowUsageWhenUntrustedDataIsPresent,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolInvocationPoliciesTable,
        eq(
          schema.agentToolsTable.id,
          schema.toolInvocationPoliciesTable.agentToolId,
        ),
      )
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          inArray(schema.toolsTable.name, toolNames),
        ),
      );

    // Group policies by tool name
    const policiesByTool = new Map<
      string,
      Array<(typeof allPolicies)[number]>
    >();
    const securityConfigByTool = new Map<string, boolean | null>();

    for (const policy of allPolicies) {
      const existing = policiesByTool.get(policy.toolName) || [];
      existing.push(policy);
      policiesByTool.set(policy.toolName, existing);
      // Also track security config (same for all policies of a tool)
      if (!securityConfigByTool.has(policy.toolName)) {
        securityConfigByTool.set(
          policy.toolName,
          policy.allowUsageWhenUntrustedDataIsPresent,
        );
      }
    }

    // For tools without policies, we need to fetch their security config
    const toolsNeedingSecurityConfig = toolNames.filter(
      (name) => !securityConfigByTool.has(name),
    );

    if (toolsNeedingSecurityConfig.length > 0) {
      const securityConfigs = await AgentToolModel.getSecurityConfigBatch(
        agentId,
        toolsNeedingSecurityConfig,
      );
      for (const [toolName, config] of securityConfigs) {
        securityConfigByTool.set(
          toolName,
          config.allowUsageWhenUntrustedDataIsPresent,
        );
      }
    }

    // Evaluate each tool call using the pre-fetched data
    for (const { toolCallName, toolInput } of nonArchestraToolCalls) {
      const policies = policiesByTool.get(toolCallName) || [];
      const allowUsageWhenUntrustedDataIsPresent =
        securityConfigByTool.get(toolCallName) ?? null;

      let hasExplicitAllowRule = false;

      // Evaluate each policy for this tool
      for (const policy of policies) {
        const {
          argumentName,
          operator,
          value: policyValue,
          action,
          reason,
        } = policy;
        const argumentValue = get(toolInput, argumentName);

        if (argumentValue === undefined) {
          if (action === "block_always") {
            continue;
          }
          if (allowUsageWhenUntrustedDataIsPresent) {
            continue;
          }
          return {
            isAllowed: false,
            reason: `Missing required argument: ${argumentName}`,
            toolCallName,
          };
        }

        // Evaluate the condition
        let conditionMet = false;

        switch (operator) {
          case "endsWith":
            conditionMet =
              typeof argumentValue === "string" &&
              argumentValue.endsWith(policyValue);
            break;
          case "startsWith":
            conditionMet =
              typeof argumentValue === "string" &&
              argumentValue.startsWith(policyValue);
            break;
          case "contains":
            conditionMet =
              typeof argumentValue === "string" &&
              argumentValue.includes(policyValue);
            break;
          case "notContains":
            conditionMet =
              typeof argumentValue === "string" &&
              !argumentValue.includes(policyValue);
            break;
          case "equal":
            conditionMet = argumentValue === policyValue;
            break;
          case "notEqual":
            conditionMet = argumentValue !== policyValue;
            break;
          case "regex":
            conditionMet =
              typeof argumentValue === "string" &&
              new RegExp(policyValue).test(argumentValue);
            break;
        }

        if (action === "allow_when_context_is_untrusted") {
          if (conditionMet) {
            hasExplicitAllowRule = true;
          }
        } else if (action === "block_always") {
          if (conditionMet) {
            return {
              isAllowed: false,
              reason: reason || `Policy violation: ${reason}`,
              toolCallName,
            };
          }
        }
      }

      if (!isContextTrusted && allowUsageWhenUntrustedDataIsPresent) {
        continue; // Tool is allowed
      }

      if (!isContextTrusted && !hasExplicitAllowRule) {
        return {
          isAllowed: false,
          reason: "Tool invocation blocked: context contains untrusted data",
          toolCallName,
        };
      }
    }

    return { isAllowed: true, reason: "" };
  }
}

export default ToolInvocationPolicyModel;
