import { and, asc, eq } from "drizzle-orm";
import db from "@/database";
import { optimizationRulesTable } from "@/database/schemas";
import type {
  InsertOptimizationRule,
  OptimizationRule,
  OptimizationRuleContentLengthConditions,
  OptimizationRuleToolPresenceConditions,
  SupportedProvider,
  UpdateOptimizationRule,
} from "@/types";

class OptimizationRuleModel {
  static async create(data: InsertOptimizationRule): Promise<OptimizationRule> {
    const [rule] = await db
      .insert(optimizationRulesTable)
      .values(data)
      .returning();

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
    provider: SupportedProvider,
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
    provider: SupportedProvider,
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
    data: Partial<UpdateOptimizationRule>,
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
          const conditions =
            rule.conditions as OptimizationRuleContentLengthConditions;
          matches = context.contentLength <= conditions.maxLength;
          break;
        }
        case "tool_presence": {
          const conditions =
            rule.conditions as OptimizationRuleToolPresenceConditions;
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
