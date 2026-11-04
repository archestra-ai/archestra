import {
  type ArchestraToolShortName,
  TOOL_PREVIEW_APP_TOOL_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { gateAppToolCall } from "@/services/apps/app-tool-runtime-gate";
import { normalizeToolArgumentsForPolicy } from "./command-normalization";

/**
 * The arguments OpenAPPA rules a call on. No selector reads an array of
 * objects, so an Archestra tool that takes one also gets a string array
 * derived from it: `initialGrantPrincipals` (`<type>:<id>`, or
 * `organization`) for `initialGrants`, and `transferModes` (`value` or
 * `link`) for a credential transfer's `environment`. A value the model sent
 * under a derived name is replaced. A malformed source derives `null`, which
 * the battery's parameter schema refuses. Execution keeps the call's own
 * arguments.
 */
export function policyArguments(toolName: string, args: unknown): unknown {
  return normalizeToolArgumentsForPolicy(
    toolName,
    withDerivedArguments(archestraMcpBranding.getToolShortName(toolName), args),
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
  const decision = await gateAppToolCall({ appId, toolName }).catch(() => ({
    allowed: false as const,
    reason: `App "${appId}" not found.`,
  }));
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

const GRANTING_TOOLS = new Set<ArchestraToolShortName | null>([
  "create_agent",
  "create_mcp_gateway",
  "create_mcp_server",
  "create_plugin",
  "create_knowledge_base",
  "scaffold_app",
]);

function withDerivedArguments(
  shortName: ArchestraToolShortName | null,
  args: unknown,
): unknown {
  if (!isRecord(args)) return args;
  if (GRANTING_TOOLS.has(shortName))
    return derived(
      args,
      "initialGrantPrincipals",
      args.initialGrants,
      (grant) =>
        isRecord(grant) && isRecord(grant.subject)
          ? principal(grant.subject)
          : null,
    );
  if (shortName === "transfer_credential")
    return derived(args, "transferModes", args.environment, (entry) =>
      isRecord(entry) ? (entry.value === undefined ? "link" : "value") : null,
    );
  return args;
}

/** `args` with `key` derived from `source`, one entry per element; absent for none. */
function derived(
  args: Record<string, unknown>,
  key: string,
  source: unknown,
  entry: (element: unknown) => string | null,
): Record<string, unknown> {
  const { [key]: _sent, ...rest } = args;
  if (source === undefined || (Array.isArray(source) && source.length === 0))
    return rest;
  const entries = Array.isArray(source) ? source.map(entry) : [null];
  return {
    ...rest,
    [key]: entries.every((value) => value !== null) ? entries : null,
  };
}

function principal(subject: Record<string, unknown>): string | null {
  const { type, id } = subject;
  if (typeof id !== "string" || id.length === 0) return null;
  switch (type) {
    case "organization":
      return id === "*" ? "organization" : null;
    case "user":
    case "team":
    case "serviceAccount":
    case "role":
      return `${type}:${id}`;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
