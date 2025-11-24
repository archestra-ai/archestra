import { and, asc, eq, getTableColumns, or } from "drizzle-orm";
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

  static async findByOrganizationId(
    organizationId: string,
  ): Promise<OptimizationRule[]> {
    const rules = await db
      .select(getTableColumns(schema.optimizationRulesTable))
      .from(schema.optimizationRulesTable)
      .leftJoin(
        schema.teamsTable,
        and(
          eq(schema.optimizationRulesTable.entityType, "team"),
          eq(schema.optimizationRulesTable.entityId, schema.teamsTable.id),
        ),
      )
      .where(
        or(
          // Organization-level rules
          and(
            eq(schema.optimizationRulesTable.entityType, "organization"),
            eq(schema.optimizationRulesTable.entityId, organizationId),
          ),
          // Team-level rules for teams in this organization
          and(
            eq(schema.optimizationRulesTable.entityType, "team"),
            eq(schema.teamsTable.organizationId, organizationId),
          ),
        ),
      )
      .orderBy(asc(schema.optimizationRulesTable.priority));

    return rules;
  }

  static async findEnabledByOrganizationAndProvider(
    organizationId: string,
    provider: SupportedProvider,
  ): Promise<OptimizationRule[]> {
    const rules = await db
      .select()
      .from(schema.optimizationRulesTable)
      .where(
        and(
          eq(schema.optimizationRulesTable.entityType, "organization"),
          eq(schema.optimizationRulesTable.entityId, organizationId),
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
      tokenCount: number;
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
          matches = context.tokenCount <= conditions.maxLength;
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
