import { SupportedProvidersSchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Clients whose setup can be fully scripted. n8n and "Any Client" stay on the
 * manual instructions flow and are deliberately absent.
 */
export const ConnectionSetupClientIdSchema = z.enum([
  "claude-code",
  "codex",
  "copilot-cli",
  "cursor",
]);

export type ConnectionSetupClientId = z.infer<
  typeof ConnectionSetupClientIdSchema
>;

/**
 * How the script authenticates LLM-proxy traffic. "provider-key" is
 * passthrough: the script only rewires the base URL and the user keeps using
 * their own provider credentials. "virtual-key" injects an auto-provisioned
 * personal virtual key.
 */
export const ConnectionSetupProxyAuthSchema = z.enum([
  "provider-key",
  "virtual-key",
]);

export type ConnectionSetupProxyAuth = z.infer<
  typeof ConnectionSetupProxyAuthSchema
>;

/**
 * Target OS for the generated setup script. macOS and Linux share the bash
 * renderer (`curl | bash`); Windows gets a PowerShell renderer (`irm | iex`).
 * Persisted on the setup row so the one-time script GET renders the variant the
 * user saw when they copied the command.
 */
export const ConnectionSetupPlatformSchema = z.enum([
  "macos",
  "linux",
  "windows",
]);

export type ConnectionSetupPlatform = z.infer<
  typeof ConnectionSetupPlatformSchema
>;

export const SelectConnectionSetupSchema = createSelectSchema(
  schema.connectionSetupsTable,
).extend({
  clientId: ConnectionSetupClientIdSchema,
  provider: SupportedProvidersSchema.nullable(),
  proxyAuth: ConnectionSetupProxyAuthSchema,
  platform: ConnectionSetupPlatformSchema,
});

export const InsertConnectionSetupSchema = createInsertSchema(
  schema.connectionSetupsTable,
)
  .omit({
    id: true,
    createdAt: true,
    consumedAt: true,
    skillShareLinkId: true,
  })
  .extend({
    clientId: ConnectionSetupClientIdSchema,
    provider: SupportedProvidersSchema.nullable().optional(),
    proxyAuth: ConnectionSetupProxyAuthSchema.optional(),
    platform: ConnectionSetupPlatformSchema.optional(),
  });

export type ConnectionSetup = z.infer<typeof SelectConnectionSetupSchema>;
export type InsertConnectionSetup = z.infer<typeof InsertConnectionSetupSchema>;
