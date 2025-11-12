import { and, asc, eq } from "drizzle-orm";
import db from "@/database";
import { optimizationRulesTable } from "@/database/schemas";
import type {
  ContentLengthConditions,
  RuleConditions,
  ToolPresenceConditions,
} from "@/database/schemas/optimization-rule";

export type OptimizationRule = typeof optimizationRulesTable.$inferSelect;
export type NewOptimizationRule = typeof optimizationRulesTable.$inferInsert;

// Allow any string for rule type and provider to support future types without migration
export type OptimizationRuleType = string;
export type LlmProvider = string;

class OptimizationRuleModel {
  static async create(data: {
    agentId: string;
    ruleType: OptimizationRuleType;
    conditions: RuleConditions;
    provider: LlmProvider;
    targetModel: string;
    priority?: number;
    enabled?: boolean;
  }): Promise<OptimizationRule> {
    const [rule] = await db
      .insert(optimizationRulesTable)
      .values({
        agentId: data.agentId,
        ruleType: data.ruleType,
        conditions: data.conditions,
        provider: data.provider,
        targetModel: data.targetModel,
        priority: data.priority ?? 0,
        enabled: data.enabled ?? true,
      })
      .returning();

    if (!rule) {
      throw new Error("Failed to create optimization rule");
    }

    return rule;
  }

  static async findByAgentId(agentId: string): Promise<OptimizationRule[]> {
    const rules = await db
      .select()
      .from(optimizationRulesTable)
      .where(eq(optimizationRulesTable.agentId, agentId))
      .orderBy(asc(optimizationRulesTable.priority));

    return rules;
  }

  static async findByAgentIdAndProvider(
    agentId: string,
    provider: LlmProvider,
  ): Promise<OptimizationRule[]> {
    const rules = await db
      .select()
      .from(optimizationRulesTable)
      .where(
        and(
          eq(optimizationRulesTable.agentId, agentId),
          eq(optimizationRulesTable.provider, provider),
        ),
      )
      .orderBy(asc(optimizationRulesTable.priority));

    return rules;
  }

  static async findEnabledByAgentIdAndProvider(
    agentId: string,
    provider: LlmProvider,
  ): Promise<OptimizationRule[]> {
    const rules = await db
      .select()
      .from(optimizationRulesTable)
      .where(
        and(
          eq(optimizationRulesTable.agentId, agentId),
          eq(optimizationRulesTable.provider, provider),
          eq(optimizationRulesTable.enabled, true),
        ),
      )
      .orderBy(asc(optimizationRulesTable.priority));

    return rules;
  }

  static async update(
    id: string,
    data: Partial<{
      ruleType: OptimizationRuleType;
      conditions: RuleConditions;
      provider: LlmProvider;
      targetModel: string;
      priority: number;
      enabled: boolean;
    }>,
  ): Promise<OptimizationRule | undefined> {
    const [rule] = await db
      .update(optimizationRulesTable)
      .set(data)
      .where(eq(optimizationRulesTable.id, id))
      .returning();

    return rule;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(optimizationRulesTable)
      .where(eq(optimizationRulesTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }

  // Evaluate rules for a given agent and context
  static evaluateRules(
    rules: OptimizationRule[],
    context: {
      contentLength: number;
      hasTools: boolean;
    },
  ): string | null {
    for (const rule of rules) {
      if (!rule.enabled) continue;

      let matches = false;

      switch (rule.ruleType) {
        case "content_length": {
          const conditions = rule.conditions as ContentLengthConditions;
          matches = context.contentLength <= conditions.maxLength;
          break;
        }
        case "tool_presence": {
          const conditions = rule.conditions as ToolPresenceConditions;
          matches = context.hasTools === conditions.hasTools;
          break;
        }
      }

      if (matches) {
        return rule.targetModel;
      }
    }

    return null;
  }
}

export default OptimizationRuleModel;
