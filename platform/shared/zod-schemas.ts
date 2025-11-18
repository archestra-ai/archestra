import { z } from "zod";
import { THEME_IDS } from "./themes/theme-config";

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

// Environment variable schema for UI forms
export const EnvironmentVariableSchema = z.object({
  key: z.string().min(1, "Key is required"),
  type: z.enum(["plain_text", "secret"]),
  value: z.string().optional(), // Optional static value (when not prompted)
  promptOnInstallation: z.boolean(), // Whether to prompt user during installation
});

export const LocalConfigSchema = z
  .object({
    command: z.string().optional(),
    arguments: z.array(z.string()).optional(),
    environment: z.array(EnvironmentVariableSchema).optional(),
    dockerImage: z.string().optional(),
    transportType: z.enum(["stdio", "streamable-http"]).optional(),
    httpPort: z.number().optional(),
    httpPath: z.string().optional(),
  })
  .refine(
    (data) => {
      // At least one of command or dockerImage must be provided
      return data.command || data.dockerImage;
    },
    {
      message:
        "Either command or dockerImage must be provided. If dockerImage is set, command is optional (Docker image's default CMD will be used).",
      path: ["command"],
    },
  );

// Form version of LocalConfigSchema for UI forms (using strings that get parsed)
export const LocalConfigFormSchema = z.object({
  command: z.string().optional(),
  arguments: z.string(), // UI uses string, gets parsed to array
  environment: z.array(EnvironmentVariableSchema), // Structured environment variables
  dockerImage: z.string().optional(), // Custom Docker image URL
  transportType: z.enum(["stdio", "streamable-http"]).optional(),
  httpPort: z.string().optional(), // UI uses string, gets parsed to number
  httpPath: z.string().optional(), // HTTP endpoint path (e.g., /mcp)
});

/**
 * Organization Appearance Schemas
 * All themes from https://github.com/jnsahaj/tweakcn
 * Theme IDs are generated from shared/themes/theme-config.ts
 */
export const OrganizationThemeSchema = z.enum(THEME_IDS);
export const OrganizationCustomFontSchema = z.enum([
  "lato",
  "inter",
  "open-sans",
  "roboto",
  "source-sans-pro",
]);

export type OrganizationTheme = z.infer<typeof OrganizationThemeSchema>;
export type OrganizationCustomFont = z.infer<
  typeof OrganizationCustomFontSchema
>;

export const StatisticsTimeFrameSchema = z.union([
  z.enum(["5m", "15m", "30m", "1h", "24h", "7d", "30d", "90d", "12m", "all"]),
  z
    .templateLiteral(["custom:", z.string(), "_", z.string()])
    .describe("Custom timeframe must be in format 'custom:startTime_endTime'"),
]);

export type StatisticsTimeFrame = z.infer<typeof StatisticsTimeFrameSchema>;
