import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";

export interface TokenPrice {
  id: string;
  provider: string;
  model: string;
  inputPricePer1M: string;
  outputPricePer1M: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTokenPriceInput {
  provider: string;
  model: string;
  inputPricePer1M?: string;
  outputPricePer1M?: string;
}

export interface UpdateTokenPriceInput {
  inputPricePer1M: string;
  outputPricePer1M: string;
}

class TokenPricingModel {
  /**
   * Find or create token prices for all models found in interactions
   * Returns all token prices, creating new ones with default $50 for any missing models
   */
  static async findOrCreateByModels(): Promise<TokenPrice[]> {
    // Get distinct provider/model combinations from interactions
    const distinctModels = await db.execute(sql`
      SELECT DISTINCT 
        COALESCE(provider, SPLIT_PART(type, ':', 1)) as provider,
        COALESCE(model, request->>'model') as model
      FROM ${schema.interactionsTable}
      WHERE 
        (provider IS NOT NULL AND model IS NOT NULL)
        OR request->>'model' IS NOT NULL
    `);

    // Process each model found
    for (const row of distinctModels.rows) {
      if (!row.provider || !row.model) continue;

      const provider = String(row.provider);
      const model = String(row.model);

      // Check if pricing already exists
      const existing = await db
        .select()
        .from(schema.tokenPricingTable)
        .where(
          and(
            eq(schema.tokenPricingTable.provider, provider),
            eq(schema.tokenPricingTable.model, model),
          ),
        );

      // Create if not exists with default $50
      if (existing.length === 0) {
        await db
          .insert(schema.tokenPricingTable)
          .values({
            provider,
            model,
            inputPricePer1M: "50.00",
            outputPricePer1M: "50.00",
          })
          .onConflictDoNothing();
      }
    }

    // Return all token prices
    const allPrices = await db
      .select()
      .from(schema.tokenPricingTable)
      .orderBy(
        schema.tokenPricingTable.provider,
        schema.tokenPricingTable.model,
      );

    return allPrices as TokenPrice[];
  }

  /**
   * Get all token prices
   */
  static async findAll(): Promise<TokenPrice[]> {
    const prices = await db
      .select()
      .from(schema.tokenPricingTable)
      .orderBy(
        schema.tokenPricingTable.provider,
        schema.tokenPricingTable.model,
      );

    return prices as TokenPrice[];
  }

  /**
   * Update token prices in bulk
   */
  static async updateMany(
    updates: Array<{ id: string } & UpdateTokenPriceInput>,
  ): Promise<TokenPrice[]> {
    const updatedPrices: TokenPrice[] = [];

    for (const update of updates) {
      const [updated] = await db
        .update(schema.tokenPricingTable)
        .set({
          inputPricePer1M: update.inputPricePer1M,
          outputPricePer1M: update.outputPricePer1M,
        })
        .where(eq(schema.tokenPricingTable.id, update.id))
        .returning();

      if (updated) {
        updatedPrices.push(updated as TokenPrice);
      }
    }

    return updatedPrices;
  }

  /**
   * Create a new token price entry
   */
  static async create(input: CreateTokenPriceInput): Promise<TokenPrice> {
    const [price] = await db
      .insert(schema.tokenPricingTable)
      .values({
        provider: input.provider,
        model: input.model,
        inputPricePer1M: input.inputPricePer1M || "50.00",
        outputPricePer1M: input.outputPricePer1M || "50.00",
      })
      .returning();

    return price as TokenPrice;
  }

  /**
   * Find token price by provider and model
   */
  static async findByProviderModel(
    provider: string,
    model: string,
  ): Promise<TokenPrice | null> {
    const [price] = await db
      .select()
      .from(schema.tokenPricingTable)
      .where(
        and(
          eq(schema.tokenPricingTable.provider, provider),
          eq(schema.tokenPricingTable.model, model),
        ),
      );

    return price ? (price as TokenPrice) : null;
  }
}

export default TokenPricingModel;
