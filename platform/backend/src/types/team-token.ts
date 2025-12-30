import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// Team Token schemas
export const SelectTeamTokenSchema = createSelectSchema(schema.teamTokensTable);
export const InsertTeamTokenSchema = createInsertSchema(
  schema.teamTokensTable,
).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});
export const UpdateTeamTokenSchema = createUpdateSchema(
  schema.teamTokensTable,
).omit({
  id: true,
  organizationId: true,
  teamId: true,
  secretId: true,
  tokenStart: true,
  createdAt: true,
});

// Token value schema stored in secret table
export const TeamTokenValueSchema = z.object({
  token: z.string(),
});

// Token prefix constant
export const TEAM_TOKEN_PREFIX = "archestra_";

// Types
export type SelectTeamToken = z.infer<typeof SelectTeamTokenSchema>;
export type InsertTeamToken = z.infer<typeof InsertTeamTokenSchema>;
export type UpdateTeamToken = z.infer<typeof UpdateTeamTokenSchema>;
export type TeamTokenValue = z.infer<typeof TeamTokenValueSchema>;

// Response types with relations
export interface TeamTokenWithTeam extends SelectTeamToken {
  team: {
    id: string;
    name: string;
  } | null;
}

// API response schemas
export const TeamTokenResponseSchema = z.object({
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
export const TeamTokenWithValueResponseSchema = TeamTokenResponseSchema.extend({
  value: z.string(),
});

export type TeamTokenResponse = z.infer<typeof TeamTokenResponseSchema>;
export type TeamTokenWithValueResponse = z.infer<
  typeof TeamTokenWithValueResponseSchema
>;

// Response schema for GET /api/tokens with permission info
export const TokensListResponseSchema = z.object({
  tokens: z.array(TeamTokenResponseSchema),
  permissions: z.object({
    canAccessOrgToken: z.boolean(),
    canAccessTeamTokens: z.boolean(),
  }),
});

export type TokensListResponse = z.infer<typeof TokensListResponseSchema>;

// Helper function to check if a token has the archestra prefix
export function isArchestraPrefixedToken(value: string): boolean {
  return value.startsWith(TEAM_TOKEN_PREFIX);
}
