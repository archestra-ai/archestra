import {
  IdentityProviderOidcConfigSchema,
  IdentityProviderSamlConfigSchema,
  IdpRoleMappingConfigSchema,
  IdpTeamSyncConfigSchema,
} from "@archestra/shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

const extendedFields = {
  oidcConfig: IdentityProviderOidcConfigSchema.optional(),
  samlConfig: IdentityProviderSamlConfigSchema.optional(),
  roleMapping: IdpRoleMappingConfigSchema.optional(),
  teamSyncConfig: IdpTeamSyncConfigSchema.optional(),
};

export const SelectIdentityProviderSchema = createSelectSchema(
  schema.identityProvidersTable,
  extendedFields,
);

/**
 * Minimal identity provider info for public/unauthenticated endpoints (e.g., login page).
 * Contains only non-sensitive fields needed to display SSO login buttons.
 */
export const PublicIdentityProviderSchema = SelectIdentityProviderSchema.pick({
  id: true,
  providerId: true,
});

/**
 * Identity provider projection for the team External Group Sync section:
 * enough to pick a provider and understand how group identifiers are
 * extracted, without exposing any provider configuration or secrets.
 */
export const TeamSyncIdentityProviderOptionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  groupsExpression: z.string().nullable(),
});

export const IdentityProviderLatestIdTokenClaimsSchema = z.object({
  providerId: z.string(),
  claims: z.record(z.string(), z.unknown()).nullable(),
  accessTokenClaims: z.record(z.string(), z.unknown()).nullable(),
  accessTokenExpiresAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
});

export const InsertIdentityProviderSchema = createInsertSchema(
  schema.identityProvidersTable,
  extendedFields,
).omit({ id: true, organizationId: true });

export const UpdateIdentityProviderSchema = createUpdateSchema(
  schema.identityProvidersTable,
  extendedFields,
).omit({
  id: true,
  organizationId: true,
  userId: true,
});

export type IdentityProvider = z.infer<typeof SelectIdentityProviderSchema>;
export type PublicIdentityProvider = z.infer<
  typeof PublicIdentityProviderSchema
>;
export type TeamSyncIdentityProviderOption = z.infer<
  typeof TeamSyncIdentityProviderOptionSchema
>;
export type IdentityProviderLatestIdTokenClaims = z.infer<
  typeof IdentityProviderLatestIdTokenClaimsSchema
>;
export type InsertIdentityProvider = z.infer<
  typeof InsertIdentityProviderSchema
>;
export type UpdateIdentityProvider = z.infer<
  typeof UpdateIdentityProviderSchema
>;
