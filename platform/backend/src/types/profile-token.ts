import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// Profile Token schemas
export const SelectProfileTokenSchema = createSelectSchema(
  schema.profileTokensTable,
);
export const InsertProfileTokenSchema = createInsertSchema(
  schema.profileTokensTable,
).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});
export const UpdateProfileTokenSchema = createUpdateSchema(
  schema.profileTokensTable,
).omit({
  id: true,
  profileId: true,
  secretId: true,
  tokenStart: true,
  createdAt: true,
});

// Token value schema stored in secret table
export const ProfileTokenValueSchema = z.object({
  token: z.string(),
});

// Token prefix constant
export const PROFILE_TOKEN_PREFIX = "archestra_";

// Types
export type SelectProfileToken = z.infer<typeof SelectProfileTokenSchema>;
export type InsertProfileToken = z.infer<typeof InsertProfileTokenSchema>;
export type UpdateProfileToken = z.infer<typeof UpdateProfileTokenSchema>;
export type ProfileTokenValue = z.infer<typeof ProfileTokenValueSchema>;

// Response types with relations
// Now uses one-to-one relationship: each token has one team (or null for org tokens)
export interface ProfileTokenWithTeam extends SelectProfileToken {
  team: {
    id: string;
    name: string;
  } | null;
}

// API response schemas
export const ProfileTokenResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tokenStart: z.string(),
  isOrganizationToken: z.boolean(),
  team: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
});

// Response with full token value (only returned on create/rotate)
export const ProfileTokenWithValueResponseSchema =
  ProfileTokenResponseSchema.extend({
    value: z.string(),
  });

export type ProfileTokenResponse = z.infer<typeof ProfileTokenResponseSchema>;
export type ProfileTokenWithValueResponse = z.infer<
  typeof ProfileTokenWithValueResponseSchema
>;
