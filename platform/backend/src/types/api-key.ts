import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectApiKeySchema = createSelectSchema(schema.apikeysTable);

export const ApiKeyPermissionsSchema = z.record(z.string(), z.array(z.string()));
export const ApiKeyMetadataSchema = z.record(z.string(), z.unknown());

export const ApiKeyResponseSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  start: z.string().nullable(),
  prefix: z.string().nullable(),
  userId: z.string(),
  enabled: z.boolean().nullable(),
  lastRequest: z.date().nullable(),
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  metadata: ApiKeyMetadataSchema.nullable(),
  permissions: ApiKeyPermissionsSchema.nullable(),
});

export const ApiKeyWithValueResponseSchema = ApiKeyResponseSchema.extend({
  key: z.string(),
});

export const CreateApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  expiresIn: z.number().int().positive().nullable().optional(),
});

export const UpdateApiKeyBodySchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    enabled: z.boolean().optional(),
    expiresIn: z.number().int().positive().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const ApiKeyIdParamsSchema = z.object({
  id: z.string(),
});

export const DeleteApiKeyResponseSchema = z.object({
  success: z.boolean(),
});

export type SelectApiKey = z.infer<typeof SelectApiKeySchema>;
export type ApiKeyResponse = z.infer<typeof ApiKeyResponseSchema>;
export type ApiKeyWithValueResponse = z.infer<typeof ApiKeyWithValueResponseSchema>;
