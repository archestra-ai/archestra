import { z } from "zod";

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

export const EnterpriseManagedCredentialConfigSchema = z.object({
  identityProviderId: z.string().optional(),
  resourceType: EnterpriseManagedResourceTypeSchema.optional(),
  resourceIdentifier: z.string().optional(),
  requestedIssuer: z.string().optional(),
  requestedCredentialType: EnterpriseManagedCredentialTypeSchema.optional(),
  scopes: z.array(z.string()).optional(),
  audience: z.string().optional(),
  clientIdOverride: z.string().optional(),
  tokenInjectionMode: EnterpriseManagedTokenInjectionModeSchema.optional(),
  headerName: z.string().optional(),
  envVarName: z.string().optional(),
  bodyFieldName: z.string().optional(),
  responseFieldPath: z.string().optional(),
  fallbackMode: EnterpriseManagedFallbackModeSchema.optional(),
  cacheTtlSeconds: z.number().int().nonnegative().optional(),
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
export type EnterpriseManagedCredentialConfig = z.infer<
  typeof EnterpriseManagedCredentialConfigSchema
>;
