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

// Profile Token Team schemas
export const SelectProfileTokenTeamSchema = createSelectSchema(
  schema.profileTokenTeamsTable,
);
export const InsertProfileTokenTeamSchema = createInsertSchema(
  schema.profileTokenTeamsTable,
).omit({
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
export type SelectProfileTokenTeam = z.infer<
  typeof SelectProfileTokenTeamSchema
>;
export type InsertProfileTokenTeam = z.infer<
  typeof InsertProfileTokenTeamSchema
>;
export type ProfileTokenValue = z.infer<typeof ProfileTokenValueSchema>;

// Response types with relations
export interface ProfileTokenWithTeams extends SelectProfileToken {
  teams: Array<{
    id: string;
    name: string;
  }>;
}

// API request/response schemas
export const CreateProfileTokenRequestSchema = z.object({
  name: z.string().min(1).max(256),
  teamIds: z.array(z.string()).optional(),
  isOrganizationToken: z.boolean().optional().default(false),
});

export const UpdateProfileTokenRequestSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  teamIds: z.array(z.string()).optional(),
  isOrganizationToken: z.boolean().optional(),
});

export const ProfileTokenResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tokenStart: z.string(),
  isOrganizationToken: z.boolean(),
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
});

// Response with full token value (only returned on create/rotate)
export const ProfileTokenWithValueResponseSchema =
  ProfileTokenResponseSchema.extend({
    value: z.string(),
  });

export type CreateProfileTokenRequest = z.infer<
  typeof CreateProfileTokenRequestSchema
>;
export type UpdateProfileTokenRequest = z.infer<
  typeof UpdateProfileTokenRequestSchema
>;
export type ProfileTokenResponse = z.infer<typeof ProfileTokenResponseSchema>;
export type ProfileTokenWithValueResponse = z.infer<
  typeof ProfileTokenWithValueResponseSchema
>;
