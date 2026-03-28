import { z } from "zod";
import { parseArchestraToolRefusal } from "./tool-refusal";

export const McpToolErrorTypeSchema = z.enum([
  "auth_required",
  "auth_expired",
  "policy_denied",
  "generic",
]);

export const GenericMcpToolErrorSchema = z
  .object({
    type: z.literal("generic"),
    message: z.string(),
  })
  .strict();

export const AuthRequiredMcpToolErrorSchema = z
  .object({
    type: z.literal("auth_required"),
    message: z.string(),
    catalogId: z.string(),
    catalogName: z.string(),
    installUrl: z.string().url(),
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
  })
  .strict();

export const PolicyDeniedMcpToolErrorSchema = z
  .object({
    type: z.literal("policy_denied"),
    message: z.string(),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    reason: z.string(),
  })
  .strict();

export const McpToolErrorSchema = z.discriminatedUnion("type", [
  GenericMcpToolErrorSchema,
  AuthRequiredMcpToolErrorSchema,
  AuthExpiredMcpToolErrorSchema,
  PolicyDeniedMcpToolErrorSchema,
]);

export type GenericMcpToolError = z.infer<typeof GenericMcpToolErrorSchema>;
export type AuthRequiredMcpToolError = z.infer<
  typeof AuthRequiredMcpToolErrorSchema
>;
export type AuthExpiredMcpToolError = z.infer<
  typeof AuthExpiredMcpToolErrorSchema
>;
export type PolicyDeniedMcpToolError = z.infer<
  typeof PolicyDeniedMcpToolErrorSchema
>;
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
      return parsePolicyDeniedMcpToolError(input);
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

function parsePolicyDeniedMcpToolError(
  input: string,
): PolicyDeniedMcpToolError | null {
  const tagged = parseArchestraToolRefusal(input);
  const toolName =
    tagged.toolName ??
    input.match(/invoke[d]?\s+(?:the\s+)?(.+?)\s+tool/i)?.[1];
  const toolArgs =
    tagged.toolArguments ??
    input.match(/tool with the following arguments:\s*(\{[\s\S]*?\})/i)?.[1];
  const reason =
    tagged.reason ??
    input.match(/(?:denied|blocked)[\s\S]*?:\s*([\s\S]+)/i)?.[1]?.trim();

  if (!toolName || !reason) {
    return null;
  }

  let parsedInput: Record<string, unknown> = {};
  if (toolArgs) {
    try {
      parsedInput = JSON.parse(toolArgs);
    } catch {
      parsedInput = {};
    }
  }

  return {
    type: "policy_denied",
    message: input,
    toolName,
    input: parsedInput,
    reason,
  };
}
