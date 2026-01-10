import { isArchestraMcpServerTool } from "@shared";
import { and, desc, eq, inArray } from "drizzle-orm";
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
    const policy = await TrustedDataPolicyModel.findById(id);
    if (!policy) {
      return false;
    }

    const result = await db
      .delete(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.id, id));

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
    // Use bulk evaluation for single tool
    const results = await TrustedDataPolicyModel.evaluateBulk(agentId, [
      { toolName, toolOutput },
    ]);
    return (
      results.get("0") || {
        isTrusted: false,
        isBlocked: false,
        shouldSanitizeWithDualLlm: false,
        reason: "Tool not found",
      }
    );
  }

  /**
   * Bulk evaluate trusted data policies for multiple tool calls
   * This method fetches all policies and tool configurations in one query to avoid N+1 issues
   */
  static async evaluateBulk(
    agentId: string,
    toolCalls: Array<{
      toolName: string;
      // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
      toolOutput: any;
    }>,
  ): Promise<
    Map<
      string,
      {
        isTrusted: boolean;
        isBlocked: boolean;
        shouldSanitizeWithDualLlm: boolean;
        reason: string;
      }
    >
  > {
    const results = new Map<
      string,
      {
        isTrusted: boolean;
        isBlocked: boolean;
        shouldSanitizeWithDualLlm: boolean;
        reason: string;
      }
    >();

    // Create an index mapping for results
    const callIndices: number[] = [];

    // Handle Archestra MCP server tools
    for (let i = 0; i < toolCalls.length; i++) {
      const { toolName } = toolCalls[i];
      if (isArchestraMcpServerTool(toolName)) {
        // Store result by index converted to string
        results.set(i.toString(), {
          isTrusted: true,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason: "Archestra MCP server tool",
        });
      } else {
        callIndices.push(i);
      }
    }

    // Get all non-Archestra tool names
    const nonArchestraToolCalls = toolCalls.filter(
      ({ toolName }) => !isArchestraMcpServerTool(toolName),
    );

    if (nonArchestraToolCalls.length === 0) {
      return results;
    }

    const toolNames = nonArchestraToolCalls.map(({ toolName }) => toolName);

    // Fetch all policies and tool configurations for all tools in one query
    const allPoliciesAndTools = await db
      .select({
        toolName: schema.toolsTable.name,
        policyId: schema.trustedDataPoliciesTable.id,
        policyDescription: schema.trustedDataPoliciesTable.description,
        attributePath: schema.trustedDataPoliciesTable.attributePath,
        operator: schema.trustedDataPoliciesTable.operator,
        policyValue: schema.trustedDataPoliciesTable.value,
        action: schema.trustedDataPoliciesTable.action,
        toolResultTreatment: schema.agentToolsTable.toolResultTreatment,
      })
      .from(schema.toolsTable)
      .innerJoin(
        schema.agentToolsTable,
        eq(schema.toolsTable.id, schema.agentToolsTable.toolId),
      )
      .leftJoin(
        schema.trustedDataPoliciesTable,
        eq(
          schema.agentToolsTable.id,
          schema.trustedDataPoliciesTable.agentToolId,
        ),
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
      Array<{
        policyId: string | null;
        policyDescription: string | null;
        attributePath: string | null;
        operator: AutonomyPolicyOperator.SupportedOperator | null;
        policyValue: string | null;
        action:
          | "mark_as_trusted"
          | "block_always"
          | "sanitize_with_dual_llm"
          | null;
        toolResultTreatment:
          | "trusted"
          | "untrusted"
          | "sanitize_with_dual_llm"
          | null;
      }>
    >();

    // Also track tools that have no agent-tool relationship
    const toolsWithRelationship = new Set<string>();

    for (const row of allPoliciesAndTools) {
      toolsWithRelationship.add(row.toolName);

      if (!policiesByTool.has(row.toolName)) {
        policiesByTool.set(row.toolName, []);
      }

      policiesByTool.get(row.toolName)?.push({
        policyId: row.policyId,
        policyDescription: row.policyDescription,
        attributePath: row.attributePath,
        operator: row.operator,
        policyValue: row.policyValue,
        action: row.action,
        toolResultTreatment: row.toolResultTreatment,
      });
    }

    // Process each tool call individually with index
    for (let i = 0; i < toolCalls.length; i++) {
      const { toolName, toolOutput } = toolCalls[i];

      // Skip Archestra tools (already handled)
      if (isArchestraMcpServerTool(toolName)) {
        continue;
      }

      // If tool has no agent-tool relationship
      if (!toolsWithRelationship.has(toolName)) {
        results.set(i.toString(), {
          isTrusted: false,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason: `Tool ${toolName} is not registered for this agent`,
        });
        continue;
      }

      const policies = policiesByTool.get(toolName) || [];

      // Get tool result treatment (will be same for all policies of the same tool)
      const toolResultTreatment =
        policies.length > 0 ? policies[0].toolResultTreatment : null;

      // Check if there are any actual policies (not just the tool config)
      const hasPolicies = policies.some((p) => p.policyId !== null);

      if (!hasPolicies) {
        // No policies, use tool's default treatment
        if (toolResultTreatment === "trusted") {
          results.set(i.toString(), {
            isTrusted: true,
            isBlocked: false,
            shouldSanitizeWithDualLlm: false,
            reason: `Tool ${toolName} is configured as trusted`,
          });
        } else if (toolResultTreatment === "sanitize_with_dual_llm") {
          results.set(i.toString(), {
            isTrusted: false,
            isBlocked: false,
            shouldSanitizeWithDualLlm: true,
            reason: `Tool ${toolName} is configured for dual LLM sanitization`,
          });
        } else {
          results.set(i.toString(), {
            isTrusted: false,
            isBlocked: false,
            shouldSanitizeWithDualLlm: false,
            reason: `Tool ${toolName} is configured as untrusted`,
          });
        }
        continue;
      }

      // Process policies - first check for blocking policies
      let isBlocked = false;
      let blockReason = "";

      for (const policy of policies) {
        if (policy.action === "block_always" && policy.attributePath) {
          const outputValue = toolOutput?.value || toolOutput;
          const values = TrustedDataPolicyModel.extractValuesFromPath(
            outputValue,
            policy.attributePath,
          );

          for (const value of values) {
            if (
              policy.operator &&
              policy.policyValue !== null &&
              TrustedDataPolicyModel.evaluateCondition(
                value,
                policy.operator,
                policy.policyValue,
              )
            ) {
              isBlocked = true;
              blockReason = `Data blocked by policy: ${policy.policyDescription}`;
              break;
            }
          }
          if (isBlocked) break;
        }
      }

      if (isBlocked) {
        results.set(i.toString(), {
          isTrusted: false,
          isBlocked: true,
          shouldSanitizeWithDualLlm: false,
          reason: blockReason,
        });
        continue;
      }

      // Check for trusted or sanitize policies
      let isTrusted = false;
      let shouldSanitize = false;
      let policyReason = "";

      for (const policy of policies) {
        if (policy.action === "mark_as_trusted" && policy.attributePath) {
          const outputValue = toolOutput?.value || toolOutput;
          const values = TrustedDataPolicyModel.extractValuesFromPath(
            outputValue,
            policy.attributePath,
          );

          let allValuesTrusted = values.length > 0;
          for (const value of values) {
            if (
              !policy.operator ||
              policy.policyValue === null ||
              !TrustedDataPolicyModel.evaluateCondition(
                value,
                policy.operator,
                policy.policyValue,
              )
            ) {
              allValuesTrusted = false;
              break;
            }
          }

          if (allValuesTrusted) {
            isTrusted = true;
            policyReason = `Data trusted by policy: ${policy.policyDescription}`;
            break;
          }
        } else if (
          policy.action === "sanitize_with_dual_llm" &&
          policy.attributePath
        ) {
          const outputValue = toolOutput?.value || toolOutput;
          const values = TrustedDataPolicyModel.extractValuesFromPath(
            outputValue,
            policy.attributePath,
          );

          let allValuesMatch = values.length > 0;
          for (const value of values) {
            if (
              !policy.operator ||
              policy.policyValue === null ||
              !TrustedDataPolicyModel.evaluateCondition(
                value,
                policy.operator,
                policy.policyValue,
              )
            ) {
              allValuesMatch = false;
              break;
            }
          }

          if (allValuesMatch) {
            shouldSanitize = true;
            policyReason = `Data requires dual LLM sanitization by policy: ${policy.policyDescription}`;
            break;
          }
        }
      }

      if (isTrusted) {
        results.set(i.toString(), {
          isTrusted: true,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason: policyReason,
        });
      } else if (shouldSanitize) {
        results.set(i.toString(), {
          isTrusted: false,
          isBlocked: false,
          shouldSanitizeWithDualLlm: true,
          reason: policyReason,
        });
      } else if (toolResultTreatment === "trusted") {
        results.set(i.toString(), {
          isTrusted: true,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason: `Tool ${toolName} is configured as trusted`,
        });
      } else if (toolResultTreatment === "sanitize_with_dual_llm") {
        results.set(i.toString(), {
          isTrusted: false,
          isBlocked: false,
          shouldSanitizeWithDualLlm: true,
          reason: `Tool ${toolName} is configured for dual LLM sanitization`,
        });
      } else {
        results.set(i.toString(), {
          isTrusted: false,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason:
            "Data does not match any trust policies - considered untrusted",
        });
      }
    }

    return results;
  }
}

export default TrustedDataPolicyModel;
