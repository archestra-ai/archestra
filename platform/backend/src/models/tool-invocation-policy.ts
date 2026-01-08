import { isAgentTool, isArchestraMcpServerTool } from "@shared";
import { desc, eq, inArray } from "drizzle-orm";
import { get } from "lodash-es";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { GlobalToolPolicy, ToolInvocation } from "@/types";

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

    // Clear auto-configured timestamp for all agent-tools using this tool
    await db
      .update(schema.agentToolsTable)
      .set({
        policiesAutoConfiguredAt: null,
        policiesAutoConfiguredReasoning: null,
      })
      .where(eq(schema.agentToolsTable.toolId, policy.toolId));

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

    if (updatedPolicy) {
      // Clear auto-configured timestamp for all agent-tools using this tool
      await db
        .update(schema.agentToolsTable)
        .set({
          policiesAutoConfiguredAt: null,
          policiesAutoConfiguredReasoning: null,
        })
        .where(eq(schema.agentToolsTable.toolId, updatedPolicy.toolId));
    }

    return updatedPolicy || null;
  }

  static async delete(id: string): Promise<boolean> {
    // Get the policy first to access toolId
    const policy = await ToolInvocationPolicyModel.findById(id);
    if (!policy) {
      return false;
    }

    const result = await db
      .delete(schema.toolInvocationPoliciesTable)
      .where(eq(schema.toolInvocationPoliciesTable.id, id));

    const deleted = result.rowCount !== null && result.rowCount > 0;

    if (deleted) {
      // Clear auto-configured timestamp for all agent-tools using this tool
      await db
        .update(schema.agentToolsTable)
        .set({
          policiesAutoConfiguredAt: null,
          policiesAutoConfiguredReasoning: null,
        })
        .where(eq(schema.agentToolsTable.toolId, policy.toolId));
    }

    return deleted;
  }

  /**
   * Bulk upsert default policies (empty conditions) for multiple tools.
   * Updates existing default policies or creates new ones in a single transaction.
   */
  static async bulkUpsertDefaultPolicy(
    toolIds: string[],
    action: "allow_when_context_is_untrusted" | "block_always",
  ): Promise<{ updated: number; created: number }> {
    if (toolIds.length === 0) {
      return { updated: 0, created: 0 };
    }

    // Find existing default policies (empty conditions) for these tools
    const existingPolicies = await db
      .select()
      .from(schema.toolInvocationPoliciesTable)
      .where(inArray(schema.toolInvocationPoliciesTable.toolId, toolIds));

    // Filter to only default policies (empty conditions array)
    const defaultPolicies = existingPolicies.filter(
      (p) => p.conditions.length === 0,
    );

    const toolIdsWithDefaultPolicy = new Set(
      defaultPolicies.map((p) => p.toolId),
    );
    const toolIdsToCreate = toolIds.filter(
      (id) => !toolIdsWithDefaultPolicy.has(id),
    );
    const policiesToUpdate = defaultPolicies.filter((p) => p.action !== action);

    let updated = 0;
    let created = 0;

    // Update existing default policies that have different action
    if (policiesToUpdate.length > 0) {
      const policyIds = policiesToUpdate.map((p) => p.id);
      await db
        .update(schema.toolInvocationPoliciesTable)
        .set({ action })
        .where(inArray(schema.toolInvocationPoliciesTable.id, policyIds));
      updated = policiesToUpdate.length;
    }

    // Create new default policies for tools that don't have one
    if (toolIdsToCreate.length > 0) {
      await db.insert(schema.toolInvocationPoliciesTable).values(
        toolIdsToCreate.map((toolId) => ({
          toolId,
          conditions: [],
          action,
          reason: null,
        })),
      );
      created = toolIdsToCreate.length;
    }

    return { updated, created };
  }

  /**
   * Batch evaluate tool invocation policies for multiple tool calls at once.
   * This avoids N+1 queries by fetching all policies upfront.
   *
   * Returns the first blocked tool call (refusal message) or null if all are allowed.
   */
  static async evaluateBatch(
    _agentId: string,
    toolCalls: Array<{
      toolCallName: string;
      // biome-ignore lint/suspicious/noExplicitAny: tool inputs can be any shape
      toolInput: Record<string, any>;
    }>,
    isContextTrusted: boolean,
    globalToolPolicy: GlobalToolPolicy,
  ): Promise<EvaluationResult & { toolCallName?: string }> {
    logger.debug(
      { globalToolPolicy },
      "ToolInvocationPolicy.evaluateBatch: global policy",
    );

    // Filter out Archestra tools and agent delegation tools (always allowed)
    const externalToolCalls = toolCalls.filter(
      (tc) =>
        !isArchestraMcpServerTool(tc.toolCallName) &&
        !isAgentTool(tc.toolCallName),
    );

    if (externalToolCalls.length === 0) {
      return { isAllowed: true, reason: "" };
    }

    const toolNames = externalToolCalls.map((tc) => tc.toolCallName);

    // Fetch tool IDs for the tool names
    const tools = await db
      .select({
        id: schema.toolsTable.id,
        name: schema.toolsTable.name,
      })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.name, toolNames));

    const toolIdsByName = new Map(tools.map((t) => [t.name, t.id]));
    const toolIds = tools.map((t) => t.id);

    if (toolIds.length === 0) {
      // No tools found, allow all
      return { isAllowed: true, reason: "" };
    }

    // Fetch all policies for all tools
    const allPolicies = await db
      .select()
      .from(schema.toolInvocationPoliciesTable)
      .where(inArray(schema.toolInvocationPoliciesTable.toolId, toolIds));

    logger.debug(
      { allPolicies },
      "ToolInvocationPolicy.evaluateBatch: evaluating policies",
    );

    // Group policies by tool ID
    const policiesByToolId = new Map<
      string,
      Array<(typeof allPolicies)[number]>
    >();
    for (const policy of allPolicies) {
      const existing = policiesByToolId.get(policy.toolId) || [];
      existing.push(policy);
      policiesByToolId.set(policy.toolId, existing);
    }

    // Evaluate each tool call
    for (const { toolCallName, toolInput } of externalToolCalls) {
      const toolId = toolIdsByName.get(toolCallName);
      if (!toolId) continue;

      const policies = policiesByToolId.get(toolId) || [];

      // Separate policies into specific (has conditions) and default (empty conditions)
      const specificPolicies = policies.filter((p) => p.conditions.length > 0);
      const defaultPolicies = policies.filter((p) => p.conditions.length === 0);

      // First, check specific policies (more specific rules take precedence)
      let hasMatchingSpecificPolicy = false;
      let specificAllowsUntrusted = false;

      for (const policy of specificPolicies) {
        // Check if all conditions match (AND logic)
        const conditionsMatch = policy.conditions.every((condition) => {
          const argumentValue = get(toolInput, condition.key);
          if (argumentValue === undefined) return false;

          switch (condition.operator) {
            case "endsWith":
              return (
                typeof argumentValue === "string" &&
                argumentValue.endsWith(condition.value)
              );
            case "startsWith":
              return (
                typeof argumentValue === "string" &&
                argumentValue.startsWith(condition.value)
              );
            case "contains":
              return (
                typeof argumentValue === "string" &&
                argumentValue.includes(condition.value)
              );
            case "notContains":
              return (
                typeof argumentValue === "string" &&
                !argumentValue.includes(condition.value)
              );
            case "equal":
              return argumentValue === condition.value;
            case "notEqual":
              return argumentValue !== condition.value;
            case "regex":
              return (
                typeof argumentValue === "string" &&
                new RegExp(condition.value).test(argumentValue)
              );
            default:
              return false;
          }
        });

        if (!conditionsMatch) continue;

        hasMatchingSpecificPolicy = true;

        if (policy.action === "block_always") {
          return {
            isAllowed: false,
            reason: policy.reason || "Policy violation",
            toolCallName,
          };
        }

        if (policy.action === "allow_when_context_is_untrusted") {
          specificAllowsUntrusted = true;
        }
      }

      // If a specific policy matched, use its result (ignore default policies)
      if (hasMatchingSpecificPolicy) {
        if (!isContextTrusted && !specificAllowsUntrusted) {
          return {
            isAllowed: false,
            reason: "Tool invocation blocked: context contains untrusted data",
            toolCallName,
          };
        }
        continue; // Tool is allowed, move to next tool
      }

      if (defaultPolicies.length > 0) {
        // No specific policy matched - fall back to default policy (empty conditions)
        let defaultAllowsUntrusted = false;

        for (const policy of defaultPolicies) {
          if (policy.action === "block_always") {
            return {
              isAllowed: false,
              reason:
                policy.reason ||
                "Tool invocation blocked: context contains untrusted data",
              toolCallName,
            };
          }

          if (policy.action === "allow_when_context_is_untrusted") {
            defaultAllowsUntrusted = true;
          }
        }
        // Check if tool is allowed when context is untrusted
        if (!isContextTrusted && !defaultAllowsUntrusted) {
          return {
            isAllowed: false,
            reason: "Tool invocation blocked: context contains untrusted data",
            toolCallName,
          };
        }
        continue; // Tool is allowed by default policy, skip global policy check
      }

      // No policies exist - fall back to global policy
      if (!isContextTrusted && globalToolPolicy !== "permissive") {
        return {
          isAllowed: false,
          reason:
            "Tool invocation blocked: forbidden in untrusted context by default",
          toolCallName,
        };
      }
    }

    return { isAllowed: true, reason: "" };
  }
}

export default ToolInvocationPolicyModel;
