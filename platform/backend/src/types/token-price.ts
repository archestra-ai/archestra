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
const BaseCreateTokenPriceSchema = InsertTokenPriceSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateTokenPriceSchema = BaseCreateTokenPriceSchema.refine(
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

export const UpdateTokenPriceSchema =
  BaseCreateTokenPriceSchema.partial().refine(
    (data) => {
      // Only validate prices if provided
      if (data.pricePerMillionInput !== undefined) {
        const inputPrice = parseFloat(data.pricePerMillionInput);
        if (inputPrice < 0) return false;
      }
      if (data.pricePerMillionOutput !== undefined) {
        const outputPrice = parseFloat(data.pricePerMillionOutput);
        if (outputPrice < 0) return false;
      }
      return true;
    },
    {
      message: "Prices must be non-negative",
    },
  );

/**
 * Exported types
 */
export type TokenPrice = z.infer<typeof SelectTokenPriceSchema>;
export type InsertTokenPrice = z.infer<typeof InsertTokenPriceSchema>;
export type CreateTokenPrice = z.infer<typeof CreateTokenPriceSchema>;
export type UpdateTokenPrice = z.infer<typeof UpdateTokenPriceSchema>;
