import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { get } from "lodash-es";
import db, { schema } from "@/database";
import type { AutonomyPolicyOperator, TrustedData } from "@/types";

class TrustedDataPolicyModel {
  static async create(
    policy: TrustedData.InsertTrustedDataPolicy,
  ): Promise<TrustedData.TrustedDataPolicy> {
    const [createdPolicy] = await db
      .insert(schema.trustedDataPoliciesTable)
      .values(policy)
      .returning();
    return createdPolicy;
  }

  static async findAll(): Promise<TrustedData.TrustedDataPolicy[]> {
    return db
      .select()
      .from(schema.trustedDataPoliciesTable)
      .orderBy(desc(schema.trustedDataPoliciesTable.createdAt));
  }

  static async findById(
    id: string,
  ): Promise<TrustedData.TrustedDataPolicy | null> {
    const [policy] = await db
      .select()
      .from(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.id, id));
    return policy || null;
  }

  static async update(
    id: string,
    policy: Partial<TrustedData.InsertTrustedDataPolicy>,
  ): Promise<TrustedData.TrustedDataPolicy | null> {
    const [updatedPolicy] = await db
      .update(schema.trustedDataPoliciesTable)
      .set(policy)
      .where(eq(schema.trustedDataPoliciesTable.id, id))
      .returning();
    return updatedPolicy || null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Extract values from an object using a path (supports wildcards like emails[*].from)
   */
  // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
  private static extractValuesFromPath(obj: any, path: string): any[] {
    // Handle wildcard paths like 'emails[*].from'
    if (path.includes("[*]")) {
      const parts = path.split("[*].");
      const arrayPath = parts[0];
      const itemPath = parts[1];

      const array = get(obj, arrayPath);
      if (!Array.isArray(array)) {
        return [];
      }

      return array
        .map((item) => get(item, itemPath))
        .filter((v) => v !== undefined);
    }
    // Simple path without wildcards
    const value = get(obj, path);
    return value !== undefined ? [value] : [];
  }

  /**
   * Evaluate if a value matches the policy condition
   */
  private static evaluateCondition(
    // biome-ignore lint/suspicious/noExplicitAny: policy values can be any type
    value: any,
    operator: AutonomyPolicyOperator.SupportedOperator,
    policyValue: string,
  ): boolean {
    switch (operator) {
      case "endsWith":
        return typeof value === "string" && value.endsWith(policyValue);
      case "startsWith":
        return typeof value === "string" && value.startsWith(policyValue);
      case "contains":
        return typeof value === "string" && value.includes(policyValue);
      case "notContains":
        return typeof value === "string" && !value.includes(policyValue);
      case "equal":
        return value === policyValue;
      case "notEqual":
        return value !== policyValue;
      case "regex":
        return typeof value === "string" && new RegExp(policyValue).test(value);
      default:
        return false;
    }
  }

  /**
   * Evaluate trusted data policies for a chat
   *
   * KEY SECURITY PRINCIPLE: Data is UNTRUSTED by default.
   * - Only data that explicitly matches a trusted data policy is considered safe
   * - If no policy matches, the data is considered untrusted
   * - This implements an allowlist approach for maximum security
   * - Policies with action='block_always' take precedence and mark data as blocked
   */
  static async evaluate(
    agentId: string,
    toolName: string,
    // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
    toolOutput: any,
  ): Promise<{
    isTrusted: boolean;
    isBlocked: boolean;
    shouldSanitizeWithDualLlm: boolean;
    reason: string;
  }> {
    /**
     * Get policies for the agent's tools that match the tool name,
     * along with the tool's configuration.
     */
    const applicablePoliciesForAgent = await db
      .select({
        ...getTableColumns(schema.trustedDataPoliciesTable),
        toolResultTreatment: schema.agentToolsTable.toolResultTreatment,
      })
      .from(schema.toolsTable)
      .innerJoin(
        schema.agentToolsTable,
        eq(schema.toolsTable.id, schema.agentToolsTable.toolId),
      )
      .innerJoin(
        schema.trustedDataPoliciesTable,
        eq(
          schema.agentToolsTable.id,
          schema.trustedDataPoliciesTable.agentToolId,
        ),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.toolsTable.name, toolName),
        ),
      );

    // Extract tool configuration (will be the same for all policies since they're for the same tool)
    const toolResultTreatment =
      applicablePoliciesForAgent.length > 0
        ? applicablePoliciesForAgent[0].toolResultTreatment
        : null;

    // If no policies exist for this tool, check the tool's result treatment configuration
    if (toolResultTreatment === null) {
      // Fetch the agent-tool relationship configuration
      const [agentTool] = await db
        .select({
          toolResultTreatment: schema.agentToolsTable.toolResultTreatment,
        })
        .from(schema.toolsTable)
        .innerJoin(
          schema.agentToolsTable,
          eq(schema.toolsTable.id, schema.agentToolsTable.toolId),
        )
        .where(
          and(
            eq(schema.agentToolsTable.agentId, agentId),
            eq(schema.toolsTable.name, toolName),
          ),
        );

      // If no agent-tool relationship exists, default to untrusted
      if (!agentTool) {
        return {
          isTrusted: false,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason: `Tool ${toolName} is not registered for this agent`,
        };
      }

      if (agentTool.toolResultTreatment === "trusted") {
        return {
          isTrusted: true,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason: `Tool ${toolName} is configured as trusted`,
        };
      }

      if (agentTool.toolResultTreatment === "sanitize_with_dual_llm") {
        return {
          isTrusted: false,
          isBlocked: false,
          shouldSanitizeWithDualLlm: true,
          reason: `Tool ${toolName} is configured for dual LLM sanitization`,
        };
      }

      return {
        isTrusted: false,
        isBlocked: false,
        shouldSanitizeWithDualLlm: false,
        reason: `Tool ${toolName} is configured as untrusted`,
      };
    }

    // First, check if ANY policy blocks this data (blocked policies take precedence)
    for (const {
      attributePath,
      operator,
      value: policyValue,
      description,
      action,
    } of applicablePoliciesForAgent) {
      if (action === "block_always") {
        // Extract values from the tool output using the attribute path
        const outputValue = toolOutput?.value || toolOutput;
        const values = TrustedDataPolicyModel.extractValuesFromPath(
          outputValue,
          attributePath,
        );

        // For blocked policies, if ANY extracted value meets the condition, data is blocked
        for (const value of values) {
          if (
            TrustedDataPolicyModel.evaluateCondition(
              value,
              operator,
              policyValue,
            )
          ) {
            return {
              isTrusted: false,
              isBlocked: true,
              shouldSanitizeWithDualLlm: false,
              reason: `Data blocked by policy: ${description}`,
            };
          }
        }
      }
    }

    // Check if ANY policy marks this data as trusted or for dual LLM sanitization (only if not blocked)
    for (const {
      attributePath,
      operator,
      value: policyValue,
      description,
      action,
    } of applicablePoliciesForAgent) {
      if (action === "mark_as_trusted") {
        // Extract values from the tool output using the attribute path
        const outputValue = toolOutput?.value || toolOutput;
        const values = TrustedDataPolicyModel.extractValuesFromPath(
          outputValue,
          attributePath,
        );

        // For trusted data policies, ALL extracted values must meet the condition
        let allValuesTrusted = values.length > 0;
        for (const value of values) {
          if (
            !TrustedDataPolicyModel.evaluateCondition(
              value,
              operator,
              policyValue,
            )
          ) {
            allValuesTrusted = false;
            break;
          }
        }

        if (allValuesTrusted) {
          // At least one policy trusts this data
          return {
            isTrusted: true,
            isBlocked: false,
            shouldSanitizeWithDualLlm: false,
            reason: `Data trusted by policy: ${description}`,
          };
        }
      }

      if (action === "sanitize_with_dual_llm") {
        // Extract values from the tool output using the attribute path
        const outputValue = toolOutput?.value || toolOutput;
        const values = TrustedDataPolicyModel.extractValuesFromPath(
          outputValue,
          attributePath,
        );

        // For sanitize policies, ALL extracted values must meet the condition
        let allValuesMatch = values.length > 0;
        for (const value of values) {
          if (
            !TrustedDataPolicyModel.evaluateCondition(
              value,
              operator,
              policyValue,
            )
          ) {
            allValuesMatch = false;
            break;
          }
        }

        if (allValuesMatch) {
          // At least one policy requires dual LLM sanitization
          return {
            isTrusted: false,
            isBlocked: false,
            shouldSanitizeWithDualLlm: true,
            reason: `Data requires dual LLM sanitization by policy: ${description}`,
          };
        }
      }
    }

    // No policies matched, use the tool's default treatment
    if (toolResultTreatment === "trusted") {
      return {
        isTrusted: true,
        isBlocked: false,
        shouldSanitizeWithDualLlm: false,
        reason: `Tool ${toolName} is configured as trusted`,
      };
    }

    if (toolResultTreatment === "sanitize_with_dual_llm") {
      return {
        isTrusted: false,
        isBlocked: false,
        shouldSanitizeWithDualLlm: true,
        reason: `Tool ${toolName} is configured for dual LLM sanitization`,
      };
    }

    return {
      isTrusted: false,
      isBlocked: false,
      shouldSanitizeWithDualLlm: false,
      reason: "Data does not match any trust policies - considered untrusted",
    };
  }
}

export default TrustedDataPolicyModel;
