import { z } from "zod";
import { isSensitiveContextPolicyDeniedReason } from "./tool-invocation-policy-reasons";
import { parseArchestraToolRefusal } from "./tool-refusal";
import { ResourceVisibilityScopeSchema } from "./visibility";

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

export const PolicyDeniedReasonTypeSchema = z.enum([
  "sensitive_context",
  "generic",
]);

export const PolicyDeniedMcpToolErrorSchema = z
  .object({
    type: z.literal("policy_denied"),
    message: z.string(),
    toolName: z.string(),
    // The id of the tool row the policy was actually evaluated against. Lets the
    // chat "Edit policy" modal resolve the tool directly by id, which the
    // assignment-based lookup cannot for All-mode tools that have no agent_tools
    // row. Optional so denials persisted before this field still parse.
    toolId: z.string().optional(),
    input: z.record(z.string(), z.unknown()),
    reason: z.string(),
    reasonType: PolicyDeniedReasonTypeSchema.optional(),
    // Deep link to this tool's guardrail editor, included only when the blocked
    // caller both is a known user and holds toolPolicy:update — so a client can
    // offer "view/modify this guardrail" without dangling a link that 403s.
    // Absent for callers without edit rights and for denials persisted before
    // this field existed.
    policyUrl: z.string().url().optional(),
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
export type AuthRequiredAction = z.infer<typeof AuthRequiredActionSchema>;
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

/**
 * Build the structured tool error a blocked tool call carries alongside its
 * prose. Attaching this to a tool result's `_meta.archestraError` /
 * `structuredContent.archestraError` lets clients render the block without
 * re-parsing the prose (extractMcpToolError finds it before any heuristic).
 */
export function buildPolicyDeniedMcpToolError(params: {
  toolName: string;
  toolId?: string;
  input: Record<string, unknown>;
  reason: string;
  message: string;
  policyUrl?: string;
}): PolicyDeniedMcpToolError {
  return {
    type: "policy_denied",
    message: params.message,
    toolName: params.toolName,
    toolId: params.toolId,
    input: params.input,
    reason: params.reason,
    reasonType: classifyPolicyDeniedReason(params.reason),
    policyUrl: params.policyUrl,
  };
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

// Anchor phrases of the current refusal template (tool-refusal.ts). Parsing
// them first keeps the extraction exact regardless of what surrounds them
// (e.g. a white-label product name containing words like "invoke"/"denied"
// that the legacy heuristics below key on).
const CURRENT_POLICY_DENIED_HEADER_MARKER = "blocked unsafe tool call: ";
const CURRENT_POLICY_DENIED_ARGS_MARKER = " with arguments:";

function extractToolNameFromPolicyDeniedMessage(input: string): string | null {
  const headerIndex = input.indexOf(CURRENT_POLICY_DENIED_HEADER_MARKER);
  if (headerIndex >= 0) {
    const candidate = input.slice(
      headerIndex + CURRENT_POLICY_DENIED_HEADER_MARKER.length,
    );
    const argsIndex = candidate.indexOf(CURRENT_POLICY_DENIED_ARGS_MARKER);
    if (argsIndex > 0) {
      const toolName = candidate.slice(0, argsIndex).trim();
      if (toolName.length > 0) {
        return toolName;
      }
    }
  }

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
  const lowered = input.toLowerCase();
  const legacyMarker = "tool with the following arguments:";
  const legacyIndex = lowered.indexOf(legacyMarker);
  const currentIndex =
    legacyIndex >= 0
      ? -1
      : input.indexOf(CURRENT_POLICY_DENIED_ARGS_MARKER.trimEnd());
  const markerIndex = legacyIndex >= 0 ? legacyIndex : currentIndex;
  const markerLength =
    legacyIndex >= 0
      ? legacyMarker.length
      : CURRENT_POLICY_DENIED_ARGS_MARKER.trimEnd().length;

  if (markerIndex < 0) {
    return null;
  }

  const remainder = input.slice(markerIndex + markerLength).trimStart();
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
  // Current template: the reason is the paragraph immediately after the
  // "blocked unsafe tool call: …" header, bounded by the next blank line (the
  // explainer paragraph — or, in messages persisted before it was removed, the
  // "Do not retry:" line; either way the reason ends at that blank line).
  const headerIndex = input.indexOf(CURRENT_POLICY_DENIED_HEADER_MARKER);
  if (headerIndex >= 0) {
    const reasonStart = input.indexOf("\n\n", headerIndex);
    const reasonEnd =
      reasonStart >= 0 ? input.indexOf("\n\n", reasonStart + 2) : -1;
    if (reasonStart >= 0 && reasonEnd > reasonStart) {
      // The template adds a closing period to the rendered line; strip it so
      // the extracted reason matches the raw constants (and the sensitive-
      // context classification sets).
      const reason = input
        .slice(reasonStart, reasonEnd)
        .trim()
        .replace(/\.$/, "");
      if (reason.length > 0) {
        return reason;
      }
    }
  }

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
