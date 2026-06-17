import { z } from "zod";

export const MCP_OAUTH_CLIENT_METADATA_TYPE = "mcp_oauth_client";

export const McpOauthClientMetadataSchema = z.object({
  type: z.literal(MCP_OAUTH_CLIENT_METADATA_TYPE),
  organizationId: z.string(),
  allowedGatewayIds: z.array(z.string().uuid()).default([]),
});

export const McpOauthClientSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  organizationId: z.string(),
  allowedGatewayIds: z.array(z.string()),
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
