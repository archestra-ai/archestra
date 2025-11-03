import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { CreateTokenPrice, InsertTokenPrice, TokenPrice } from "@/types";

class TokenPriceModel {
  static async findAll(): Promise<TokenPrice[]> {
    return await db.select().from(schema.tokenPriceTable);
  }

  static async findById(id: string): Promise<TokenPrice | null> {
    const [tokenPrice] = await db
      .select()
      .from(schema.tokenPriceTable)
      .where(eq(schema.tokenPriceTable.id, id));

    return tokenPrice || null;
  }

  static async findByModel(model: string): Promise<TokenPrice | null> {
    const [tokenPrice] = await db
      .select()
      .from(schema.tokenPriceTable)
      .where(eq(schema.tokenPriceTable.model, model));

    return tokenPrice || null;
  }

  static async create(data: CreateTokenPrice): Promise<TokenPrice> {
    const [tokenPrice] = await db
      .insert(schema.tokenPriceTable)
      .values(data)
      .returning();

    return tokenPrice;
  }

  static async update(
    id: string,
    data: Partial<CreateTokenPrice>,
  ): Promise<TokenPrice | null> {
    const [tokenPrice] = await db
      .update(schema.tokenPriceTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.tokenPriceTable.id, id))
      .returning();

    return tokenPrice || null;
  }

  static async upsertForModel(
    model: string,
    data: Omit<CreateTokenPrice, "model">,
  ): Promise<TokenPrice> {
    const [tokenPrice] = await db
      .insert(schema.tokenPriceTable)
      .values({ model, ...data })
      .onConflictDoUpdate({
        target: schema.tokenPriceTable.model,
        set: {
          pricePerMillionInput: data.pricePerMillionInput,
          pricePerMillionOutput: data.pricePerMillionOutput,
          updatedAt: new Date(),
        },
      })
      .returning();

    return tokenPrice;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.tokenPriceTable)
      .where(eq(schema.tokenPriceTable.id, id));

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get all unique models from interactions table
   */
  static async getAllModelsFromInteractions(): Promise<string[]> {
    const results = await db
      .select({
        model: schema.interactionsTable.model,
      })
      .from(schema.interactionsTable)
      .where(sql`${schema.interactionsTable.model} IS NOT NULL`)
      .groupBy(schema.interactionsTable.model);

    return results.map((row) => row.model).filter(Boolean) as string[];
  }

  /**
   * Ensure all models from interactions have pricing records with default $50 pricing
   */
  static async ensureAllModelsHavePricing(): Promise<void> {
    const models = await TokenPriceModel.getAllModelsFromInteractions();
    const existingTokenPrices = await TokenPriceModel.findAll();
    const existingModels = new Set(existingTokenPrices.map((tp) => tp.model));

    // Create default pricing for models that don't have pricing records
    const missingModels = models.filter((model) => !existingModels.has(model));

    if (missingModels.length > 0) {
      const defaultPrices: InsertTokenPrice[] = missingModels.map((model) => ({
        model,
        pricePerMillionInput: "50.00", // Default $50 per million tokens
        pricePerMillionOutput: "50.00", // Default $50 per million tokens
      }));

      await db.insert(schema.tokenPriceTable).values(defaultPrices);
    }
  }
}

export default TokenPriceModel;
