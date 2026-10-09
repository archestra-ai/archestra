import { z } from "zod";
import { ResourceVisibilityScopeSchema } from "./visibility";

export const McpToolErrorTypeSchema = z.enum([
  "auth_required",
  "auth_expired",
  "assigned_credential_unavailable",
  "tool_state",
  "cancelled",
  "generic",
]);

export const GenericMcpToolErrorSchema = z
  .object({
    type: z.literal("generic"),
    message: z.string(),
  })
  .strict();

export const AuthRequiredActionSchema = z.enum([
  "install_mcp_credentials",
  "connect_identity_provider",
]);

export const AuthRequiredMcpToolErrorSchema = z
  .object({
    type: z.literal("auth_required"),
    message: z.string(),
    catalogId: z.string(),
    catalogName: z.string(),
    action: AuthRequiredActionSchema.optional(),
    actionUrl: z.string().url().optional(),
    installUrl: z.string().url().optional(),
    providerId: z.string().optional(),
  })
  .strict();

export const AuthExpiredMcpToolErrorSchema = z
  .object({
    type: z.literal("auth_expired"),
    message: z.string(),
    catalogId: z.string(),
    catalogName: z.string(),
    serverId: z.string(),
    reauthUrl: z.string().url(),
    // Which credential the runtime resolved for this call (personal / team /
    // org) so the chat card can tell the user whose credential expired.
    // Optional so errors persisted in chat history before this field existed
    // still parse and render (they fall back to generic copy).
    credentialScope: ResourceVisibilityScopeSchema.optional(),
    // Owning team's display name, present only for team-scoped credentials.
    credentialTeamName: z.string().nullable().optional(),
  })
  .strict();

export const AssignedCredentialUnavailableMcpToolErrorSchema = z
  .object({
    type: z.literal("assigned_credential_unavailable"),
    message: z.string(),
    catalogId: z.string(),
    catalogName: z.string(),
  })
  .strict();

export const ToolStateMcpToolErrorSchema = z
  .object({
    type: z.literal("tool_state"),
    message: z.string(),
    code: z.string(),
    toolName: z.string().optional(),
  })
  .strict();

/**
 * The call was aborted before it finished — the user cancelled a background
 * task or stopped the chat run. Deliberately its own type rather than
 * `generic`: a user-initiated stop is not a tool failure, and log surfaces
 * render it as a distinct Cancelled state instead of an error.
 */
export const CancelledMcpToolErrorSchema = z
  .object({
    type: z.literal("cancelled"),
    message: z.string(),
  })
  .strict();

export const McpToolErrorSchema = z.discriminatedUnion("type", [
  GenericMcpToolErrorSchema,
  CancelledMcpToolErrorSchema,
  AuthRequiredMcpToolErrorSchema,
  AuthExpiredMcpToolErrorSchema,
  AssignedCredentialUnavailableMcpToolErrorSchema,
  ToolStateMcpToolErrorSchema,
]);

export type GenericMcpToolError = z.infer<typeof GenericMcpToolErrorSchema>;
export type AuthRequiredMcpToolError = z.infer<
  typeof AuthRequiredMcpToolErrorSchema
>;
export type AuthRequiredAction = z.infer<typeof AuthRequiredActionSchema>;
export type AuthExpiredMcpToolError = z.infer<
  typeof AuthExpiredMcpToolErrorSchema
>;
export type AssignedCredentialUnavailableMcpToolError = z.infer<
  typeof AssignedCredentialUnavailableMcpToolErrorSchema
>;
export type ToolStateMcpToolError = z.infer<typeof ToolStateMcpToolErrorSchema>;
export type McpToolError = z.infer<typeof McpToolErrorSchema>;

export function extractMcpToolError(input: unknown): McpToolError | null {
  return extractMcpToolErrorRecursive(input, 0);
}

function extractMcpToolErrorRecursive(
  input: unknown,
  depth: number,
): McpToolError | null {
  if (depth > 3 || input == null) {
    return null;
  }

  const direct = McpToolErrorSchema.safeParse(input);
  if (direct.success) {
    return direct.data;
  }

  if (typeof input === "string") {
    try {
      return extractMcpToolErrorRecursive(JSON.parse(input), depth + 1);
    } catch {
      return null;
    }
  }

  if (typeof input !== "object") {
    return null;
  }

  const objectWithFields = input as {
    archestraError?: unknown;
    _meta?: { archestraError?: unknown };
    structuredContent?: { archestraError?: unknown };
  };

  return (
    extractMcpToolErrorRecursive(objectWithFields.archestraError, depth + 1) ??
    extractMcpToolErrorRecursive(
      objectWithFields._meta?.archestraError,
      depth + 1,
    ) ??
    extractMcpToolErrorRecursive(
      objectWithFields.structuredContent?.archestraError,
      depth + 1,
    ) ??
    ("message" in input
      ? extractMcpToolErrorRecursive(
          (input as { message?: unknown }).message,
          depth + 1,
        )
      : null) ??
    ("originalError" in input
      ? extractMcpToolErrorRecursive(
          (input as { originalError?: { message?: unknown } }).originalError
            ?.message,
          depth + 1,
        )
      : null)
  );
}
