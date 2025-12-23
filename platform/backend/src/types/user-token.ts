import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// User Token schemas
export const SelectUserTokenSchema = createSelectSchema(schema.userTokensTable);
export const InsertUserTokenSchema = createInsertSchema(
  schema.userTokensTable,
).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});
export const UpdateUserTokenSchema = createUpdateSchema(
  schema.userTokensTable,
).omit({
  id: true,
  organizationId: true,
  userId: true,
  secretId: true,
  tokenStart: true,
  createdAt: true,
});

// Token value schema stored in secret table
export const UserTokenValueSchema = z.object({
  token: z.string(),
});

// Token prefix constant (shared with team tokens)
export const USER_TOKEN_PREFIX = "archestra_";

// Types
export type SelectUserToken = z.infer<typeof SelectUserTokenSchema>;
export type InsertUserToken = z.infer<typeof InsertUserTokenSchema>;
export type UpdateUserToken = z.infer<typeof UpdateUserTokenSchema>;
export type UserTokenValue = z.infer<typeof UserTokenValueSchema>;

// API response schemas
export const UserTokenResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tokenStart: z.string(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
});

// Response with full token value (only returned on create/rotate)
export const UserTokenWithValueResponseSchema = UserTokenResponseSchema.extend({
  value: z.string(),
});

export type UserTokenResponse = z.infer<typeof UserTokenResponseSchema>;
export type UserTokenWithValueResponse = z.infer<
  typeof UserTokenWithValueResponseSchema
>;
