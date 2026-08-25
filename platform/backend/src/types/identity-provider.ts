import {
  IDENTITY_PROVIDER_SECRET_PATHS,
  IdentityProviderOidcConfigSchema,
  IdentityProviderSamlConfigSchema,
  IdpRoleMappingConfigSchema,
  IdpTeamSyncConfigSchema,
  RedactedIdentityProviderOidcConfigSchema,
  RedactedIdentityProviderSamlConfigSchema,
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
 * Identity provider as returned by the admin CRUD endpoints.
 *
 * Same shape as `SelectIdentityProviderSchema` minus every credential in
 * `IDENTITY_PROVIDER_SECRET_PATHS`, plus `configuredSecretPaths` so the edit
 * form can tell "stored, left blank" apart from "never set". Secrets stay
 * readable through the model for the SSO login and token-exchange paths; they
 * simply stop crossing the HTTP boundary.
 */
export const RedactedIdentityProviderSchema = createSelectSchema(
  schema.identityProvidersTable,
  {
    ...extendedFields,
    oidcConfig: RedactedIdentityProviderOidcConfigSchema.optional(),
    samlConfig: RedactedIdentityProviderSamlConfigSchema.optional(),
  },
).extend({
  configuredSecretPaths: z.array(z.enum(IDENTITY_PROVIDER_SECRET_PATHS)),
});

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

/**
 * Update payload. `oidcConfig.clientSecret` is optional here (unlike on create)
 * because reads redact it: an admin editing an unrelated field submits the
 * config back without a secret, and the model restores the stored one. Sending
 * a non-empty value still rotates the credential.
 */
export const UpdateIdentityProviderSchema = createUpdateSchema(
  schema.identityProvidersTable,
  {
    ...extendedFields,
    oidcConfig: RedactedIdentityProviderOidcConfigSchema.optional(),
    samlConfig: RedactedIdentityProviderSamlConfigSchema.optional(),
  },
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
