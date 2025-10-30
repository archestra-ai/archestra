import { z } from "zod";

export const OAuthConfigSchema = z.object({
  name: z.string(),
  server_url: z.string(),
  auth_server_url: z.string().optional(),
  resource_metadata_url: z.string().optional(),
  client_id: z.string(),
  client_secret: z.string().optional(),
  redirect_uris: z.array(z.string()),
  scopes: z.array(z.string()),
  description: z.string().optional(),
  well_known_url: z.string().optional(),
  default_scopes: z.array(z.string()),
  supports_resource_metadata: z.boolean(),
  generic_oauth: z.boolean().optional(),
  token_endpoint: z.string().optional(),
  access_token_env_var: z.string().optional(),
  requires_proxy: z.boolean().optional(),
  provider_name: z.string().optional(),
  browser_auth: z.boolean().optional(),
  streamable_http_url: z.string().optional(),
  streamable_http_port: z.number().optional(),
});

export const LocalConfigSchema = z.object({
  command: z.string(),
  arguments: z.array(z.string()),
  environment: z.record(z.string(), z.string()).optional(),
});

// Form version of LocalConfigSchema for UI forms (using strings that get parsed)
export const LocalConfigFormSchema = z.object({
  command: z.string().min(1, "Command is required"),
  arguments: z.string(), // UI uses string, gets parsed to array
  environment: z.string(), // UI uses string, gets parsed to record
});
