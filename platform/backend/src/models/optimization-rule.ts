import { and, eq, getTableColumns, or } from "drizzle-orm";
import db, { schema } from "@/database";
import TokenPriceModel from "@/models/token-price";
import type {
  ContentLengthConditions,
  InsertOptimizationRule,
  InsertTokenPrice,
  OptimizationRule,
  SupportedProvider,
  ToolPresenceConditions,
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
      );

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
      );

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

  // Evaluate rules for a given context
  // Rules are grouped by models. If all rules in such group match, returns the model.
  static matchByRules(
    rules: OptimizationRule[],
    context: {
      tokenCount: number;
      hasTools: boolean;
    },
  ): string | null {
    const rulesByModel: Record<string, OptimizationRule[]> = {};

    for (const rule of rules) {
      if (!rule.enabled) continue;

      const model = rule.targetModel;
      if (!rulesByModel[model]) {
        rulesByModel[model] = [];
      }
      rulesByModel[model].push(rule);
    }

    for (const [model, modelRules] of Object.entries(rulesByModel)) {
      let match = true;

      for (const rule of modelRules) {
        if (rule.ruleType === "content_length") {
          const conditions = rule.conditions as ContentLengthConditions;
          if (context.tokenCount > conditions.maxLength) {
            match = false;
            break;
          }
        } else if (rule.ruleType === "tool_presence") {
          const conditions = rule.conditions as ToolPresenceConditions;
          if (context.hasTools !== conditions.hasTools) {
            match = false;
            break;
          }
        }
      }

      if (match) {
        return model;
      }
    }

    return null;
  }

  /**
   * Ensure default optimization rules and token prices exist for common cheaper models
   */
  static async ensureDefaultOptimizationRules(
    organizationId: string,
  ): Promise<void> {
    // First ensure token prices exist for the models used in optimization rules
    const defaultPrices: InsertTokenPrice[] = [
      {
        model: "gpt-4o-mini",
        pricePerMillionInput: "0.15",
        pricePerMillionOutput: "0.60",
      },
      {
        model: "claude-3-5-sonnet",
        pricePerMillionInput: "3.00",
        pricePerMillionOutput: "15.00",
      },
    ];

    await db
      .insert(schema.tokenPricesTable)
      .values(defaultPrices)
      .onConflictDoNothing({
        target: schema.tokenPricesTable.model,
      });

    const defaultRules: InsertOptimizationRule[] = [
      // OpenAI rules
      {
        entityType: "organization",
        entityId: organizationId,
        ruleType: "tool_presence",
        conditions: { hasTools: false },
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      },
      {
        entityType: "organization",
        entityId: organizationId,
        ruleType: "content_length",
        conditions: { maxLength: 1000 },
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      },
      // Anthropic rules
      {
        entityType: "organization",
        entityId: organizationId,
        ruleType: "tool_presence",
        conditions: { hasTools: false },
        provider: "anthropic",
        targetModel: "claude-3-5-sonnet",
        enabled: true,
      },
      {
        entityType: "organization",
        entityId: organizationId,
        ruleType: "content_length",
        conditions: { maxLength: 1000 },
        provider: "anthropic",
        targetModel: "claude-3-5-sonnet",
        enabled: true,
      },
    ];

    // Get existing rules for this organization
    const existingRules =
      await OptimizationRuleModel.findByOrganizationId(organizationId);

    // Filter out rules that already exist
    const rulesToCreate = defaultRules.filter((rule) => {
      return !existingRules.some(
        (existing) =>
          existing.entityType === rule.entityType &&
          existing.entityId === rule.entityId &&
          existing.provider === rule.provider &&
          existing.ruleType === rule.ruleType &&
          JSON.stringify(existing.conditions) ===
            JSON.stringify(rule.conditions),
      );
    });

    // Insert new rules
    if (rulesToCreate.length > 0) {
      await db.insert(schema.optimizationRulesTable).values(rulesToCreate);
    }
  }
}

export default OptimizationRuleModel;
