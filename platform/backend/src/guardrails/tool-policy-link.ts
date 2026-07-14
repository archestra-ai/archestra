import type { PolicyDeniedMcpToolError } from "@archestra/shared";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import logger from "@/logging";
import {
  type PolicyBlockResult,
  policyBlockToToolError,
} from "./tool-invocation";

// ===================================================================
// Public API
// ===================================================================

/**
 * Turn a policy block into the `{ error, text }` an external-client tool result
 * carries. When the blocked caller is a known user who holds `toolPolicy:update`
 * and the blocked tool row is identifiable, both the structured error and the
 * prose gain a deep link to that tool's guardrail editor so the client can offer
 * "view/modify this guardrail". Callers without edit rights (or org/service
 * tokens with no user identity) get the block unchanged — never a link they'd
 * only hit a 403 behind.
 *
 * `textPrefix` is prepended to the prose (the gateway sends the refusal as-is;
 * run_tool prefixes it with "Error: ").
 */
export async function buildPolicyBlockedToolResult(params: {
  policyBlock: PolicyBlockResult;
  userId?: string;
  organizationId?: string;
  textPrefix?: string;
}): Promise<{ error: PolicyDeniedMcpToolError; text: string }> {
  const policyUrl = await resolveToolPolicyEditUrl({
    toolId: params.policyBlock.blockedToolId,
    toolName: params.policyBlock.blockedToolName,
    userId: params.userId,
    organizationId: params.organizationId,
  });

  const prefix = params.textPrefix ?? "";
  const urlLine = policyUrl
    ? `\n\nYou have permission to review or update this guardrail here: ${policyUrl}`
    : "";

  return {
    error: policyBlockToToolError(params.policyBlock, policyUrl ?? undefined),
    text: `${prefix}${params.policyBlock.refusalMessage}${urlLine}`,
  };
}

// ===================================================================
// Internal helpers
// ===================================================================

/**
 * Deep link to a tool's guardrail editor, gated on the caller holding
 * `toolPolicy:update`. Returns null (fail-closed) unless we can identify both
 * the tool row and an acting user who can edit it.
 */
async function resolveToolPolicyEditUrl(params: {
  toolId?: string;
  toolName?: string;
  userId?: string;
  organizationId?: string;
}): Promise<string | null> {
  const { toolId, toolName, userId, organizationId } = params;
  if (!toolId || !userId || !organizationId) {
    return null;
  }

  let canEdit = false;
  try {
    canEdit = await userHasPermission(
      userId,
      organizationId,
      "toolPolicy",
      "update",
    );
  } catch (err) {
    logger.info(
      { err },
      "Failed to resolve tool policy edit permission for deep link",
    );
    return null;
  }

  if (!canEdit) {
    return null;
  }

  const url = new URL("/mcp/tool-guardrails", config.frontendBaseUrl);
  url.searchParams.set("toolId", toolId);
  // Name is only for the editor's title; the id is what resolves the tool.
  if (toolName) {
    url.searchParams.set("toolName", toolName);
  }
  return url.toString();
}
