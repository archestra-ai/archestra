import {
  createInsertSchema,
  createSelectSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectApiKeySchema = createSelectSchema(schema.apikeysTable);
export const InsertApiKeySchema = createInsertSchema(schema.apikeysTable);

export const ApiKeyPermissionsSchema = z.record(z.string(), z.array(z.string()));
export const ApiKeyMetadataSchema = z.record(z.string(), z.unknown());

export const ApiKeyResponseSchema = SelectApiKeySchema.omit({
  key: true,
  permissions: true,
  metadata: true,
}).extend({
  metadata: ApiKeyMetadataSchema.nullable(),
  permissions: ApiKeyPermissionsSchema.nullable(),
});

export const ApiKeyWithValueResponseSchema = SelectApiKeySchema.omit({
  permissions: true,
  metadata: true,
}).extend({
  metadata: ApiKeyMetadataSchema.nullable(),
  permissions: ApiKeyPermissionsSchema.nullable(),
});

export const CreateApiKeyBodySchema = InsertApiKeySchema.pick({
  name: true,
})
  .extend({
    expiresIn: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const ApiKeyIdParamsSchema = z.object({
  id: z.string(),
});

export const DeleteApiKeyResponseSchema = z.object({
  success: z.boolean(),
});

export type SelectApiKey = z.infer<typeof SelectApiKeySchema>;
export type ApiKeyResponse = z.infer<typeof ApiKeyResponseSchema>;
export type ApiKeyWithValueResponse = z.infer<typeof ApiKeyWithValueResponseSchema>;
