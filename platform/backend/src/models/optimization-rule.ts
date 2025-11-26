import { and, eq, getTableColumns, or } from "drizzle-orm";
import db, { schema } from "@/database";
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
   * Get all unique providers from interactions table
   */
  private static async getAllProvidersFromInteractions(): Promise<
    SupportedProvider[]
  > {
    const results = await db
      .select({
        providerDiscriminator: schema.interactionsTable.type,
      })
      .from(schema.interactionsTable)
      .groupBy(schema.interactionsTable.type);

    // Convert discriminators like "openai:chatCompletions" to providers like "openai"
    const providers = results
      .map((row) => row.providerDiscriminator?.split(":")[0])
      .filter(Boolean) as SupportedProvider[];

    // Return unique providers
    return [...new Set(providers)];
  }

  /**
   * Ensure default optimization rules and token prices exist for common cheaper models
   * @param organizationId - The organization ID
   */
  static async ensureDefaultOptimizationRules(
    organizationId: string,
  ): Promise<void> {
    // Define prices per provider
    const pricesByProvider: Record<SupportedProvider, InsertTokenPrice[]> = {
      openai: [
        {
          model: "gpt-4o-mini",
          pricePerMillionInput: "0.15",
          pricePerMillionOutput: "0.60",
        },
      ],
      anthropic: [
        {
          model: "claude-3-5-sonnet",
          pricePerMillionInput: "3.00",
          pricePerMillionOutput: "15.00",
        },
      ],
      gemini: [],
    };

    // Define rules per provider
    const rulesByProvider: Record<SupportedProvider, InsertOptimizationRule[]> =
      {
        openai: [
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
        ],
        anthropic: [
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
        ],
        gemini: [],
      };

    // Filter by provider if specified, otherwise get providers from interactions
    let providers: SupportedProvider[] =
      await OptimizationRuleModel.getAllProvidersFromInteractions();

    // Fall back to Anthropic if no interactions exist yet
    if (providers.length === 0) {
      providers = ["anthropic"];
    }

    const defaultPrices = providers.flatMap((p) => pricesByProvider[p]);
    const defaultRules = providers.flatMap((p) => rulesByProvider[p]);

    // Insert token prices
    if (defaultPrices.length > 0) {
      await db
        .insert(schema.tokenPricesTable)
        .values(defaultPrices)
        .onConflictDoNothing({
          target: schema.tokenPricesTable.model,
        });
    }

    // Get existing rules for this organization
    const existingRules =
      await OptimizationRuleModel.findByOrganizationId(organizationId);

    // Get providers that already have rules (don't add defaults if any rules exist for provider)
    const providersWithRules = new Set(
      existingRules.map((rule) => rule.provider),
    );

    // Only insert rules for providers that have no existing rules
    const rulesToCreate = defaultRules.filter(
      (rule) => !providersWithRules.has(rule.provider),
    );

    // Insert new rules
    if (rulesToCreate.length > 0) {
      await db.insert(schema.optimizationRulesTable).values(rulesToCreate);
    }
  }
}

export default OptimizationRuleModel;
