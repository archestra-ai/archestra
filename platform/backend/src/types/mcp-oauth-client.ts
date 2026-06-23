import { z } from "zod";

export const MCP_OAUTH_CLIENT_METADATA_TYPE = "mcp_oauth_client";

/**
 * Which OAuth grant an MCP OAuth client uses:
 * - `client_credentials`: a shared application credential with no acting user.
 *   Scoped to an explicit list of gateways via `allowedGatewayIds`.
 * - `authorization_code`: a pre-registered client that mints user-bound tokens
 *   so the gateway resolves the acting user's identity (enabling per-user
 *   "Resolve at call time" connection resolution). Gateway access is governed by
 *   the user's own permissions, so `allowedGatewayIds` does not apply; the client
 *   is identified by its `redirectUris` instead.
 */
export const McpOauthClientGrantTypeSchema = z.enum([
  "client_credentials",
  "authorization_code",
]);
export type McpOauthClientGrantType = z.infer<
  typeof McpOauthClientGrantTypeSchema
>;

export const McpOauthClientMetadataSchema = z.object({
  type: z.literal(MCP_OAUTH_CLIENT_METADATA_TYPE),
  organizationId: z.string(),
  allowedGatewayIds: z.array(z.string().uuid()).default([]),
  // Rows created before authorization_code support have no grantType; treat
  // them as the original client_credentials clients.
  grantType: McpOauthClientGrantTypeSchema.default("client_credentials"),
});

export const McpOauthClientSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  organizationId: z.string(),
  grantType: McpOauthClientGrantTypeSchema,
  allowedGatewayIds: z.array(z.string()),
  redirectUris: z.array(z.string()),
  disabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const McpOauthClientWithSecretSchema = McpOauthClientSchema.extend({
  clientSecret: z.string(),
});

export type McpOauthClientMetadata = z.infer<
  typeof McpOauthClientMetadataSchema
>;
export type McpOauthClient = z.infer<typeof McpOauthClientSchema>;
