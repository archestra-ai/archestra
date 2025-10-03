import { and, desc, eq, getTableColumns } from "drizzle-orm";
import _ from "lodash";
import db, { schema } from "../database";
import type { AutonomyPolicyOperator, TrustedData } from "../types";
import ToolModel from "./tool";

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

  static async findByToolId(
    toolId: string,
  ): Promise<TrustedData.TrustedDataPolicy[]> {
    return db
      .select()
      .from(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.toolId, toolId));
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

      const array = _.get(obj, arrayPath);
      if (!Array.isArray(array)) {
        return [];
      }

      return array
        .map((item) => _.get(item, itemPath))
        .filter((v) => v !== undefined);
    }
    // Simple path without wildcards
    const value = _.get(obj, path);
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
    chatId: string,
    toolName: string,
    // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
    toolOutput: any,
  ): Promise<{
    isTrusted: boolean;
    isBlocked: boolean;
    reason: string;
  }> {
    /**
     * Get policies for the agent's tools that match the tool name,
     * along with the tool's configuration
     */
    const applicablePoliciesForAgent = await db
      .select({
        ...getTableColumns(schema.trustedDataPoliciesTable),
        dataIsTrustedByDefault: schema.toolsTable.dataIsTrustedByDefault,
      })
      .from(schema.chatsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.chatsTable.agentId, schema.toolsTable.agentId),
      )
      .innerJoin(
        schema.trustedDataPoliciesTable,
        eq(schema.toolsTable.id, schema.trustedDataPoliciesTable.toolId),
      )
      .where(
        and(
          eq(schema.chatsTable.id, chatId),
          eq(schema.toolsTable.name, toolName),
        ),
      );

    // Extract tool configuration (will be the same for all policies since they're for the same tool)
    const dataIsTrustedByDefault =
      applicablePoliciesForAgent.length > 0
        ? applicablePoliciesForAgent[0].dataIsTrustedByDefault
        : null;

    // If no policies exist for this tool, check if data is trusted by default
    if (dataIsTrustedByDefault === null) {
      // Fetch the tool directly to check dataIsTrustedByDefault
      const tool = await ToolModel.findByName(toolName);

      if (tool?.dataIsTrustedByDefault) {
        return {
          isTrusted: true,
          isBlocked: false,
          reason: `Tool ${toolName} is configured to trust data by default`,
        };
      }

      return {
        isTrusted: false,
        isBlocked: false,
        reason: `No trust policy defined for tool ${toolName} - data is untrusted by default`,
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
              reason: `Data blocked by policy: ${description}`,
            };
          }
        }
      }
    }

    // Check if ANY policy marks this data as trusted (only if not blocked)
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
            reason: `Data trusted by policy: ${description}`,
          };
        }
      }
    }

    // No policies trust this data, check if the tool trusts data by default
    if (dataIsTrustedByDefault) {
      return {
        isTrusted: true,
        isBlocked: false,
        reason: `Tool ${toolName} is configured to trust data by default`,
      };
    }

    return {
      isTrusted: false,
      isBlocked: false,
      reason: "Data does not match any trust policies - considered untrusted",
    };
  }
}

export default TrustedDataPolicyModel;
