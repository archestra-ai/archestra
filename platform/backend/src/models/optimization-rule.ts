import type { SupportedProvider } from "@shared";
import { and, asc, eq, getTableColumns, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import getDefaultModelPrice from "@/default-model-prices";
import logger from "@/logging";
import type {
  InsertOptimizationRule,
  InsertTokenPrice,
  OptimizationRule,
  UpdateOptimizationRule,
} from "@/types";

class OptimizationRuleModel {
  /**
   * Create a new optimization rule
   */
  static async create(data: InsertOptimizationRule): Promise<OptimizationRule> {
    logger.debug(
      {
        entityType: data.entityType,
        entityId: data.entityId,
        provider: data.provider,
      },
      "OptimizationRuleModel.create: creating rule",
    );
    const [rule] = await db
      .insert(schema.optimizationRulesTable)
      .values(data)
      .returning();

    logger.debug(
      { ruleId: rule.id },
      "OptimizationRuleModel.create: completed",
    );
    return rule;
  }

  /**
   * Find all rules for an organization (including team-level rules)
   */
  static async findByOrganizationId(
    organizationId: string,
  ): Promise<OptimizationRule[]> {
    logger.debug(
      { organizationId },
      "OptimizationRuleModel.findByOrganizationId: fetching rules",
    );
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
      .orderBy(asc(schema.optimizationRulesTable.createdAt));

    logger.debug(
      { organizationId, count: rules.length },
      "OptimizationRuleModel.findByOrganizationId: completed",
    );
    return rules;
  }

  /**
   * Find enabled rules for an organization and provider
   */
  static async findEnabledByOrganizationAndProvider(
    organizationId: string,
    provider: SupportedProvider,
  ): Promise<OptimizationRule[]> {
    logger.debug(
      { organizationId, provider },
      "OptimizationRuleModel.findEnabledByOrganizationAndProvider: fetching rules",
    );
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
      .orderBy(asc(schema.optimizationRulesTable.createdAt));

    logger.debug(
      { organizationId, provider, count: rules.length },
      "OptimizationRuleModel.findEnabledByOrganizationAndProvider: completed",
    );
    return rules;
  }

  /**
   * Get the first organization ID that has optimization rules
   * Used as fallback when an agent has no teams
   */
  static async getFirstOrganizationId(): Promise<string | null> {
    logger.debug(
      "OptimizationRuleModel.getFirstOrganizationId: fetching first organization with rules",
    );
    const [result] = await db
      .select({ entityId: schema.optimizationRulesTable.entityId })
      .from(schema.optimizationRulesTable)
      .where(sql`${schema.optimizationRulesTable.entityType} = 'organization'`)
      .limit(1);

    const organizationId = result?.entityId || null;
    logger.debug(
      { organizationId },
      "OptimizationRuleModel.getFirstOrganizationId: completed",
    );
    return organizationId;
  }

  /**
   * Update an optimization rule
   */
  static async update(
    id: string,
    data: Partial<UpdateOptimizationRule>,
  ): Promise<OptimizationRule | undefined> {
    logger.debug({ id, data }, "OptimizationRuleModel.update: updating rule");
    const [rule] = await db
      .update(schema.optimizationRulesTable)
      .set(data)
      .where(eq(schema.optimizationRulesTable.id, id))
      .returning();

    logger.debug(
      { id, updated: !!rule },
      "OptimizationRuleModel.update: completed",
    );
    return rule;
  }

  /**
   * Delete an optimization rule
   */
  static async delete(id: string): Promise<boolean> {
    logger.debug({ id }, "OptimizationRuleModel.delete: deleting rule");
    const result = await db
      .delete(schema.optimizationRulesTable)
      .where(eq(schema.optimizationRulesTable.id, id));

    const deleted = result.rowCount !== null && result.rowCount > 0;
    logger.debug({ id, deleted }, "OptimizationRuleModel.delete: completed");
    return deleted;
  }

  /**
   * Evaluate rules for a given context.
   * Returns the target model of the first matching rule, or null if no match.
   */
  static matchByRules(
    rules: OptimizationRule[],
    context: {
      tokenCount: number;
      hasTools: boolean;
    },
  ): string | null {
    logger.debug(
      { rulesCount: rules.length, context },
      "OptimizationRuleModel.matchByRules: evaluating rules",
    );
    for (const rule of rules) {
      if (!rule.enabled) continue;

      logger.debug(
        { ruleId: rule.id, conditions: rule.conditions, context },
        "OptimizationRuleModel.matchByRules: checking rule",
      );

      // Check if all conditions in the array match
      const allConditionsMatch = rule.conditions.every((condition) => {
        if ("maxLength" in condition) {
          return context.tokenCount <= condition.maxLength;
        }
        if ("hasTools" in condition) {
          return context.hasTools === condition.hasTools;
        }
        return false;
      });

      if (allConditionsMatch) {
        logger.debug(
          { ruleId: rule.id, targetModel: rule.targetModel },
          "OptimizationRuleModel.matchByRules: rule matched",
        );
        return rule.targetModel;
      }
    }

    logger.debug("OptimizationRuleModel.matchByRules: no rules matched");
    return null;
  }

  /**
   * Get all unique providers from interactions table
   */
  private static async getAllProvidersFromInteractions(): Promise<
    SupportedProvider[]
  > {
    logger.debug(
      "OptimizationRuleModel.getAllProvidersFromInteractions: fetching providers",
    );
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
    const uniqueProviders = [...new Set(providers)];
    logger.debug(
      { providers: uniqueProviders },
      "OptimizationRuleModel.getAllProvidersFromInteractions: completed",
    );
    return uniqueProviders;
  }

  /**
   * Ensure default optimization rules and token prices exist for common cheaper models
   * @param organizationId - The organization ID
   */
  static async ensureDefaultOptimizationRules(
    organizationId: string,
  ): Promise<void> {
    logger.debug(
      { organizationId },
      "OptimizationRuleModel.ensureDefaultOptimizationRules: starting",
    );
    const pricesByProvider: Record<SupportedProvider, InsertTokenPrice[]> = {
      openai: [
        {
          provider: "openai",
          model: "gpt-5-mini",
          ...getDefaultModelPrice("gpt-5-mini"),
        },
      ],
      anthropic: [
        {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          ...getDefaultModelPrice("claude-haiku-4-5"),
        },
      ],
      gemini: [],
      cerebras: [],
      vllm: [], // vLLM model pricing varies by deployment, so no defaults
      ollama: [], // Ollama model pricing varies by deployment, so no defaults
    };

    // Define rules per provider
    const rulesByProvider: Record<SupportedProvider, InsertOptimizationRule[]> =
      {
        openai: [
          {
            entityType: "organization",
            entityId: organizationId,
            conditions: [{ maxLength: 1000 }],
            provider: "openai",
            targetModel: "gpt-5-mini",
            enabled: true,
          },
        ],
        anthropic: [
          {
            entityType: "organization",
            entityId: organizationId,
            // Adding a hasTools: false will not work with chat because it has tools
            conditions: [{ maxLength: 1000 }],
            provider: "anthropic",
            targetModel: "claude-haiku-4-5",
            enabled: true,
          },
        ],
        gemini: [],
        cerebras: [],
        vllm: [], // vLLM optimization rules are deployment-specific, no defaults
        ollama: [], // Ollama optimization rules are deployment-specific, no defaults
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
      logger.debug(
        { count: defaultPrices.length },
        "OptimizationRuleModel.ensureDefaultOptimizationRules: inserted token prices",
      );
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
      logger.debug(
        { count: rulesToCreate.length },
        "OptimizationRuleModel.ensureDefaultOptimizationRules: inserted default rules",
      );
    }

    logger.debug(
      { organizationId },
      "OptimizationRuleModel.ensureDefaultOptimizationRules: completed",
    );
  }
}

export default OptimizationRuleModel;
