import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectServiceAccountSchema = createSelectSchema(
  schema.serviceAccountsTable,
);
export const InsertServiceAccountSchema = createInsertSchema(
  schema.serviceAccountsTable,
);
export const SelectServiceAccountTokenSchema = createSelectSchema(
  schema.serviceAccountTokensTable,
);

export const ServiceAccountTokenResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tokenStart: z.string(),
  disabled: z.boolean(),
  lastUsedAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

export const ServiceAccountResponseSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string(),
  name: z.string(),
  role: z.string(),
  disabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  tokenCount: z.number().int().nonnegative(),
});

export const ServiceAccountDetailResponseSchema =
  ServiceAccountResponseSchema.extend({
    tokens: z.array(ServiceAccountTokenResponseSchema),
  });

export const ServiceAccountTokenWithValueResponseSchema =
  ServiceAccountTokenResponseSchema.extend({
    token: z.string(),
  });

export const CreateServiceAccountBodySchema = z.object({
  name: z.string().trim().min(1).max(256),
  role: z.string().trim().min(1).max(256),
});

export const UpdateServiceAccountBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    role: z.string().trim().min(1).max(256).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export const CreateServiceAccountTokenBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    expiresIn: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const UpdateServiceAccountTokenBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export const ServiceAccountIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const ServiceAccountTokenIdParamsSchema =
  ServiceAccountIdParamsSchema.extend({
    tokenId: z.string().uuid(),
  });

export const DeleteServiceAccountResponseSchema = z.object({
  success: z.boolean(),
});

export type SelectServiceAccount = z.infer<typeof SelectServiceAccountSchema>;
export type SelectServiceAccountToken = z.infer<
  typeof SelectServiceAccountTokenSchema
>;
export type ServiceAccountResponse = z.infer<
  typeof ServiceAccountResponseSchema
>;
export type ServiceAccountDetailResponse = z.infer<
  typeof ServiceAccountDetailResponseSchema
>;
export type ServiceAccountTokenResponse = z.infer<
  typeof ServiceAccountTokenResponseSchema
>;
