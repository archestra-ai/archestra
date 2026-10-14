import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/** Who owns a reusable credential used by Agent Runtime containers. */
export const RuntimeCredentialConnectionScopeSchema = z.enum([
  "personal",
  "organization",
]);
export type RuntimeCredentialConnectionScope = z.infer<
  typeof RuntimeCredentialConnectionScopeSchema
>;

export const SelectRuntimeCredentialConnectionSchema = createSelectSchema(
  schema.runtimeCredentialConnectionsTable,
).extend({ scope: RuntimeCredentialConnectionScopeSchema });

export type RuntimeCredentialConnection = z.infer<
  typeof SelectRuntimeCredentialConnectionSchema
>;

/** Numeric GitHub account id, stable across login renames. */
export const GitHubUserIdSchema = z
  .number()
  .int()
  .positive()
  .brand<"GitHubUserId">();
export type GitHubUserId = z.infer<typeof GitHubUserIdSchema>;

/**
 * Why a credential an MCP server is configured with cannot be resolved for
 * the person installing it:
 * - `no_access`: they have no value and may not use the credential to add one.
 * - `not_connected`: they may use it but have not added their value yet.
 * - `not_set_up`: the credential has no organization value, or no longer exists.
 * - `personal_only`: it takes each person's own value, so only a personal
 *   installation can carry it.
 */
export const McpCredentialBlockerSchema = z.object({
  envKey: z.string(),
  credentialId: z.string(),
  credentialName: z.string(),
  reason: z.enum(["no_access", "not_connected", "not_set_up", "personal_only"]),
});
export type McpCredentialBlocker = z.infer<typeof McpCredentialBlockerSchema>;
