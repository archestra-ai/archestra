import { and, desc, eq, getTableColumns } from "drizzle-orm";
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
    return updatedPolicy || null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.toolInvocationPoliciesTable)
      .where(eq(schema.toolInvocationPoliciesTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Evaluate tool invocation policies for a given chat
   */
  static async evaluate(
    agentId: string,
    toolName: string,
    // biome-ignore lint/suspicious/noExplicitAny: tool inputs can be any shape
    toolInput: Record<string, any>,
    isContextTrusted: boolean,
  ): Promise<EvaluationResult> {
    /**
     * Get policies assigned to this agent that also match the tool name,
     * along with the tool's configuration
     */
    const applicablePoliciesForAgent = await db
      .select({
        ...getTableColumns(schema.toolInvocationPoliciesTable),
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
        // Filter to policies that match the agent and tool
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.toolsTable.name, toolName),
        ),
      );

    // Track if we found an explicit allow rule for this tool call
    let hasExplicitAllowRule = false;
    let allowUsageWhenUntrustedDataIsPresent =
      applicablePoliciesForAgent.length > 0
        ? applicablePoliciesForAgent[0].allowUsageWhenUntrustedDataIsPresent
        : null;

    // If we don't have the tool config from policies, fetch it from agent-tool relationship
    if (allowUsageWhenUntrustedDataIsPresent === null) {
      const securityConfig = await AgentToolModel.getSecurityConfig(
        agentId,
        toolName,
      );
      if (securityConfig) {
        allowUsageWhenUntrustedDataIsPresent =
          securityConfig.allowUsageWhenUntrustedDataIsPresent;
      }
    }

    // If context is untrusted and tool allows usage with untrusted data, allow immediately
    if (!isContextTrusted && allowUsageWhenUntrustedDataIsPresent) {
      return {
        isAllowed: true,
        reason: "",
      };
    }

    // Evaluate each policy
    for (const {
      argumentName,
      operator,
      value: policyValue,
      action,
      reason,
    } of applicablePoliciesForAgent) {
      // Extract the argument value using lodash
      const argumentValue = get(toolInput, argumentName);

      if (argumentValue === undefined) {
        // If the argument doesn't exist and we have a block policy, that's okay
        if (action === "block_always") {
          continue;
        }
        // If it's an allow policy and the argument is missing, that's a problem
        return {
          isAllowed: false,
          reason: `Missing required argument: ${argumentName}`,
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

      // Apply the allow/block logic
      if (action === "allow_when_context_is_untrusted") {
        // If condition is met, this is an explicit allow rule
        if (conditionMet) {
          hasExplicitAllowRule = true;
        }
      } else if (action === "block_always") {
        // Policy says "block" when condition is met
        if (conditionMet) {
          return {
            isAllowed: false,
            reason: reason || `Policy violation: ${reason}`,
          };
        }
      }
    }

    // If context is untrusted and we don't have an explicit allow rule, block
    if (!isContextTrusted && !hasExplicitAllowRule) {
      return {
        isAllowed: false,
        reason: "Tool invocation blocked: context contains untrusted data",
      };
    }

    // All policies passed
    return {
      isAllowed: true,
      reason: "",
    };
  }
}

export default ToolInvocationPolicyModel;
