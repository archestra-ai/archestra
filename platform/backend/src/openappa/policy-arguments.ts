import { TOOL_PREVIEW_APP_TOOL_SHORT_NAME } from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import logger from "@/logging";
import { gateAppToolCall } from "@/services/apps/app-tool-runtime-gate";
import { normalizeToolArgumentsForPolicy } from "./command-normalization";
import { withDerivedArguments } from "./derived-arguments";

/**
 * The arguments OpenAPPA rules a call on: a tool that shares a resource or
 * transfers a credential also gets the string array `withDerivedArguments`
 * derives. Execution keeps the call's own arguments.
 */
export function policyArguments(toolName: string, args: unknown): unknown {
  return normalizeToolArgumentsForPolicy(
    toolName,
    withDerivedArguments(toolName, args),
  );
}

type PolicyTarget = {
  toolCallName: string;
  toolCallArgs: string;
  isRunToolDispatchTarget?: boolean;
};

/**
 * A `preview_app_tool` call ruled as the app tool it runs, resolved by the gate
 * its execution uses. Only an exact name is ruled: a suffix the gate resolves
 * could name another assigned tool by the time the call runs.
 */
export async function previewAppToolTarget(
  target: PolicyTarget,
): Promise<PolicyTarget | { refusal: string }> {
  if (
    archestraMcpBranding.getToolShortName(target.toolCallName) !==
    TOOL_PREVIEW_APP_TOOL_SHORT_NAME
  )
    return target;
  const args: unknown = JSON.parse(target.toolCallArgs);
  const { appId, toolName, args: toolArgs = {} } = isRecord(args) ? args : {};
  if (
    typeof appId !== "string" ||
    typeof toolName !== "string" ||
    !isRecord(toolArgs)
  )
    return { refusal: "preview_app_tool needs an appId, a toolName and args." };
  // An app id the database cannot read (not a UUID) resolves no tool.
  const decision = await gateAppToolCall({ appId, toolName }).catch((err) => {
    logger.warn(
      { err, appId, toolName },
      "OpenAPPA could not resolve the app tool a preview call names",
    );
    return { allowed: false as const, reason: `App "${appId}" not found.` };
  });
  if (!decision.allowed) return { refusal: decision.reason };
  const resolved =
    decision.kind === "upstream" ? decision.resolvedToolName : toolName;
  if (resolved !== toolName)
    return {
      refusal: `Call preview_app_tool with the tool's full name, "${resolved}".`,
    };
  return {
    toolCallName: resolved,
    toolCallArgs: JSON.stringify(toolArgs),
    isRunToolDispatchTarget: true,
  };
}

// ===

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
