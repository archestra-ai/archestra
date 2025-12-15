import type { SupportedProvider } from "@shared";
import { asc, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import getDefaultModelPrice from "@/default-model-prices";
import type { CreateTokenPrice, TokenPrice } from "@/types";

class TokenPriceModel {
  static async findAll(): Promise<TokenPrice[]> {
    return await db
      .select()
      .from(schema.tokenPricesTable)
      .orderBy(asc(schema.tokenPricesTable.createdAt));
  }

  static async findById(id: string): Promise<TokenPrice | null> {
    const [tokenPrice] = await db
      .select()
      .from(schema.tokenPricesTable)
      .where(eq(schema.tokenPricesTable.id, id));

    return tokenPrice || null;
  }

  static async findByModel(model: string): Promise<TokenPrice | null> {
    const [tokenPrice] = await db
      .select()
      .from(schema.tokenPricesTable)
      .where(eq(schema.tokenPricesTable.model, model));

    return tokenPrice || null;
  }

  static async create(data: CreateTokenPrice): Promise<TokenPrice> {
    const [tokenPrice] = await db
      .insert(schema.tokenPricesTable)
      .values(data)
      .returning();

    return tokenPrice;
  }

  static async update(
    id: string,
    data: Partial<CreateTokenPrice>,
  ): Promise<TokenPrice | null> {
    const [tokenPrice] = await db
      .update(schema.tokenPricesTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.tokenPricesTable.id, id))
      .returning();

    return tokenPrice || null;
  }

  static async upsertForModel(
    model: string,
    data: Omit<CreateTokenPrice, "model">,
  ): Promise<TokenPrice> {
    const [tokenPrice] = await db
      .insert(schema.tokenPricesTable)
      .values({ model, ...data })
      .onConflictDoUpdate({
        target: schema.tokenPricesTable.model,
        set: {
          ...data,
          updatedAt: new Date(),
        },
      })
      .returning();

    return tokenPrice;
  }

  static async createIfNotExists(
    model: string,
    data: Omit<CreateTokenPrice, "model">,
  ): Promise<TokenPrice | null> {
    const result = await db
      .insert(schema.tokenPricesTable)
      .values({ model, ...data })
      .onConflictDoNothing({
        target: schema.tokenPricesTable.model,
      })
      .returning();

    return result[0] || null;
  }

  static async delete(id: string): Promise<boolean> {
    // First check if the token price exists
    const existing = await TokenPriceModel.findById(id);
    if (!existing) {
      return false;
    }

    await db
      .delete(schema.tokenPricesTable)
      .where(eq(schema.tokenPricesTable.id, id));

    return true;
  }

  /**
   * Get all unique models from interactions table (both actual and requested models)
   */
  static async getAllModelsFromInteractions(): Promise<
    { provider: SupportedProvider; model: string }[]
  > {
    const results = await db
      .select({
        model: schema.interactionsTable.model,
        requestedModel: sql<string>`${schema.interactionsTable.request} ->> 'model'`,
        type: schema.interactionsTable.type,
      })
      .from(schema.interactionsTable);

    // Collect both actual models and requested models.
    // When the model was optimized, they are different.
    const modelDictionary: Record<string, SupportedProvider> = {};
    for (const row of results) {
      const provider = row.type.split(":")[0] as SupportedProvider;
      if (row.model) {
        modelDictionary[row.model] = provider;
      }
      if (row.requestedModel) {
        modelDictionary[row.requestedModel] = provider;
      }
    }

    return Object.entries(modelDictionary).map(([model, provider]) => ({
      provider,
      model,
    }));
  }

  static async ensureAllModelsHavePricing(): Promise<void> {
    const entries = await TokenPriceModel.getAllModelsFromInteractions();
    const existingTokenPrices = await TokenPriceModel.findAll();
    const existingModels = new Set(existingTokenPrices.map((tp) => tp.model));

    // Create default pricing for models that don't have pricing records
    const missingEntries = entries.filter(
      ({ model }) => !existingModels.has(model),
    );

    if (missingEntries.length > 0) {
      const defaultPrices = missingEntries.map(({ provider, model }) => ({
        model,
        provider,
        ...getDefaultModelPrice(model),
      }));

      await db
        .insert(schema.tokenPricesTable)
        .values(defaultPrices)
        .onConflictDoNothing({
          target: schema.tokenPricesTable.model,
        });
    }
  }
}

export default TokenPriceModel;
