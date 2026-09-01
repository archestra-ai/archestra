import { CreatedByNullableSchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { LabelWithDetailsSchema } from "./label";

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
  /** Who added this account, for "who do I ask about this automation". */
  createdBy: CreatedByNullableSchema,
  organizationId: z.string(),
  name: z.string(),
  role: z.string(),
  disabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  labels: z.array(LabelWithDetailsSchema),
  tokenCount: z.number().int().nonnegative(),
  /**
   * Keys that would actually pass authentication right now: not disabled and
   * not past their expiry. `tokenCount` alone cannot distinguish a working
   * automation from one whose only key expired last week.
   */
  activeTokenCount: z.number().int().nonnegative(),
  /** Most recent use across all of this account's keys; null if never used. */
  lastUsedAt: z.coerce.date().nullable(),
  /**
   * Earliest expiry among the keys that still work, so the list can warn
   * before a key lapses instead of after. Null when nothing is expiring:
   * either no key works, or every working key is open-ended.
   */
  soonestExpiryAt: z.coerce.date().nullable(),
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
  labels: z.array(LabelWithDetailsSchema).optional(),
});

export const UpdateServiceAccountBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    role: z.string().trim().min(1).max(256).optional(),
    disabled: z.boolean().optional(),
    labels: z.array(LabelWithDetailsSchema).optional(),
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
