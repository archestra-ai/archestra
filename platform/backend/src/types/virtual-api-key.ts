import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectVirtualApiKeySchema = createSelectSchema(
  schema.virtualApiKeysTable,
);

export const InsertVirtualApiKeySchema = createInsertSchema(
  schema.virtualApiKeysTable,
).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});

/** Schema for virtual key response at creation time (includes full token value) */
export const VirtualApiKeyWithValueSchema = SelectVirtualApiKeySchema.extend({
  value: z.string(),
});

/** Schema for virtual key with parent API key info (for org-wide listing) */
export const VirtualApiKeyWithParentInfoSchema =
  SelectVirtualApiKeySchema.extend({
    parentKeyName: z.string(),
    parentKeyProvider: z.string(),
    parentKeyBaseUrl: z.string().nullable(),
  });

export type SelectVirtualApiKey = z.infer<typeof SelectVirtualApiKeySchema>;
export type InsertVirtualApiKey = z.infer<typeof InsertVirtualApiKeySchema>;
export type VirtualApiKeyWithValue = z.infer<
  typeof VirtualApiKeyWithValueSchema
>;
export type VirtualApiKeyWithParentInfo = z.infer<
  typeof VirtualApiKeyWithParentInfoSchema
>;
