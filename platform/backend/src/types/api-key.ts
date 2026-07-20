import {
  API_KEY_MAX_EXPIRATION_DAYS,
  API_KEY_MAX_NAME_LENGTH,
  API_KEY_MIN_EXPIRATION_DAYS,
} from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

const SECONDS_PER_DAY = 24 * 60 * 60;

export const SelectApiKeySchema = createSelectSchema(schema.apikeysTable);

export const ApiKeyPermissionsSchema = z.record(
  z.string(),
  z.array(z.string()),
);
export const ApiKeyMetadataSchema = z.record(z.string(), z.unknown());

export const ApiKeyResponseSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  start: z.string().nullable(),
  prefix: z.string().nullable(),
  userId: z.string(),
  enabled: z.boolean().nullable(),
  lastRequest: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  metadata: ApiKeyMetadataSchema.nullable(),
  permissions: ApiKeyPermissionsSchema.nullable(),
});

export const ApiKeyWithValueResponseSchema = ApiKeyResponseSchema.extend({
  key: z.string(),
});

export const CreateApiKeyBodySchema = z
  .object({
    name: z
      .string()
      .max(
        API_KEY_MAX_NAME_LENGTH,
        `Name must be at most ${API_KEY_MAX_NAME_LENGTH} characters`,
      )
      .nullable()
      .optional(),
    expiresIn: z
      .number()
      .int()
      .min(
        API_KEY_MIN_EXPIRATION_DAYS * SECONDS_PER_DAY,
        `Expiration must be at least ${API_KEY_MIN_EXPIRATION_DAYS} day from now`,
      )
      .max(
        API_KEY_MAX_EXPIRATION_DAYS * SECONDS_PER_DAY,
        `Expiration cannot be more than ${API_KEY_MAX_EXPIRATION_DAYS} days from now`,
      )
      .nullable()
      .optional(),
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
export type ApiKeyWithValueResponse = z.infer<
  typeof ApiKeyWithValueResponseSchema
>;
