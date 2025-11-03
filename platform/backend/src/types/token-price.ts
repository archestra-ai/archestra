import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Base database schema derived from Drizzle
 */
export const SelectTokenPriceSchema = createSelectSchema(
  schema.tokenPriceTable,
);
export const InsertTokenPriceSchema = createInsertSchema(
  schema.tokenPriceTable,
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

export const UpdateTokenPriceSchema = CreateTokenPriceSchema.partial().extend({
  id: z.string().uuid(),
});

/**
 * Exported types
 */
export type TokenPrice = z.infer<typeof SelectTokenPriceSchema>;
export type InsertTokenPrice = z.infer<typeof InsertTokenPriceSchema>;
export type CreateTokenPrice = z.infer<typeof CreateTokenPriceSchema>;
export type UpdateTokenPrice = z.infer<typeof UpdateTokenPriceSchema>;
