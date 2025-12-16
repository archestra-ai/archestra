import { SupportedProvidersSchema } from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

const fieldsToExtend = {
  provider: SupportedProvidersSchema,
};

/**
 * Base database schema derived from Drizzle
 */
export const SelectTokenPriceSchema = createSelectSchema(
  schema.tokenPricesTable,
  fieldsToExtend,
);
export const InsertTokenPriceSchema = createInsertSchema(
  schema.tokenPricesTable,
  fieldsToExtend,
);

/**
 * Refined types for better type safety and validation
 */
export const CreateTokenPriceSchema = InsertTokenPriceSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).refine(
  (data) => {
    // Validation: prices must be positive
    const inputPrice = parseFloat(data.pricePerMillionInput);
    const outputPrice = parseFloat(data.pricePerMillionOutput);
    return inputPrice >= 0 && outputPrice >= 0;
  },
  {
    message: "Prices must be non-negative",
  },
);

export const UpdateTokenPriceSchema = CreateTokenPriceSchema.partial();

/**
 * Exported types
 */
export type TokenPrice = z.infer<typeof SelectTokenPriceSchema>;
export type InsertTokenPrice = z.infer<typeof InsertTokenPriceSchema>;
export type CreateTokenPrice = z.infer<typeof CreateTokenPriceSchema>;
export type UpdateTokenPrice = z.infer<typeof UpdateTokenPriceSchema>;
