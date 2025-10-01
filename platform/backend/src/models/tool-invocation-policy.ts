import { and, eq } from "drizzle-orm";
import _ from "lodash";
import db, { schema } from "../database";
import type { ToolInvocation } from "../types";

type EvaluationResult = {
  isAllowed: boolean;
  denyReason: string;
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
    return db.select().from(schema.toolInvocationPoliciesTable);
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

  static async findByToolId(
    toolId: string,
  ): Promise<ToolInvocation.ToolInvocationPolicy[]> {
    return db
      .select()
      .from(schema.toolInvocationPoliciesTable)
      .where(eq(schema.toolInvocationPoliciesTable.toolId, toolId));
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
   * Evaluate tool invocation policies for an agent
   */
  static async evaluateForAgent(
    agentId: string,
    toolName: string,
    // biome-ignore lint/suspicious/noExplicitAny: tool inputs can be any shape
    toolInput: Record<string, any>,
  ): Promise<EvaluationResult> {
    /**
     * Get policies assigned to this agent that also match the tool name
     */
    const applicablePoliciesForAgent = await db
      .select({
        policy: schema.toolInvocationPoliciesTable,
      })
      .from(schema.agentToolInvocationPoliciesTable)
      .innerJoin(
        schema.toolInvocationPoliciesTable,
        eq(
          schema.agentToolInvocationPoliciesTable.policyId,
          schema.toolInvocationPoliciesTable.id,
        ),
      )
      .innerJoin(
        schema.toolsTable,
        eq(schema.toolInvocationPoliciesTable.toolId, schema.toolsTable.id),
      )
      .where(
        // Filter to policies that match the tool id
        and(
          eq(schema.agentToolInvocationPoliciesTable.agentId, agentId),
          eq(schema.toolsTable.name, toolName),
        ),
      );

    // Evaluate each policy
    for (const { policy } of applicablePoliciesForAgent) {
      const {
        argumentName,
        operator,
        value: policyValue,
        action,
        description,
        blockPrompt,
      } = policy;

      // Extract the argument value using lodash
      const argumentValue = _.get(toolInput, argumentName);

      if (argumentValue === undefined) {
        // If the argument doesn't exist and we have a block policy, that's okay
        if (action === "block") {
          continue;
        }
        // If it's an allow policy and the argument is missing, that's a problem
        return {
          isAllowed: false,
          denyReason: `Missing required argument: ${argumentName}`,
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
      if (action === "allow") {
        // Policy says "allow" when condition is met
        if (!conditionMet) {
          return {
            isAllowed: false,
            denyReason: blockPrompt || `Policy violation: ${description}`,
          };
        }
      } else {
        // Policy says "block" when condition is met
        if (conditionMet) {
          return {
            isAllowed: false,
            denyReason: blockPrompt || `Policy violation: ${description}`,
          };
        }
      }
    }

    // All policies passed
    return {
      isAllowed: true,
      denyReason: "",
    };
  }
}

export default ToolInvocationPolicyModel;
