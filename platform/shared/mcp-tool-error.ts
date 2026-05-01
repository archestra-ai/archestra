import { z } from "zod";
import { isSensitiveContextPolicyDeniedReason } from "./tool-invocation-policy-reasons";
import { parseArchestraToolRefusal } from "./tool-refusal";

export const McpToolErrorTypeSchema = z.enum([
  "auth_required",
  "auth_expired",
  "assigned_credential_unavailable",
  "policy_denied",
  "tool_state",
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

export const AssignedCredentialUnavailableMcpToolErrorSchema = z
  .object({
    type: z.literal("assigned_credential_unavailable"),
    message: z.string(),
    catalogId: z.string(),
    catalogName: z.string(),
  })
  .strict();

export const PolicyDeniedReasonTypeSchema = z.enum([
  "sensitive_context",
  "generic",
]);

export const PolicyDeniedMcpToolErrorSchema = z
  .object({
    type: z.literal("policy_denied"),
    message: z.string(),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    reason: z.string(),
    reasonType: PolicyDeniedReasonTypeSchema.optional(),
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

export const McpToolErrorSchema = z.discriminatedUnion("type", [
  GenericMcpToolErrorSchema,
  AuthRequiredMcpToolErrorSchema,
  AuthExpiredMcpToolErrorSchema,
  AssignedCredentialUnavailableMcpToolErrorSchema,
  PolicyDeniedMcpToolErrorSchema,
  ToolStateMcpToolErrorSchema,
]);

export type GenericMcpToolError = z.infer<typeof GenericMcpToolErrorSchema>;
export type AuthRequiredMcpToolError = z.infer<
  typeof AuthRequiredMcpToolErrorSchema
>;
export type AuthExpiredMcpToolError = z.infer<
  typeof AuthExpiredMcpToolErrorSchema
>;
export type AssignedCredentialUnavailableMcpToolError = z.infer<
  typeof AssignedCredentialUnavailableMcpToolErrorSchema
>;
export type PolicyDeniedMcpToolError = z.infer<
  typeof PolicyDeniedMcpToolErrorSchema
>;
export type ToolStateMcpToolError = z.infer<typeof ToolStateMcpToolErrorSchema>;
export type PolicyDeniedReasonType = z.infer<
  typeof PolicyDeniedReasonTypeSchema
>;
export type McpToolError = z.infer<typeof McpToolErrorSchema>;

export function extractMcpToolError(input: unknown): McpToolError | null {
  return extractMcpToolErrorRecursive(input, 0);
}

export function classifyPolicyDeniedReason(
  reason: string,
): PolicyDeniedReasonType {
  if (isSensitiveContextPolicyDeniedReason(reason)) {
    return "sensitive_context";
  }

  return "generic";
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
    return normalizeMcpToolError(direct.data);
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
    tagged.toolName ?? extractToolNameFromPolicyDeniedMessage(input);
  const toolArgs =
    tagged.toolArguments ?? extractToolArgumentsFromPolicyDeniedMessage(input);
  const reason = tagged.reason ?? extractReasonFromPolicyDeniedMessage(input);

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
    reasonType: classifyPolicyDeniedReason(reason),
  };
}

function normalizeMcpToolError(error: McpToolError): McpToolError {
  if (error.type !== "policy_denied") {
    return error;
  }

  return {
    ...error,
    reasonType: error.reasonType ?? classifyPolicyDeniedReason(error.reason),
  };
}

function extractToolNameFromPolicyDeniedMessage(input: string): string | null {
  const lowered = input.toLowerCase();
  const invokedIndex = lowered.indexOf("invoked ");
  const invokeIndex = lowered.indexOf("invoke ");
  const startIndex = invokedIndex >= 0 ? invokedIndex : invokeIndex;

  if (startIndex < 0) {
    return null;
  }

  let candidate = input.slice(startIndex + (invokedIndex >= 0 ? 8 : 7));
  if (candidate.toLowerCase().startsWith("the ")) {
    candidate = candidate.slice(4);
  }

  const toolIndex = candidate.toLowerCase().indexOf(" tool");
  if (toolIndex < 0) {
    return null;
  }

  const toolName = candidate.slice(0, toolIndex).trim();
  return toolName.length > 0 ? toolName : null;
}

function extractToolArgumentsFromPolicyDeniedMessage(
  input: string,
): string | null {
  const marker = "tool with the following arguments:";
  const lowered = input.toLowerCase();
  const markerIndex = lowered.indexOf(marker);

  if (markerIndex < 0) {
    return null;
  }

  const remainder = input.slice(markerIndex + marker.length).trimStart();
  if (!remainder.startsWith("{")) {
    return null;
  }

  const endIndex = findBalancedJsonObjectEnd(remainder);
  if (endIndex < 0) {
    return null;
  }

  return remainder.slice(0, endIndex + 1).trim();
}

function extractReasonFromPolicyDeniedMessage(input: string): string | null {
  const lowered = input.toLowerCase();
  const deniedIndex = lowered.indexOf("denied");
  const blockedIndex = lowered.indexOf("blocked");
  const markerIndex =
    deniedIndex >= 0 ? deniedIndex : blockedIndex >= 0 ? blockedIndex : -1;

  if (markerIndex < 0) {
    return null;
  }

  const colonIndex = input.indexOf(":", markerIndex);
  if (colonIndex < 0) {
    return null;
  }

  const reason = input.slice(colonIndex + 1).trim();
  if (!reason) {
    return null;
  }

  const nestedColonIndex = reason.indexOf(":");
  if (nestedColonIndex >= 0) {
    return reason.slice(nestedColonIndex + 1).trim();
  }

  return reason;
}

function findBalancedJsonObjectEnd(input: string): number {
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (const [index, char] of Array.from(input).entries()) {
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === "\\") {
        isEscaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}
