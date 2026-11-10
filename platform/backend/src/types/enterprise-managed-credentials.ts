import { z } from "zod";

export const ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY =
  "enterprise_managed_client_secret_override";

export const ENTERPRISE_MANAGED_PRIVATE_KEY_OVERRIDE_SECRET_KEY =
  "enterprise_managed_private_key_override";

/**
 * The enterprise-managed override credentials a catalog item keeps in its
 * client secret bag: config field, and the bag key it is stored under.
 */
export const ENTERPRISE_MANAGED_OVERRIDE_SECRET_FIELDS = [
  {
    field: "clientSecretOverride",
    key: ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY,
  },
  {
    field: "privateKeyPemOverride",
    key: ENTERPRISE_MANAGED_PRIVATE_KEY_OVERRIDE_SECRET_KEY,
  },
] as const;

export const CredentialResolutionModeSchema = z.enum([
  "static",
  "dynamic",
  "enterprise_managed",
]);

export const EnterpriseManagedCredentialTypeSchema = z.enum([
  "id_jag",
  "bearer_token",
  "secret",
  "service_account",
  "opaque_json",
]);

export const EnterpriseManagedResourceTypeSchema = z.enum([
  "mcp",
  "oauth_protected_resource",
  "secret",
  "service_account",
  "custom_http",
]);

export const EnterpriseManagedTokenInjectionModeSchema = z.enum([
  "authorization_bearer",
  "raw_authorization",
  "header",
  "env",
  "body_field",
]);

export const EnterpriseManagedFallbackModeSchema = z.enum([
  "fail_closed",
  "fallback_to_dynamic",
  "fallback_to_static",
]);

export const EnterpriseManagedAssertionModeSchema = z.enum([
  "exchange",
  "passthrough",
]);

/**
 * Which client an exchanged credential was issued to: the identity provider's
 * own client, the MCP server's override client, or the calling agent's Entra
 * agent identity. Recorded on MCP tool call logs.
 */
export const EnterpriseCredentialClientTypeSchema = z.enum([
  "identity_provider",
  "mcp_server",
  "entra_agent_identity",
]);

export const EnterpriseManagedCredentialConfigSchema = z.object({
  identityProviderId: z.string().optional(),
  assertionMode: EnterpriseManagedAssertionModeSchema.optional(),
  resourceType: EnterpriseManagedResourceTypeSchema.optional(),
  resourceIdentifier: z.string().optional(),
  requestedIssuer: z.string().optional(),
  requestedCredentialType: EnterpriseManagedCredentialTypeSchema.optional(),
  scopes: z.array(z.string()).optional(),
  audience: z.string().optional(),
  /**
   * Client this MCP server's token exchange runs as, instead of the identity
   * provider's own client. Entra On-Behalf-Of and ID-JAG honour it.
   */
  clientIdOverride: z.string().optional(),
  /** Secret for `clientIdOverride`. Stored in the catalog's secret bag. */
  clientSecretOverride: z.string().optional(),
  /**
   * PKCS#8 private key for `clientIdOverride` (private_key_jwt). Stored in the
   * catalog's secret bag; takes precedence over `clientSecretOverride`.
   */
  privateKeyPemOverride: z.string().optional(),
  /**
   * Key ID sent with `privateKeyPemOverride`. For Entra, the certificate's
   * SHA-1 thumbprint as the portal shows it.
   */
  privateKeyIdOverride: z.string().optional(),
  tokenInjectionMode: EnterpriseManagedTokenInjectionModeSchema.optional(),
  headerName: z.string().optional(),
  envVarName: z.string().optional(),
  bodyFieldName: z.string().optional(),
  responseFieldPath: z.string().optional(),
  fallbackMode: EnterpriseManagedFallbackModeSchema.optional(),
  cacheTtlSeconds: z.number().int().nonnegative().optional(),
});

/**
 * The config as the API returns it. The exchange client's secret and private
 * key are write-only: edit forms leave them blank to keep the stored value.
 */
export const EnterpriseManagedCredentialConfigResponseSchema =
  EnterpriseManagedCredentialConfigSchema.omit({
    clientSecretOverride: true,
    privateKeyPemOverride: true,
  });

export type CredentialResolutionMode = z.infer<
  typeof CredentialResolutionModeSchema
>;
export type EnterpriseManagedCredentialType = z.infer<
  typeof EnterpriseManagedCredentialTypeSchema
>;
export type EnterpriseManagedResourceType = z.infer<
  typeof EnterpriseManagedResourceTypeSchema
>;
export type EnterpriseManagedTokenInjectionMode = z.infer<
  typeof EnterpriseManagedTokenInjectionModeSchema
>;
export type EnterpriseManagedFallbackMode = z.infer<
  typeof EnterpriseManagedFallbackModeSchema
>;
export type EnterpriseManagedAssertionMode = z.infer<
  typeof EnterpriseManagedAssertionModeSchema
>;
export type EnterpriseCredentialClientType = z.infer<
  typeof EnterpriseCredentialClientTypeSchema
>;
export type EnterpriseManagedCredentialConfig = z.infer<
  typeof EnterpriseManagedCredentialConfigSchema
>;
