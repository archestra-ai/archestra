import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
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
      .insert(schema.optimizationRulesTable)
      .values(data)
      .returning();

    return rule;
  }

  static async findByAgentId(agentId: string): Promise<OptimizationRule[]> {
    const rules = await db
      .select()
      .from(schema.optimizationRulesTable)
      .where(eq(schema.optimizationRulesTable.agentId, agentId))
      .orderBy(asc(schema.optimizationRulesTable.priority));

    return rules;
  }

  static async findByAgentIdAndProvider(
    agentId: string,
    provider: SupportedProvider,
  ): Promise<OptimizationRule[]> {
    const rules = await db
      .select()
      .from(schema.optimizationRulesTable)
      .where(
        and(
          eq(schema.optimizationRulesTable.agentId, agentId),
          eq(schema.optimizationRulesTable.provider, provider),
        ),
      )
      .orderBy(asc(schema.optimizationRulesTable.priority));

    return rules;
  }

  static async findEnabledByAgentIdAndProvider(
    agentId: string,
    provider: SupportedProvider,
  ): Promise<OptimizationRule[]> {
    const rules = await db
      .select()
      .from(schema.optimizationRulesTable)
      .where(
        and(
          eq(schema.optimizationRulesTable.agentId, agentId),
          eq(schema.optimizationRulesTable.provider, provider),
          eq(schema.optimizationRulesTable.enabled, true),
        ),
      )
      .orderBy(asc(schema.optimizationRulesTable.priority));

    return rules;
  }

  static async update(
    id: string,
    data: Partial<UpdateOptimizationRule>,
  ): Promise<OptimizationRule | undefined> {
    const [rule] = await db
      .update(schema.optimizationRulesTable)
      .set(data)
      .where(eq(schema.optimizationRulesTable.id, id))
      .returning();

    return rule;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.optimizationRulesTable)
      .where(eq(schema.optimizationRulesTable.id, id));

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
